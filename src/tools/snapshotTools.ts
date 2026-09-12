import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertAgentCanSign, getMessageClient, getSafeClient } from "../safe.js";
import { assertSpaceAllowed, type Config } from "../config.js";
import * as snapshot from "../platforms/snapshot.js";
import { guard, isoTime, json, relativeTime } from "./shared.js";

const APP_NAME = "safe-mpc";

/** How long to wait for the Transaction Service to index a new Safe message. */
const SIGNATURE_POLL_ATTEMPTS = 10;
const SIGNATURE_POLL_DELAY_MS = 1_500;

const choiceSchema = z
  .union([
    z.number().int().positive(),
    z.array(z.number().int().positive()),
    z.record(z.string(), z.number().positive()),
  ])
  .describe(
    "1-indexed choice. A single number for single-choice/basic proposals, " +
      "an array for approval or ranked-choice, or an object of option->weight " +
      "for weighted or quadratic (e.g. {\"1\": 70, \"2\": 30})."
  );

/**
 * Waits for the Safe Transaction Service to assemble a signature that satisfies
 * the Safe's threshold. `preparedSignature` is the concatenated, owner-sorted
 * bundle that Snapshot will hand to the Safe's EIP-1271 validator.
 */
async function awaitPreparedSignature(
  config: Config,
  messageHash: string
): Promise<{ signature: string; confirmations: number; threshold: number }> {
  const client = await getSafeClient(config);
  const threshold = await client.getThreshold();

  for (let attempt = 0; attempt < SIGNATURE_POLL_ATTEMPTS; attempt += 1) {
    const message = await client.apiKit.getMessage(messageHash).catch(() => null);

    if (message) {
      const confirmations = message.confirmations?.length ?? 0;

      if (message.preparedSignature && confirmations >= threshold) {
        return { signature: message.preparedSignature, confirmations, threshold };
      }

      // Threshold not met yet: more owners must sign before Snapshot will
      // accept the vote. Stop polling and report that clearly.
      if (confirmations > 0 && confirmations < threshold) {
        throw new Error(
          `The Safe message is signed by ${confirmations} of ${threshold} required owners. ` +
            `Ask the remaining owner(s) to sign message ${messageHash} in the Safe UI, ` +
            "then call snapshot_submit_pending_vote to send the vote."
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, SIGNATURE_POLL_DELAY_MS));
  }

  throw new Error(
    `Timed out waiting for the Safe Transaction Service to index message ${messageHash}. ` +
      "The signature may still land; retry with snapshot_submit_pending_vote."
  );
}

export function registerSnapshotTools(server: McpServer, config: Config): void {
  server.registerTool(
    "snapshot_list_proposals",
    {
      title: "List Snapshot proposals",
      description:
        "Lists proposals in a Snapshot space, newest first. Defaults to proposals " +
        "that are currently open for voting.",
      inputSchema: {
        space: z.string().describe('Snapshot space id, e.g. "ens.eth" or "aavedao.eth"'),
        state: z
          .enum(["active", "pending", "closed", "all"])
          .default("active")
          .describe("Which proposals to return"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ space, state, limit }) => {
      const proposals = await snapshot.listProposals(config, { space, state, limit });

      const rows = proposals.map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        state: p.state,
        choices: p.choices,
        start: isoTime(p.start),
        end: isoTime(p.end),
        closesIn: relativeTime(p.end),
        scoresTotal: p.scores_total,
        quorum: p.quorum,
        url: `https://snapshot.box/#/s:${p.space.id}/proposal/${p.id}`,
      }));

      return json(
        { space, state, count: rows.length, proposals: rows },
        rows.length === 0
          ? `No ${state} proposals in ${space}.`
          : `${rows.length} ${state} proposal(s) in ${space}.`
      );
    })
  );

  server.registerTool(
    "snapshot_get_proposal",
    {
      title: "Read a Snapshot proposal",
      description:
        "Fetches a Snapshot proposal in full, including the body text, the voting " +
        "system, every choice with its index, current scores, and how much voting " +
        "power the Safe holds. Read this before voting.",
      inputSchema: {
        proposalId: z.string().describe("Snapshot proposal id (0x… hash)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ proposalId }) => {
      const proposal = await snapshot.getProposal(config, proposalId);

      const [power, existingVotes] = await Promise.all([
        snapshot
          .getVotingPower(config, {
            space: proposal.space.id,
            proposalId,
            voter: config.SAFE_ADDRESS,
          })
          .catch(() => null),
        snapshot
          .getVotes(config, { proposalId, voter: config.SAFE_ADDRESS })
          .catch(() => []),
      ]);

      return json({
        id: proposal.id,
        space: proposal.space,
        title: proposal.title,
        body: proposal.body,
        votingSystem: proposal.type,
        state: proposal.state,
        choices: proposal.choices.map((label, index) => ({
          index: index + 1,
          label,
          score: proposal.scores?.[index] ?? null,
        })),
        scoresTotal: proposal.scores_total,
        quorum: proposal.quorum,
        start: isoTime(proposal.start),
        end: isoTime(proposal.end),
        closesIn: relativeTime(proposal.end),
        author: proposal.author,
        discussion: proposal.link,
        safeVotingPower: power?.vp ?? null,
        safeAlreadyVoted: existingVotes.length > 0,
        safeExistingVote:
          existingVotes[0] === undefined
            ? null
            : {
                choice: snapshot.describeChoice(proposal, existingVotes[0].choice),
                reason: existingVotes[0].reason,
                votedAt: isoTime(existingVotes[0].created),
              },
        url: `https://snapshot.box/#/s:${proposal.space.id}/proposal/${proposal.id}`,
      });
    })
  );

  server.registerTool(
    "snapshot_voting_power",
    {
      title: "Safe voting power on a Snapshot proposal",
      description:
        "Reports how much voting power the Safe has on a specific proposal, broken " +
        "down by the space's strategies. Zero means the vote would carry no weight.",
      inputSchema: {
        space: z.string(),
        proposalId: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ space, proposalId }) => {
      const power = await snapshot.getVotingPower(config, {
        space,
        proposalId,
        voter: config.SAFE_ADDRESS,
      });

      return json(
        {
          safeAddress: config.SAFE_ADDRESS,
          space,
          proposalId,
          votingPower: power.vp,
          byStrategy: power.vpByStrategy,
          state: power.vpState,
        },
        power.vp > 0
          ? `The Safe holds ${power.vp} voting power on this proposal.`
          : "The Safe holds no voting power on this proposal, so a vote would have no effect."
      );
    })
  );

  server.registerTool(
    "snapshot_vote",
    {
      title: "Cast a Snapshot vote from the Safe",
      description:
        "Casts an off-chain, gasless Snapshot vote on behalf of the Safe. Signs an " +
        "EIP-712 vote as a Safe message, waits for the Safe's EIP-1271 signature, " +
        "then submits it to the Snapshot sequencer. Read the proposal with " +
        "snapshot_get_proposal first so the choice index and voting system match. " +
        "Voting again on the same proposal replaces the earlier vote.",
      inputSchema: {
        proposalId: z.string().describe("Snapshot proposal id (0x… hash)"),
        choice: choiceSchema,
        reason: z
          .string()
          .max(2_000)
          .default("")
          .describe("Public rationale recorded with the vote. Strongly recommended."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ proposalId, choice, reason }) => {
      const proposal = await snapshot.getProposal(config, proposalId);
      const space = proposal.space.id;

      assertSpaceAllowed(config, space);

      if (proposal.state !== "active") {
        throw new Error(
          `Proposal ${proposalId} is "${proposal.state}", not active. ` +
            (proposal.state === "pending"
              ? `Voting opens ${isoTime(proposal.start)}.`
              : `Voting closed ${isoTime(proposal.end)}.`)
        );
      }

      // Reject early rather than burning a signature on a vote the hub will drop.
      const power = await snapshot.getVotingPower(config, {
        space,
        proposalId,
        voter: config.SAFE_ADDRESS,
      });

      if (power.vp <= 0) {
        throw new Error(
          `The Safe ${config.SAFE_ADDRESS} has no voting power on proposal ${proposalId}, ` +
            "so Snapshot would reject the vote. Check that the Safe holds the space's " +
            "voting token, or that delegation is in place, at the proposal's snapshot block " +
            `(${proposal.snapshot}).`
        );
      }

      const typedData = snapshot.buildVoteTypedData({
        safeAddress: config.SAFE_ADDRESS,
        space,
        proposalId,
        proposalType: proposal.type,
        choices: proposal.choices,
        choice,
        reason,
        app: APP_NAME,
      });

      const chosen = snapshot.describeChoice(proposal, typedData.message.choice);

      if (config.DRY_RUN) {
        return json(
          {
            dryRun: true,
            proposalId,
            space,
            votingSystem: proposal.type,
            choice: chosen,
            reason,
            votingPower: power.vp,
            typedData,
          },
          `DRY_RUN is on. Would have voted "${chosen}" on "${proposal.title}".`
        );
      }

      await assertAgentCanSign(config);

      const messageClient = await getMessageClient(config);
      const created = await messageClient.sendOffChainMessage({ message: typedData });
      const messageHash = created.messages?.messageHash;

      if (!messageHash) {
        throw new Error(
          "The Safe Transaction Service did not return a message hash for the vote."
        );
      }

      const { signature, confirmations, threshold } = await awaitPreparedSignature(
        config,
        messageHash
      );

      const receipt = await snapshot.submitVote(config, {
        address: config.SAFE_ADDRESS,
        signature,
        typedData,
      });

      return json(
        {
          submitted: true,
          proposalId,
          space,
          proposalTitle: proposal.title,
          votingSystem: proposal.type,
          choice: chosen,
          rawChoice: typedData.message.choice,
          reason,
          votingPower: power.vp,
          safeMessageHash: messageHash,
          confirmations: `${confirmations}/${threshold}`,
          voteId: receipt.id,
          ipfs: receipt.ipfs ?? null,
          url: `https://snapshot.box/#/s:${space}/proposal/${proposalId}`,
        },
        `Voted "${chosen}" on "${proposal.title}" in ${space} with ${power.vp} voting power.`
      );
    })
  );

  server.registerTool(
    "snapshot_submit_pending_vote",
    {
      title: "Submit an already-signed Snapshot vote",
      description:
        "Finishes a vote whose Safe message was created earlier but not submitted, " +
        "usually because the Safe needed more owner signatures. Pass the " +
        "safeMessageHash reported by snapshot_vote.",
      inputSchema: {
        safeMessageHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .describe("The safeMessageHash from an earlier snapshot_vote call"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ safeMessageHash }) => {
      const client = await getSafeClient(config);
      const message = await client.apiKit.getMessage(safeMessageHash);

      if (typeof message.message === "string") {
        throw new Error(
          `Safe message ${safeMessageHash} is a plain string, not a Snapshot vote.`
        );
      }

      const typedData = message.message as snapshot.SnapshotVoteTypedData;

      if (typedData.domain?.name !== "snapshot") {
        throw new Error(
          `Safe message ${safeMessageHash} is not a Snapshot vote (domain: ${typedData.domain?.name}).`
        );
      }

      const space = String(typedData.message.space);
      assertSpaceAllowed(config, space);

      if (config.DRY_RUN) {
        return json({ dryRun: true, safeMessageHash, typedData }, "DRY_RUN is on.");
      }

      const { signature, confirmations, threshold } = await awaitPreparedSignature(
        config,
        safeMessageHash
      );

      const receipt = await snapshot.submitVote(config, {
        address: config.SAFE_ADDRESS,
        signature,
        typedData,
      });

      return json(
        {
          submitted: true,
          safeMessageHash,
          space,
          proposalId: String(typedData.message.proposal),
          confirmations: `${confirmations}/${threshold}`,
          voteId: receipt.id,
          ipfs: receipt.ipfs ?? null,
        },
        `Submitted the pending Snapshot vote for proposal ${typedData.message.proposal}.`
      );
    })
  );
}
