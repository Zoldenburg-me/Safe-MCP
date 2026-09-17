import { z } from "zod";
import type { Address } from "viem";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertAgentCanPayGas, assertAgentCanSign, getSafeClient } from "../safe.js";
import type { Config } from "../config.js";
import { explorerTxUrl, getChainName } from "../chains.js";
import * as sx from "../platforms/snapshotX.js";
import { appendVote, type VoteOutcome } from "../voteLog.js";
import { guard, json } from "./shared.js";

const spaceSchema = z
  .string()
  .describe(
    "The Snapshot X space: a space contract address, a prefixed id like " +
      '"eth:0x594E…", or a full snapshot.box proposal URL (in which case ' +
      "proposalId can be omitted)."
  );

const proposalIdSchema = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .optional()
  .describe("The proposal number, e.g. 3. Not needed when the space is a proposal URL.");

/** Resolves space + proposal from the flexible inputs, or throws a clear error. */
function resolveTarget(
  config: Config,
  spaceInput: string,
  proposalIdInput: string | number | undefined
): { space: Address; proposalId: string } {
  const ref = sx.parseSpaceRef(spaceInput);

  if (ref.chainId !== undefined && ref.chainId !== config.SAFE_CHAIN_ID) {
    throw new Error(
      `The space "${spaceInput.trim()}" is on chain ${ref.chainId}, but this Safe is on ` +
        `${getChainName(config.SAFE_CHAIN_ID)} (chain ${config.SAFE_CHAIN_ID}). ` +
        "A Safe can only manage Snapshot X spaces on its own chain."
    );
  }

  const proposalId =
    proposalIdInput !== undefined ? String(proposalIdInput) : ref.proposalId;

  if (proposalId === undefined) {
    throw new Error(
      "No proposal id given: pass proposalId, or a full snapshot.box proposal URL as the space."
    );
  }

  return { space: ref.space, proposalId };
}

function proposalUrl(config: Config, space: Address, proposalId: string): string {
  const shortName = sx.chainShortName(config.SAFE_CHAIN_ID);
  return shortName
    ? `https://snapshot.box/#/${shortName}:${space}/proposal/${proposalId}`
    : `https://snapshot.box/#/${space}/proposal/${proposalId}`;
}

/**
 * Guards a Snapshot X space against ALLOWED_SNAPSHOT_SPACES. Operators write
 * these spaces either as the bare contract address or in the "eth:0x…" form
 * snapshot.box shows, so both spellings count.
 */
function assertSxSpaceAllowed(config: Config, space: Address): void {
  if (config.ALLOWED_SNAPSHOT_SPACES.length === 0) return;

  const shortName = sx.chainShortName(config.SAFE_CHAIN_ID);
  const spellings = [
    space.toLowerCase(),
    ...(shortName ? [`${shortName}:${space.toLowerCase()}`] : []),
  ];

  if (spellings.some((s) => config.ALLOWED_SNAPSHOT_SPACES.includes(s))) return;

  throw new Error(
    `Snapshot X space "${space}" is not in ALLOWED_SNAPSHOT_SPACES ` +
      `(${config.ALLOWED_SNAPSHOT_SPACES.join(", ")}). ` +
      `Add "${spellings[spellings.length - 1]}" to the allowlist to let the agent act there.`
  );
}

function safeQueueUrl(config: Config): string | null {
  const shortName = sx.chainShortName(config.SAFE_CHAIN_ID);
  return shortName
    ? `https://app.safe.global/transactions/queue?safe=${shortName}:${config.SAFE_ADDRESS}`
    : null;
}

export function registerSnapshotXTools(server: McpServer, config: Config): void {
  server.registerTool(
    "snapshot_x_proposal",
    {
      title: "Read an on-chain Snapshot X proposal",
      description:
        "Reads a Snapshot X (snapshot.box) proposal straight from its space " +
        "contract: live status, finalization state, author, and whether this Safe " +
        "is the space controller that could cancel it. Use it before " +
        "snapshot_x_cancel_proposal, and again afterwards to confirm the proposal " +
        "shows Cancelled.",
      inputSchema: { space: spaceSchema, proposalId: proposalIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ space: spaceInput, proposalId: proposalIdInput }) => {
      const { space, proposalId } = resolveTarget(config, spaceInput, proposalIdInput);
      const state = await sx.readSpaceProposal(config, space, proposalId);

      const safeIsController =
        state.owner === null
          ? null
          : state.owner.toLowerCase() === config.safeAddressLower;

      const cancellable =
        state.exists === true && state.finalizationStatus === "Pending";

      const notes: string[] = [];
      if (state.exists === false) {
        notes.push(
          `No proposal ${proposalId} exists in this space` +
            (state.nextProposalId !== null
              ? ` (ids run 1 to ${BigInt(state.nextProposalId) - 1n})`
              : "") +
            "."
        );
      }
      if (state.status !== null) notes.push(`Live status: ${state.status}.`);
      if (state.finalizationStatus !== null && state.finalizationStatus !== "Pending") {
        notes.push(`The proposal is finalized as ${state.finalizationStatus}.`);
      }
      if (safeIsController === true) {
        notes.push(
          cancellable
            ? "This Safe controls the space and can cancel the proposal with snapshot_x_cancel_proposal."
            : "This Safe controls the space."
        );
      } else if (safeIsController === false) {
        notes.push(
          `The space is controlled by ${state.owner}, not this Safe, so this Safe cannot cancel its proposals.`
        );
      }
      if (state.readErrors.length > 0) {
        notes.push(`Some reads failed: ${state.readErrors.join("; ")}`);
      }

      return json(
        {
          space,
          chainId: config.SAFE_CHAIN_ID,
          proposalId,
          exists: state.exists,
          status: state.status,
          finalizationStatus: state.finalizationStatus,
          author: state.author,
          spaceController: state.owner,
          safeIsController,
          cancellable: cancellable && safeIsController === true,
          url: proposalUrl(config, space, proposalId),
        },
        notes.join(" ")
      );
    })
  );

  server.registerTool(
    "snapshot_x_cancel_proposal",
    {
      title: "Cancel a Snapshot X proposal from the Safe",
      description:
        "Cancels (vetoes) an on-chain Snapshot X proposal by proposing " +
        "Space.cancel(proposalId) from the Safe — the streamlined replacement for " +
        "wiring snapshot.box to the Safe over WalletConnect by hand. Only works " +
        "when the Safe is the space controller. At threshold 1 the transaction " +
        "executes immediately; above that it lands in the Safe queue with the " +
        "exact to/data/value for the other owners to verify and sign, and the " +
        "final signer's confirmation executes it.",
      inputSchema: {
        space: spaceSchema,
        proposalId: proposalIdSchema,
        reason: z
          .string()
          .max(2_000)
          .default("")
          .describe("Why the proposal is being cancelled. Recorded in the local log only."),
        skipChecks: z
          .boolean()
          .default(false)
          .describe(
            "Bypass the pre-flight controller/state checks and simulation. Only " +
              "for sx-evm forks that break the standard view methods."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(async ({ space: spaceInput, proposalId: proposalIdInput, reason, skipChecks }) => {
      const { space, proposalId } = resolveTarget(config, spaceInput, proposalIdInput);

      assertSxSpaceAllowed(config, space);

      // Pre-flight. A live cancel stops on blockers; a dry run reports them and
      // still returns the payload it would have proposed.
      const blockers: string[] = [];
      let state: sx.SpaceProposalState | null = null;

      if (!skipChecks) {
        state = await sx.readSpaceProposal(config, space, proposalId);

        if (state.owner !== null && state.owner.toLowerCase() !== config.safeAddressLower) {
          blockers.push(
            `The Safe ${config.SAFE_ADDRESS} is not the controller of this space — ` +
              `${state.owner} is — and Space.cancel is restricted to the controller.`
          );
        }
        if (state.exists === false) {
          blockers.push(`No proposal ${proposalId} exists in space ${space}.`);
        }
        if (state.finalizationStatus !== null && state.finalizationStatus !== "Pending") {
          blockers.push(
            `Proposal ${proposalId} is already finalized as ${state.finalizationStatus}.`
          );
        }

        // The simulation is the authoritative check: it is the same evaluation
        // the chain will make, so it also catches whatever the reads missed.
        const sim = await sx.simulateCancel(config, {
          space,
          proposalId,
          from: config.SAFE_ADDRESS as Address,
        });
        if (!sim.ok && sim.reason !== null && blockers.length === 0) {
          blockers.push(sim.reason);
        }
      }

      if (blockers.length > 0 && !config.DRY_RUN) {
        throw new Error(blockers.join(" "));
      }

      const data = sx.encodeCancel(proposalId);

      // What every co-signer checks in the Safe queue before confirming. This
      // is the same checklist DAOs pass around by hand; emitting it with the
      // transaction means nobody has to reconstruct the calldata to verify it.
      const verifyBeforeSigning = {
        to: space,
        data,
        value: "0",
        method: "cancel(uint256)",
        proposalId,
      };

      const record = (
        outcome: VoteOutcome,
        extra: { receipt?: string | null; safeTxHash?: string | null; error?: string | null }
      ) =>
        appendVote(config, {
          platform: "snapshot-x",
          outcome,
          safeAddress: config.SAFE_ADDRESS,
          chainId: config.SAFE_CHAIN_ID,
          proposalId,
          venue: space,
          title: null,
          choice: "cancel",
          reason,
          votingPower: null,
          receipt: extra.receipt ?? null,
          safeTxHash: extra.safeTxHash ?? null,
          safeMessageHash: null,
          error: extra.error ?? null,
        });

      if (config.DRY_RUN) {
        await record("dry-run", {
          error: blockers.length > 0 ? blockers.join(" ") : null,
        });

        return json(
          {
            dryRun: true,
            blocked: blockers.length > 0,
            blockers,
            space,
            proposalId,
            reason,
            transaction: verifyBeforeSigning,
            preflight: state,
            url: proposalUrl(config, space, proposalId),
          },
          blockers.length > 0
            ? `DRY_RUN is on, and this cancel would be REJECTED: ${blockers.join(" ")} ` +
                "The transaction that would have been proposed is below."
            : `DRY_RUN is on. Would have proposed cancel(${proposalId}) on space ${space} to the Safe.`
        );
      }

      await assertAgentCanSign(config);

      const client = await getSafeClient(config);
      const threshold = await client.getThreshold().catch(() => 0);

      // At threshold 1 the agent executes on the spot and pays gas; above that
      // this call only proposes to the Transaction Service, which is free.
      if (threshold === 1) await assertAgentCanPayGas(config);

      let result: Awaited<ReturnType<typeof client.send>>;

      try {
        result = await client.send({
          transactions: [{ to: space, value: "0", data }],
        });
      } catch (error) {
        await record("failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const ethereumTxHash = result.transactions?.ethereumTxHash;
      const safeTxHash = result.transactions?.safeTxHash;
      const executed = Boolean(ethereumTxHash);
      const signaturesOutstanding = executed ? 0 : Math.max(threshold - 1, 0);

      await record(executed ? "submitted" : "queued", {
        receipt: ethereumTxHash ?? null,
        safeTxHash: safeTxHash ?? null,
      });

      return json(
        {
          executed,
          status: result.status,
          space,
          proposalId,
          reason,
          transaction: verifyBeforeSigning,
          safeTxHash: safeTxHash ?? null,
          ethereumTxHash: ethereumTxHash ?? null,
          explorerUrl: ethereumTxHash
            ? explorerTxUrl(config.SAFE_CHAIN_ID, ethereumTxHash) ?? null
            : null,
          confirmations: executed ? null : `1/${threshold}`,
          signaturesOutstanding,
          safeQueueUrl: safeQueueUrl(config),
          url: proposalUrl(config, space, proposalId),
        },
        executed
          ? `Cancelled proposal ${proposalId} on space ${space}. Transaction ${ethereumTxHash}. ` +
              "The proposal should now show Cancelled on snapshot.box; confirm with snapshot_x_proposal."
          : `The cancel is queued on the Safe as ${safeTxHash} and needs ${signaturesOutstanding} more ` +
              `signature(s) of ${threshold}. Tell the other owners to open the Safe queue` +
              (safeQueueUrl(config) ? ` (${safeQueueUrl(config)})` : "") +
              `, check the transaction matches To ${space}, method cancel, value 0, ` +
              `data ${data}, and confirm. The final signer's confirmation executes it, or ` +
              "the agent can finish it with safe_confirm_transaction once enough owners signed."
      );
    })
  );
}
