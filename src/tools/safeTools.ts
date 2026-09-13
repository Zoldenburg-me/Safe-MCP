import { z } from "zod";
import { formatEther } from "viem";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentAddress, getPublicClient, getSafeClient } from "../safe.js";
import { describeEnvSource } from "../dotenv.js";
import { explorerTxUrl, getChainName } from "../chains.js";
import { guard, json, text } from "./shared.js";
import type { Config } from "../config.js";

export function registerSafeTools(server: McpServer, config: Config): void {
  server.registerTool(
    "safe_info",
    {
      title: "Safe wallet info",
      description:
        "Reports the configured Safe and the agent's readiness to vote: chain, owners, " +
        "threshold, nonce, both ETH balances, and whether the agent's signer key is an " +
        "owner that can execute alone. The agent's own balance is what pays gas for " +
        "on-chain votes; Snapshot votes are gasless and need none. Call this first.",
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

      const client_ = getPublicClient(config);

      // The Safe's balance funds proposal payloads; the agent's balance pays the
      // gas for execTransaction. They are separate concerns and both are worth
      // surfacing, because the agent's is the one that stops votes landing.
      const [safeBalance, agentBalance] = await Promise.all([
        client_.getBalance({ address: config.SAFE_ADDRESS as `0x${string}` }).catch(() => null),
        client_.getBalance({ address: agent as `0x${string}` }).catch(() => null),
      ]);

      const isOwner = owners.some((o) => o.toLowerCase() === agent.toLowerCase());
      const agentIsFunded = agentBalance !== null && agentBalance > 0n;

      return json(
        {
          safeAddress: config.SAFE_ADDRESS,
          chainId: config.SAFE_CHAIN_ID,
          chainName: getChainName(config.SAFE_CHAIN_ID),
          deployed,
          owners,
          threshold,
          nonce,
          safeBalance: safeBalance === null ? null : formatEther(safeBalance),
          agentSigner: agent,
          agentBalance: agentBalance === null ? null : formatEther(agentBalance),
          agentIsOwner: isOwner,
          agentCanExecuteAlone: isOwner && threshold === 1,
          canVoteOnSnapshot: isOwner,
          canVoteOnChain: isOwner && agentIsFunded,
          dryRun: config.DRY_RUN,
          // Where DRY_RUN was read from. An MCP client that caches its launch
          // config keeps passing a stale value in the environment, where it
          // wins over the .env file the operator just edited.
          dryRunSource: describeEnvSource("DRY_RUN"),
          watchSnapshotAuto: config.WATCH_SNAPSHOT_AUTO,
          snapshotTestSpace: config.SNAPSHOT_TEST_SPACE || null,
          allowedSnapshotSpaces:
            config.ALLOWED_SNAPSHOT_SPACES.length > 0
              ? config.ALLOWED_SNAPSHOT_SPACES
              : "all",
          allowedGovernors:
            config.ALLOWED_GOVERNORS.length > 0 ? config.ALLOWED_GOVERNORS : "all",
        },
        [
          config.DRY_RUN
            ? `DRY_RUN is ON, read from ${describeEnvSource("DRY_RUN")}: no vote will be ` +
              "submitted. If you meant it to be off and it is coming from the process " +
              "environment, the MCP client is passing a cached value and needs its " +
              "server entry updated, not just a restart."
            : "DRY_RUN is off: votes are real.",
          isOwner
            ? threshold === 1
              ? "The agent signer is an owner and the threshold is 1, so it can cast votes on its own."
              : `The agent signer is an owner, but the threshold is ${threshold}. Votes will be proposed and need ${threshold - 1} more confirmation(s).`
            : `WARNING: the agent signer ${agent} is not an owner of this Safe and cannot vote.`,
          agentIsFunded
            ? "Snapshot voting is gasless. On-chain Governor voting is funded by the agent signer, which holds ETH."
            : "Snapshot voting is gasless and works as is. On-chain Governor voting will fail: " +
              `the agent signer ${agent} holds no ETH, and it is the account that pays gas ` +
              "for execTransaction. Send ETH to the agent signer, not to the Safe.",
        ].join(" ")
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
