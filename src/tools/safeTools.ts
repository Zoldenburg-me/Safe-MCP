import { z } from "zod";
import { formatEther } from "viem";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentAddress, getPublicClient, getSafeClient } from "../safe.js";
import { explorerTxUrl, getChainName } from "../chains.js";
import { guard, json, text } from "./shared.js";
import type { Config } from "../config.js";

export function registerSafeTools(server: McpServer, config: Config): void {
  server.registerTool(
    "safe_info",
    {
      title: "Safe wallet info",
      description:
        "Reports the configured Safe: chain, owners, threshold, nonce, native balance, " +
        "and whether the agent's signer key is an owner that can execute alone. " +
        "Call this first to confirm the agent can actually vote.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const client = await getSafeClient(config);
      const agent = getAgentAddress(config);

      const [deployed, owners, threshold, nonce] = await Promise.all([
        client.isDeployed(),
        client.getOwners().catch(() => [] as string[]),
        client.getThreshold().catch(() => 0),
        client.getNonce().catch(() => 0),
      ]);

      const balance = await getPublicClient(config)
        .getBalance({ address: config.SAFE_ADDRESS as `0x${string}` })
        .catch(() => null);

      const isOwner = owners.some((o) => o.toLowerCase() === agent.toLowerCase());

      return json(
        {
          safeAddress: config.SAFE_ADDRESS,
          chainId: config.SAFE_CHAIN_ID,
          chainName: getChainName(config.SAFE_CHAIN_ID),
          deployed,
          owners,
          threshold,
          nonce,
          nativeBalance: balance === null ? null : formatEther(balance),
          agentSigner: agent,
          agentIsOwner: isOwner,
          agentCanExecuteAlone: isOwner && threshold === 1,
          dryRun: config.DRY_RUN,
          allowedSnapshotSpaces:
            config.ALLOWED_SNAPSHOT_SPACES.length > 0
              ? config.ALLOWED_SNAPSHOT_SPACES
              : "all",
          allowedGovernors:
            config.ALLOWED_GOVERNORS.length > 0 ? config.ALLOWED_GOVERNORS : "all",
        },
        isOwner
          ? threshold === 1
            ? "The agent signer is an owner and the threshold is 1, so it can cast votes on its own."
            : `The agent signer is an owner, but the threshold is ${threshold}. Votes will be proposed and need ${threshold - 1} more confirmation(s).`
          : `WARNING: the agent signer ${agent} is not an owner of this Safe and cannot vote.`
      );
    })
  );

  server.registerTool(
    "safe_pending_transactions",
    {
      title: "List queued Safe transactions",
      description:
        "Lists transactions queued on the Safe Transaction Service that are waiting " +
        "for confirmations or execution.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const client = await getSafeClient(config);
      const pending = await client.getPendingTransactions();

      const rows = pending.results.map((tx) => ({
        safeTxHash: tx.safeTxHash,
        to: tx.to,
        value: tx.value,
        nonce: tx.nonce,
        confirmations: tx.confirmations?.length ?? 0,
        confirmationsRequired: tx.confirmationsRequired,
        submissionDate: tx.submissionDate,
        dataSize: tx.data ? (tx.data.length - 2) / 2 : 0,
      }));

      return json(
        { count: rows.length, transactions: rows },
        rows.length === 0
          ? "No transactions are queued on this Safe."
          : `${rows.length} queued transaction(s).`
      );
    })
  );

  server.registerTool(
    "safe_confirm_transaction",
    {
      title: "Confirm a queued Safe transaction",
      description:
        "Adds the agent's signature to a queued Safe transaction. When this signature " +
        "meets the threshold, the transaction is executed on-chain. Use this to help " +
        "along a vote that was proposed but not yet executed.",
      inputSchema: {
        safeTxHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .describe("The safeTxHash from safe_pending_transactions"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ safeTxHash }) => {
      if (config.DRY_RUN) {
        return text(`DRY_RUN is on. Would have confirmed Safe transaction ${safeTxHash}.`);
      }

      const client = await getSafeClient(config);
      const result = await client.confirm({ safeTxHash });
      const ethereumTxHash = result.transactions?.ethereumTxHash;

      return json(
        {
          status: result.status,
          description: result.description,
          safeTxHash: result.transactions?.safeTxHash ?? safeTxHash,
          ethereumTxHash: ethereumTxHash ?? null,
          explorerUrl: ethereumTxHash
            ? explorerTxUrl(config.SAFE_CHAIN_ID, ethereumTxHash) ?? null
            : null,
        },
        result.description
      );
    })
  );
}
