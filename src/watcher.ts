import { spawn } from "node:child_process";
import { parseDuration, formatDuration } from "./duration.js";
import {
  dueVotes,
  expiredVotes,
  loadSchedule,
  pruneSchedule,
  saveSchedule,
  scheduleLeadMs,
  updateEntry,
  upsertProposals,
  type DiscoveredProposal,
  type ScheduledVote,
} from "./schedule.js";
import { hasVotedOn } from "./voteLog.js";
import * as snapshot from "./platforms/snapshot.js";
import * as tally from "./platforms/tally.js";
import * as indexer from "./platforms/governorIndexer.js";
import type { Config } from "./config.js";

/** Closed proposals stay in the schedule this long, for visibility. */
const RETAIN_CLOSED = parseDuration("30d");

/**
 * Identifiers are interpolated into the agent's argv, so they are constrained
 * to characters that cannot alter how the command is parsed. Proposal titles
 * are attacker-controlled text from a public DAO, and are never interpolated —
 * they reach the agent through the environment only.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

function log(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Splits a command string into argv, honouring single and double quotes. The
 * result is spawned without a shell, so no metacharacter in any substituted
 * value can be interpreted.
 */
export function parseCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) throw new Error(`Unterminated ${quote} quote in AGENT_COMMAND.`);
  if (started) argv.push(current);
  if (argv.length === 0) throw new Error("AGENT_COMMAND is empty.");

  return argv;
}

/** The instruction handed to the agent. Built here, never from proposal text. */
export function buildAgentPrompt(entry: ScheduledVote): string {
  return entry.platform === "snapshot"
    ? `Decide and cast the Safe's vote on Snapshot proposal ${entry.proposalId} ` +
        `in space ${entry.venue}. Read the proposal and the voting policy resources ` +
        `first, vote according to that policy, and record a substantive reason. ` +
        `Voting closes at ${entry.endsAt}.`
    : `Decide and cast the Safe's vote on Governor proposal ${entry.proposalId} at ` +
        `contract ${entry.venue}. Check the on-chain proposal state and the voting ` +
        `policy resources first, vote according to that policy, and record a ` +
        `substantive reason. This vote costs gas and is final. ` +
        `Voting closes at ${entry.endsAt}.`;
}

/** Substitutes validated placeholders into each argv element. */
export function renderArgv(argv: string[], entry: ScheduledVote): string[] {
  for (const value of [entry.proposalId, entry.venue]) {
    if (!SAFE_IDENTIFIER.test(value)) {
      throw new Error(
        `Refusing to dispatch: "${value}" is not a safe identifier for a command argument.`
      );
    }
  }

  const replacements: Record<string, string> = {
    "{platform}": entry.platform,
    "{proposalId}": entry.proposalId,
    "{venue}": entry.venue,
    "{endsAt}": entry.endsAt,
    "{prompt}": buildAgentPrompt(entry),
  };

  return argv.map((argument) =>
    Object.entries(replacements).reduce(
      (rendered, [token, value]) => rendered.split(token).join(value),
      argument
    )
  );
}

/** Discovers open Snapshot proposals in every watched space. */
export async function discoverSnapshot(config: Config): Promise<DiscoveredProposal[]> {
  const found: DiscoveredProposal[] = [];

  for (const space of config.WATCH_SNAPSHOT_SPACES) {
    try {
      const proposals = await snapshot.listProposals(config, {
        space,
        state: "active",
        limit: 50,
      });

      for (const proposal of proposals) {
        found.push({
          platform: "snapshot",
          proposalId: proposal.id,
          venue: proposal.space.id,
          title: proposal.title,
          endsAt: new Date(Number(proposal.end) * 1000),
        });
      }

      log(`snapshot ${space}: ${proposals.length} open proposal(s)`);
    } catch (error) {
      log(
        `snapshot ${space}: discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return found;
}

/**
 * Discovers open on-chain proposals by reading ProposalCreated logs from each
 * watched Governor. This is the supported path: it needs no third-party
 * indexer, which matters because Tally shut down in March 2026.
 */
export async function discoverGovernorOnChain(
  config: Config
): Promise<DiscoveredProposal[]> {
  const found: DiscoveredProposal[] = [];

  for (const governor of config.WATCH_GOVERNORS) {
    try {
      const { proposals, lookback } = await indexer.findProposals(config, {
        governor: governor as `0x${string}`,
        states: ["Pending", "Active"],
      });

      for (const proposal of proposals) {
        found.push({
          platform: "governor",
          proposalId: proposal.proposalId,
          venue: proposal.governor,
          title: proposal.title,
          endsAt: proposal.endsAt,
        });
      }

      log(
        `governor ${governor}: ${proposals.length} open proposal(s); ` +
          `scan window ${lookback.detail}` +
          (proposals.some((p) => p.endsAtIsEstimate)
            ? "; deadlines estimated from block time"
            : "")
      );
    } catch (error) {
      log(
        `governor ${governor}: discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return found;
}

/**
 * Legacy discovery through the Tally-compatible hosted API. Kept for operators
 * with a working key; WATCH_GOVERNORS is the supported route.
 */
export async function discoverGovernorHosted(
  config: Config
): Promise<DiscoveredProposal[]> {
  const found: DiscoveredProposal[] = [];

  for (const slug of config.WATCH_TALLY_SLUGS) {
    try {
      const proposals = await tally.listProposals(config, {
        organizationSlug: slug,
        limit: 50,
      });

      let kept = 0;

      for (const proposal of proposals) {
        if (proposal.status !== "active") continue;

        // Tally governor ids look like "eip155:1:0xAbC…".
        const parts = proposal.governor?.id.split(":") ?? [];
        const chainId = Number(parts[1]);
        const address = parts[2];
        const endsAt = proposal.end?.timestamp
          ? new Date(proposal.end.timestamp)
          : null;

        if (!address || chainId !== config.SAFE_CHAIN_ID) continue;
        if (!endsAt || Number.isNaN(endsAt.getTime())) continue;

        found.push({
          platform: "governor",
          proposalId: proposal.onchainId,
          venue: address,
          title: proposal.metadata?.title ?? "(untitled)",
          endsAt,
        });
        kept += 1;
      }

      log(`tally ${slug}: ${kept} open on-chain proposal(s) on chain ${config.SAFE_CHAIN_ID}`);
    } catch (error) {
      log(
        `tally ${slug}: discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return found;
}

/** Runs the agent command for one proposal. Resolves with its exit code. */
async function dispatch(
  config: Config,
  entry: ScheduledVote
): Promise<{ code: number; output: string }> {
  const argv = renderArgv(parseCommand(config.AGENT_COMMAND!), entry);
  const [command, ...args] = argv as [string, ...string[]];
  const timeoutMs = parseDuration(config.AGENT_TIMEOUT);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SAFE_MPC_PLATFORM: entry.platform,
        SAFE_MPC_PROPOSAL_ID: entry.proposalId,
        SAFE_MPC_VENUE: entry.venue,
        SAFE_MPC_PROPOSAL_TITLE: entry.title,
        SAFE_MPC_ENDS_AT: entry.endsAt,
        SAFE_MPC_PROMPT: buildAgentPrompt(entry),
      },
    });

    let output = "";
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 64_000) output = output.slice(-64_000);
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`The agent command exceeded AGENT_TIMEOUT (${config.AGENT_TIMEOUT}).`)
      );
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run the agent command "${command}": ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, output });
    });
  });
}

export interface TickResult {
  discovered: number;
  added: number;
  due: number;
  dispatched: number;
  voted: number;
  failed: number;
  expired: number;
}

/**
 * One pass: discover open proposals, merge them into the schedule, then ask
 * the agent to decide on everything that has reached its vote window.
 */
export async function tick(
  config: Config,
  options: { planOnly?: boolean } = {}
): Promise<TickResult> {
  const leadMs = scheduleLeadMs(config);
  const now = new Date();

  const discovered = [
    ...(await discoverSnapshot(config)),
    ...(await discoverGovernorOnChain(config)),
    ...(await discoverGovernorHosted(config)),
  ];

  let schedule = pruneSchedule(await loadSchedule(config), RETAIN_CLOSED, now);
  const merged = upsertProposals(schedule, discovered, leadMs, now);
  schedule = merged.schedule;

  for (const entry of merged.added) {
    log(
      `queued ${entry.platform} ${entry.proposalId} (${entry.venue}): ` +
        `voting in ${formatDuration(Date.parse(entry.voteAt) - now.getTime())}, ` +
        `closes ${entry.endsAt}`
    );
  }

  for (const entry of expiredVotes(schedule, now)) {
    log(`expired without a vote: ${entry.platform} ${entry.proposalId} (${entry.venue})`);
    schedule = updateEntry(schedule, entry.key, { status: "expired" });
  }

  const due = dueVotes(schedule, now);
  const result: TickResult = {
    discovered: discovered.length,
    added: merged.added.length,
    due: due.length,
    dispatched: 0,
    voted: 0,
    failed: 0,
    expired: expiredVotes(schedule, now).length,
  };

  if (options.planOnly) {
    await saveSchedule(config, schedule);
    for (const entry of due) {
      log(`DUE NOW: ${entry.platform} ${entry.proposalId} (${entry.venue}) — ${entry.title}`);
    }
    return result;
  }

  for (const entry of due) {
    // The log is the durable record, so a vote cast in a previous run is never
    // re-dispatched even if the schedule write was lost.
    if (await hasVotedOn(config, entry.proposalId)) {
      log(`already voted, skipping: ${entry.platform} ${entry.proposalId}`);
      schedule = updateEntry(schedule, entry.key, { status: "voted" });
      continue;
    }

    log(`dispatching agent for ${entry.platform} ${entry.proposalId} (${entry.venue})`);

    schedule = updateEntry(schedule, entry.key, {
      status: "dispatched",
      attempts: entry.attempts + 1,
      dispatchedAt: new Date().toISOString(),
    });
    await saveSchedule(config, schedule);
    result.dispatched += 1;

    try {
      const { code, output } = await dispatch(config, entry);
      const voted = await hasVotedOn(config, entry.proposalId);

      if (voted) {
        schedule = updateEntry(schedule, entry.key, { status: "voted", lastError: null });
        result.voted += 1;
        log(`voted on ${entry.proposalId}`);
      } else {
        const detail =
          code === 0
            ? "the agent exited cleanly but cast no vote"
            : `the agent exited with code ${code}`;
        schedule = updateEntry(schedule, entry.key, {
          status: "pending",
          lastError: detail,
        });
        result.failed += 1;
        log(`no vote recorded for ${entry.proposalId}: ${detail}`);
        if (output.trim()) log(`agent output tail: ${output.trim().slice(-2_000)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      schedule = updateEntry(schedule, entry.key, {
        status: "pending",
        lastError: message,
      });
      result.failed += 1;
      log(`dispatch failed for ${entry.proposalId}: ${message}`);
    }

    await saveSchedule(config, schedule);
  }

  await saveSchedule(config, schedule);

  return result;
}
