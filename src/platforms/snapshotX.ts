import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
} from "viem";
import { getPublicClient } from "../safe.js";
import type { Config } from "../config.js";

/**
 * Snapshot X (snapshot.box) is Snapshot's fully on-chain voting protocol. Each
 * space is a contract (snapshot-labs/sx-evm `Space.sol`), not an off-chain ENS
 * id, and proposals are numbered from 1 by that contract. Administrative
 * actions such as cancelling a proposal are plain contract calls gated by
 * `onlyOwner`, where the owner ("controller") is typically the DAO's Safe.
 */
export const SPACE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function nextProposalId() view returns (uint256)",
  "function cancel(uint256 proposalId)",
  // The auto-generated getter for `mapping(uint256 => Proposal) proposals`.
  // Field order matches sx-evm src/types.sol exactly; finalizationStatus is
  // the FinalizationStatus enum (0 Pending, 1 Executed, 2 Cancelled).
  "function proposals(uint256 proposalId) view returns (address author, uint32 startBlockNumber, address executionStrategy, uint32 minEndBlockNumber, uint32 maxEndBlockNumber, uint8 finalizationStatus, bytes32 executionPayloadHash, uint256 activeVotingStrategies)",
  "function getProposalStatus(uint256 proposalId) view returns (uint8)",
  "error InvalidProposal()",
  "error ProposalFinalized()",
]);

/** sx-evm FinalizationStatus, stored in the proposal struct. */
export const FINALIZATION_STATUS = ["Pending", "Executed", "Cancelled"] as const;

/** sx-evm ProposalStatus, computed live by the execution strategy. */
export const PROPOSAL_STATUS = [
  "VotingDelay",
  "VotingPeriod",
  "VotingPeriodAccepted",
  "Accepted",
  "Executed",
  "Rejected",
  "Cancelled",
] as const;

/**
 * EIP-3770 short names, as used both in snapshot.box space ids
 * ("eth:0x594E...") and in app.safe.global URLs.
 */
const CHAIN_ID_BY_SHORT_NAME: Record<string, number> = {
  eth: 1,
  oeth: 10,
  matic: 137,
  mnt: 5000,
  base: 8453,
  arb1: 42161,
  ape: 33139,
  sep: 11155111,
};

const SHORT_NAME_BY_CHAIN_ID = new Map(
  Object.entries(CHAIN_ID_BY_SHORT_NAME).map(([name, id]) => [id, name])
);

export function chainShortName(chainId: number): string | undefined {
  return SHORT_NAME_BY_CHAIN_ID.get(chainId);
}

export interface SpaceRef {
  /** Checksummed space contract address. */
  space: Address;
  /** Chain id, when the reference carried a network prefix. */
  chainId?: number;
  /** Proposal number, when the reference was a full proposal URL. */
  proposalId?: string;
}

/**
 * Accepts every way people paste a Snapshot X space around: a bare contract
 * address, a prefixed space id ("eth:0x594E..."), or a full snapshot.box
 * proposal URL — in which case the proposal number comes along for free.
 */
export function parseSpaceRef(input: string): SpaceRef {
  let ref = input.trim();

  // Full URL: https://snapshot.box/#/eth:0x594E.../proposal/3
  const hashIndex = ref.indexOf("#/");
  if (hashIndex !== -1) ref = ref.slice(hashIndex + 2);
  ref = ref.replace(/^\/+/, "");

  let proposalId: string | undefined;
  const proposalMatch = ref.match(/^([^/]+)\/proposal\/(\d+)/);
  if (proposalMatch) {
    ref = proposalMatch[1]!;
    proposalId = proposalMatch[2]!;
  }

  let chainId: number | undefined;
  const prefixMatch = ref.match(/^([a-zA-Z0-9-]+):(0x[a-fA-F0-9]{40})$/);
  if (prefixMatch) {
    const prefix = prefixMatch[1]!.toLowerCase();
    ref = prefixMatch[2]!;
    chainId = CHAIN_ID_BY_SHORT_NAME[prefix];
    if (chainId === undefined) {
      throw new Error(
        `Unknown network prefix "${prefix}" in Snapshot X space "${input.trim()}". ` +
          `Known prefixes: ${Object.keys(CHAIN_ID_BY_SHORT_NAME).join(", ")}. ` +
          "Pass the bare space contract address if the network matches the Safe's chain."
      );
    }
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(ref)) {
    throw new Error(
      `"${input.trim()}" is not a Snapshot X space. Expected a space contract ` +
        'address, a prefixed id like "eth:0x594E…", or a snapshot.box proposal URL. ' +
        "Off-chain Snapshot spaces (ENS ids like \"ens.eth\") have no cancel " +
        "transaction; those proposals are managed on hub.snapshot.org."
    );
  }

  return {
    space: getAddress(ref),
    ...(chainId !== undefined ? { chainId } : {}),
    ...(proposalId !== undefined ? { proposalId } : {}),
  };
}

/** Calldata for Space.cancel(proposalId). Selector 0x40e58ee5. */
export function encodeCancel(proposalId: string | number | bigint): `0x${string}` {
  return encodeFunctionData({
    abi: SPACE_ABI,
    functionName: "cancel",
    args: [BigInt(proposalId)],
  });
}

export interface SpaceProposalState {
  owner: Address | null;
  nextProposalId: string | null;
  exists: boolean | null;
  author: Address | null;
  /** "Pending" | "Executed" | "Cancelled", from the proposal struct. */
  finalizationStatus: string | null;
  /** Live status from the execution strategy, e.g. "VotingPeriod". */
  status: string | null;
  /** Reads that failed, with the reason, so a partial view is still honest. */
  readErrors: string[];
}

/**
 * Reads a Snapshot X proposal straight from the space contract. Every read is
 * independent and a failure is reported rather than thrown: a space on an
 * unexpected sx-evm fork should degrade to "could not read", not block the
 * caller, because the cancel simulation is the authoritative check anyway.
 */
export async function readSpaceProposal(
  config: Config,
  space: Address,
  proposalId: string
): Promise<SpaceProposalState> {
  const client = getPublicClient(config);
  const id = BigInt(proposalId);
  const readErrors: string[] = [];

  const note = (what: string) => (error: unknown) => {
    readErrors.push(
      `${what}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
    );
    return null;
  };

  const [owner, nextId, proposal, status] = await Promise.all([
    client
      .readContract({ address: space, abi: SPACE_ABI, functionName: "owner" })
      .catch(note("owner()")),
    client
      .readContract({ address: space, abi: SPACE_ABI, functionName: "nextProposalId" })
      .catch(note("nextProposalId()")),
    client
      .readContract({
        address: space,
        abi: SPACE_ABI,
        functionName: "proposals",
        args: [id],
      })
      .catch(note("proposals()")),
    client
      .readContract({
        address: space,
        abi: SPACE_ABI,
        functionName: "getProposalStatus",
        args: [id],
      })
      .catch(() => null), // Reverts with InvalidProposal for unknown ids; not a read error.
  ]);

  const author = proposal?.[0] ?? null;
  const finalization = proposal?.[5];

  return {
    owner: owner ?? null,
    nextProposalId: nextId === null ? null : String(nextId),
    // A proposal exists when the struct is populated; an empty struct decodes
    // to the zero author. nextProposalId corroborates when readable.
    exists:
      proposal === null
        ? null
        : author !== null && author !== "0x0000000000000000000000000000000000000000",
    author,
    finalizationStatus:
      finalization === undefined || finalization === null
        ? null
        : FINALIZATION_STATUS[finalization] ?? `unknown (${finalization})`,
    status: status === null ? null : PROPOSAL_STATUS[status] ?? `unknown (${status})`,
    readErrors,
  };
}

/**
 * Simulates cancel(proposalId) as an eth_call from the Safe. This is the same
 * check the chain will make, so it catches everything at once — wrong owner,
 * unknown proposal, already finalized — without trusting our own reads.
 */
export async function simulateCancel(
  config: Config,
  args: { space: Address; proposalId: string; from: Address }
): Promise<{ ok: boolean; reason: string | null }> {
  const client = getPublicClient(config);

  try {
    await client.simulateContract({
      address: args.space,
      abi: SPACE_ABI,
      functionName: "cancel",
      args: [BigInt(args.proposalId)],
      account: args.from,
    });
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: describeCancelRevert(error) };
  }
}

function describeCancelRevert(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);

    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason;

      if (name === "InvalidProposal") {
        return "The space contract reports InvalidProposal(): no proposal with this id exists.";
      }
      if (name === "ProposalFinalized") {
        return (
          "The space contract reports ProposalFinalized(): the proposal was already " +
          "executed or cancelled, so there is nothing left to cancel."
        );
      }
      if (typeof name === "string" && /not the owner/i.test(name)) {
        return (
          "The space contract rejected the call because the sender is not its owner: " +
          "only the space controller can cancel a proposal."
        );
      }
      if (name) return `The space contract reverted with ${name}.`;
    }

    return `Simulation failed: ${error.shortMessage}`;
  }

  return `Simulation failed: ${error instanceof Error ? error.message : String(error)}`;
}
