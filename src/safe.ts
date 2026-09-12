import { createSafeClient, offChainMessages } from "@safe-global/sdk-starter-kit";
import {
  createPublicClient,
  http,
  type Chain,
  type HttpTransport,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, resolveRpcUrl } from "./chains.js";
import type { Config } from "./config.js";

type SafeClient = Awaited<ReturnType<typeof createSafeClient>>;
type MessageClient = Awaited<ReturnType<ReturnType<typeof offChainMessages>>>;

let safeClientPromise: Promise<SafeClient> | undefined;
let messageClientPromise: Promise<SafeClient & MessageClient> | undefined;

/**
 * The Safe client is expensive to build (it resolves the Safe's deployed
 * version and contract addresses over RPC), so build it once per process.
 */
export function getSafeClient(config: Config): Promise<SafeClient> {
  safeClientPromise ??= createSafeClient({
    provider: resolveRpcUrl(config.SAFE_CHAIN_ID, config.SAFE_RPC_URL),
    signer: config.SAFE_AGENT_PRIVATE_KEY,
    safeAddress: config.SAFE_ADDRESS,
    ...(config.SAFE_API_KEY ? { apiKey: config.SAFE_API_KEY } : {}),
    ...(config.SAFE_TX_SERVICE_URL ? { txServiceUrl: config.SAFE_TX_SERVICE_URL } : {}),
  });

  return safeClientPromise;
}

/** Safe client extended with the off-chain (EIP-1271) message methods. */
export async function getMessageClient(
  config: Config
): Promise<SafeClient & MessageClient> {
  messageClientPromise ??= getSafeClient(config).then((client) =>
    client.extend(offChainMessages())
  );

  return messageClientPromise;
}

/** Read-only viem client for contract reads that don't involve the Safe SDK. */
export function getPublicClient(
  config: Config
): PublicClient<HttpTransport, Chain> {
  return createPublicClient({
    chain: getChain(config.SAFE_CHAIN_ID),
    transport: http(resolveRpcUrl(config.SAFE_CHAIN_ID, config.SAFE_RPC_URL)),
  });
}

/** The EOA the agent signs with. This address must be an owner of the Safe. */
export function getAgentAddress(config: Config): string {
  return privateKeyToAccount(config.SAFE_AGENT_PRIVATE_KEY as `0x${string}`).address;
}

/**
 * Fails loudly when the agent key cannot actually act for the Safe, so a vote
 * attempt reports "not an owner" rather than an opaque SDK error.
 */
export async function assertAgentCanSign(config: Config): Promise<void> {
  const client = await getSafeClient(config);
  const agent = getAgentAddress(config);

  if (!(await client.isDeployed())) {
    throw new Error(
      `Safe ${config.SAFE_ADDRESS} is not deployed on ${config.SAFE_CHAIN_ID}. ` +
        "Check SAFE_ADDRESS and SAFE_CHAIN_ID."
    );
  }

  if (!(await client.isOwner(agent))) {
    const owners = await client.getOwners();
    throw new Error(
      `Agent signer ${agent} is not an owner of Safe ${config.SAFE_ADDRESS}. ` +
        `Current owners: ${owners.join(", ")}. ` +
        "Add the agent as an owner in the Safe UI first."
    );
  }
}

/**
 * The agent EOA submits execTransaction, so it is the account that pays gas for
 * an on-chain vote, not the Safe. A Safe holding ETH does not help here. Fail
 * before signing, with the cause named, rather than on an opaque RPC rejection.
 */
export async function assertAgentCanPayGas(config: Config): Promise<void> {
  const agent = getAgentAddress(config);

  const balance = await getPublicClient(config)
    .getBalance({ address: agent as `0x${string}` })
    .catch(() => null);

  if (balance === null) return; // Balance unreadable; let the send attempt decide.

  if (balance === 0n) {
    throw new Error(
      `The agent signer ${agent} holds no ETH and is the account that pays gas for ` +
        "this transaction, so it would be rejected. Send ETH to the agent signer " +
        `address, not to the Safe ${config.SAFE_ADDRESS}: the Safe's own balance does ` +
        "not pay for execTransaction. Snapshot voting is gasless and needs none of this."
    );
  }
}

/** Test seam: drop the memoised clients. */
export function resetSafeClients(): void {
  safeClientPromise = undefined;
  messageClientPromise = undefined;
}
