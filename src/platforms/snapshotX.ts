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
  "function vote(address voter, uint256 proposalId, uint8 choice, (uint8 index, bytes params)[] userVotingStrategies, string metadataURI)",
  "function authenticators(address auth) view returns (uint256)",
  "function votingStrategies(uint8 index) view returns (address addr, bytes params)",
  "function voteRegistry(uint256 proposalId, address voter) view returns (uint256)",
  "function votePower(uint256 proposalId, uint8 choice) view returns (uint256)",
  "error InvalidProposal()",
  "error ProposalFinalized()",
  "error AuthenticatorNotWhitelisted()",
  "error UserAlreadyVoted()",
  "error UserHasNoVotingPower()",
  "error VotingPeriodHasNotStarted()",
  "error VotingPeriodHasEnded()",
  "error InvalidStrategyIndex(uint256 index)",
]);

/**
 * sx-evm EthTxAuthenticator. It forwards a call to the space after checking
 * the voter in the calldata is msg.sender, which is exactly what a Safe needs:
 * the Safe executes authenticate(...) and so votes as itself, with no
 * off-chain signature for an EIP-1271 wallet to struggle with.
 */
export const ETH_TX_AUTHENTICATOR_ABI = parseAbi([
  "function authenticate(address target, bytes4 functionSelector, bytes data)",
  "error InvalidMessageSender()",
  "error InvalidFunctionSelector()",
]);

/** IVotingStrategy.getVotingPower, shared by every sx-evm voting strategy. */
export const VOTING_STRATEGY_ABI = parseAbi([
  "function getVotingPower(uint32 blockNumber, address voter, bytes params, bytes userParams) view returns (uint256)",
]);

/**
 * The EthTx authenticator snapshot.box deploys on every standard EVM network
 * (sx-monorepo packages/sx.js/src/evmNetworks.ts). A space only accepts it if
 * its controller whitelisted it, which the vote tool checks before sending.
 */
export const DEFAULT_ETH_TX_AUTHENTICATOR = getAddress(
  "0xBA06E6cCb877C332181A6867c05c8b746A21Aed1"
);

/** sx-evm Choice enum. The on-chain values are not the Governor's order. */
export const CHOICE_VALUE = { against: 0, for: 1, abstain: 2 } as const;
export type SxChoice = keyof typeof CHOICE_VALUE;

/**
 * Per-voter strategy params. Vanilla, Comp and OZVotes ignore them, and sx.js
 * sends a single zero byte; merkle-whitelist and ApeGas need a proof that has
 * to be passed in explicitly.
 */
export const DEFAULT_USER_PARAMS = "0x00" as const;

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
        "Off-chain Snapshot spaces (ENS ids like \"ens.eth\") are not Snapshot X: " +
        "vote there with snapshot_vote; their proposals are managed on hub.snapshot.org."
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
  /** Block at which voting opens; also the voting-power snapshot block. */
  startBlockNumber: number | null;
  minEndBlockNumber: number | null;
  maxEndBlockNumber: number | null;
  /** Bitmask of the space's voting strategies active for this proposal. */
  activeVotingStrategies: bigint | null;
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
    startBlockNumber: proposal ? proposal[1] : null,
    minEndBlockNumber: proposal ? proposal[3] : null,
    maxEndBlockNumber: proposal ? proposal[4] : null,
    activeVotingStrategies: proposal ? proposal[7] : null,
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
  return describeSpaceRevert(error);
}

/** Turns a Space / authenticator revert into a sentence an operator can act on. */
export function describeSpaceRevert(error: unknown): string {
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
      if (name === "UserAlreadyVoted") {
        return "The space contract reports UserAlreadyVoted(): the Safe has already voted on this proposal, and Snapshot X votes are final.";
      }
      if (name === "UserHasNoVotingPower") {
        return (
          "The space contract reports UserHasNoVotingPower(): the Safe had no voting power " +
          "at the proposal's snapshot block under the strategies submitted."
        );
      }
      if (name === "VotingPeriodHasNotStarted") {
        return "The space contract reports VotingPeriodHasNotStarted(): the proposal is still in its voting delay.";
      }
      if (name === "VotingPeriodHasEnded") {
        return "The space contract reports VotingPeriodHasEnded(): voting on this proposal is closed.";
      }
      if (name === "AuthenticatorNotWhitelisted") {
        return (
          "The space contract reports AuthenticatorNotWhitelisted(): this space does not accept " +
          "votes through that authenticator. Pass the space's EthTx authenticator explicitly."
        );
      }
      if (name === "InvalidStrategyIndex") {
        return (
          `The space contract reports InvalidStrategyIndex(${String(revert.data?.args?.[0] ?? "?")}): ` +
          "that voting strategy is not active for this proposal."
        );
      }
      if (name === "InvalidMessageSender") {
        return "The authenticator reports InvalidMessageSender(): the voter in the calldata is not the Safe sending it.";
      }
      if (name) return `The space contract reverted with ${name}.`;
    }

    return `Simulation failed: ${error.shortMessage}`;
  }

  return `Simulation failed: ${error instanceof Error ? error.message : String(error)}`;
}

export interface UserStrategy {
  index: number;
  params: `0x${string}`;
}

/** Calldata for Space.vote(...), selector included. */
export function encodeSpaceVote(args: {
  voter: Address;
  proposalId: string | number | bigint;
  choice: SxChoice;
  strategies: UserStrategy[];
  metadataUri: string;
}): `0x${string}` {
  return encodeFunctionData({
    abi: SPACE_ABI,
    functionName: "vote",
    args: [
      args.voter,
      BigInt(args.proposalId),
      CHOICE_VALUE[args.choice],
      args.strategies.map((s) => ({ index: s.index, params: s.params })),
      args.metadataUri,
    ],
  });
}

type EthTxVoteArgs = {
  space: Address;
  voter: Address;
  proposalId: string | number | bigint;
  choice: SxChoice;
  strategies: UserStrategy[];
  metadataUri: string;
};

/**
 * Arguments for EthTxAuthenticator.authenticate(space, voteSelector, args):
 * the Space.vote call split into its selector and ABI-encoded arguments, the
 * same split sx.js makes.
 */
function authenticateArgs(args: EthTxVoteArgs): readonly [Address, `0x${string}`, `0x${string}`] {
  const voteCall = encodeSpaceVote(args);
  return [
    args.space,
    voteCall.slice(0, 10) as `0x${string}`,
    `0x${voteCall.slice(10)}` as `0x${string}`,
  ];
}

/** Calldata the Safe sends to the EthTx authenticator to vote. */
export function encodeEthTxVote(args: EthTxVoteArgs): `0x${string}` {
  return encodeFunctionData({
    abi: ETH_TX_AUTHENTICATOR_ABI,
    functionName: "authenticate",
    args: authenticateArgs(args),
  });
}

/** Indices of the set bits in a strategy bitmask, lowest first. */
export function activeStrategyIndices(mask: bigint): number[] {
  const indices: number[] = [];
  for (let i = 0; i < 256; i++) {
    if ((mask >> BigInt(i)) & 1n) indices.push(i);
  }
  return indices;
}

export interface StrategyPower {
  index: number;
  address: Address | null;
  userParams: `0x${string}`;
  votingPower: string | null;
  error: string | null;
}

/**
 * Evaluates each strategy active on the proposal for the voter at the
 * proposal's snapshot block, the same call the space makes when counting the
 * vote. Only strategies that return power are worth submitting: one that
 * reverts (a whitelist without its proof, say) would revert the whole vote.
 */
export async function readStrategyPowers(
  config: Config,
  args: {
    space: Address;
    voter: Address;
    startBlockNumber: number;
    activeVotingStrategies: bigint;
    userParams?: Record<number, `0x${string}`>;
  }
): Promise<StrategyPower[]> {
  const client = getPublicClient(config);
  const indices = activeStrategyIndices(args.activeVotingStrategies);

  return Promise.all(
    indices.map(async (index): Promise<StrategyPower> => {
      const userParams = args.userParams?.[index] ?? DEFAULT_USER_PARAMS;
      let address: Address | null = null;

      try {
        const [addr, params] = await client.readContract({
          address: args.space,
          abi: SPACE_ABI,
          functionName: "votingStrategies",
          args: [index],
        });
        address = addr;

        const power = await client.readContract({
          address: addr,
          abi: VOTING_STRATEGY_ABI,
          functionName: "getVotingPower",
          args: [args.startBlockNumber, args.voter, params, userParams],
        });

        return { index, address, userParams, votingPower: String(power), error: null };
      } catch (error) {
        return {
          index,
          address,
          userParams,
          votingPower: null,
          error: error instanceof Error ? error.message.split("\n")[0]! : String(error),
        };
      }
    })
  );
}

export interface SpaceVoteState {
  hasVoted: boolean | null;
  /** Running totals by choice, as raw integers. */
  tally: { for: string; against: string; abstain: string } | null;
  authenticatorWhitelisted: boolean | null;
}

export async function readVoteState(
  config: Config,
  args: { space: Address; proposalId: string; voter: Address; authenticator: Address }
): Promise<SpaceVoteState> {
  const client = getPublicClient(config);
  const id = BigInt(args.proposalId);
  const read = <T>(p: Promise<T>) => p.catch(() => null);

  const [voted, against, forVotes, abstain, auth] = await Promise.all([
    read(
      client.readContract({
        address: args.space,
        abi: SPACE_ABI,
        functionName: "voteRegistry",
        args: [id, args.voter],
      })
    ),
    ...([0, 1, 2] as const).map((choice) =>
      read(
        client.readContract({
          address: args.space,
          abi: SPACE_ABI,
          functionName: "votePower",
          args: [id, choice],
        })
      )
    ),
    read(
      client.readContract({
        address: args.space,
        abi: SPACE_ABI,
        functionName: "authenticators",
        args: [args.authenticator],
      })
    ),
  ]);

  return {
    hasVoted: voted === null ? null : voted !== 0n,
    tally:
      against === null || forVotes === null || abstain === null
        ? null
        : { for: String(forVotes), against: String(against), abstain: String(abstain) },
    authenticatorWhitelisted: auth === null ? null : auth !== 0n,
  };
}

/**
 * Simulates the authenticate(...) call as an eth_call from the Safe: the
 * authenticator, the space and every strategy all run exactly as they will
 * on-chain, so a vote that would revert is caught before anyone signs. The
 * space's errors bubble up through the authenticator unchanged, so both ABIs
 * are given to decode them by name.
 */
export async function simulateEthTxVote(
  config: Config,
  args: EthTxVoteArgs & { authenticator: Address }
): Promise<{ ok: boolean; reason: string | null }> {
  const client = getPublicClient(config);

  try {
    await client.simulateContract({
      address: args.authenticator,
      abi: [...ETH_TX_AUTHENTICATOR_ABI, ...SPACE_ABI],
      functionName: "authenticate",
      args: authenticateArgs(args),
      account: args.voter,
    });
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: describeSpaceRevert(error) };
  }
}

/**
 * Pins the vote reason to IPFS through pineapple.fyi, Snapshot's own pinning
 * service, which is how snapshot.box attaches a reason to a Snapshot X vote.
 * Returns null on failure: a reason that cannot be published should not stop
 * the vote, and the caller says it went without one.
 */
export async function pinReason(
  reason: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response = await fetchImpl("https://pineapple.fyi", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "pin",
        params: { reason },
        protocol: "ipfs",
        id: null,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { result?: { cid?: string } };
    const cid = body.result?.cid;
    return typeof cid === "string" && cid.length > 0 ? `ipfs://${cid}` : null;
  } catch {
    return null;
  }
}
