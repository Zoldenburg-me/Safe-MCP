import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "./config.js";

export type VoteOutcome = "submitted" | "queued" | "failed" | "dry-run";

export interface VoteLogEntry {
  /** ISO timestamp of the attempt. */
  at: string;
  platform: "snapshot" | "snapshot-x" | "governor";
  outcome: VoteOutcome;
  safeAddress: string;
  chainId: number;
  proposalId: string;
  /** Snapshot space id, or the Governor contract address. */
  venue: string;
  title: string | null;
  /** Human-readable choice, e.g. "For" or "A: 70, B: 30". */
  choice: string;
  reason: string;
  votingPower: string | null;
  /** Snapshot vote id, or the on-chain transaction hash. */
  receipt: string | null;
  safeTxHash: string | null;
  safeMessageHash: string | null;
  error: string | null;
}

/**
 * The vote log is an append-only JSONL file. It is deliberately not a database:
 * the authoritative record of a vote is on Snapshot or on-chain, and this exists
 * so the agent can see its own precedent and the operator can audit what the
 * agent did without standing up Postgres.
 */
function logPath(config: Config): string {
  return resolve(config.VOTE_LOG_PATH);
}

export async function appendVote(
  config: Config,
  entry: Omit<VoteLogEntry, "at">
): Promise<void> {
  const path = logPath(config);

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8");
  } catch (error) {
    // A vote that succeeded must not be reported as failed because logging
    // broke, so this degrades to a stderr warning.
    console.error(
      `safe-mpc: could not write the vote log at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/** Reads the whole log, oldest first. Malformed lines are skipped. */
export async function readVoteLog(config: Config): Promise<VoteLogEntry[]> {
  let raw: string;

  try {
    raw = await readFile(logPath(config), "utf-8");
  } catch {
    return [];
  }

  const entries: VoteLogEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as VoteLogEntry);
    } catch {
      // A partially written final line is expected if the process died
      // mid-append; ignore it rather than failing the read.
    }
  }

  return entries;
}

export interface VoteLogQuery {
  platform?: "snapshot" | "snapshot-x" | "governor";
  venue?: string;
  proposalId?: string;
  outcome?: VoteOutcome;
  limit?: number;
}

/** Queries the log, newest first. */
export async function queryVoteLog(
  config: Config,
  query: VoteLogQuery = {}
): Promise<VoteLogEntry[]> {
  const all = await readVoteLog(config);

  const filtered = all.filter((entry) => {
    if (query.platform && entry.platform !== query.platform) return false;
    if (query.outcome && entry.outcome !== query.outcome) return false;
    if (query.proposalId && entry.proposalId !== query.proposalId) return false;
    if (query.venue && entry.venue.toLowerCase() !== query.venue.toLowerCase()) {
      return false;
    }
    return true;
  });

  return filtered.reverse().slice(0, query.limit ?? 20);
}

/**
 * Whether this Safe already recorded a submitted vote on a proposal. The
 * scheduler uses this to avoid dispatching an agent twice for the same
 * proposal after a restart.
 */
export async function hasVotedOn(
  config: Config,
  proposalId: string
): Promise<boolean> {
  const entries = await readVoteLog(config);
  return entries.some(
    (entry) => entry.proposalId === proposalId && entry.outcome === "submitted"
  );
}
