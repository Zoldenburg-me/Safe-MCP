#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { getAgentAddress } from "./safe.js";
import { getChainName } from "./chains.js";
import { registerSafeTools } from "./tools/safeTools.js";
import { registerSnapshotTools } from "./tools/snapshotTools.js";
import { registerGovernorTools } from "./tools/governorTools.js";
import { registerPolicyResources, registerPrompts } from "./prompts.js";

const INSTRUCTIONS = `
Safe-MPC connects a Safe smart-account wallet to you so you can vote on DAO
proposals as that Safe.

Two voting paths:
- Snapshot, off-chain and gasless. The Safe signs an EIP-712 vote, the Safe
  Transaction Service assembles an EIP-1271 signature, and the vote goes to the
  Snapshot sequencer. A later vote on the same proposal replaces the earlier one.
- On-chain Governor (OpenZeppelin or Compound Bravo, as indexed by Tally). The
  Safe executes castVoteWithReason. This costs gas and is final once mined.

Before your first vote, call safe_info to confirm the agent's signer is an owner
of the Safe. If the Safe's threshold is above 1, your signature alone will not
cast the vote: the transaction or message is queued for the other owners.

Always read a proposal in full before voting, confirm the Safe holds voting
power, and record a substantive reason with the vote. If the operator has
configured voting-policy resources, read them and vote to that policy.
`.trim();

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer(
    { name: "safe-mpc", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );

  registerSafeTools(server, config);
  registerSnapshotTools(server, config);
  registerGovernorTools(server, config);
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
