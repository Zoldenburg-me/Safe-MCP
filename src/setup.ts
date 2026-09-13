#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { formatEther, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import SafeApiKitModule from "@safe-global/api-kit";
import { describeEnvSource, loadDotEnv, packageRoot } from "./dotenv.js";
import { getChainName, resolveRpcUrl } from "./chains.js";

const USAGE = `
safe-mpc-setup — create the agent's key and connect it to a Safe.

  safe-mpc-setup             interactive setup, writes .env
  safe-mpc-setup --new-key   print a fresh agent key and address, write nothing
  safe-mpc-setup --check     verify the current .env and report readiness

Non-interactive, for scripts and containers:

  safe-mpc-setup --safe 0xSafe [--chain 1] [--rpc URL] [--api-key KEY]
                 [--key 0xPrivateKey]      reuse a key instead of generating one
                 [--space a.eth,b.eth]     Snapshot spaces to watch, on top of the
                                           ones the Safe has voting power in
                 [--dry-run]               write DRY_RUN=true; off by default

  --force                    overwrite an existing .env

There is no web UI. This command is the setup screen.
`.trim();

/**
 * The space a fresh install is wired up to, so there is somewhere to exercise
 * the whole vote path before pointing the agent at a DAO that matters. The
 * server watches it alongside whatever spaces the Safe has voting power in.
 */
const DEFAULT_WATCH_SPACES = "staging.daoplomats.eth";

const CHAINS: Array<{ id: number; label: string }> = [
  { id: 1, label: "Ethereum" },
  { id: 8453, label: "Base" },
  { id: 42161, label: "Arbitrum One" },
  { id: 10, label: "OP Mainnet" },
  { id: 137, label: "Polygon" },
  { id: 100, label: "Gnosis" },
];

function envPath(): string {
  return join(packageRoot(), ".env");
}

/**
 * api-kit ships one .d.ts for both its CJS and ESM builds, so TypeScript
 * resolves the default import to the module namespace rather than the class.
 * At runtime the default export is the constructor, so this pins the shape we
 * actually use.
 */
type SafeApiKitCtor = new (config: { chainId: bigint; apiKey?: string }) => {
  getSafesByOwner(owner: string): Promise<{ safes: string[] }>;
};

const SafeApiKit = SafeApiKitModule as unknown as SafeApiKitCtor;

/** Lists the Safes an address owns, which is how you pick one to connect. */
async function safesOwnedBy(
  chainId: number,
  owner: string,
  apiKey?: string
): Promise<string[]> {
  const apiKit = new SafeApiKit({
    chainId: BigInt(chainId),
    ...(apiKey ? { apiKey } : {}),
  });

  const response = await apiKit.getSafesByOwner(owner);

  return response.safes ?? [];
}

async function newKey(): Promise<void> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  console.log(
    [
      "",
      "  Agent address:  " + account.address,
      "  Private key:    " + privateKey,
      "",
      "  Add the ADDRESS as an owner of your Safe at https://app.safe.global.",
      "  Keep the PRIVATE KEY secret. Anyone holding it can act as that owner.",
      "",
    ].join("\n")
  );
}

async function check(): Promise<void> {
  const loaded = loadDotEnv();

  const { loadConfig } = await import("./config.js");
  const { getAgentAddress, getPublicClient, getSafeClient } = await import("./safe.js");

  console.log(`\nConfiguration: ${loaded ?? "environment only (no .env found)"}\n`);

  const config = loadConfig();
  const agent = getAgentAddress(config);

  console.log(`  Chain          ${getChainName(config.SAFE_CHAIN_ID)} (${config.SAFE_CHAIN_ID})`);
  console.log(`  RPC            ${resolveRpcUrl(config.SAFE_CHAIN_ID, config.SAFE_RPC_URL)}`);
  console.log(`  Agent signer   ${agent}`);
  console.log(`  Safe           ${config.SAFE_ADDRESS}`);
  console.log(`  Safe API key   ${config.SAFE_API_KEY ? "set" : "NOT SET (Snapshot voting needs it)"}`);
  console.log(
    `  Dry run        ${config.DRY_RUN ? "on" : "OFF — votes are real"} ` +
      `(from ${describeEnvSource("DRY_RUN")})\n`
  );

  const problems: string[] = [];

  const agentBalance = await getPublicClient(config)
    .getBalance({ address: agent as `0x${string}` })
    .catch(() => null);

  console.log(
    `  Agent balance  ${agentBalance === null ? "unreadable" : `${formatEther(agentBalance)} ETH`}`
  );

  if (agentBalance === 0n) {
    problems.push(
      "The agent holds no ETH. Snapshot voting still works, but on-chain Governor " +
        "voting needs gas, and the agent pays it, not the Safe."
    );
  }

  try {
    const client = await getSafeClient(config);

    if (!(await client.isDeployed())) {
      problems.push(`Safe ${config.SAFE_ADDRESS} is not deployed on this chain.`);
    } else {
      const [owners, threshold] = await Promise.all([
        client.getOwners(),
        client.getThreshold(),
      ]);

      const isOwner = owners.some((o) => o.toLowerCase() === agent.toLowerCase());

      console.log(`  Threshold      ${threshold} of ${owners.length}`);
      console.log(`  Agent is owner ${isOwner ? "yes" : "NO"}\n`);

      if (!isOwner) {
        problems.push(
          `The agent ${agent} is not an owner of this Safe. Add it at ` +
            "https://app.safe.global, under Settings then Setup."
        );
      } else if (threshold > 1) {
        console.log(
          `  Votes will be queued for ${threshold - 1} more owner signature(s).\n`
        );
      }
    }
  } catch (error) {
    problems.push(
      `Could not read the Safe: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (config.SAFE_API_KEY) {
    try {
      const owned = await safesOwnedBy(config.SAFE_CHAIN_ID, agent, config.SAFE_API_KEY);
      console.log(
        owned.length > 0
          ? `  Safes owned by the agent on this chain:\n${owned.map((s) => `    ${s}`).join("\n")}\n`
          : "  The agent owns no Safes on this chain yet.\n"
      );
    } catch {
      // The owner lookup is a convenience; never fail the check on it.
    }
  }

  // Where the Safe can actually vote. This is the question an operator asks
  // straight after "is the agent an owner", and answering it here saves
  // assembling it by hand out of Snapshot and token balances.
  try {
    const { resolveWatchedSpaces } = await import("./spaces.js");
    const { spaces, discovered } = await resolveWatchedSpaces(config);
    const withPower = discovered.filter((row) => row.votingPower > 0);
    const unreadable = discovered.filter((row) => row.error !== null);

    console.log(
      withPower.length > 0
        ? `  Voting power in ${withPower.length} Snapshot space(s):\n` +
            withPower
              .map((row) => `    ${row.space}  ${row.votingPower}  (${row.sources.join(", ")})`)
              .join("\n") +
            "\n"
        : "  The Safe holds no Snapshot voting power in any discovered space.\n"
    );

    console.log(`  Watching       ${spaces.join(", ") || "(nothing)"}\n`);

    if (unreadable.length > 0) {
      problems.push(
        `Could not read the Safe's voting power in ${unreadable.length} space(s) ` +
          `(${unreadable[0]!.space}: ${unreadable[0]!.error}). Until the Snapshot hub ` +
          "is reachable, this says nothing either way about where the Safe can vote."
      );
    } else if (withPower.length === 0) {
      problems.push(
        "The Safe has no Snapshot voting power anywhere Safe-MPC can see, so any vote " +
          "it casts would be rejected. Check that the Safe holds a space's voting token, " +
          "or that delegation to it is in place."
      );
    }
  } catch (error) {
    console.log(
      `  Could not read Snapshot voting power: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }

  if (problems.length === 0) {
    console.log("Ready to vote.\n");
    return;
  }

  console.log("Not ready:\n");
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log("");
  process.exitCode = 1;
}

interface EnvOptions {
  force: boolean;
  safeAddress: string;
  privateKey: string;
  chainId: number;
  rpcUrl: string;
  apiKey: string;
  /** Comma-separated Snapshot spaces to watch explicitly. */
  watchSpaces: string;
  dryRun: boolean;
}

async function refuseIfPresent(force: boolean): Promise<void> {
  if (force) return;

  try {
    await readFile(envPath(), "utf-8");
  } catch {
    return; // Absent, which is what we want.
  }

  throw new Error(
    `${envPath()} already exists. Run with --force to overwrite it, or edit it by hand.`
  );
}

/** Writes .env with restrictive permissions, since it holds a private key. */
async function writeEnv(options: EnvOptions): Promise<void> {
  await refuseIfPresent(options.force);

  if (!/^0x[a-fA-F0-9]{64}$/.test(options.privateKey)) {
    throw new Error("That is not a 32-byte hex private key.");
  }

  if (!Number.isInteger(options.chainId) || options.chainId <= 0) {
    throw new Error(`Invalid chain id: ${options.chainId}`);
  }

  const agent = privateKeyToAccount(options.privateKey as `0x${string}`).address;

  const lines = [
    "# Written by safe-mpc-setup. Keep this file secret.",
    `SAFE_ADDRESS=${options.safeAddress}`,
    `SAFE_AGENT_PRIVATE_KEY=${options.privateKey}`,
    `SAFE_CHAIN_ID=${options.chainId}`,
    options.rpcUrl ? `SAFE_RPC_URL=${options.rpcUrl}` : "# SAFE_RPC_URL=",
    options.apiKey ? `SAFE_API_KEY=${options.apiKey}` : "# SAFE_API_KEY=",
    "",
    "# Votes are real. Set DRY_RUN=true to have every vote tool return the payload",
    "# it would have signed without submitting anything.",
    `DRY_RUN=${options.dryRun}`,
    "",
    "# Snapshot spaces watched explicitly, on top of every space the Safe holds",
    "# voting power in (see WATCH_SNAPSHOT_AUTO).",
    `WATCH_SNAPSHOT_SPACES=${options.watchSpaces}`,
    "",
    "# Watch every Snapshot space the Safe can vote in, re-checked on every pass.",
    "WATCH_SNAPSHOT_AUTO=true",
    "",
    "# Restrict where the agent may vote. Strongly recommended.",
    "# ALLOWED_SNAPSHOT_SPACES=",
    "# ALLOWED_GOVERNORS=",
    "",
    "KNOWLEDGE_DIR=knowledge",
    "VOTE_LOG_PATH=data/votes.jsonl",
    "",
  ];

  await writeFile(envPath(), lines.join("\n"), { encoding: "utf-8", mode: 0o600 });
  await chmod(envPath(), 0o600);

  console.log(
    [
      "",
      `Wrote ${envPath()} (mode 600).`,
      "",
      `  Agent address: ${agent}`,
      `  Safe:          ${options.safeAddress}`,
      `  Chain:         ${getChainName(options.chainId)} (${options.chainId})`,
      `  Watching:      ${options.watchSpaces || "(auto-discovered spaces only)"}`,
      `  Dry run:       ${options.dryRun ? "on — nothing will be submitted" : "OFF — votes are real"}`,
      "",
      "Next:",
      `  1. add ${agent} as an owner of the Safe at https://app.safe.global`,
      "  2. safe-mpc-setup --check        confirm ownership and see where it can vote",
      "  3. write your voting policy into knowledge/",
      `  4. claude mcp add safe-mpc -- node ${join(packageRoot(), "dist", "index.js")}`,
      "",
    ].join("\n")
  );
}

/**
 * readline resolves nothing once stdin closes, so a piped or truncated session
 * would otherwise exit 0 having written nothing. Fail loudly instead.
 */
async function ask(
  rl: ReturnType<typeof createInterface>,
  prompt: string
): Promise<string> {
  let answered = false;

  const closed = new Promise<never>((_, reject) => {
    rl.once("close", () => {
      if (!answered) {
        reject(
          new Error(
            "Input ended before setup finished, so nothing was written. Use the " +
              "non-interactive form instead: safe-mpc-setup --safe 0xYourSafe"
          )
        );
      }
    });
  });

  const answer = rl.question(prompt).then((value) => {
    answered = true;
    return value;
  });

  return Promise.race([answer, closed]);
}

async function init(force: boolean): Promise<void> {
  await refuseIfPresent(force);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\nSafe-MPC setup\n");

    const reuse = (await ask(rl, "Do you already have an agent private key? [y/N] "))
      .trim()
      .toLowerCase();

    let privateKey: string;

    if (reuse === "y" || reuse === "yes") {
      privateKey = (await ask(rl, "Agent private key (0x…): ")).trim();
      if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
        throw new Error("That is not a 32-byte hex private key.");
      }
    } else {
      privateKey = generatePrivateKey();
      console.log("\nGenerated a new agent key.");
    }

    const agent = privateKeyToAccount(privateKey as `0x${string}`).address;

    console.log(`\n  Agent address: ${agent}\n`);
    console.log("Chains:");
    for (const chain of CHAINS) console.log(`  ${chain.id}\t${chain.label}`);

    const chainInput = (await ask(rl, "\nChain id [1]: ")).trim();
    const chainId = chainInput ? Number(chainInput) : 1;

    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error(`Invalid chain id: ${chainInput}`);
    }

    const rpcUrl = (await ask(rl, "RPC URL (blank for a public one): ")).trim();
    const apiKey = (
      await ask(rl, "Safe API key from developer.safe.global (blank to skip): ")
    ).trim();

    console.log(
      "\nThe agent votes in every Snapshot space the Safe holds voting power in.\n" +
        "Name any further spaces to watch as well, comma-separated.\n"
    );

    const watchSpaces =
      (await ask(rl, `Extra Snapshot spaces [${DEFAULT_WATCH_SPACES}]: `)).trim() ||
      DEFAULT_WATCH_SPACES;

    const dryRun = (await ask(rl, "Start in dry-run mode (submit nothing)? [y/N] "))
      .trim()
      .toLowerCase();

    console.log(
      `\nNow add ${agent} as an owner of your Safe at https://app.safe.global,\n` +
        "under Settings then Setup then Add new owner. Then come back here.\n"
    );

    if (apiKey) {
      await ask(rl, "Press Enter once the owner has been added. ");

      try {
        const owned = await safesOwnedBy(chainId, agent, apiKey);
        console.log(
          owned.length > 0
            ? `\nSafes this agent now owns:\n${owned.map((x) => `  ${x}`).join("\n")}\n`
            : "\nNo Safes found for this agent yet. You can still enter the address below.\n"
        );
      } catch {
        console.log("\nCould not look up Safes; enter the address below.\n");
      }
    }

    const safeInput = (await ask(rl, "Safe address (0x…): ")).trim();

    await writeEnv({
      force,
      safeAddress: getAddress(safeInput),
      privateKey,
      chainId,
      rpcUrl,
      apiKey,
      watchSpaces,
      dryRun: dryRun === "y" || dryRun === "yes",
    });
  } finally {
    rl.close();
  }
}

interface Flags {
  bare: Set<string>;
  values: Map<string, string>;
}

function parseFlags(argv: string[]): Flags {
  const bare = new Set<string>();
  const values = new Map<string, string>();
  const takesValue = new Set([
    "--safe",
    "--chain",
    "--rpc",
    "--api-key",
    "--key",
    "--space",
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value.`);
      }
      values.set(arg, value);
      i += 1;
      continue;
    }

    bare.add(arg);
  }

  return { bare, values };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.bare.has("--help") || flags.bare.has("-h")) {
    console.log(USAGE);
    return;
  }

  if (flags.bare.has("--new-key")) return newKey();
  if (flags.bare.has("--check")) return check();

  const force = flags.bare.has("--force");
  const safe = flags.values.get("--safe");

  if (safe) {
    return writeEnv({
      force,
      safeAddress: getAddress(safe),
      privateKey: flags.values.get("--key") ?? generatePrivateKey(),
      chainId: Number(flags.values.get("--chain") ?? 1),
      rpcUrl: flags.values.get("--rpc") ?? "",
      apiKey: flags.values.get("--api-key") ?? "",
      watchSpaces: flags.values.get("--space") ?? DEFAULT_WATCH_SPACES,
      dryRun: flags.bare.has("--dry-run"),
    });
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "Interactive setup needs a terminal. Run it in one, or use the " +
        "non-interactive form:\n\n  safe-mpc-setup --safe 0xYourSafe --chain 1\n\n" +
        "See --help for every flag."
    );
  }

  return init(force);
}

main().catch((error: unknown) => {
  console.error(
    `\nsafe-mpc-setup: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
