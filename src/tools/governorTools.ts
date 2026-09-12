import { z } from "zod";
import { getAddress, type Address } from "viem";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertAgentCanSign, getSafeClient } from "../safe.js";
import { assertGovernorAllowed, type Config } from "../config.js";
import { explorerTxUrl } from "../chains.js";
import * as governor from "../platforms/governor.js";
import * as tally from "../platforms/tally.js";
import { guard, isoTime, json, relativeTime } from "./shared.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed address");

export function registerGovernorTools(server: McpServer, config: Config): void {
  server.registerTool(
    "governor_list_proposals",
    {
      title: "List on-chain Governor proposals",
      description:
        "Lists on-chain proposals for a DAO via the Tally API, newest first. " +
        'Identify the DAO by its Tally slug (e.g. "uniswap"), its Tally organization ' +
        "id, or a specific governor id. Requires TALLY_API_KEY.",
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
      title: "Read an on-chain Governor proposal",
      description:
        "Fetches a proposal's title, full description and vote tallies from Tally. " +
        "Requires TALLY_API_KEY. For the live on-chain state of a proposal, use " +
        "governor_proposal_state instead, which needs no API key.",
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

      if (config.DRY_RUN) {
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
      const result = await client.send({
        transactions: [{ to: governorChecksum, value: "0", data }],
      });

      const ethereumTxHash = result.transactions?.ethereumTxHash;
      const safeTxHash = result.transactions?.safeTxHash;
      const executed = Boolean(ethereumTxHash);

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
