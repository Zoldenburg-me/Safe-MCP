import { parseAbiItem, type Address, type PublicClient } from "viem";
import { getPublicClient } from "../safe.js";
import { GOVERNOR_ABI, PROPOSAL_STATES } from "./governor.js";
import { formatDuration, parseDuration } from "../duration.js";
import type { Config } from "../config.js";

/**
 * OpenZeppelin Governor and Compound Bravo emit the same event signature, so
 * one definition indexes both. Parameter names differ between the two
 * (voteStart/voteEnd against startBlock/endBlock) but the types, and therefore
 * the topic hash, are identical.
 */
const PROPOSAL_CREATED = parseAbiItem(
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)"
);

/** ERC-6372: a Governor counts time in block numbers or in seconds. */
export type ClockMode = "blocknumber" | "timestamp";

export interface OnChainProposal {
  proposalId: string;
  governor: Address;
  title: string;
  description: string;
  proposer: Address;
  state: string;
  voteStart: string;
  voteEnd: string;
  /** Wall-clock deadline. Estimated, on a Governor that counts in blocks. */
  endsAt: Date;
  endsAtIsEstimate: boolean;
  createdInBlock: string;
  transactionHash: string;
}

const secondsPerBlockCache = new Map<number, number>();
const clockModeCache = new Map<string, ClockMode>();

/**
 * Measures the chain's recent average block time by sampling two blocks. This
 * avoids a hardcoded per-chain table, which silently rots as chains change
 * their block times.
 */
export async function secondsPerBlock(
  client: PublicClient,
  chainId: number
): Promise<number> {
  const cached = secondsPerBlockCache.get(chainId);
  if (cached !== undefined) return cached;

  const latest = await client.getBlock();
  const span = latest.number > 10_000n ? 10_000n : latest.number / 2n;

  if (span < 1n) return 12;

  const earlier = await client.getBlock({ blockNumber: latest.number - span });
  const seconds = Number(latest.timestamp - earlier.timestamp) / Number(span);
  const safe = seconds > 0 ? seconds : 12;

  secondsPerBlockCache.set(chainId, safe);

  return safe;
}

/** Reads the Governor's clock mode, defaulting to block numbers as OZ v4 does. */
export async function getClockMode(
  client: PublicClient,
  governor: Address
): Promise<ClockMode> {
  const key = governor.toLowerCase();
  const cached = clockModeCache.get(key);
  if (cached !== undefined) return cached;

  let mode: ClockMode = "blocknumber";

  try {
    const raw = (await client.readContract({
      address: governor,
      abi: [
        {
          type: "function",
          name: "CLOCK_MODE",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "string" }],
        },
      ] as const,
      functionName: "CLOCK_MODE",
    })) as string;

    if (raw.includes("mode=timestamp")) mode = "timestamp";
  } catch {
    // Governors predating ERC-6372 have no CLOCK_MODE and count in blocks.
  }

  clockModeCache.set(key, mode);

  return mode;
}

/** Converts a Governor timepoint into a wall-clock time. */
export async function timepointToDate(
  client: PublicClient,
  chainId: number,
  timepoint: bigint,
  mode: ClockMode
): Promise<{ date: Date; isEstimate: boolean }> {
  if (mode === "timestamp") {
    return { date: new Date(Number(timepoint) * 1_000), isEstimate: false };
  }

  const [currentBlock, perBlock] = await Promise.all([
    client.getBlockNumber(),
    secondsPerBlock(client, chainId),
  ]);

  const deltaBlocks = Number(timepoint) - Number(currentBlock);

  return {
    date: new Date(Date.now() + deltaBlocks * perBlock * 1_000),
    isEstimate: true,
  };
}

/**
 * How far back a scan must reach to still catch an open proposal: the longest a
 * proposal can sit between creation and its deadline, which is exactly
 * votingDelay + votingPeriod, plus a margin.
 *
 * Both values are in the Governor's own clock units, so they are blocks or
 * seconds depending on its ERC-6372 mode.
 */
export function lookbackFromGovernorClock(args: {
  votingDelay: bigint;
  votingPeriod: bigint;
  mode: ClockMode;
  secondsPerBlock: number;
  marginMs: number;
}): number {
  const units = Number(args.votingDelay) + Number(args.votingPeriod);

  if (!Number.isFinite(units) || units <= 0) {
    throw new Error("The Governor reported a non-positive voting window.");
  }

  const seconds = args.mode === "timestamp" ? units : units * args.secondsPerBlock;

  return Math.ceil(seconds * 1_000) + args.marginMs;
}

export interface ResolvedLookback {
  ms: number;
  /** Where the window came from, so the caller can explain it. */
  source: "explicit" | "contract" | "fallback";
  detail: string;
}

/**
 * Works out the scan window. Asking the Governor beats guessing: a DAO with a
 * three-day voting period needs a three-day scan, not a fixed month of logs.
 */
export async function resolveLookback(
  config: Config,
  client: PublicClient,
  governor: Address,
  mode: ClockMode,
  perBlock: number,
  override?: string
): Promise<ResolvedLookback> {
  if (override) {
    return {
      ms: parseDuration(override),
      source: "explicit",
      detail: `lookback of ${override} given explicitly`,
    };
  }

  try {
    const [votingDelay, votingPeriod] = await Promise.all([
      client.readContract({
        address: governor,
        abi: GOVERNOR_ABI,
        functionName: "votingDelay",
      }),
      client.readContract({
        address: governor,
        abi: GOVERNOR_ABI,
        functionName: "votingPeriod",
      }),
    ]);

    const marginMs = parseDuration(config.GOVERNOR_LOOKBACK_MARGIN);
    const ms = lookbackFromGovernorClock({
      votingDelay,
      votingPeriod,
      mode,
      secondsPerBlock: perBlock,
      marginMs,
    });

    const unit = mode === "timestamp" ? "seconds" : "blocks";

    return {
      ms,
      source: "contract",
      detail:
        `derived from the Governor: votingDelay ${votingDelay} + votingPeriod ` +
        `${votingPeriod} ${unit}, plus a ${config.GOVERNOR_LOOKBACK_MARGIN} margin`,
    };
  } catch {
    // A Governor fork without votingDelay/votingPeriod, so fall back to config.
    return {
      ms: parseDuration(config.GOVERNOR_LOOKBACK),
      source: "fallback",
      detail:
        "this Governor does not expose votingDelay/votingPeriod, so " +
        `GOVERNOR_LOOKBACK (${config.GOVERNOR_LOOKBACK}) was used`,
    };
  }
}

/** First meaningful line of an OZ proposal description, used as its title. */
export function titleFromDescription(description: string): string {
  const line = description
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  if (!line) return "(untitled)";

  const stripped = line.replace(/^#+\s*/, "").trim();

  return stripped.length > 200 ? `${stripped.slice(0, 197)}...` : stripped || "(untitled)";
}

/**
 * Scans ProposalCreated logs over the configured lookback, then filters by the
 * Governor's live state. Ranges are chunked because most RPC providers cap the
 * span of a single eth_getLogs call.
 */
export async function findProposals(
  config: Config,
  args: {
    governor: Address;
    states?: string[];
    lookback?: string;
  }
): Promise<{ proposals: OnChainProposal[]; lookback: ResolvedLookback }> {
  const client = getPublicClient(config);
  const chunkSize = BigInt(config.GOVERNOR_LOG_CHUNK_BLOCKS);

  const [latestBlock, perBlock, mode] = await Promise.all([
    client.getBlockNumber(),
    secondsPerBlock(client, config.SAFE_CHAIN_ID),
    getClockMode(client, args.governor),
  ]);

  const lookback = await resolveLookback(
    config,
    client,
    args.governor,
    mode,
    perBlock,
    args.lookback
  );

  const lookbackBlocks = BigInt(Math.ceil(lookback.ms / 1_000 / perBlock));
  const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;
  const chunks = Number((latestBlock - fromBlock) / chunkSize) + 1;

  if (chunks > config.GOVERNOR_MAX_LOG_CHUNKS) {
    throw new Error(
      `Scanning ${formatDuration(lookback.ms)} back needs ${chunks} eth_getLogs calls, ` +
        `over the GOVERNOR_MAX_LOG_CHUNKS limit of ${config.GOVERNOR_MAX_LOG_CHUNKS}. ` +
        `That window was ${lookback.detail}, at roughly ${perBlock.toFixed(2)}s per block. ` +
        "Raise GOVERNOR_LOG_CHUNK_BLOCKS if your RPC provider allows wider ranges, or " +
        "pass a shorter explicit lookback."
    );
  }

  const logs = [];

  for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > latestBlock ? latestBlock : start + chunkSize - 1n;

    logs.push(
      ...(await client.getLogs({
        address: args.governor,
        event: PROPOSAL_CREATED,
        fromBlock: start,
        toBlock: end,
      }))
    );
  }

  const wanted = args.states ?? ["Pending", "Active"];
  const proposals: OnChainProposal[] = [];

  for (const entry of logs) {
    const proposalId = entry.args.proposalId;
    const voteEnd = entry.args.voteEnd;

    if (proposalId === undefined || voteEnd === undefined) continue;

    let state: string;

    try {
      const raw = await client.readContract({
        address: args.governor,
        abi: GOVERNOR_ABI,
        functionName: "state",
        args: [proposalId],
      });
      state = PROPOSAL_STATES[Number(raw)] ?? `Unknown(${raw})`;
    } catch {
      // A proposal the Governor no longer recognises, e.g. after a migration.
      continue;
    }

    if (!wanted.includes(state)) continue;

    const { date, isEstimate } = await timepointToDate(
      client,
      config.SAFE_CHAIN_ID,
      voteEnd,
      mode
    );

    const description = entry.args.description ?? "";

    proposals.push({
      proposalId: proposalId.toString(),
      governor: args.governor,
      title: titleFromDescription(description),
      description,
      proposer: (entry.args.proposer ?? "0x") as Address,
      state,
      voteStart: (entry.args.voteStart ?? 0n).toString(),
      voteEnd: voteEnd.toString(),
      endsAt: date,
      endsAtIsEstimate: isEstimate,
      createdInBlock: entry.blockNumber?.toString() ?? "0",
      transactionHash: entry.transactionHash ?? "",
    });
  }

  return {
    proposals: proposals.sort((a, b) => Number(BigInt(b.voteEnd) - BigInt(a.voteEnd))),
    lookback,
  };
}

/** Test seam: drop the measured block time and clock-mode caches. */
export function resetIndexerCaches(): void {
  secondsPerBlockCache.clear();
  clockModeCache.clear();
}
