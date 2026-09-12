import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseDuration } from "./duration.js";
import type { Config } from "./config.js";

export type ScheduleStatus =
  | "pending"
  | "dispatched"
  | "voted"
  | "failed"
  | "expired";

export interface ScheduledVote {
  /** Stable key: `${platform}:${venue}:${proposalId}`. */
  key: string;
  platform: "snapshot" | "governor";
  proposalId: string;
  /** Snapshot space id, or the Governor contract address. */
  venue: string;
  title: string;
  /** ISO time voting closes. */
  endsAt: string;
  /** ISO time the agent should be asked to decide. */
  voteAt: string;
  status: ScheduleStatus;
  attempts: number;
  discoveredAt: string;
  dispatchedAt: string | null;
  lastError: string | null;
}

export interface ScheduleFile {
  version: 1;
  entries: Record<string, ScheduledVote>;
}

const EMPTY: ScheduleFile = { version: 1, entries: {} };

export function scheduleKey(
  platform: "snapshot" | "governor",
  venue: string,
  proposalId: string
): string {
  return `${platform}:${venue.toLowerCase()}:${proposalId}`;
}

function schedulePath(config: Config): string {
  return resolve(config.SCHEDULE_PATH);
}

export async function loadSchedule(config: Config): Promise<ScheduleFile> {
  try {
    const parsed = JSON.parse(await readFile(schedulePath(config), "utf-8")) as ScheduleFile;
    if (parsed?.version !== 1 || typeof parsed.entries !== "object") return { ...EMPTY };
    return { version: 1, entries: parsed.entries ?? {} };
  } catch {
    return { ...EMPTY, entries: {} };
  }
}

/**
 * Writes via a temporary file and rename, so a crash mid-write cannot leave a
 * truncated schedule that would lose every pending vote.
 */
export async function saveSchedule(
  config: Config,
  schedule: ScheduleFile
): Promise<void> {
  const path = schedulePath(config);
  const temp = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify(schedule, null, 2)}\n`, "utf-8");
  await rename(temp, path);
}

/**
 * When to ask the agent to decide: `VOTE_BEFORE_CLOSE` ahead of the deadline,
 * mirroring Minerva's behaviour of voting late so the decision reflects how
 * sentiment developed. A proposal discovered inside that window is due now.
 */
export function computeVoteAt(
  endsAt: Date,
  leadMs: number,
  now: Date = new Date()
): Date {
  const target = endsAt.getTime() - leadMs;
  return new Date(Math.max(target, now.getTime()));
}

export interface DiscoveredProposal {
  platform: "snapshot" | "governor";
  proposalId: string;
  venue: string;
  title: string;
  endsAt: Date;
}

/**
 * Merges freshly discovered proposals into the schedule. Existing entries keep
 * their status and attempt count, so a restart never re-votes; only the
 * deadline is refreshed, since a space can extend a proposal.
 */
export function upsertProposals(
  schedule: ScheduleFile,
  discovered: DiscoveredProposal[],
  leadMs: number,
  now: Date = new Date()
): { schedule: ScheduleFile; added: ScheduledVote[] } {
  const added: ScheduledVote[] = [];
  const entries = { ...schedule.entries };

  for (const proposal of discovered) {
    const key = scheduleKey(proposal.platform, proposal.venue, proposal.proposalId);
    const existing = entries[key];

    if (existing) {
      entries[key] = {
        ...existing,
        title: proposal.title || existing.title,
        endsAt: proposal.endsAt.toISOString(),
        voteAt:
          existing.status === "pending"
            ? computeVoteAt(proposal.endsAt, leadMs, now).toISOString()
            : existing.voteAt,
      };
      continue;
    }

    const entry: ScheduledVote = {
      key,
      platform: proposal.platform,
      proposalId: proposal.proposalId,
      venue: proposal.venue,
      title: proposal.title,
      endsAt: proposal.endsAt.toISOString(),
      voteAt: computeVoteAt(proposal.endsAt, leadMs, now).toISOString(),
      status: "pending",
      attempts: 0,
      discoveredAt: now.toISOString(),
      dispatchedAt: null,
      lastError: null,
    };

    entries[key] = entry;
    added.push(entry);
  }

  return { schedule: { version: 1, entries }, added };
}

/** Pending entries whose vote time has arrived and whose deadline has not. */
export function dueVotes(
  schedule: ScheduleFile,
  now: Date = new Date()
): ScheduledVote[] {
  return Object.values(schedule.entries)
    .filter(
      (entry) =>
        entry.status === "pending" &&
        Date.parse(entry.voteAt) <= now.getTime() &&
        Date.parse(entry.endsAt) > now.getTime()
    )
    .sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
}

/** Pending entries whose deadline passed without a vote. */
export function expiredVotes(
  schedule: ScheduleFile,
  now: Date = new Date()
): ScheduledVote[] {
  return Object.values(schedule.entries).filter(
    (entry) =>
      (entry.status === "pending" || entry.status === "dispatched") &&
      Date.parse(entry.endsAt) <= now.getTime()
  );
}

export function updateEntry(
  schedule: ScheduleFile,
  key: string,
  patch: Partial<ScheduledVote>
): ScheduleFile {
  const existing = schedule.entries[key];
  if (!existing) return schedule;

  return {
    version: 1,
    entries: { ...schedule.entries, [key]: { ...existing, ...patch } },
  };
}

/** Drops entries that closed more than `retain` ago, to bound the file. */
export function pruneSchedule(
  schedule: ScheduleFile,
  retainMs: number,
  now: Date = new Date()
): ScheduleFile {
  const cutoff = now.getTime() - retainMs;
  const entries: Record<string, ScheduledVote> = {};

  for (const [key, entry] of Object.entries(schedule.entries)) {
    if (Date.parse(entry.endsAt) >= cutoff) entries[key] = entry;
  }

  return { version: 1, entries };
}

export function scheduleLeadMs(config: Config): number {
  return parseDuration(config.VOTE_BEFORE_CLOSE);
}
