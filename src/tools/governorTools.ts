import { z } from "zod";
import { getAddress, type Address } from "viem";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertAgentCanSign, getSafeClient } from "../safe.js";
import { assertGovernorAllowed, type Config } from "../config.js";
import { explorerTxUrl } from "../chains.js";
import * as governor from "../platforms/governor.js";
import * as tally from "../platforms/tally.js";
import * as indexer from "../platforms/governorIndexer.js";
import { appendVote, type VoteOutcome } from "../voteLog.js";
import { guard, isoTime, json, relativeTime } from "./shared.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed address");

export function registerGovernorTools(server: McpServer, config: Config): void {
  server.registerTool(
    "governor_find_proposals",
    {
      title: "Find on-chain Governor proposals (no API key)",
      description:
        "Discovers proposals by reading ProposalCreated logs straight from a " +
        "Governor contract, then filtering by the contract's live state. Returns " +
        "the full proposal description, so no third-party indexer is involved. " +
        "This is the supported way to find on-chain proposals: Tally shut down in " +
        "March 2026. Works with OpenZeppelin Governor and Compound Bravo.",
      inputSchema: {
        governor: addressSchema.describe("Governor contract address"),
        states: z
          .array(
            z.enum([
              "Pending",
              "Active",
              "Canceled",
              "Defeated",
              "Succeeded",
              "Queued",
              "Expired",
              "Executed",
            ])
          )
          .default(["Pending", "Active"])
          .describe("Which proposal states to return"),
        lookback: z
          .string()
          .optional()
          .describe(
            'Override how far back to scan, e.g. "7d". By default the window is ' +
              "derived from the Governor's own votingDelay and votingPeriod, which " +
              "is the shortest span that can still contain an open proposal. Only " +
              "set this if the Governor's parameters changed recently."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ governor: governorAddress, states, lookback }) => {
      const { proposals, lookback: window } = await indexer.findProposals(config, {
        governor: getAddress(governorAddress) as Address,
        states,
        ...(lookback ? { lookback } : {}),
      });

      const rows = proposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        title: proposal.title,
        state: proposal.state,
        proposer: proposal.proposer,
        voteEnd: proposal.voteEnd,
        endsAt: proposal.endsAt.toISOString(),
        endsAtIsEstimate: proposal.endsAtIsEstimate,
        closesIn: relativeTime(Math.floor(proposal.endsAt.getTime() / 1000)),
        description: proposal.description,
      }));

      const estimated = rows.some((row) => row.endsAtIsEstimate);

      return json(
        {
          governor: governorAddress,
          count: rows.length,
          scanWindow: { source: window.source, detail: window.detail },
          proposals: rows,
        },
        (rows.length === 0
          ? `No proposals in those states. Scanned back ${window.detail}.`
          : `${rows.length} proposal(s).`) +
          (estimated
            ? " This Governor counts time in blocks, so each deadline is estimated from" +
              " the chain's recent average block time and will drift."
            : "")
      );
    })
  );

  server.registerTool(
    "governor_list_proposals",
    {
      title: "List Governor proposals via a hosted indexer (legacy)",
      description:
        "Legacy path: lists proposals through the Tally-compatible hosted API. " +
        "Tally shut down in March 2026 and is now Cactus, so this may fail even " +
        "with a key. Prefer governor_find_proposals, which reads the Governor " +
        "contract directly and needs no API key.",
      inputSchema: {
        organizationSlug: z
          .string()
          .optional()
          .describe('Tally slug from the DAO\'s tally.xyz URL, e.g. "uniswap"'),
        organizationId: z.string().optional(),
        governorId: z
          .string()
          .optional()
          .describe('Tally governor id, e.g. "eip155:1:0x408E..."'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ organizationSlug, organizationId, governorId, limit }) => {
      const proposals = await tally.listProposals(config, {
        ...(organizationSlug ? { organizationSlug } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(governorId ? { governorId } : {}),
        limit,
      });

      const rows = proposals.map((p) => ({
        tallyId: p.id,
        onchainId: p.onchainId,
        title: p.metadata?.title ?? "(untitled)",
        status: p.status,
        governorId: p.governor?.id ?? null,
        governorName: p.governor?.name ?? null,
        start: isoTime(p.start?.timestamp ? Date.parse(p.start.timestamp) / 1000 : null),
        end: isoTime(p.end?.timestamp ? Date.parse(p.end.timestamp) / 1000 : null),
        closesIn: p.end?.timestamp ? relativeTime(Date.parse(p.end.timestamp) / 1000) : "-",
        voteStats: p.voteStats,
      }));

      return json(
        { count: rows.length, proposals: rows },
        rows.length === 0
          ? "No proposals found."
          : `${rows.length} proposal(s). Use onchainId with governor_vote, and note that ` +
              "the governor contract address is the last segment of governorId."
      );
    })
  );

  server.registerTool(
    "governor_get_proposal",
    {
      title: "Read a Governor proposal via a hosted indexer (legacy)",
      description:
        "Legacy path: fetches a proposal's title, description and tallies from the " +
        "Tally-compatible hosted API, which shut down in March 2026. Prefer " +
        "governor_find_proposals for the description and governor_proposal_state " +
        "for live on-chain state; neither needs an API key.",
      inputSchema: {
        tallyId: z.string().optional().describe("Tally's internal proposal id"),
        onchainId: z.string().optional().describe("The Governor contract's proposal id"),
        governorId: z.string().optional().describe("Required alongside onchainId"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ tallyId, onchainId, governorId }) => {
      const proposal = await tally.getProposal(config, {
        ...(tallyId ? { id: tallyId } : {}),
        ...(onchainId ? { onchainId } : {}),
        ...(governorId ? { governorId } : {}),
      });

      return json({
        tallyId: proposal.id,
        onchainId: proposal.onchainId,
        title: proposal.metadata?.title ?? "(untitled)",
        description: proposal.metadata?.description ?? "",
        status: proposal.status,
        quorum: proposal.quorum,
        voteStats: proposal.voteStats,
        governor: proposal.governor,
        organization: proposal.organization,
        start: proposal.start?.timestamp ?? null,
        end: proposal.end?.timestamp ?? null,
      });
    })
  );

  server.registerTool(
    "governor_proposal_state",
    {
      title: "Read live Governor state for a proposal",
      description:
        "Reads the Governor contract directly: the proposal's state, whether the Safe " +
        "has already voted, the Safe's voting power at the proposal's snapshot, the " +
        "quorum and the running tally. Needs no API key. Call this before voting.",
      inputSchema: {
        governor: addressSchema.describe("Governor contract address"),
        proposalId: z.string().describe("On-chain proposal id (decimal or 0x hex)"),
        decimals: z
          .number()
          .int()
          .min(0)
          .max(36)
          .default(18)
          .describe("Governance token decimals, for readable vote weights"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ governor: governorAddress, proposalId, decimals }) => {
      const state = await governor.readProposalState(config, {
        governor: getAddress(governorAddress) as Address,
        proposalId,
        voter: config.SAFE_ADDRESS as Address,
        decimals,
      });

      const notes: string[] = [];
      if (state.state !== "Active") {
        notes.push(`The proposal is "${state.state}", so it cannot be voted on now.`);
      }
      if (state.hasVoted) {
        notes.push("The Safe has already voted; Governor votes cannot be changed.");
      }
      if (state.votingPowerRaw === "0") {
        notes.push(
          "The Safe had no voting power at the snapshot block, so a vote would be rejected."
        );
      }

      return json(
        { safeAddress: config.SAFE_ADDRESS, ...state },
        notes.length > 0 ? notes.join(" ") : "The Safe can vote on this proposal."
      );
    })
  );

  server.registerTool(
    "governor_vote",
    {
      title: "Cast an on-chain Governor vote from the Safe",
      description:
        "Votes on an OpenZeppelin or Compound-style Governor by executing " +
        "castVoteWithReason from the Safe. This is a real on-chain transaction that " +
        "costs gas and cannot be undone or changed. Check governor_proposal_state " +
        "first to confirm the proposal is Active and the Safe has voting power.",
      inputSchema: {
        governor: addressSchema.describe("Governor contract address"),
        proposalId: z.string().describe("On-chain proposal id (decimal or 0x hex)"),
        support: z
          .enum(["for", "against", "abstain"])
          .describe("How to vote. Maps to Governor support values 1, 0 and 2."),
        reason: z
          .string()
          .max(2_000)
          .default("")
          .describe(
            "Public rationale stored on-chain with the vote. Costs extra gas but is " +
              "strongly recommended for an agent vote."
          ),
        skipChecks: z
          .boolean()
          .default(false)
          .describe(
            "Bypass the pre-flight state and voting-power checks. Only for unusual " +
              "Governor forks that do not implement the standard view methods."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(async ({ governor: governorAddress, proposalId, support, reason, skipChecks }) => {
      const governorChecksum = getAddress(governorAddress) as Address;

      assertGovernorAllowed(config, governorChecksum);

      let preflight: governor.GovernorProposalState | null = null;

      if (!skipChecks) {
        preflight = await governor.readProposalState(config, {
          governor: governorChecksum,
          proposalId,
          voter: config.SAFE_ADDRESS as Address,
        });

        if (preflight.state !== "Active") {
          throw new Error(
            `Proposal ${proposalId} is "${preflight.state}", not Active, so the Governor ` +
              "would revert the vote."
          );
        }
        if (preflight.hasVoted) {
          throw new Error(
            `The Safe has already voted on proposal ${proposalId}. Governor votes are final.`
          );
        }
        if (preflight.votingPowerRaw === "0") {
          throw new Error(
            `The Safe ${config.SAFE_ADDRESS} had no voting power at the snapshot ` +
              `(timepoint ${preflight.snapshotTimepoint}), so the Governor would revert. ` +
              "Check that the governance token is held or delegated to the Safe."
          );
        }
      }

      const data = governor.encodeCastVote({ proposalId, support, reason });

      const record = (
        outcome: VoteOutcome,
        extra: {
          receipt?: string | null;
          safeTxHash?: string | null;
          error?: string | null;
        }
      ) =>
        appendVote(config, {
          platform: "governor",
          outcome,
          safeAddress: config.SAFE_ADDRESS,
          chainId: config.SAFE_CHAIN_ID,
          proposalId,
          venue: governorChecksum,
          title: null,
          choice: support,
          reason,
          votingPower: preflight?.votingPower ?? null,
          receipt: extra.receipt ?? null,
          safeTxHash: extra.safeTxHash ?? null,
          safeMessageHash: null,
          error: extra.error ?? null,
        });

      if (config.DRY_RUN) {
        await record("dry-run", {});

        return json(
          {
            dryRun: true,
            governor: governorChecksum,
            proposalId,
            support,
            supportValue: governor.supportToUint8(support),
            reason,
            calldata: data,
            preflight,
          },
          `DRY_RUN is on. Would have voted "${support}" on proposal ${proposalId}.`
        );
      }

      await assertAgentCanSign(config);

      const client = await getSafeClient(config);

      let result: Awaited<ReturnType<typeof client.send>>;

      try {
        result = await client.send({
          transactions: [{ to: governorChecksum, value: "0", data }],
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

      await record(executed ? "submitted" : "queued", {
        receipt: ethereumTxHash ?? null,
        safeTxHash: safeTxHash ?? null,
      });

      return json(
        {
          executed,
          status: result.status,
          description: result.description,
          governor: governorChecksum,
          proposalId,
          support,
          supportValue: governor.supportToUint8(support),
          reason,
          safeTxHash: safeTxHash ?? null,
          ethereumTxHash: ethereumTxHash ?? null,
          explorerUrl: ethereumTxHash
            ? explorerTxUrl(config.SAFE_CHAIN_ID, ethereumTxHash) ?? null
            : null,
          votingPower: preflight?.votingPower ?? null,
        },
        executed
          ? `Voted "${support}" on proposal ${proposalId}. Transaction ${ethereumTxHash}.`
          : `The vote was proposed to the Safe as ${safeTxHash} but needs more owner ` +
              "confirmations before it executes. Use safe_confirm_transaction or the Safe UI."
      );
    })
  );
}
