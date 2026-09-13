import * as snapshot from "./platforms/snapshot.js";
import type { Config } from "./config.js";

/**
 * Why a space ended up on the list. Several can apply at once, and the set is
 * worth reporting: "the Safe follows it" and "the Safe voted there last month"
 * mean quite different things to an operator deciding whether to trust the
 * agent with it.
 */
export type SpaceSource =
  | "requested"
  | "watch-list"
  | "allowlist"
  | "candidate-list"
  | "test-space"
  | "follows"
  | "past-vote";

export interface SpaceVotingPower {
  space: string;
  name: string | null;
  votingPower: number;
  vpState: string | null;
  /** False when ALLOWED_SNAPSHOT_SPACES is set and does not include this space. */
  allowed: boolean;
  sources: SpaceSource[];
  /** Set when the voting-power lookup itself failed, rather than returning zero. */
  error: string | null;
}

/**
 * Voting power is one hub request per space, so the candidate set is capped.
 * Beyond this many spaces the operator wants an explicit list, not discovery.
 */
const MAX_CANDIDATES = 60;

/** Concurrent hub requests. The public hub rate-limits, so this stays modest. */
const CONCURRENCY = 5;

/** Runs `worker` over `items`, at most `limit` at a time, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });

  await Promise.all(runners);

  return results;
}

function addCandidate(
  into: Map<string, Set<SpaceSource>>,
  space: string,
  source: SpaceSource
): void {
  const id = space.trim().toLowerCase();
  if (!id) return;

  const existing = into.get(id);
  if (existing) existing.add(source);
  else into.set(id, new Set([source]));
}

/**
 * Every space worth testing for voting power: what the operator configured,
 * plus what the Safe's own on-chain identity implies — the spaces it follows
 * and the spaces it has voted in before.
 *
 * Discovery failures are swallowed: a hub outage should narrow the candidate
 * set, not break voting in the spaces that were configured by hand.
 */
export async function collectCandidateSpaces(
  config: Config,
  requested: string[] = []
): Promise<Map<string, Set<SpaceSource>>> {
  const candidates = new Map<string, Set<SpaceSource>>();

  for (const space of requested) addCandidate(candidates, space, "requested");
  for (const space of config.WATCH_SNAPSHOT_SPACES) {
    addCandidate(candidates, space, "watch-list");
  }
  for (const space of config.ALLOWED_SNAPSHOT_SPACES) {
    addCandidate(candidates, space, "allowlist");
  }
  for (const space of config.SNAPSHOT_SPACE_CANDIDATES) {
    addCandidate(candidates, space, "candidate-list");
  }
  if (config.SNAPSHOT_TEST_SPACE) {
    addCandidate(candidates, config.SNAPSHOT_TEST_SPACE, "test-space");
  }

  const [followed, voted] = await Promise.all([
    snapshot.listFollowedSpaces(config, config.SAFE_ADDRESS).catch(() => []),
    snapshot.listVotedSpaceIds(config, config.SAFE_ADDRESS).catch(() => []),
  ]);

  for (const space of followed) addCandidate(candidates, space.id, "follows");
  for (const space of voted) addCandidate(candidates, space, "past-vote");

  return candidates;
}

export interface DiscoverOptions {
  /** Extra space ids to test, on top of the configured and derived ones. */
  spaces?: string[];
  /** Keep spaces where the Safe has no voting power. Default false. */
  includeZero?: boolean;
  /** Keep spaces the allowlist excludes. Default false. */
  includeDisallowed?: boolean;
}

/**
 * The spaces this Safe can actually vote in, newest measurement each time.
 *
 * Voting power is read at the current block rather than at any proposal's
 * snapshot, so this answers "is this space worth watching" and not "will this
 * particular vote count" — the second question is asked again, per proposal,
 * before anything is signed.
 */
export async function discoverVotingSpaces(
  config: Config,
  options: DiscoverOptions = {}
): Promise<SpaceVotingPower[]> {
  const candidates = await collectCandidateSpaces(config, options.spaces ?? []);
  const ids = [...candidates.keys()].slice(0, MAX_CANDIDATES);

  const allowlist = config.ALLOWED_SNAPSHOT_SPACES;
  const isAllowed = (id: string) =>
    allowlist.length === 0 || allowlist.includes(id);

  const tested = ids.filter((id) => options.includeDisallowed || isAllowed(id));

  const [names, powers] = await Promise.all([
    snapshot
      .listSpacesByIds(config, tested)
      .then((spaces) => new Map(spaces.map((s) => [s.id.toLowerCase(), s.name])))
      .catch(() => new Map<string, string | null>()),
    mapWithConcurrency(tested, CONCURRENCY, async (space) => {
      try {
        const power = await snapshot.getVotingPower(config, {
          space,
          voter: config.SAFE_ADDRESS,
        });
        return { vp: power.vp, vpState: power.vpState, error: null as string | null };
      } catch (error) {
        return {
          vp: 0,
          vpState: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  ]);

  const rows: SpaceVotingPower[] = tested.map((space, index) => ({
    space,
    name: names.get(space) ?? null,
    votingPower: powers[index]!.vp,
    vpState: powers[index]!.vpState,
    allowed: isAllowed(space),
    sources: [...(candidates.get(space) ?? [])],
    error: powers[index]!.error,
  }));

  return (
    rows
      // A space whose lookup failed is kept whatever the filter: a hub outage
      // reads as zero voting power otherwise, and "the Safe cannot vote here"
      // is a very different answer from "nobody could tell you".
      .filter((row) => options.includeZero || row.votingPower > 0 || row.error !== null)
      .sort((a, b) => b.votingPower - a.votingPower || a.space.localeCompare(b.space))
  );
}

/**
 * The Snapshot spaces the watcher should poll: the explicit list, the test
 * space, and — unless WATCH_SNAPSHOT_AUTO is off — every space the Safe holds
 * voting power in.
 *
 * The explicit entries are kept even at zero voting power. An operator who
 * named a space meant it, and a space can gain the Safe voting power between
 * one proposal and the next.
 */
export async function resolveWatchedSpaces(
  config: Config
): Promise<{ spaces: string[]; discovered: SpaceVotingPower[] }> {
  const explicit = [...config.WATCH_SNAPSHOT_SPACES];
  if (config.SNAPSHOT_TEST_SPACE) explicit.push(config.SNAPSHOT_TEST_SPACE);

  const allowlist = config.ALLOWED_SNAPSHOT_SPACES;
  const allowed = (id: string) => allowlist.length === 0 || allowlist.includes(id);

  const discovered = config.WATCH_SNAPSHOT_AUTO
    ? await discoverVotingSpaces(config)
    : [];

  const spaces = [
    ...new Set([
      ...explicit.map((id) => id.toLowerCase()).filter(allowed),
      ...discovered.map((row) => row.space),
    ]),
  ];

  return { spaces, discovered };
}
