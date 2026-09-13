import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  collectCandidateSpaces,
  discoverVotingSpaces,
  resolveWatchedSpaces,
} from "../src/spaces.js";
import { loadConfig, resetConfig, type Config } from "../src/config.js";

const SAFE = "0x1111111111111111111111111111111111111111";
const KEY = `0x${"a".repeat(64)}`;

function configFrom(env: Record<string, string>): Config {
  resetConfig();
  return loadConfig({
    SAFE_ADDRESS: SAFE,
    SAFE_AGENT_PRIVATE_KEY: KEY,
    ...env,
  } as NodeJS.ProcessEnv);
}

interface HubStub {
  /** Spaces the Safe follows. */
  follows?: string[];
  /** Spaces the Safe has voted in. */
  voted?: string[];
  /** Voting power per space; anything absent reads as zero. */
  power?: Record<string, number>;
  /** Spaces whose voting-power lookup should fail. */
  failing?: string[];
}

let realFetch: typeof globalThis.fetch;
/** Every space a voting-power query was made for, in call order. */
let vpCalls: string[];

/**
 * Answers the handful of hub queries space discovery makes. Routing on the
 * operation name keeps the stub honest: a renamed query fails the test rather
 * than silently returning an empty result.
 */
function stubHub(stub: HubStub): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, string>;
    };

    const reply = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (query.includes("query Follows")) {
      return reply({
        follows: (stub.follows ?? []).map((id) => ({ space: { id, name: id } })),
      });
    }

    if (query.includes("query VotedSpaces")) {
      return reply({ votes: (stub.voted ?? []).map((id) => ({ space: { id } })) });
    }

    if (query.includes("query Spaces")) {
      return reply({
        spaces: (variables["ids"] as unknown as string[]).map((id) => ({
          id,
          name: `${id} DAO`,
        })),
      });
    }

    if (query.includes("query VotingPower")) {
      const space = variables["space"]!;
      vpCalls.push(space);

      if ((stub.failing ?? []).includes(space)) {
        return new Response("upstream exploded", { status: 500 });
      }

      return reply({
        vp: { vp: stub.power?.[space] ?? 0, vp_by_strategy: [], vp_state: "final" },
      });
    }

    throw new Error(`Unexpected hub query in test:\n${query}`);
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  vpCalls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConfig();
});

describe("Snapshot space candidates", () => {
  it("gathers spaces from config, follows and past votes", async () => {
    stubHub({ follows: ["followed.eth"], voted: ["voted.eth"] });

    const config = configFrom({
      WATCH_SNAPSHOT_SPACES: "watched.eth",
      ALLOWED_SNAPSHOT_SPACES: "allowed.eth",
      SNAPSHOT_SPACE_CANDIDATES: "extra.eth",
    });

    const candidates = await collectCandidateSpaces(config, ["asked.eth"]);

    assert.deepEqual(
      [...candidates.keys()].sort(),
      [
        "allowed.eth",
        "asked.eth",
        "extra.eth",
        "followed.eth",
        "staging.daoplomats.eth",
        "voted.eth",
        "watched.eth",
      ]
    );
    assert.deepEqual([...candidates.get("watched.eth")!], ["watch-list"]);
    assert.deepEqual([...candidates.get("followed.eth")!], ["follows"]);
  });

  it("records every reason a space is a candidate", async () => {
    stubHub({ follows: ["both.eth"], voted: ["both.eth"] });

    const config = configFrom({ WATCH_SNAPSHOT_SPACES: "both.eth" });
    const candidates = await collectCandidateSpaces(config);

    assert.deepEqual([...candidates.get("both.eth")!].sort(), [
      "follows",
      "past-vote",
      "watch-list",
    ]);
  });

  it("includes the test space without any configuration", async () => {
    stubHub({});

    const candidates = await collectCandidateSpaces(configFrom({}));

    assert.ok(candidates.has("staging.daoplomats.eth"));
    assert.deepEqual([...candidates.get("staging.daoplomats.eth")!], ["test-space"]);
  });

  it("drops the test space when it is configured empty", async () => {
    stubHub({});

    const candidates = await collectCandidateSpaces(
      configFrom({ SNAPSHOT_TEST_SPACE: "" })
    );

    assert.equal(candidates.size, 0);
  });

  it("lowercases and de-duplicates ids", async () => {
    stubHub({ follows: ["Mixed.eth"] });

    const candidates = await collectCandidateSpaces(
      configFrom({ WATCH_SNAPSHOT_SPACES: "MIXED.eth" })
    );

    assert.ok(candidates.has("mixed.eth"));
    assert.equal([...candidates.keys()].filter((id) => id === "mixed.eth").length, 1);
  });

  it("survives a hub that will not answer", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 403 })) as unknown as typeof globalThis.fetch;

    const candidates = await collectCandidateSpaces(
      configFrom({ WATCH_SNAPSHOT_SPACES: "watched.eth" })
    );

    // The configured space still stands; only the derived ones are lost.
    assert.deepEqual([...candidates.keys()], ["watched.eth", "staging.daoplomats.eth"]);
  });
});

describe("Snapshot voting-power discovery", () => {
  it("keeps only spaces with voting power, strongest first", async () => {
    stubHub({
      follows: ["small.eth", "none.eth", "big.eth"],
      power: { "big.eth": 900, "small.eth": 12 },
    });

    const rows = await discoverVotingSpaces(configFrom({}));

    assert.deepEqual(
      rows.map((row) => [row.space, row.votingPower]),
      [
        ["big.eth", 900],
        ["small.eth", 12],
      ]
    );
    assert.equal(rows[0]!.name, "big.eth DAO");
  });

  it("reports zero-power spaces when asked", async () => {
    stubHub({ follows: ["none.eth"], power: {} });

    const rows = await discoverVotingSpaces(configFrom({}), { includeZero: true });

    assert.deepEqual(rows.map((row) => row.space).sort(), [
      "none.eth",
      "staging.daoplomats.eth",
    ]);
  });

  it("never tests a space the allowlist excludes", async () => {
    stubHub({ follows: ["other.eth"], power: { "other.eth": 5, "allowed.eth": 3 } });

    const rows = await discoverVotingSpaces(
      configFrom({ ALLOWED_SNAPSHOT_SPACES: "allowed.eth" })
    );

    assert.deepEqual(rows.map((row) => row.space), ["allowed.eth"]);
    assert.deepEqual(vpCalls, ["allowed.eth"]);
  });

  it("keeps a space whose lookup failed, so an outage does not read as zero", async () => {
    stubHub({ follows: ["broken.eth"], failing: ["broken.eth"] });

    const rows = await discoverVotingSpaces(configFrom({}));

    assert.deepEqual(rows.map((row) => row.space), ["broken.eth"]);
    assert.equal(rows[0]!.votingPower, 0);
    assert.ok(rows[0]!.error);
  });

  it("surfaces a per-space failure without losing the other spaces", async () => {
    stubHub({
      follows: ["broken.eth", "fine.eth"],
      power: { "fine.eth": 7 },
      failing: ["broken.eth"],
    });

    const rows = await discoverVotingSpaces(configFrom({}), { includeZero: true });
    const broken = rows.find((row) => row.space === "broken.eth")!;

    assert.equal(rows.find((row) => row.space === "fine.eth")!.votingPower, 7);
    assert.equal(broken.votingPower, 0);
    assert.match(broken.error!, /500/);
  });
});

describe("Resolving the watched spaces", () => {
  it("watches configured spaces plus every space with voting power", async () => {
    stubHub({ follows: ["earned.eth"], power: { "earned.eth": 42 } });

    const { spaces, discovered } = await resolveWatchedSpaces(
      configFrom({ WATCH_SNAPSHOT_SPACES: "configured.eth" })
    );

    assert.deepEqual(spaces.sort(), [
      "configured.eth",
      "earned.eth",
      "staging.daoplomats.eth",
    ]);
    assert.deepEqual(discovered.map((row) => row.space), ["earned.eth"]);
  });

  it("keeps a configured space that currently has no voting power", async () => {
    stubHub({ power: {} });

    const { spaces } = await resolveWatchedSpaces(
      configFrom({ WATCH_SNAPSHOT_SPACES: "configured.eth" })
    );

    assert.ok(spaces.includes("configured.eth"));
  });

  it("discovers nothing when auto-watching is turned off", async () => {
    stubHub({ follows: ["earned.eth"], power: { "earned.eth": 42 } });

    const { spaces, discovered } = await resolveWatchedSpaces(
      configFrom({ WATCH_SNAPSHOT_SPACES: "configured.eth", WATCH_SNAPSHOT_AUTO: "false" })
    );

    assert.deepEqual(spaces.sort(), ["configured.eth", "staging.daoplomats.eth"]);
    assert.deepEqual(discovered, []);
    assert.deepEqual(vpCalls, []);
  });

  it("never watches a space the allowlist excludes, however it was configured", async () => {
    stubHub({ follows: ["earned.eth"], power: { "earned.eth": 42, "allowed.eth": 1 } });

    const { spaces } = await resolveWatchedSpaces(
      configFrom({
        WATCH_SNAPSHOT_SPACES: "configured.eth,allowed.eth",
        ALLOWED_SNAPSHOT_SPACES: "allowed.eth",
      })
    );

    assert.deepEqual(spaces, ["allowed.eth"]);
  });
});
