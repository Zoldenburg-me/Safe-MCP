# Running Safe-MPC with OpenClaw

OpenClaw spawns stdio MCP servers as child processes on the machine it runs on,
which is exactly what Safe-MPC is. Put this repo on the same box as OpenClaw and
no network exposure is involved: the server speaks JSON-RPC over a pipe to its
parent and listens on no port.

That matters here more than it does for most MCP servers. This one holds an
owner key for your Safe. Keeping it as a child process means the key is reachable
only by the OpenClaw process, not by anything that can reach the host.

## Before you start

- Node 20 or newer.
- A deployed Safe, and the ability to add an owner to it.
- A Safe Transaction Service API key, free from
  [developer.safe.global](https://developer.safe.global). The server will not
  start without one. Every tool that touches the Safe needs it, on-chain
  Governor voting included.
- An Ethereum RPC URL. The public fallback is rate limited and will bite you
  during log scans.

## 1. Install and build

```bash
git clone https://github.com/Zoldenburg-me/Safe-MPC.git /srv/safe-mpc
cd /srv/safe-mpc
npm install
npm run build
```

## 2. Write the configuration

```bash
node dist/setup.js --safe 0xYourSafeAddress --chain 1
```

This generates a fresh agent key, writes `.env` at mode 600, and leaves
`DRY_RUN=true`. It prints the agent's address. Generate the key on this machine
rather than copying one in, so the key never exists anywhere else.

The state paths it writes are absolute, rooted at the repo. That is deliberate:
OpenClaw spawns the server from its own working directory, and relative paths
would put your vote log and policy documents somewhere you never chose. If you
write `.env` by hand instead, keep these absolute:

```bash
KNOWLEDGE_DIR=/srv/safe-mpc/knowledge
VOTE_LOG_PATH=/srv/safe-mpc/data/votes.jsonl
SCHEDULE_PATH=/srv/safe-mpc/data/schedule.json
```

Then add your API key and RPC URL to `.env`:

```bash
SAFE_API_KEY=your-key
SAFE_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
```

## 3. Make the agent an owner of the Safe

Open the Safe at [app.safe.global](https://app.safe.global), add the agent
address from step 2 as an owner, and execute that change. Until this is done
every vote fails, and `safe_info` will tell you so rather than failing opaquely.

Decide the threshold here. At threshold 1 the agent votes alone and the vote is
final the moment it calls the tool. Above 1 the agent signs and a human
co-signer completes the vote, which gives you autonomy on the reading and
reasoning with a human gate on the irreversible step. See
[Keeping control](#keeping-control) below.

## 4. Verify before connecting anything

```bash
npm run check
```

This reports the chain, the agent signer, whether the key is set, whether the
agent is an owner, the agent's gas balance, and whether dry run is on. Fix
anything it flags now. It is much easier to read here than through an agent.

## 5. Register the server with OpenClaw

Add one entry to `~/.openclaw/openclaw.json`:

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

Restart OpenClaw. Some versions instead take a YAML form with `mcp_servers`
declared per agent, so check this against the version you are running.

You do not need to repeat any secret here. The server loads `.env` from its own
package root as well as from the working directory, so credentials stay in one
file at mode 600 rather than being duplicated into OpenClaw's config. If you
prefer OpenClaw's own secrets handling, set the variables there and leave them
out of `.env`: a real environment variable always wins over the file.

## 6. First conversation

Ask the agent to run `safe_info`. It reports the chain, the owners, the
threshold, both relevant balances, and whether the agent can vote alone. If that
comes back clean, the integration works.

Then stay read-only for a while. These tools cast nothing:

| Tool | What you get |
| --- | --- |
| `snapshot_list_proposals` | Open proposals in a space |
| `snapshot_get_proposal` | Full body, indexed choices, the Safe's voting power |
| `governor_find_proposals` | On-chain proposals from `ProposalCreated` logs |
| `governor_proposal_state` | Live state straight from the contract |
| `vote_log` | Every vote this Safe has cast, with reasons |

The `review_open_proposals` prompt recommends votes without casting any. Run it
a few times and read what it produces before you let it vote for real.

## 7. Write a voting policy

Drop your operating values into `/srv/safe-mpc/knowledge/` as Markdown. Those
files are served as MCP resources and inlined into the voting prompts, so the
agent votes to a stated policy rather than improvising. See
`knowledge/README.md` and the example file beside it.

This is the highest-leverage thing you can do for vote quality. An agent with no
policy will reason from the proposal text alone, which is written by whoever
wants it passed.

## 8. Going live

Turn off dry run only after you have watched a full cycle:

```bash
DRY_RUN=false
```

Set both allowlists at the same time. Once the agent can cast real votes these
are what bound the damage:

```bash
ALLOWED_SNAPSHOT_SPACES=ens.eth,aavedao.eth
ALLOWED_GOVERNORS=0x408ED6354d4973f66138C91495F2f2FCbd8724C3
```

An empty allowlist means no restriction, so leaving them blank lets the agent
vote anywhere it can find a proposal.

For on-chain voting, send a small amount of ETH to the agent address. The Safe
does not pay gas for its own votes: the agent EOA calls `execTransaction` and
pays. Funding the Safe instead is the common mistake and does nothing. Snapshot
voting is entirely gasless and needs no ETH anywhere.

## 9. Unattended voting

Pick one clock, not two. The repo ships `safe-mpc-watch`, which polls the spaces
you name and dispatches `AGENT_COMMAND` when a proposal nears its deadline. That
expects a one-shot CLI it can spawn per proposal, which is not how a persistent
gateway like OpenClaw works.

So either:

- **Let OpenClaw schedule it.** Have OpenClaw wake its own agent on a cron and
  call `vote_schedule` plus the read tools directly. Simpler, and the queue
  stays in one place.
- **Keep the watcher** and point `AGENT_COMMAND` at something that pokes
  OpenClaw's API, with the watcher owning the schedule.

Either way, run `npm run watch:plan` first. It prints what is queued and due and
dispatches nothing.

## Keeping control

The agent key is an owner of your Safe, and OpenClaw is usually wired to
messaging channels. Two consequences worth being deliberate about:

**Anyone who can message OpenClaw can ask it to vote.** The vote path inherits
whatever trust boundary your OpenClaw channels have. If that includes a group
chat, it includes everyone in it.

**Proposal text is written by people who want it to pass.** This repo is careful
where it can be: proposal titles never reach a command line, only the
environment, and identifiers are checked against a strict allowlist before
substitution. But once a proposal body is in the model's context, it can try to
steer the vote, and no care in the spawning code prevents that.

A threshold above 1 is the single strongest answer to both. The agent assembles
and signs, a human finishes. At threshold 1, `DRY_RUN` and the two allowlists
are your only gate.

## Troubleshooting

**"SAFE_API_KEY is not set"** at startup. The Safe SDK needs a Transaction
Service key to construct its client, even for paths that never call the service.
Get one at [developer.safe.global](https://developer.safe.global).

**The vote log is empty, or policy documents are not found.** The paths in
`.env` are relative, so they resolved against OpenClaw's working directory
rather than the repo. Make them absolute, as in step 2.

**"is not an owner of Safe".** Step 3 was not completed, or was completed on a
different chain than `SAFE_CHAIN_ID`.

**"holds no ETH".** The agent EOA pays gas for on-chain votes, not the Safe.

**"needs N eth_getLogs calls".** The Governor scan window is too wide for the
chain's block time. Raise `GOVERNOR_LOG_CHUNK_BLOCKS` or use a better RPC.

The repo's own `README.md` has the full tool reference, the Snapshot choice
format, and a longer troubleshooting list.
