import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address");

const privateKey = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte private key");

/** Comma- or space-separated list -> trimmed, de-duplicated, lowercased array. */
const csv = z
  .string()
  .optional()
  .transform((raw) =>
    raw ? [...new Set(raw.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean))] : []
  );

const csvLower = z
  .string()
  .optional()
  .transform((raw) =>
    raw
      ? [...new Set(raw.split(/[,\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))]
      : []
  );

const bool = z
  .string()
  .optional()
  .transform((raw) => raw === "1" || raw?.toLowerCase() === "true");

const envSchema = z.object({
  SAFE_ADDRESS: address,
  SAFE_AGENT_PRIVATE_KEY: privateKey,
  SAFE_CHAIN_ID: z.coerce.number().int().positive().default(1),
  SAFE_RPC_URL: z.string().url().optional(),
  SAFE_API_KEY: z.string().min(1).optional(),
  SAFE_TX_SERVICE_URL: z.string().url().optional(),

  SNAPSHOT_HUB_URL: z.string().url().default("https://hub.snapshot.org"),
  SNAPSHOT_SEQUENCER_URL: z.string().url().default("https://seq.snapshot.org"),

  // Tally shut down in March 2026 and the platform is now Cactus, run by
  // ScopeLift. These are optional: on-chain discovery needs no API at all.
  CACTUS_API_URL: z.string().url().optional(),
  CACTUS_API_KEY: z.string().min(1).optional(),
  TALLY_API_URL: z.string().url().default("https://api.tally.xyz/query"),
  TALLY_API_KEY: z.string().min(1).optional(),

  ALLOWED_SNAPSHOT_SPACES: csvLower,
  ALLOWED_GOVERNORS: csvLower,

  DRY_RUN: bool,
  KNOWLEDGE_DIR: z.string().default("knowledge"),

  // Vote log and scheduler
  VOTE_LOG_PATH: z.string().default("data/votes.jsonl"),
  SCHEDULE_PATH: z.string().default("data/schedule.json"),
  WATCH_SNAPSHOT_SPACES: csv,
  WATCH_GOVERNORS: csv,
  WATCH_TALLY_SLUGS: csv,
  POLL_INTERVAL: z.string().default("1h"),
  VOTE_BEFORE_CLOSE: z.string().default("6h"),
  AGENT_COMMAND: z.string().optional(),
  AGENT_TIMEOUT: z.string().default("10m"),

  // On-chain Governor proposal discovery
  // Only used when a Governor does not expose votingDelay/votingPeriod. The
  // scan window is normally derived from the contract itself.
  GOVERNOR_LOOKBACK: z.string().default("30d"),
  GOVERNOR_LOOKBACK_MARGIN: z.string().default("2d"),
  GOVERNOR_LOG_CHUNK_BLOCKS: z.coerce.number().int().positive().default(10_000),
  GOVERNOR_MAX_LOG_CHUNKS: z.coerce.number().int().positive().default(200),
});

export type Config = z.infer<typeof envSchema> & {
  /** Lowercased Safe address, for comparisons. */
  safeAddressLower: string;
  /** Resolved governance-indexer endpoint: CACTUS_* wins over legacy TALLY_*. */
  indexerApiUrl: string;
  indexerApiKey: string | undefined;
};

let cached: Config | undefined;

/**
 * Reads and validates configuration from the environment.
 *
 * Throws a single readable error listing every missing or malformed variable,
 * because an MCP server that half-starts is worse than one that refuses to.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid Safe-MPC configuration:\n${issues}\n\n` +
        "See .env.example for the full list of variables."
    );
  }

  cached = {
    ...parsed.data,
    safeAddressLower: parsed.data.SAFE_ADDRESS.toLowerCase(),
    indexerApiUrl: parsed.data.CACTUS_API_URL ?? parsed.data.TALLY_API_URL,
    indexerApiKey: parsed.data.CACTUS_API_KEY ?? parsed.data.TALLY_API_KEY,
  };

  return cached;
}

/** Test seam: forget the memoised config. */
export function resetConfig(): void {
  cached = undefined;
}

/**
 * Guards a Snapshot space against ALLOWED_SNAPSHOT_SPACES.
 * An empty allowlist means "no restriction".
 */
export function assertSpaceAllowed(config: Config, space: string): void {
  if (config.ALLOWED_SNAPSHOT_SPACES.length === 0) return;
  if (config.ALLOWED_SNAPSHOT_SPACES.includes(space.toLowerCase())) return;

  throw new Error(
    `Snapshot space "${space}" is not in ALLOWED_SNAPSHOT_SPACES ` +
      `(${config.ALLOWED_SNAPSHOT_SPACES.join(", ")}). ` +
      "Add it to the allowlist to let the agent vote there."
  );
}

/**
 * Guards a Governor contract against ALLOWED_GOVERNORS.
 * An empty allowlist means "no restriction".
 */
export function assertGovernorAllowed(config: Config, governor: string): void {
  if (config.ALLOWED_GOVERNORS.length === 0) return;
  if (config.ALLOWED_GOVERNORS.includes(governor.toLowerCase())) return;

  throw new Error(
    `Governor "${governor}" is not in ALLOWED_GOVERNORS ` +
      `(${config.ALLOWED_GOVERNORS.join(", ")}). ` +
      "Add it to the allowlist to let the agent vote there."
  );
}
