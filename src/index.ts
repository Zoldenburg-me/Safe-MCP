#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDotEnv } from "./dotenv.js";
import { loadConfig } from "./config.js";
import { assertSafeServiceConfigured, getAgentAddress } from "./safe.js";
import { getChainName } from "./chains.js";
import { registerSafeTools } from "./tools/safeTools.js";
import { registerSnapshotTools } from "./tools/snapshotTools.js";
import { registerSnapshotXTools } from "./tools/snapshotXTools.js";
import { registerGovernorTools } from "./tools/governorTools.js";
import { registerLogTools } from "./tools/logTools.js";
import { registerPolicyResources, registerPrompts } from "./prompts.js";

const INSTRUCTIONS = `
Safe-MPC connects a Safe smart-account wallet to you so you can vote on DAO
proposals as that Safe.

Three voting paths:
- Snapshot, off-chain and gasless. The Safe signs an EIP-712 vote, the Safe
  Transaction Service assembles an EIP-1271 signature, and the vote goes to the
  Snapshot sequencer. A later vote on the same proposal replaces the earlier one.
- On-chain Governor (OpenZeppelin or Compound Bravo, as indexed by Tally). The
  Safe executes castVoteWithReason. This costs gas and is final once mined.
- Snapshot X (snapshot.box), fully on-chain. snapshot_x_vote has the Safe call
  the space's EthTx authenticator, which forwards Space.vote with the Safe as
  voter. Choices are for, against and abstain. This costs gas and is final:
  Snapshot X has no revote. snapshot_x_proposal shows the Safe's voting power
  and whether it already voted; read it first.

You do not need to be told where this Safe votes. snapshot_spaces_with_voting_power
finds every Snapshot space it holds voting power in — from the spaces it follows,
the spaces it has voted in before, and the operator's configuration — and
snapshot_open_proposals lists everything currently open for a vote across them.
Start there when asked to vote and given nothing more specific.

Before your first vote, call safe_info to confirm the agent's signer is an owner
of the Safe. If the Safe's threshold is above 1, your signature alone will not
cast the vote: the transaction or message is queued for the other owners.

Always read a proposal in full before voting, confirm the Safe holds voting
power, and record a substantive reason with the vote. If the operator has
configured voting-policy resources, read them and vote to that policy. Check
vote_log for how this Safe voted before, so decisions stay consistent.

If the Safe is the controller of an on-chain Snapshot X (snapshot.box) space,
it can also veto proposals there: snapshot_x_cancel_proposal proposes
Space.cancel(proposalId) straight to the Safe, replacing the manual
WalletConnect-into-the-Safe flow. Above threshold 1 the transaction waits in
the Safe queue and the tool reports the exact to/data/value the other owners
should verify before signing. snapshot_x_proposal reads a proposal's live
state and confirms the cancellation afterwards.

If DRY_RUN is on, nothing is signed or submitted: the vote tools return the
payload they would have sent, including when the vote would be rejected, and say
so. safe_info reports whether it is on and where that setting came from.

Every vote attempt is appended to a local vote log. vote_schedule shows
proposals the safe-mpc-watch scheduler has queued for a decision, if it is
running.
`.trim();

async function main(): Promise<void> {
  loadDotEnv();

  const config = loadConfig();

  // Refuse to start rather than fail on the agent's first Safe tool call.
  assertSafeServiceConfigured(config);

  const server = new McpServer(
    { name: "safe-mpc", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );

  registerSafeTools(server, config);
  registerSnapshotTools(server, config);
  registerSnapshotXTools(server, config);
  registerGovernorTools(server, config);
  registerLogTools(server, config);
  registerPolicyResources(server, config);
  registerPrompts(server, config);

  // stdout is the JSON-RPC channel, so every human-facing line goes to stderr.
  console.error(
    `safe-mpc ready: Safe ${config.SAFE_ADDRESS} on ${getChainName(config.SAFE_CHAIN_ID)} ` +
      `(chain ${config.SAFE_CHAIN_ID}), signing as ${getAgentAddress(config)}` +
      (config.DRY_RUN ? " [DRY_RUN: no votes will be submitted]" : "")
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(
    `safe-mpc failed to start: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
