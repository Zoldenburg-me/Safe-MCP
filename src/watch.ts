#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { formatDuration, parseDuration } from "./duration.js";
import { getChainName } from "./chains.js";
import { tick } from "./watcher.js";

const USAGE = `
safe-mpc-watch — polls for open DAO proposals and asks an agent to vote as the
proposal's deadline approaches.

  safe-mpc-watch            run continuously, polling every POLL_INTERVAL
  safe-mpc-watch --once     run a single pass and exit (use from cron)
  safe-mpc-watch --plan     show what is queued and due, dispatching nothing

Configure WATCH_SNAPSHOT_SPACES, WATCH_GOVERNORS, VOTE_BEFORE_CLOSE and
AGENT_COMMAND. See .env.example.
`.trim();

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--help") || args.has("-h")) {
    console.log(USAGE);
    return;
  }

  const planOnly = args.has("--plan");
  const once = args.has("--once");
  const config = loadConfig();

  if (
    config.WATCH_SNAPSHOT_SPACES.length === 0 &&
    config.WATCH_GOVERNORS.length === 0 &&
    config.WATCH_TALLY_SLUGS.length === 0
  ) {
    throw new Error(
      "Nothing to watch. Set WATCH_SNAPSHOT_SPACES (Snapshot space ids) and/or " +
        "WATCH_GOVERNORS (Governor contract addresses on this chain)."
    );
  }

  if (!planOnly && !config.AGENT_COMMAND) {
    throw new Error(
      "AGENT_COMMAND is not set, so there is no agent to ask for a decision. " +
        'Set it to the command that runs your agent, for example:\n\n' +
        '  AGENT_COMMAND=claude -p "{prompt}" --mcp-config .mcp.json ' +
        "--allowedTools 'mcp__safe-mpc__*'\n\n" +
        "Or run with --plan to see the schedule without dispatching."
    );
  }

  const intervalMs = parseDuration(config.POLL_INTERVAL);
  const leadMs = parseDuration(config.VOTE_BEFORE_CLOSE);

  console.error(
    `safe-mpc-watch: Safe ${config.SAFE_ADDRESS} on ${getChainName(config.SAFE_CHAIN_ID)}\n` +
      `  spaces:   ${config.WATCH_SNAPSHOT_SPACES.join(", ") || "(none)"}\n` +
      `  governors: ${config.WATCH_GOVERNORS.join(", ") || "(none)"}\n` +
      (config.WATCH_TALLY_SLUGS.length > 0
        ? `  hosted:   ${config.WATCH_TALLY_SLUGS.join(", ")} (legacy, Tally shut down)\n`
        : "") +
      `  vote at:  ${formatDuration(leadMs)} before a proposal closes\n` +
      `  polling:  every ${formatDuration(intervalMs)}${once ? " (single pass)" : ""}\n` +
      `  mode:     ${planOnly ? "plan only" : config.DRY_RUN ? "DRY_RUN" : "live"}`
  );

  const runOnce = async () => {
    const result = await tick(config, { planOnly });
    console.error(
      `pass complete: ${result.discovered} open, ${result.added} newly queued, ` +
        `${result.due} due, ${result.dispatched} dispatched, ${result.voted} voted, ` +
        `${result.failed} failed`
    );
  };

  await runOnce();

  if (once || planOnly) return;

  // A long-lived watcher polls on a timer; failures in one pass must not end it.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      await runOnce();
    } catch (error) {
      console.error(
        `pass failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    `safe-mpc-watch: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
