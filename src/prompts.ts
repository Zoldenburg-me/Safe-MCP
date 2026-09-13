import { z } from "zod";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listPolicies, readAllPolicies, readPolicy } from "./policy.js";
import type { Config } from "./config.js";

const POLICY_SCHEME = "safe-mpc://policy/";

/** Exposes each policy document in KNOWLEDGE_DIR as a readable MCP resource. */
export function registerPolicyResources(server: McpServer, config: Config): void {
  server.registerResource(
    "voting-policy",
    new ResourceTemplate(`${POLICY_SCHEME}{name}`, {
      list: async () => {
        const docs = await listPolicies(config);
        return {
          resources: docs.map((doc) => ({
            uri: `${POLICY_SCHEME}${doc.name}`,
            name: doc.name,
            title: `Voting policy: ${doc.name}`,
            mimeType: "text/markdown",
          })),
        };
      },
      complete: {
        name: async (value) => {
          const docs = await listPolicies(config);
          return docs
            .map((doc) => doc.name)
            .filter((name) => name.startsWith(value));
        },
      },
    }),
    {
      title: "Voting policy document",
      description:
        "An operating-values or precedent document the Safe's operator wrote to " +
        "govern how the agent votes.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const raw = variables["name"];
      const name = Array.isArray(raw) ? raw[0] : raw;

      if (!name) throw new Error("No policy name given in the resource URI.");

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: await readPolicy(config, name),
          },
        ],
      };
    }
  );
}

async function policyBlock(config: Config): Promise<string> {
  const policy = await readAllPolicies(config);

  if (!policy) {
    const docs = await listPolicies(config);
    return docs.length === 0
      ? `No voting policy is configured (${config.KNOWLEDGE_DIR} is empty). ` +
          "Judge the proposal on its merits, and say plainly in your reason that no " +
          "operator policy was available."
      : "";
  }

  return `The Safe's operator has set out this voting policy. Follow it.\n\n${policy}`;
}

/** Joins non-empty paragraphs, so an absent policy block leaves no stray gap. */
function paragraphs(...sections: string[]): string {
  return sections.map((s) => s.trim()).filter(Boolean).join("\n\n");
}

const VOTE_WORKFLOW = `
Work in this order and stop if any step rules the vote out:
1. Read the proposal in full.
2. Check that voting is open and that the Safe has voting power. A vote with zero
   power is wasted and will be rejected.
3. Check whether the Safe has already voted. Snapshot votes can be replaced;
   on-chain Governor votes cannot.
4. Decide, then write a reason of two or three sentences that a token holder
   reading the vote later would find sufficient. State the concrete grounds, not
   generalities.
5. Cast the vote, then report the choice, the reason and the transaction or vote id.
`.trim();

export function registerPrompts(server: McpServer, config: Config): void {
  server.registerPrompt(
    "vote_on_snapshot_proposal",
    {
      title: "Vote on a Snapshot proposal",
      description:
        "Walks through reading, judging and casting a Snapshot vote from the Safe, " +
        "against the operator's configured voting policy.",
      argsSchema: {
        proposalId: z.string().describe("Snapshot proposal id (0x… hash)"),
      },
    },
    async ({ proposalId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: paragraphs(
              `Decide and cast the Safe's vote on Snapshot proposal ${proposalId}.`,
              await policyBlock(config),
              VOTE_WORKFLOW,
              "Use snapshot_get_proposal to read it, then snapshot_vote to cast it. " +
                "Match the choice format to the proposal's voting system."
            ),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "vote_on_governor_proposal",
    {
      title: "Vote on an on-chain Governor proposal",
      description:
        "Walks through reading, judging and casting an on-chain Governor vote from " +
        "the Safe, against the operator's configured voting policy.",
      argsSchema: {
        governor: z.string().describe("Governor contract address"),
        proposalId: z.string().describe("On-chain proposal id"),
      },
    },
    async ({ governor, proposalId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: paragraphs(
              `Decide and cast the Safe's vote on Governor proposal ${proposalId} at ${governor}.`,
              await policyBlock(config),
              VOTE_WORKFLOW,
              "Use governor_proposal_state for the live on-chain state and " +
                "governor_get_proposal for the description, then governor_vote to cast it.",
              "This vote costs gas and is final once mined. Do not cast it if any " +
                "pre-flight check fails."
            ),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "vote_on_every_open_proposal",
    {
      title: "Vote on everything open",
      description:
        "Finds every Snapshot space the Safe holds voting power in, then decides and " +
        "casts a vote on each proposal open there, against the operator's policy.",
      argsSchema: {},
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: paragraphs(
              "Cast the Safe's vote on every Snapshot proposal it can currently vote on.",
              await policyBlock(config),
              "Start with snapshot_open_proposals, which lists the open proposals across " +
                "every space the Safe has voting power in, soonest deadline first. Work " +
                "through them in that order.",
              "Check vote_log first and skip any proposal the Safe has already voted on " +
                "unless the policy calls for changing the vote.",
              VOTE_WORKFLOW,
              "Report a line per proposal: space, title, choice, and whether the vote was " +
                "cast, skipped or blocked. Do not stop the run because one proposal failed."
            ),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "review_open_proposals",
    {
      title: "Review every open proposal",
      description:
        "Surveys the open proposals in a Snapshot space — or in every space the Safe " +
        "can vote in — and recommends a vote on each one, without casting anything.",
      argsSchema: {
        space: z
          .string()
          .optional()
          .describe(
            'Snapshot space id, e.g. "ens.eth". Leave it out to survey every space ' +
              "the Safe has voting power in."
          ),
      },
    },
    async ({ space }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: paragraphs(
              space
                ? `List every open proposal in the Snapshot space ${space} and recommend how ` +
                    "the Safe should vote on each."
                : "List every open proposal the Safe can vote on, across every Snapshot " +
                    "space it holds voting power in, and recommend how it should vote on " +
                    "each. Use snapshot_open_proposals to find them.",
              await policyBlock(config),
              "Read each proposal before recommending. Do not cast any votes: report a " +
                "table of proposal, recommended choice, and a one-sentence reason, then " +
                "wait for approval."
            ),
          },
        },
      ],
    })
  );
}
