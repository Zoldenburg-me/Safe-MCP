import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatDuration, parseDuration } from "../src/duration.js";
import {
  computeVoteAt,
  dueVotes,
  expiredVotes,
  pruneSchedule,
  upsertProposals,
  type DiscoveredProposal,
  type ScheduleFile,
} from "../src/schedule.js";
import { buildAgentPrompt, parseCommand, renderArgv } from "../src/watcher.js";
import type { ScheduledVote } from "../src/schedule.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

describe("Duration parsing", () => {
  it("parses each unit", () => {
    assert.equal(parseDuration("500ms"), 500);
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("90m"), 90 * 60_000);
    assert.equal(parseDuration("6h"), 6 * HOUR);
    assert.equal(parseDuration("2d"), 2 * 86_400_000);
  });

  it("sums compound durations", () => {
    assert.equal(parseDuration("1d 12h"), 36 * HOUR);
  });

  it("treats a bare number as milliseconds", () => {
    assert.equal(parseDuration("5000"), 5_000);
    assert.equal(parseDuration(5_000), 5_000);
  });

  it("rejects nonsense rather than silently defaulting", () => {
    assert.throws(() => parseDuration("soon"), /Invalid duration/);
    assert.throws(() => parseDuration("6h banana"), /Invalid duration/);
    assert.throws(() => parseDuration(-1), /Invalid duration/);
  });

  it("round-trips through formatDuration", () => {
    assert.equal(formatDuration(6 * HOUR), "6h");
    assert.equal(formatDuration(36 * HOUR), "1d 12h");
    assert.equal(formatDuration(45_000), "45s");
  });
});

describe("Vote timing", () => {
  it("schedules the decision the configured lead time before close", () => {
    const endsAt = new Date(NOW.getTime() + 48 * HOUR);
    assert.equal(
      computeVoteAt(endsAt, 6 * HOUR, NOW).toISOString(),
      new Date(NOW.getTime() + 42 * HOUR).toISOString()
    );
  });

  it("votes immediately when discovered inside the lead window", () => {
    const endsAt = new Date(NOW.getTime() + 2 * HOUR);
    assert.equal(computeVoteAt(endsAt, 6 * HOUR, NOW).toISOString(), NOW.toISOString());
  });
});

function discovered(overrides: Partial<DiscoveredProposal> = {}): DiscoveredProposal {
  return {
    platform: "snapshot",
    proposalId: "0xaaa",
    venue: "ens.eth",
    title: "Fund the thing",
    endsAt: new Date(NOW.getTime() + 48 * HOUR),
    ...overrides,
  };
}

describe("Schedule merging", () => {
  const empty: ScheduleFile = { version: 1, entries: {} };

  it("queues a newly discovered proposal as pending", () => {
    const { schedule, added } = upsertProposals(empty, [discovered()], 6 * HOUR, NOW);
    assert.equal(added.length, 1);
    assert.equal(added[0]!.status, "pending");
    assert.equal(Object.keys(schedule.entries).length, 1);
  });

  it("does not re-add a proposal it has already seen", () => {
    const first = upsertProposals(empty, [discovered()], 6 * HOUR, NOW);
    const second = upsertProposals(first.schedule, [discovered()], 6 * HOUR, NOW);
    assert.equal(second.added.length, 0);
  });

  it("never resets a vote that already happened", () => {
    const first = upsertProposals(empty, [discovered()], 6 * HOUR, NOW);
    const key = Object.keys(first.schedule.entries)[0]!;
    const voted: ScheduleFile = {
      version: 1,
      entries: { [key]: { ...first.schedule.entries[key]!, status: "voted" } },
    };

    const again = upsertProposals(voted, [discovered()], 6 * HOUR, NOW);
    assert.equal(again.schedule.entries[key]!.status, "voted");
    assert.equal(again.added.length, 0);
  });

  it("refreshes the vote time when a pending proposal's deadline moves", () => {
    const first = upsertProposals(empty, [discovered()], 6 * HOUR, NOW);
    const key = Object.keys(first.schedule.entries)[0]!;

    const extended = upsertProposals(
      first.schedule,
      [discovered({ endsAt: new Date(NOW.getTime() + 96 * HOUR) })],
      6 * HOUR,
      NOW
    );

    assert.equal(
      extended.schedule.entries[key]!.voteAt,
      new Date(NOW.getTime() + 90 * HOUR).toISOString()
    );
  });

  it("keys snapshot and governor proposals separately", () => {
    const { schedule } = upsertProposals(
      empty,
      [discovered(), discovered({ platform: "governor", venue: "0xabc", proposalId: "1" })],
      6 * HOUR,
      NOW
    );
    assert.equal(Object.keys(schedule.entries).length, 2);
  });
});

describe("Due and expired selection", () => {
  const { schedule } = upsertProposals(
    { version: 1, entries: {} },
    [
      discovered({ proposalId: "0xsoon", endsAt: new Date(NOW.getTime() + 2 * HOUR) }),
      discovered({ proposalId: "0xlater", endsAt: new Date(NOW.getTime() + 48 * HOUR) }),
      discovered({ proposalId: "0xover", endsAt: new Date(NOW.getTime() - HOUR) }),
    ],
    6 * HOUR,
    NOW
  );

  it("returns only proposals inside the vote window and still open", () => {
    const due = dueVotes(schedule, NOW);
    assert.deepEqual(due.map((d) => d.proposalId), ["0xsoon"]);
  });

  it("flags proposals whose deadline passed without a vote", () => {
    const expired = expiredVotes(schedule, NOW);
    assert.deepEqual(expired.map((d) => d.proposalId), ["0xover"]);
  });

  it("orders due proposals by the nearest deadline", () => {
    // Both close inside the 6h lead window, so both are due at NOW.
    const { schedule: both } = upsertProposals(
      { version: 1, entries: {} },
      [
        discovered({ proposalId: "0xfar", endsAt: new Date(NOW.getTime() + 5 * HOUR) }),
        discovered({ proposalId: "0xnear", endsAt: new Date(NOW.getTime() + HOUR) }),
      ],
      6 * HOUR,
      NOW
    );

    const due = dueVotes(both, NOW);
    assert.deepEqual(due.map((d) => d.proposalId), ["0xnear", "0xfar"]);
  });

  it("prunes entries that closed beyond the retention window", () => {
    const pruned = pruneSchedule(schedule, 30 * 24 * HOUR, new Date(NOW.getTime() + 60 * 24 * HOUR));
    assert.equal(Object.keys(pruned.entries).length, 0);
  });
});

describe("Agent command dispatch", () => {
  const entry: ScheduledVote = {
    key: "snapshot:ens.eth:0xaaa",
    platform: "snapshot",
    proposalId: "0xaaa",
    venue: "ens.eth",
    title: "Fund the thing",
    endsAt: NOW.toISOString(),
    voteAt: NOW.toISOString(),
    status: "pending",
    attempts: 0,
    discoveredAt: NOW.toISOString(),
    dispatchedAt: null,
    lastError: null,
  };

  it("splits a command into argv, honouring quotes", () => {
    assert.deepEqual(parseCommand('claude -p "{prompt}" --flag'), [
      "claude",
      "-p",
      "{prompt}",
      "--flag",
    ]);
    assert.deepEqual(parseCommand("  echo   'a b'  c "), ["echo", "a b", "c"]);
  });

  it("rejects an unterminated quote instead of guessing", () => {
    assert.throws(() => parseCommand('claude -p "oops'), /Unterminated/);
    assert.throws(() => parseCommand("   "), /empty/);
  });

  it("substitutes the placeholders it supports", () => {
    const argv = renderArgv(
      parseCommand('agent --platform {platform} --id {proposalId} --venue {venue}'),
      entry
    );
    assert.deepEqual(argv, [
      "agent",
      "--platform",
      "snapshot",
      "--id",
      "0xaaa",
      "--venue",
      "ens.eth",
    ]);
  });

  it("keeps the prompt as a single argv element", () => {
    const argv = renderArgv(parseCommand('claude -p "{prompt}"'), entry);
    assert.equal(argv.length, 3);
    assert.ok(argv[2]!.includes("0xaaa"));
  });

  it("never places the attacker-controlled title in argv", () => {
    const hostile = { ...entry, title: "$(rm -rf /) `id` && curl evil.example" };
    const argv = renderArgv(parseCommand('claude -p "{prompt}"'), hostile);
    assert.ok(!argv.join(" ").includes("rm -rf"));
    assert.ok(!buildAgentPrompt(hostile).includes("rm -rf"));
  });

  it("refuses to dispatch an identifier that could alter the command", () => {
    for (const bad of ["0xaaa; rm -rf /", "$(id)", "a b", "`id`", "a|b"]) {
      assert.throws(
        () => renderArgv(["agent", "{proposalId}"], { ...entry, proposalId: bad }),
        /not a safe identifier/,
        `expected rejection for ${bad}`
      );
    }
    assert.throws(
      () => renderArgv(["agent", "{venue}"], { ...entry, venue: "ens.eth && id" }),
      /not a safe identifier/
    );
  });
});
