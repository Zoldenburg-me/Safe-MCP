import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryVoteLog } from "../voteLog.js";
import { dueVotes, loadSchedule } from "../schedule.js";
import { formatDuration } from "../duration.js";
import { guard, json } from "./shared.js";
import type { Config } from "../config.js";

export function registerLogTools(server: McpServer, config: Config): void {
  server.registerTool(
    "vote_log",
    {
      title: "Read this Safe's voting record",
      description:
        "Returns votes this Safe has already cast through Safe-MPC, newest first, " +
        "with the choice and the reason given. Read it before deciding so the Safe " +
        "votes consistently with its own precedent, and to check whether a proposal " +
        "has already been handled.",
      inputSchema: {
        platform: z.enum(["snapshot", "snapshot-x", "governor"]).optional(),
        venue: z
          .string()
          .optional()
          .describe("Snapshot space id, Snapshot X space contract, or Governor contract address"),
        proposalId: z.string().optional(),
        outcome: z.enum(["submitted", "queued", "failed", "dry-run"]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ platform, venue, proposalId, outcome, limit }) => {
      const entries = await queryVoteLog(config, {
        ...(platform ? { platform } : {}),
        ...(venue ? { venue } : {}),
        ...(proposalId ? { proposalId } : {}),
        ...(outcome ? { outcome } : {}),
        limit,
      });

      return json(
        { count: entries.length, votes: entries },
        entries.length === 0
          ? "No votes recorded yet."
          : `${entries.length} recorded vote(s), newest first.`
      );
    })
  );

  server.registerTool(
    "vote_schedule",
    {
      title: "Read the scheduled vote queue",
      description:
        "Shows proposals the watcher has queued for a decision, when each is due, " +
        "and which are due now. Populated by safe-mpc-watch; empty if the watcher " +
        "is not running.",
      inputSchema: {
        status: z
          .enum(["pending", "dispatched", "voted", "failed", "expired", "all"])
          .default("pending"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ status }) => {
      const schedule = await loadSchedule(config);
      const now = new Date();

      const all = Object.values(schedule.entries)
        .filter((entry) => status === "all" || entry.status === status)
        .sort((a, b) => Date.parse(a.voteAt) - Date.parse(b.voteAt))
        .map((entry) => ({
          ...entry,
          votesIn: formatDuration(Date.parse(entry.voteAt) - now.getTime()),
          closesIn: formatDuration(Date.parse(entry.endsAt) - now.getTime()),
        }));

      const due = dueVotes(schedule, now);

      return json(
        { count: all.length, dueNow: due.length, scheduled: all },
        all.length === 0
          ? "Nothing is scheduled. Run safe-mpc-watch to populate the queue."
          : `${all.length} scheduled, ${due.length} due now.`
      );
    })
  );
}
