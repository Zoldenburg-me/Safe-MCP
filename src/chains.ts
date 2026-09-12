import * as viemChains from "viem/chains";
import type { Chain } from "viem";

const byId = new Map<number, Chain>();

for (const value of Object.values(viemChains)) {
  const chain = value as Chain;
  if (chain && typeof chain === "object" && typeof chain.id === "number") {
    if (!byId.has(chain.id)) byId.set(chain.id, chain);
  }
}

/** Looks up a viem chain definition by id. */
export function getChain(chainId: number): Chain {
  const chain = byId.get(chainId);
  if (!chain) {
    throw new Error(
      `Unknown chain id ${chainId}. Set SAFE_RPC_URL explicitly for custom networks.`
    );
  }
  return chain;
}

/** Human-readable chain name, falling back to the raw id. */
export function getChainName(chainId: number): string {
  return byId.get(chainId)?.name ?? `chain ${chainId}`;
}

/**
 * Resolves the RPC endpoint to use: the explicit override if set, otherwise the
 * chain's first public RPC. Public RPCs are rate limited, so production
 * deployments should always set SAFE_RPC_URL.
 */
export function resolveRpcUrl(chainId: number, override?: string): string {
  if (override) return override;

  const fallback = getChain(chainId).rpcUrls.default.http[0];
  if (!fallback) {
    throw new Error(
      `No public RPC known for chain ${chainId}. Set SAFE_RPC_URL.`
    );
  }
  return fallback;
}

/** Block explorer link for a transaction, when the chain declares one. */
export function explorerTxUrl(chainId: number, txHash: string): string | undefined {
  const base = byId.get(chainId)?.blockExplorers?.default.url;
  return base ? `${base}/tx/${txHash}` : undefined;
}
