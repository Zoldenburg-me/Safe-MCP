import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSchedule, loadSchedule, type ScheduleFile } from "../src/schedule.js";
import { readVoteLog } from "../src/voteLog.js";
import { tick } from "../src/watcher.js";
import type { Config } from "../src/config.js";

let dir: string;
let base: Config;

/** A due-now proposal that closes in an hour. */
function seed(): ScheduleFile {
  const now = Date.now();
  return {
    version: 1,
    entries: {
      "snapshot:ens.eth:0xaaa": {
        key: "snapshot:ens.eth:0xaaa",
        platform: "snapshot",
        proposalId: "0xaaa",
        venue: "ens.eth",
        title: "Fund the thing",
        endsAt: new Date(now + 3_600_000).toISOString(),
        voteAt: new Date(now - 1_000).toISOString(),
        status: "pending",
        attempts: 0,
        discoveredAt: new Date(now - 10_000).toISOString(),
        dispatchedAt: null,
        lastError: null,
      },
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "safe-mpc-watch-"));
  base = {
    SAFE_ADDRESS: "0x1234567890123456789012345678901234567890",
    SAFE_CHAIN_ID: 1,
    VOTE_LOG_PATH: join(dir, "votes.jsonl"),
    SCHEDULE_PATH: join(dir, "schedule.json"),
    // Empty watch lists keep discovery entirely offline.
    WATCH_SNAPSHOT_SPACES: [],
    WATCH_GOVERNORS: [],
    WATCH_TALLY_SLUGS: [],
    VOTE_BEFORE_CLOSE: "6h",
    POLL_INTERVAL: "1h",
    AGENT_TIMEOUT: "30s",
  } as unknown as Config;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a stub agent that appends a submitted vote, as a real agent would. */
async function writeVotingAgent(): Promise<string> {
  const path = join(dir, "agent.mjs");
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";
const entry = {
  at: new Date().toISOString(),
  platform: "snapshot",
  outcome: "submitted",
  safeAddress: process.env.SAFE_MPC_VENUE ? "0x1234567890123456789012345678901234567890" : "",
  chainId: 1,
  proposalId: process.env.SAFE_MPC_PROPOSAL_ID,
  venue: process.env.SAFE_MPC_VENUE,
  title: process.env.SAFE_MPC_PROPOSAL_TITLE,
  choice: "For",
  reason: "Stub agent vote.",
  votingPower: "1",
  receipt: "vote-stub",
  safeTxHash: null,
  safeMessageHash: null,
  error: null,
};
appendFileSync(process.argv[2], JSON.stringify(entry) + "\\n");
`,
    "utf-8"
  );
  await chmod(path, 0o755);
  return path;
}

describe("Watcher dispatch", () => {
  it("runs the agent for a due proposal and marks it voted", async () => {
    const agent = await writeVotingAgent();
    await saveSchedule(base, seed());

    const config = {
      ...base,
      AGENT_COMMAND: `node ${agent} ${base.VOTE_LOG_PATH} --id {proposalId}`,
    } as Config;

    const result = await tick(config);

    assert.equal(result.due, 1);
    assert.equal(result.dispatched, 1);
    assert.equal(result.voted, 1);
    assert.equal(result.failed, 0);

    const votes = await readVoteLog(config);
    assert.equal(votes.length, 1);
    assert.equal(votes[0]!.proposalId, "0xaaa");
    // The title reaches the agent through the environment, not the command line.
    assert.equal(votes[0]!.title, "Fund the thing");

    const schedule = await loadSchedule(config);
    assert.equal(schedule.entries["snapshot:ens.eth:0xaaa"]!.status, "voted");
  });

  it("does not dispatch twice for the same proposal", async () => {
    const agent = await writeVotingAgent();
    await saveSchedule(base, seed());

    const config = {
      ...base,
      AGENT_COMMAND: `node ${agent} ${base.VOTE_LOG_PATH}`,
    } as Config;

    await tick(config);
    const second = await tick(config);

    assert.equal(second.dispatched, 0);
    assert.equal((await readVoteLog(config)).length, 1);
  });

  it("leaves the proposal pending when the agent casts no vote", async () => {
    await saveSchedule(base, seed());

    const config = { ...base, AGENT_COMMAND: "node --eval 0" } as Config;
    const result = await tick(config);

    assert.equal(result.dispatched, 1);
    assert.equal(result.voted, 0);
    assert.equal(result.failed, 1);

    const entry = (await loadSchedule(config)).entries["snapshot:ens.eth:0xaaa"]!;
    assert.equal(entry.status, "pending");
    assert.equal(entry.attempts, 1);
    assert.match(entry.lastError!, /cast no vote/);
  });

  it("records a dispatch failure when the command cannot run", async () => {
    await saveSchedule(base, seed());

    const config = { ...base, AGENT_COMMAND: "safe-mpc-no-such-binary" } as Config;
    const result = await tick(config);

    assert.equal(result.failed, 1);
    const entry = (await loadSchedule(config)).entries["snapshot:ens.eth:0xaaa"]!;
    assert.equal(entry.status, "pending");
    assert.match(entry.lastError!, /Could not run the agent command/);
  });

  it("plans without dispatching", async () => {
    const agent = await writeVotingAgent();
    await saveSchedule(base, seed());

    const config = {
      ...base,
      AGENT_COMMAND: `node ${agent} ${base.VOTE_LOG_PATH}`,
    } as Config;

    const result = await tick(config, { planOnly: true });

    assert.equal(result.due, 1);
    assert.equal(result.dispatched, 0);
    assert.deepEqual(await readVoteLog(config), []);
  });

  it("expires a proposal whose deadline passed without a vote", async () => {
    const stale = seed();
    const key = "snapshot:ens.eth:0xaaa";
    stale.entries[key] = {
      ...stale.entries[key]!,
      endsAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await saveSchedule(base, stale);

    const config = { ...base, AGENT_COMMAND: "node --eval 0" } as Config;
    const result = await tick(config);

    assert.equal(result.dispatched, 0);
    assert.equal((await loadSchedule(config)).entries[key]!.status, "expired");
  });
});
