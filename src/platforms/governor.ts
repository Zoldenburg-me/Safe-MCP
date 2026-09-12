import { encodeFunctionData, formatUnits, type Address } from "viem";
import { getPublicClient } from "../safe.js";
import type { Config } from "../config.js";

/**
 * The slice of the OpenZeppelin Governor interface we need. Compound Bravo and
 * most Governor forks expose the same selectors.
 */
export const GOVERNOR_ABI = [
  {
    type: "function",
    name: "castVoteWithReason",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "uint8" },
      { name: "reason", type: "string" },
    ],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "castVote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "uint8" },
    ],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "state",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "hasVoted",
    stateMutability: "view",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "proposalSnapshot",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "proposalDeadline",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "proposalVotes",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      { name: "againstVotes", type: "uint256" },
      { name: "forVotes", type: "uint256" },
      { name: "abstainVotes", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getVotes",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "timepoint", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "quorum",
    stateMutability: "view",
    inputs: [{ name: "timepoint", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Governor's ProposalState enum, in order. */
export const PROPOSAL_STATES = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
] as const;

/** GovernorCountingSimple support values. */
export const SUPPORT = { against: 0, for: 1, abstain: 2 } as const;

export type SupportLabel = keyof typeof SUPPORT;

export function supportToUint8(support: SupportLabel): number {
  return SUPPORT[support];
}

/** Encodes the calldata the Safe will execute against the Governor. */
export function encodeCastVote(args: {
  proposalId: string;
  support: SupportLabel;
  reason: string;
}): `0x${string}` {
  const proposalId = BigInt(args.proposalId);
  const support = supportToUint8(args.support);

  return args.reason
    ? encodeFunctionData({
        abi: GOVERNOR_ABI,
        functionName: "castVoteWithReason",
        args: [proposalId, support, args.reason],
      })
    : encodeFunctionData({
        abi: GOVERNOR_ABI,
        functionName: "castVote",
        args: [proposalId, support],
      });
}

export interface GovernorProposalState {
  proposalId: string;
  state: string;
  hasVoted: boolean;
  snapshotTimepoint: string;
  deadlineTimepoint: string;
  votingPower: string;
  votingPowerRaw: string;
  quorum: string | null;
  tally: { for: string; against: string; abstain: string } | null;
}

/**
 * Reads everything an agent needs before voting on-chain: whether the proposal
 * is open, whether the Safe already voted, and how much weight it carries.
 *
 * Optional Governor methods that a fork may not implement degrade to null
 * rather than failing the whole read.
 */
export async function readProposalState(
  config: Config,
  args: { governor: Address; proposalId: string; voter: Address; decimals?: number }
): Promise<GovernorProposalState> {
  const client = getPublicClient(config);
  const proposalId = BigInt(args.proposalId);
  const base = { address: args.governor, abi: GOVERNOR_ABI } as const;

  const [state, hasVoted, snapshotTimepoint, deadline] = await Promise.all([
    client.readContract({ ...base, functionName: "state", args: [proposalId] }),
    client.readContract({ ...base, functionName: "hasVoted", args: [proposalId, args.voter] }),
    client.readContract({ ...base, functionName: "proposalSnapshot", args: [proposalId] }),
    client.readContract({ ...base, functionName: "proposalDeadline", args: [proposalId] }),
  ]);

  const [votingPower, quorum, tally] = await Promise.all([
    client
      .readContract({ ...base, functionName: "getVotes", args: [args.voter, snapshotTimepoint] })
      .catch(() => 0n),
    client
      .readContract({ ...base, functionName: "quorum", args: [snapshotTimepoint] })
      .catch(() => null),
    client
      .readContract({ ...base, functionName: "proposalVotes", args: [proposalId] })
      .catch(() => null),
  ]);

  const decimals = args.decimals ?? 18;
  const format = (value: bigint) => formatUnits(value, decimals);

  return {
    proposalId: args.proposalId,
    state: PROPOSAL_STATES[Number(state)] ?? `Unknown(${state})`,
    hasVoted,
    snapshotTimepoint: snapshotTimepoint.toString(),
    deadlineTimepoint: deadline.toString(),
    votingPower: format(votingPower),
    votingPowerRaw: votingPower.toString(),
    quorum: quorum === null ? null : format(quorum),
    tally: tally
      ? {
          against: format(tally[0]),
          for: format(tally[1]),
          abstain: format(tally[2]),
        }
      : null,
  };
}
