import { z } from "zod";
import { getAddress, type Address } from "viem";
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

const OPEN_STATUSES = new Set(["VotingPeriod", "VotingPeriodAccepted"]);

interface SafeVotingView {
  canVote: boolean;
  hasVoted: boolean | null;
  votingPower: string | null;
  strategies: sx.StrategyPower[];
  tally: sx.SpaceVoteState["tally"];
  authenticator: Address;
  authenticatorWhitelisted: boolean | null;
}

/** How this Safe stands on a proposal: power, prior vote, running tally. */
async function readSafeVotingView(
  config: Config,
  space: Address,
  proposalId: string,
  state: sx.SpaceProposalState,
  options: { authenticator?: Address; userParams?: Record<number, `0x${string}`> } = {}
): Promise<SafeVotingView> {
  const voter = config.SAFE_ADDRESS as Address;
  const authenticator = options.authenticator ?? sx.DEFAULT_ETH_TX_AUTHENTICATOR;

  const [voteState, strategies] = await Promise.all([
    sx.readVoteState(config, { space, proposalId, voter, authenticator }),
    state.startBlockNumber !== null && state.activeVotingStrategies !== null
      ? sx.readStrategyPowers(config, {
          space,
          voter,
          startBlockNumber: state.startBlockNumber,
          activeVotingStrategies: state.activeVotingStrategies,
          ...(options.userParams ? { userParams: options.userParams } : {}),
        })
      : Promise.resolve([] as sx.StrategyPower[]),
  ]);

  const counted = strategies.filter((s) => s.votingPower !== null);
  const votingPower =
    counted.length === 0
      ? null
      : String(counted.reduce((sum, s) => sum + BigInt(s.votingPower!), 0n));

  return {
    canVote:
      state.status !== null &&
      OPEN_STATUSES.has(state.status) &&
      voteState.hasVoted === false &&
      votingPower !== null &&
      votingPower !== "0",
    hasVoted: voteState.hasVoted,
    votingPower,
    strategies,
    tally: voteState.tally,
    authenticator,
    authenticatorWhitelisted: voteState.authenticatorWhitelisted,
  };
}

export function registerSnapshotXTools(server: McpServer, config: Config): void {
  server.registerTool(
    "snapshot_x_proposal",
    {
      title: "Read an on-chain Snapshot X proposal",
      description:
        "Reads a Snapshot X (snapshot.box) proposal straight from its space " +
        "contract: live status, the running For/Against/Abstain tally, the Safe's " +
        "voting power at the proposal's snapshot block, whether the Safe already " +
        "voted, and whether this Safe is the space controller that could cancel it. " +
        "Use it before snapshot_x_vote or snapshot_x_cancel_proposal, and again " +
        "afterwards to confirm the vote landed or the proposal shows Cancelled.",
      inputSchema: { space: spaceSchema, proposalId: proposalIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ space: spaceInput, proposalId: proposalIdInput }) => {
      const { space, proposalId } = resolveTarget(config, spaceInput, proposalIdInput);
      const state = await sx.readSpaceProposal(config, space, proposalId);
      const voting =
        state.exists === true ? await readSafeVotingView(config, space, proposalId, state) : null;

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
      if (voting) {
        if (voting.hasVoted === true) {
          notes.push("This Safe has already voted on this proposal; Snapshot X votes are final.");
        } else if (voting.canVote) {
          notes.push(
            `This Safe can vote with power ${voting.votingPower} using snapshot_x_vote.`
          );
        } else if (voting.votingPower === "0" || voting.votingPower === null) {
          notes.push(
            "This Safe has no readable voting power at the proposal's snapshot block" +
              (voting.strategies.some((s) => s.error)
                ? " (some strategies need user params, such as a whitelist proof)."
                : ".")
          );
        }
      }
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
          startBlockNumber: state.startBlockNumber,
          minEndBlockNumber: state.minEndBlockNumber,
          maxEndBlockNumber: state.maxEndBlockNumber,
          tally: voting?.tally ?? null,
          safeHasVoted: voting?.hasVoted ?? null,
          safeVotingPower: voting?.votingPower ?? null,
          safeCanVote: voting?.canVote ?? false,
          strategies: voting?.strategies ?? [],
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
    "snapshot_x_vote",
    {
      title: "Cast an on-chain Snapshot X vote from the Safe",
      description:
        "Votes For, Against or Abstain on a Snapshot X (snapshot.box) proposal as " +
        "the Safe. The Safe calls the space's EthTx authenticator, which forwards " +
        "Space.vote with the Safe as voter — the path snapshot.box itself uses for " +
        "smart-contract wallets, since a Safe cannot produce the gasless EIP-712 " +
        "signature. This is an on-chain transaction: it costs gas and is final, " +
        "Snapshot X does not allow changing a vote. The Safe's voting strategies are " +
        "resolved automatically and the vote is simulated from the Safe before " +
        "anything is signed. Read the proposal with snapshot_x_proposal first.",
      inputSchema: {
        space: spaceSchema,
        proposalId: proposalIdSchema,
        choice: z
          .enum(["for", "against", "abstain"])
          .describe("How to vote. Maps to the sx-evm Choice values 1, 0 and 2."),
        reason: z
          .string()
          .max(2_000)
          .default("")
          .describe(
            "Public rationale. Pinned to IPFS and attached to the vote as its " +
              "metadata URI, which is how snapshot.box shows a reason."
          ),
        metadataUri: z
          .string()
          .max(2_000)
          .optional()
          .describe(
            "Use this metadata URI (e.g. ipfs://…) instead of pinning the reason. " +
              "Pass an empty string to vote with no metadata."
          ),
        authenticator: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .optional()
          .describe(
            "The space's EthTx authenticator. Defaults to the snapshot.box " +
              `deployment ${sx.DEFAULT_ETH_TX_AUTHENTICATOR}; only needed for custom spaces.`
          ),
        strategyParams: z
          .array(
            z.object({
              index: z.number().int().min(0).max(255),
              params: z.string().regex(/^0x([a-fA-F0-9]{2})*$/),
            })
          )
          .optional()
          .describe(
            "Per-strategy user params, for strategies that need them (a merkle " +
              "whitelist proof, for instance). Other active strategies use 0x00."
          ),
        skipChecks: z
          .boolean()
          .default(false)
          .describe(
            "Bypass the pre-flight checks and simulation, and submit every active " +
              "strategy. Only for sx-evm forks that break the standard view methods."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(
      async ({
        space: spaceInput,
        proposalId: proposalIdInput,
        choice,
        reason,
        metadataUri: metadataUriInput,
        authenticator: authenticatorInput,
        strategyParams,
        skipChecks,
      }) => {
        const { space, proposalId } = resolveTarget(config, spaceInput, proposalIdInput);

        assertSxSpaceAllowed(config, space);

        const voter = config.SAFE_ADDRESS as Address;
        const authenticator = authenticatorInput
          ? (getAddress(authenticatorInput) as Address)
          : sx.DEFAULT_ETH_TX_AUTHENTICATOR;
        const userParams = Object.fromEntries(
          (strategyParams ?? []).map((s) => [s.index, s.params as `0x${string}`])
        );

        const blockers: string[] = [];
        const notes: string[] = [];
        let voting: SafeVotingView | null = null;
        let strategies: sx.UserStrategy[] = [];

        const state = await sx.readSpaceProposal(config, space, proposalId);

        if (skipChecks) {
          strategies =
            state.activeVotingStrategies === null
              ? (strategyParams ?? []).map((s) => ({
                  index: s.index,
                  params: s.params as `0x${string}`,
                }))
              : sx.activeStrategyIndices(state.activeVotingStrategies).map((index) => ({
                  index,
                  params: userParams[index] ?? sx.DEFAULT_USER_PARAMS,
                }));
        } else {
          if (state.exists === false) {
            blockers.push(`No proposal ${proposalId} exists in space ${space}.`);
          } else {
            voting = await readSafeVotingView(config, space, proposalId, state, {
              authenticator,
              userParams,
            });

            if (state.status !== null && !OPEN_STATUSES.has(state.status)) {
              blockers.push(
                `Proposal ${proposalId} is ${state.status}, not open for voting.`
              );
            }
            if (voting.hasVoted === true) {
              blockers.push(
                `The Safe has already voted on proposal ${proposalId}. Snapshot X votes are final.`
              );
            }
            if (voting.authenticatorWhitelisted === false) {
              blockers.push(
                `Space ${space} does not accept votes through authenticator ${authenticator}. ` +
                  "Pass the space's EthTx authenticator as `authenticator`; a space with only " +
                  "signature authenticators cannot take a vote from a Safe."
              );
            }

            // Submit only strategies that yield power: one that reverts would
            // revert the whole vote, and a zero one only costs gas.
            strategies = voting.strategies
              .filter((s) => s.votingPower !== null && s.votingPower !== "0")
              .map((s) => ({ index: s.index, params: s.userParams }));

            for (const s of voting.strategies.filter((s) => s.error !== null)) {
              notes.push(
                `Strategy ${s.index}${s.address ? ` (${s.address})` : ""} could not be ` +
                  `evaluated and was left out: ${s.error}. If it needs a proof, pass it in strategyParams.`
              );
            }

            if (strategies.length === 0) {
              blockers.push(
                `The Safe ${config.SAFE_ADDRESS} has no voting power on proposal ${proposalId} ` +
                  `at its snapshot block ${state.startBlockNumber ?? "?"}. Check the token is held ` +
                  "or delegated to the Safe, or pass strategyParams for whitelist strategies."
              );
            }
          }
        }

        // The reason is pinned only when the vote can go ahead, so a blocked
        // or dry run does not publish anything.
        let metadataUri = metadataUriInput ?? "";
        const willSend = blockers.length === 0 && !config.DRY_RUN;
        if (metadataUriInput === undefined && reason.trim() !== "" && willSend) {
          const pinned = await sx.pinReason(reason);
          if (pinned) {
            metadataUri = pinned;
          } else {
            notes.push(
              "The reason could not be pinned to IPFS, so the vote carries no public reason; " +
                "it is kept in the local vote log."
            );
          }
        }

        if (!skipChecks && blockers.length === 0) {
          const sim = await sx.simulateEthTxVote(config, {
            authenticator,
            space,
            voter,
            proposalId,
            choice,
            strategies,
            metadataUri,
          });
          if (!sim.ok && sim.reason !== null) blockers.push(sim.reason);
        }

        if (blockers.length > 0 && !config.DRY_RUN) {
          throw new Error([...blockers, ...notes].join(" "));
        }

        const data = sx.encodeEthTxVote({
          space,
          voter,
          proposalId,
          choice,
          strategies,
          metadataUri,
        });

        const verifyBeforeSigning = {
          to: authenticator,
          data,
          value: "0",
          method: "authenticate(address,bytes4,bytes)",
          forwardsTo: `${space}.vote(${voter}, ${proposalId}, ${sx.CHOICE_VALUE[choice]} /* ${choice} */, …)`,
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
            choice,
            reason,
            votingPower: voting?.votingPower ?? null,
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
              notes,
              space,
              proposalId,
              choice,
              choiceValue: sx.CHOICE_VALUE[choice],
              reason,
              votingPower: voting?.votingPower ?? null,
              strategies,
              transaction: verifyBeforeSigning,
              url: proposalUrl(config, space, proposalId),
            },
            blockers.length > 0
              ? `DRY_RUN is on, and this vote would be REJECTED: ${blockers.join(" ")} ` +
                  "The transaction that would have been proposed is below."
              : `DRY_RUN is on. Would have voted "${choice}" on proposal ${proposalId} in space ${space}` +
                  (reason ? " (the reason would be pinned to IPFS on a live vote)." : ".")
          );
        }

        await assertAgentCanSign(config);

        const client = await getSafeClient(config);
        const threshold = await client.getThreshold().catch(() => 0);

        // At threshold 1 the agent executes on the spot and pays gas; above
        // that this call only proposes to the Transaction Service.
        if (threshold === 1) await assertAgentCanPayGas(config);

        let result: Awaited<ReturnType<typeof client.send>>;

        try {
          result = await client.send({
            transactions: [{ to: authenticator, value: "0", data }],
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
            choice,
            choiceValue: sx.CHOICE_VALUE[choice],
            reason,
            metadataUri: metadataUri || null,
            votingPower: voting?.votingPower ?? null,
            strategies,
            notes,
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
          (executed
            ? `Voted "${choice}" on proposal ${proposalId} in space ${space}. Transaction ${ethereumTxHash}. ` +
              "Confirm with snapshot_x_proposal."
            : `The vote is queued on the Safe as ${safeTxHash} and needs ${signaturesOutstanding} more ` +
              `signature(s) of ${threshold}. Other owners should check it goes To ${authenticator} ` +
              `(the space's EthTx authenticator) with value 0 and confirm before voting closes` +
              (safeQueueUrl(config) ? ` (${safeQueueUrl(config)})` : "") +
              ", or the agent can finish it with safe_confirm_transaction once enough owners signed.") +
            (notes.length > 0 ? ` ${notes.join(" ")}` : "")
        );
      }
    )
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
