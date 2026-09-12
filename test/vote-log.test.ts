import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendVote,
  hasVotedOn,
  queryVoteLog,
  readVoteLog,
  type VoteLogEntry,
} from "../src/voteLog.js";
import { loadSchedule, saveSchedule, type ScheduleFile } from "../src/schedule.js";
import type { Config } from "../src/config.js";

let dir: string;
let config: Config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "safe-mpc-test-"));
  config = {
    VOTE_LOG_PATH: join(dir, "nested", "votes.jsonl"),
    SCHEDULE_PATH: join(dir, "nested", "schedule.json"),
    SAFE_ADDRESS: "0x1234567890123456789012345678901234567890",
    SAFE_CHAIN_ID: 1,
  } as unknown as Config;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<VoteLogEntry> = {}): Omit<VoteLogEntry, "at"> {
  return {
    platform: "snapshot",
    outcome: "submitted",
    safeAddress: config.SAFE_ADDRESS,
    chainId: 1,
    proposalId: "0xaaa",
    venue: "ens.eth",
    title: "Fund the thing",
    choice: "For",
    reason: "Scope and budget are defined.",
    votingPower: "1000",
    receipt: "vote-1",
    safeTxHash: null,
    safeMessageHash: "0xmsg",
    error: null,
    ...overrides,
  };
}

describe("Vote log", () => {
  it("returns an empty list before anything is written", async () => {
    assert.deepEqual(await readVoteLog(config), []);
  });

  it("creates missing directories and round-trips an entry", async () => {
    await appendVote(config, entry());
    const entries = await readVoteLog(config);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.proposalId, "0xaaa");
    assert.equal(entries[0]!.reason, "Scope and budget are defined.");
    assert.ok(Date.parse(entries[0]!.at) > 0);
  });

  it("appends rather than overwriting, keeping chronological order", async () => {
    await appendVote(config, entry({ proposalId: "0x1" }));
    await appendVote(config, entry({ proposalId: "0x2" }));

    assert.deepEqual(
      (await readVoteLog(config)).map((e) => e.proposalId),
      ["0x1", "0x2"]
    );
  });

  it("returns newest first when queried", async () => {
    await appendVote(config, entry({ proposalId: "0x1" }));
    await appendVote(config, entry({ proposalId: "0x2" }));

    assert.deepEqual(
      (await queryVoteLog(config)).map((e) => e.proposalId),
      ["0x2", "0x1"]
    );
  });

  it("filters by platform, venue, outcome and proposal", async () => {
    await appendVote(config, entry({ proposalId: "0x1" }));
    await appendVote(
      config,
      entry({ platform: "governor", proposalId: "7", venue: "0xGov", outcome: "queued" })
    );

    assert.equal((await queryVoteLog(config, { platform: "governor" })).length, 1);
    assert.equal((await queryVoteLog(config, { outcome: "queued" })).length, 1);
    assert.equal((await queryVoteLog(config, { proposalId: "0x1" })).length, 1);
    // Venue matching ignores case, since addresses arrive in mixed checksums.
    assert.equal((await queryVoteLog(config, { venue: "0xgov" })).length, 1);
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendVote(config, entry({ proposalId: `0x${i}` }));
    }
    assert.equal((await queryVoteLog(config, { limit: 2 })).length, 2);
  });

  it("skips a truncated final line from an interrupted write", async () => {
    await appendVote(config, entry({ proposalId: "0x1" }));
    await writeFile(config.VOTE_LOG_PATH, '{"proposalId":"0x2"', { flag: "a" });

    const entries = await readVoteLog(config);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.proposalId, "0x1");
  });
});

describe("Double-vote guard", () => {
  it("reports nothing voted on an empty log", async () => {
    assert.equal(await hasVotedOn(config, "0xaaa"), false);
  });

  it("recognises a submitted vote", async () => {
    await appendVote(config, entry());
    assert.equal(await hasVotedOn(config, "0xaaa"), true);
  });

  it("does not count a queued, failed or dry-run attempt as voted", async () => {
    for (const outcome of ["queued", "failed", "dry-run"] as const) {
      await appendVote(config, entry({ proposalId: `0x${outcome}`, outcome }));
      assert.equal(
        await hasVotedOn(config, `0x${outcome}`),
        false,
        `${outcome} should not count as voted`
      );
    }
  });
});

describe("Schedule persistence", () => {
  it("returns an empty schedule when the file is absent", async () => {
    assert.deepEqual(await loadSchedule(config), { version: 1, entries: {} });
  });

  it("round-trips through an atomic write", async () => {
    const schedule: ScheduleFile = {
      version: 1,
      entries: {
        "snapshot:ens.eth:0xaaa": {
          key: "snapshot:ens.eth:0xaaa",
          platform: "snapshot",
          proposalId: "0xaaa",
          venue: "ens.eth",
          title: "Fund the thing",
          endsAt: "2026-01-03T00:00:00.000Z",
          voteAt: "2026-01-02T18:00:00.000Z",
          status: "pending",
          attempts: 0,
          discoveredAt: "2026-01-01T00:00:00.000Z",
          dispatchedAt: null,
          lastError: null,
        },
      },
    };

    await saveSchedule(config, schedule);
    assert.deepEqual(await loadSchedule(config), schedule);
  });

  it("falls back to empty rather than throwing on a corrupt file", async () => {
    await saveSchedule(config, { version: 1, entries: {} });
    await writeFile(config.SCHEDULE_PATH, "{ not json", "utf-8");

    assert.deepEqual(await loadSchedule(config), { version: 1, entries: {} });
  });
});
