import type { Config } from "../config.js";

/** Snapshot's voting systems, which determine the shape of a `choice`. */
export type SnapshotProposalType =
  | "single-choice"
  | "basic"
  | "approval"
  | "ranked-choice"
  | "weighted"
  | "quadratic";

export interface SnapshotProposal {
  id: string;
  title: string;
  body: string;
  choices: string[];
  type: SnapshotProposalType;
  state: "pending" | "active" | "closed";
  start: number;
  end: number;
  snapshot: string;
  author: string;
  quorum: number;
  scores: number[] | null;
  scores_total: number | null;
  link: string | null;
  space: { id: string; name: string };
}

export interface SnapshotVote {
  id: string;
  voter: string;
  choice: unknown;
  vp: number;
  reason: string | null;
  created: number;
}

/** A Snapshot space, as much of it as space discovery needs. */
export interface SnapshotSpace {
  id: string;
  name: string | null;
  symbol: string | null;
  network: string | null;
  followersCount: number | null;
  proposalsCount: number | null;
}

const SPACE_FIELDS = `
  id
  name
  symbol
  network
  followersCount
  proposalsCount
`;

const PROPOSAL_FIELDS = `
  id
  title
  body
  choices
  type
  state
  start
  end
  snapshot
  author
  quorum
  scores
  scores_total
  link
  space { id name }
`;

/** Minimal GraphQL client for the Snapshot hub. */
async function hubQuery<T>(
  config: Config,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${config.SNAPSHOT_HUB_URL}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `Snapshot hub returned ${response.status} ${response.statusText}: ${await response.text()}`
    );
  }

  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(
      `Snapshot hub query failed: ${body.errors.map((e) => e.message).join("; ")}`
    );
  }

  if (!body.data) throw new Error("Snapshot hub returned no data");

  return body.data;
}

/**
 * Runs an arbitrary caller-written GraphQL query against the Snapshot hub.
 * The hub's GraphQL endpoint is read-only — every write on Snapshot goes
 * through the sequencer with a signature — so exposing it whole adds reach,
 * not risk.
 */
export function rawQuery(
  config: Config,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<unknown> {
  return hubQuery<unknown>(config, query, variables);
}

export async function listProposals(
  config: Config,
  args: { space: string; state?: "active" | "pending" | "closed" | "all"; limit: number }
): Promise<SnapshotProposal[]> {
  const query = `
    query Proposals($space: String!, $state: String!, $limit: Int!) {
      proposals(
        first: $limit
        skip: 0
        where: { space: $space, state: $state }
        orderBy: "created"
        orderDirection: desc
      ) { ${PROPOSAL_FIELDS} }
    }
  `;

  const data = await hubQuery<{ proposals: SnapshotProposal[] }>(config, query, {
    space: args.space,
    state: args.state ?? "active",
    limit: args.limit,
  });

  return data.proposals ?? [];
}

export async function getProposal(
  config: Config,
  proposalId: string
): Promise<SnapshotProposal> {
  const query = `
    query Proposal($id: String!) {
      proposal(id: $id) { ${PROPOSAL_FIELDS} }
    }
  `;

  const data = await hubQuery<{ proposal: SnapshotProposal | null }>(config, query, {
    id: proposalId,
  });

  if (!data.proposal) {
    throw new Error(`Snapshot proposal ${proposalId} not found`);
  }

  return data.proposal;
}

/**
 * Voting power a voter holds in a space. With a proposal id this is the power
 * at that proposal's snapshot block, which is what the hub checks when the vote
 * lands; without one it is the power right now, which is what tells you whether
 * the space is worth watching at all.
 */
export async function getVotingPower(
  config: Config,
  args: { space: string; proposalId?: string; voter: string }
): Promise<{ vp: number; vpByStrategy: number[]; vpState: string | null }> {
  // `proposal` is optional on the hub, but a declared variable must be passed,
  // so the query is built to match the arguments actually being sent.
  const scoped = args.proposalId !== undefined;

  const query = `
    query VotingPower($voter: String!, $space: String!${scoped ? ", $proposal: String!" : ""}) {
      vp(voter: $voter, space: $space${scoped ? ", proposal: $proposal" : ""}) {
        vp
        vp_by_strategy
        vp_state
      }
    }
  `;

  const data = await hubQuery<{
    vp: { vp: number; vp_by_strategy: number[]; vp_state: string | null } | null;
  }>(config, query, {
    voter: args.voter,
    space: args.space,
    ...(scoped ? { proposal: args.proposalId } : {}),
  });

  return {
    vp: data.vp?.vp ?? 0,
    vpByStrategy: data.vp?.vp_by_strategy ?? [],
    vpState: data.vp?.vp_state ?? null,
  };
}

/** Reads one space, or null when the id does not exist. */
export async function getSpace(
  config: Config,
  id: string
): Promise<SnapshotSpace | null> {
  const query = `
    query Space($id: String!) {
      space(id: $id) { ${SPACE_FIELDS} }
    }
  `;

  const data = await hubQuery<{ space: SnapshotSpace | null }>(config, query, { id });

  return data.space ?? null;
}

/** Reads several spaces at once. Unknown ids are simply absent from the result. */
export async function listSpacesByIds(
  config: Config,
  ids: string[]
): Promise<SnapshotSpace[]> {
  if (ids.length === 0) return [];

  const query = `
    query Spaces($ids: [String]!, $limit: Int!) {
      spaces(first: $limit, where: { id_in: $ids }) { ${SPACE_FIELDS} }
    }
  `;

  const data = await hubQuery<{ spaces: SnapshotSpace[] }>(config, query, {
    ids,
    limit: ids.length,
  });

  return data.spaces ?? [];
}

/**
 * Spaces an address follows. Following a space is the closest thing Snapshot
 * has to membership, so it is the first place to look for spaces this Safe
 * cares about.
 */
export async function listFollowedSpaces(
  config: Config,
  follower: string,
  limit = 100
): Promise<SnapshotSpace[]> {
  const query = `
    query Follows($follower: String!, $limit: Int!) {
      follows(first: $limit, where: { follower: $follower }) {
        space { ${SPACE_FIELDS} }
      }
    }
  `;

  const data = await hubQuery<{ follows: Array<{ space: SnapshotSpace | null }> }>(
    config,
    query,
    { follower, limit }
  );

  return (data.follows ?? [])
    .map((follow) => follow.space)
    .filter((space): space is SnapshotSpace => Boolean(space?.id));
}

/** Spaces an address has voted in before, newest first, de-duplicated. */
export async function listVotedSpaceIds(
  config: Config,
  voter: string,
  limit = 100
): Promise<string[]> {
  const query = `
    query VotedSpaces($voter: String!, $limit: Int!) {
      votes(
        first: $limit
        where: { voter: $voter }
        orderBy: "created"
        orderDirection: desc
      ) {
        space { id }
      }
    }
  `;

  const data = await hubQuery<{ votes: Array<{ space: { id: string } | null }> }>(
    config,
    query,
    { voter, limit }
  );

  const ids = (data.votes ?? [])
    .map((vote) => vote.space?.id)
    .filter((id): id is string => Boolean(id));

  return [...new Set(ids)];
}

/** Votes already cast on a proposal by a given voter (empty when it has not voted). */
export async function getVotes(
  config: Config,
  args: { proposalId: string; voter: string }
): Promise<SnapshotVote[]> {
  const query = `
    query Votes($proposal: String!, $voter: String!) {
      votes(first: 5, where: { proposal: $proposal, voter: $voter }) {
        id
        voter
        choice
        vp
        reason
        created
      }
    }
  `;

  const data = await hubQuery<{ votes: SnapshotVote[] }>(config, query, {
    proposal: args.proposalId,
    voter: args.voter,
  });

  return data.votes ?? [];
}

/**
 * The three EIP-712 `Vote` shapes Snapshot accepts. These must match
 * @snapshot-labs/snapshot.js byte for byte, because the hub recomputes the
 * typed-data hash from the payload we send and checks it against the Safe's
 * EIP-1271 signature.
 */
type VoteField = { name: string; type: string };
type VoteTypes = { Vote: VoteField[] };

const VOTE_FIELDS: VoteField[] = [
  { name: "from", type: "string" },
  { name: "space", type: "string" },
  { name: "timestamp", type: "uint64" },
  { name: "proposal", type: "string" },
  { name: "choice", type: "uint32" },
  { name: "reason", type: "string" },
  { name: "app", type: "string" },
  { name: "metadata", type: "string" },
];

/** Swaps the `choice` field's solidity type, keeping field order intact. */
function voteTypesWithChoice(choiceType: string): VoteTypes {
  return {
    Vote: VOTE_FIELDS.map((field) =>
      field.name === "choice" ? { name: "choice", type: choiceType } : { ...field }
    ),
  };
}

const VOTE_TYPES = voteTypesWithChoice("uint32");
const VOTE_ARRAY_TYPES = voteTypesWithChoice("uint32[]");
const VOTE_STRING_TYPES = voteTypesWithChoice("string");

export const SNAPSHOT_DOMAIN = { name: "snapshot", version: "0.1.4" };

/** The EIP-712 payload Snapshot signs and the hub re-derives on verification. */
export type SnapshotVoteTypedData = {
  domain: { name: string; version: string };
  types: VoteTypes;
  primaryType: "Vote";
  message: {
    from: string;
    space: string;
    timestamp: number;
    proposal: string;
    choice: number | number[] | string;
    reason: string;
    app: string;
    metadata: string;
  };
};

export type ChoiceInput = number | number[] | Record<string, number>;

/**
 * Normalises an agent-supplied choice into the on-the-wire form Snapshot
 * expects for the proposal's voting system, and picks the matching type set.
 *
 * Choices are 1-indexed throughout, matching the Snapshot UI.
 */
export function encodeChoice(
  type: SnapshotProposalType,
  choices: string[],
  choice: ChoiceInput
): { choice: number | number[] | string; types: VoteTypes } {
  const inRange = (n: number) =>
    Number.isInteger(n) && n >= 1 && n <= choices.length;

  if (type === "single-choice" || type === "basic") {
    if (typeof choice !== "number" || !inRange(choice)) {
      throw new Error(
        `A "${type}" proposal needs a single integer choice between 1 and ${choices.length}. ` +
          `Options: ${choices.map((c, i) => `${i + 1}=${c}`).join(", ")}`
      );
    }
    return { choice, types: VOTE_TYPES };
  }

  if (type === "approval" || type === "ranked-choice") {
    if (!Array.isArray(choice) || choice.length === 0 || !choice.every(inRange)) {
      throw new Error(
        `A "${type}" proposal needs an array of integer choices between 1 and ${choices.length}. ` +
          (type === "ranked-choice"
            ? "List every option exactly once, best first. "
            : "List each option you approve of. ") +
          `Options: ${choices.map((c, i) => `${i + 1}=${c}`).join(", ")}`
      );
    }
    if (new Set(choice).size !== choice.length) {
      throw new Error(`A "${type}" proposal cannot list the same option twice.`);
    }
    if (type === "ranked-choice" && choice.length !== choices.length) {
      throw new Error(
        `A "ranked-choice" proposal needs all ${choices.length} options ranked, got ${choice.length}.`
      );
    }
    return { choice, types: VOTE_ARRAY_TYPES };
  }

  // weighted and quadratic: a map of 1-indexed option -> relative weight,
  // sent as a JSON string.
  if (
    typeof choice !== "object" ||
    choice === null ||
    Array.isArray(choice) ||
    Object.keys(choice).length === 0
  ) {
    throw new Error(
      `A "${type}" proposal needs an object mapping option numbers to weights, ` +
        `for example {"1": 70, "2": 30}. ` +
        `Options: ${choices.map((c, i) => `${i + 1}=${c}`).join(", ")}`
    );
  }

  for (const [key, weight] of Object.entries(choice)) {
    if (!inRange(Number(key))) {
      throw new Error(
        `Option "${key}" is out of range; this proposal has ${choices.length} options.`
      );
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Weight for option "${key}" must be a positive number.`);
    }
  }

  return { choice: JSON.stringify(choice), types: VOTE_STRING_TYPES };
}

/** Builds the EIP-712 payload for a Snapshot vote cast by the Safe. */
export function buildVoteTypedData(args: {
  safeAddress: string;
  space: string;
  proposalId: string;
  proposalType: SnapshotProposalType;
  choices: string[];
  choice: ChoiceInput;
  reason: string;
  app: string;
}): SnapshotVoteTypedData {
  const { choice, types } = encodeChoice(args.proposalType, args.choices, args.choice);

  const message = {
    from: args.safeAddress,
    space: args.space,
    timestamp: Math.floor(Date.now() / 1000),
    proposal: args.proposalId,
    choice,
    reason: args.reason,
    app: args.app,
    metadata: "{}",
  };

  return { domain: SNAPSHOT_DOMAIN, types, primaryType: "Vote", message };
}

/** Submits a signed vote to the Snapshot sequencer. */
export async function submitVote(
  config: Config,
  args: {
    address: string;
    signature: string;
    typedData: SnapshotVoteTypedData;
  }
): Promise<{ id: string; ipfs?: string }> {
  const response = await fetch(config.SNAPSHOT_SEQUENCER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: args.address,
      sig: args.signature,
      data: {
        domain: args.typedData.domain,
        types: args.typedData.types,
        message: args.typedData.message,
      },
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Snapshot sequencer rejected the vote (${response.status}): ${text}`
    );
  }

  try {
    return JSON.parse(text) as { id: string; ipfs?: string };
  } catch {
    throw new Error(`Snapshot sequencer returned an unreadable response: ${text}`);
  }
}

/** Human-readable rendering of a stored Snapshot choice. */
export function describeChoice(proposal: SnapshotProposal, choice: unknown): string {
  const label = (n: number) => proposal.choices[n - 1] ?? `option ${n}`;

  if (typeof choice === "number") return label(choice);
  if (Array.isArray(choice)) return choice.map((n) => label(Number(n))).join(", ");

  if (typeof choice === "object" && choice !== null) {
    return Object.entries(choice as Record<string, number>)
      .map(([k, weight]) => `${label(Number(k))}: ${weight}`)
      .join(", ");
  }

  return String(choice);
}
