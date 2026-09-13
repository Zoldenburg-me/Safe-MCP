# Running the Safe-MPC server for Grokbot and OpenClaw

Safe-MPC is a stdio MCP server: it speaks JSON-RPC over a pipe to the agent
that spawns it and listens on no port. Running it "for" an agent therefore
means installing it on the same machine as that agent and registering one
command in the agent's MCP config. This page walks the shared path once and
then shows the client-specific step for each of the two agents. The deep
dives live beside this file:

- [openclaw.md](./openclaw.md) — the full OpenClaw guide, including
  unattended voting and the trust-boundary discussion.
- [grokbot.md](./grokbot.md) — the Grok guide, including why the cloud
  Grok Bot cannot connect today and what hosting it would take.

**One caveat up front about Grok.** The cloud **Grok Bot** attaches only MCP
servers reachable over the public internet and cannot spawn stdio processes,
so it cannot run Safe-MPC as shipped — see
[What Grok Bot would need](./grokbot.md#what-grok-bot-would-need). The steps
below apply to **Grok Build**, xAI's terminal agent, which supports stdio
servers like any other local MCP client.

## Prerequisites

- Node 20 or newer, on the same box the agent runs on.
- A deployed Safe, and the ability to add an owner to it.
- A Safe Transaction Service API key, free from
  [developer.safe.global](https://developer.safe.global). The server refuses
  to start without one (or a self-hosted `SAFE_TX_SERVICE_URL`).
- An Ethereum RPC URL. The public fallback is rate limited and will bite you
  during Governor log scans.

## 1. Install and build

```bash
git clone https://github.com/Zoldenburg-me/Safe-MPC.git /srv/safe-mpc
cd /srv/safe-mpc
npm install
npm run build
```

## 2. Configure

```bash
node dist/setup.js --safe 0xYourSafeAddress --chain 1
```

This generates the agent's EOA key on this machine, writes `.env` at mode 600
with absolute state paths, and leaves `DRY_RUN=true`. It prints the agent
address you will add to the Safe in the next step. Then add your key and RPC
URL to `.env`:

```bash
SAFE_API_KEY=your-key
SAFE_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
```

Keep the state paths absolute (setup already writes them that way). Both
agents spawn the server from their own working directory, and relative paths
would put the vote log and policy documents somewhere you never chose:

```bash
KNOWLEDGE_DIR=/srv/safe-mpc/knowledge
VOTE_LOG_PATH=/srv/safe-mpc/data/votes.jsonl
SCHEDULE_PATH=/srv/safe-mpc/data/schedule.json
```

## 3. Make the agent an owner of the Safe

Open the Safe at [app.safe.global](https://app.safe.global), under Settings →
Setup → Add new owner, add the agent address from step 2, and execute the
change. The threshold you pick here decides how much the agent can do alone:
at 1 it casts votes outright; at 2 or more it signs and queues, and a human
co-signer finishes in the Safe UI. A threshold above 1 is the single
strongest control you have — see
[Keeping control](./openclaw.md#keeping-control).

## 4. Verify

```bash
npm run check
```

This reports the chain, both addresses, whether the agent is an owner, its
gas balance, and whether dry run is on. Fix anything it flags before wiring
up either agent — it is much easier to read here than through one.

## 5. Register the server with your agent

### OpenClaw

Add one entry to `~/.openclaw/openclaw.json` and restart OpenClaw:

```json
{
  "mcpServers": {
    "safe-mpc": {
      "command": "node",
      "args": ["/srv/safe-mpc/dist/index.js"]
    }
  }
}
```

Some OpenClaw versions instead take a YAML form with `mcp_servers` declared
per agent, so check against the version you run.

### Grok Build

Grok Build reads the same `mcpServers` shape:

```json
{
  "mcpServers": {
    "safe-mpc": {
      "command": "node",
      "args": ["/srv/safe-mpc/dist/index.js"]
    }
  }
}
```

Check the config file's location and exact key names against
[xAI's Grok documentation](https://docs.x.ai/build/features/mcp-servers),
which is the authority on where its config lives.

In both cases, no secrets go in the agent's config. The server loads `.env`
from its own package root as well as the working directory, so credentials
stay in one mode-600 file. If you prefer the agent's own secrets handling,
set the variables there instead: a real environment variable always wins
over the file.

## 6. First conversation

Ask the agent to run `safe_info`. It reports the chain, the owners, the
threshold, both relevant balances, and whether the agent can vote alone. If
that comes back clean, the integration works.

Then stay read-only for a while: `snapshot_list_proposals`,
`snapshot_get_proposal`, `governor_find_proposals`,
`governor_proposal_state`, and `vote_log` cast nothing, and the
`review_open_proposals` prompt recommends votes without casting any. Read
what it produces before you let it vote for real.

## 7. Policy, then going live

Drop your operating values into `/srv/safe-mpc/knowledge/` as Markdown —
they are served as MCP resources and inlined into the voting prompts, so the
agent votes to a stated policy rather than improvising
(`knowledge/README.md` has the format). Then, once you have watched a full
dry-run cycle, flip `DRY_RUN=false` and set both allowlists at the same
time — an empty allowlist means no restriction:

```bash
DRY_RUN=false
ALLOWED_SNAPSHOT_SPACES=ens.eth,aavedao.eth
ALLOWED_GOVERNORS=0x408ED6354d4973f66138C91495F2f2FCbd8724C3
```

For on-chain Governor voting, send a small amount of ETH to the agent EOA —
it pays the gas for `execTransaction`, not the Safe. Snapshot voting is
entirely gasless and needs no ETH anywhere.

## Where the guides diverge

Everything above is identical for both agents. What differs:

| Topic | OpenClaw | Grok |
| --- | --- | --- |
| Transport | stdio child process, works as shipped | stdio works for Grok Build; the cloud Grok Bot needs a hosted HTTPS endpoint this repo does not ship |
| Unattended voting | Let OpenClaw's own scheduler drive the tools, or point `safe-mpc-watch`'s `AGENT_COMMAND` at OpenClaw — see [openclaw.md §9](./openclaw.md#9-unattended-voting) | Same options apply to any one-shot CLI; the openclaw guide's step 9 covers the trade-off |
| Trust boundary | Anyone who can message OpenClaw's channels can ask it to vote — see [Keeping control](./openclaw.md#keeping-control) | Grok Build inherits your terminal session; a hosted endpoint for Grok Bot would need auth and TLS — see [grokbot.md](./grokbot.md#what-grok-bot-would-need) |

For troubleshooting ("SAFE_API_KEY is not set", "is not an owner of Safe",
empty vote logs from relative paths, and the rest), see the
[openclaw.md troubleshooting section](./openclaw.md#troubleshooting) — it
applies to both clients — and the repo `README.md` for the full tool
reference.
