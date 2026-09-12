# Safe-MPC

An MCP (Model Context Protocol) server that connects a [Safe](https://safe.global)
smart-account wallet to AI agents so they can read DAO proposals and **vote as
the Safe** — off-chain on Snapshot, and on-chain through OpenZeppelin or
Compound-style Governors.

Point Claude Code, Claude Desktop, Cursor, or your own agent at this server and
the Safe becomes a voter your agent can operate.

It runs two ways. **On demand**, as an MCP server your agent calls when you ask
it to vote. **Unattended**, with the bundled `safe-mpc-watch` scheduler, which
polls for new proposals and asks an agent to decide as each deadline
approaches.

> Successor to [MinervaV2](https://github.com/DAOplomats/minervaV2). Minerva was
> a standing backend that polled for proposals, decided with its own LLM call,
> and voted on a schedule. Safe-MPC keeps Minerva's proven signing paths and its
> deadline-timed cadence, but inverts the control flow: the connected agent is
> the decision-maker, so there is no second model and no Postgres to run.

## How voting works

**Snapshot (off-chain, gasless).** The Safe cannot sign an EIP-712 payload
itself, so the vote is signed as an EIP-1271 contract signature. Safe-MPC builds
the Snapshot `Vote` payload, registers it as a Safe message, waits for the Safe
Transaction Service to assemble a signature meeting the Safe's threshold, then
posts it to the Snapshot sequencer. Voting again on the same proposal replaces
the earlier vote.

**Governor (on-chain).** Safe-MPC encodes `castVoteWithReason` and sends it as a
Safe transaction. This costs gas and is final once mined. Every vote runs
pre-flight checks against the Governor first: the proposal must be `Active`, the
Safe must not have voted already, and it must have had voting power at the
proposal's snapshot.

The EIP-712 vote types match `@snapshot-labs/snapshot.js` field for field,
including the three distinct shapes Snapshot uses (`uint32` for single-choice
and basic, `uint32[]` for approval and ranked-choice, a JSON string for weighted
and quadratic). The hub re-derives the typed-data hash from the payload it
receives, so this has to agree exactly.

## Setup

### 1. Install

```bash
git clone https://github.com/Zoldenburg-me/Safe-MPC.git
cd Safe-MPC
npm install
npm run build
```

### 2. Make the agent an owner of the Safe

Create a fresh EOA for the agent and add it as an owner in the Safe UI. The
agent key never holds the treasury — it only signs.

The Safe's **threshold** decides how much the agent can do alone:

| Threshold | What a vote tool does |
| --- | --- |
| 1 | Casts the vote outright. |
| 2 or more | Queues the vote and reports what is still needed. Other owners confirm in the Safe UI, then `snapshot_submit_pending_vote` or `safe_confirm_transaction` finishes it. |

A 1-of-N Safe gives the agent full autonomy. Raise the threshold to put a human
in the loop without changing anything here.

### 3. Configure

```bash
cp .env.example .env
```

Set `SAFE_ADDRESS`, `SAFE_AGENT_PRIVATE_KEY`, `SAFE_CHAIN_ID`, and an
`SAFE_RPC_URL` you control. Snapshot voting also needs a `SAFE_API_KEY` from
[developer.safe.global](https://developer.safe.global), because the Safe message
service assembles the EIP-1271 signature.

**Run with `DRY_RUN=true` first.** Every vote tool then returns the exact payload
it would have submitted and signs nothing.

### 4. Write a voting policy

Drop your operating values into `knowledge/` as Markdown. Those files are served
as MCP resources and inlined into the voting prompts, so the agent votes to a
stated policy rather than improvising. See `knowledge/README.md`.

### 5. Connect an agent

Claude Code:

```bash
claude mcp add safe-mpc --env-file .env -- node /absolute/path/to/Safe-MPC/dist/index.js
```

Claude Desktop or Cursor, in the MCP config file:

```json
{
  "mcpServers": {
    "safe-mpc": {
      "command": "node",
      "args": ["/absolute/path/to/Safe-MPC/dist/index.js"],
      "env": {
        "SAFE_ADDRESS": "0x...",
        "SAFE_AGENT_PRIVATE_KEY": "0x...",
        "SAFE_CHAIN_ID": "1",
        "SAFE_RPC_URL": "https://...",
        "SAFE_API_KEY": "...",
        "DRY_RUN": "true"
      }
    }
  }
}
```

Then ask the agent to run `safe_info`. It reports whether the agent's signer is
an owner and whether it can vote alone.

To poke at the server directly:

```bash
npm run inspect
```

## Tools

| Tool | Reads or writes | What it does |
| --- | --- | --- |
| `safe_info` | read | Chain, owners, threshold, nonce, balance, and whether the agent can vote alone. |
| `safe_pending_transactions` | read | Transactions queued on the Safe. |
| `safe_confirm_transaction` | write | Adds the agent's signature to a queued transaction, executing it if that meets the threshold. |
| `snapshot_list_proposals` | read | Proposals in a space, open ones by default. |
| `snapshot_get_proposal` | read | Full body, indexed choices, scores, the Safe's voting power, and any vote it already cast. |
| `snapshot_voting_power` | read | The Safe's voting power on one proposal, by strategy. |
| `snapshot_vote` | write | Casts an off-chain Snapshot vote as the Safe. |
| `snapshot_submit_pending_vote` | write | Submits a vote whose Safe message needed more signatures. |
| `governor_list_proposals` | read | On-chain proposals for a DAO, via Tally. |
| `governor_get_proposal` | read | Title, description and tallies, via Tally. |
| `governor_proposal_state` | read | Live Governor state, read straight from the contract. No API key needed. |
| `governor_vote` | write | Casts `castVoteWithReason` on-chain from the Safe. |
| `vote_log` | read | Every vote this Safe has cast, with the choice and reason, so decisions stay consistent with precedent. |
| `vote_schedule` | read | Proposals the scheduler has queued, and which are due now. |

Three prompts wrap the tools into a reviewed workflow:
`vote_on_snapshot_proposal`, `vote_on_governor_proposal`, and
`review_open_proposals`, which recommends votes without casting any.

### Choice format

Snapshot choices are **1-indexed**, matching the UI, and their shape follows the
proposal's voting system:

| Voting system | `choice` argument |
| --- | --- |
| `single-choice`, `basic` | `1` |
| `approval`, `ranked-choice` | `[2, 1, 3]` |
| `weighted`, `quadratic` | `{"1": 70, "2": 30}` |

Governor votes take `"for"`, `"against"` or `"abstain"` instead of the raw
support integers.

## Vote log

Every vote attempt is appended to `data/votes.jsonl`: the proposal, the choice,
the reason given, the voting power, and the resulting vote id or transaction
hash. Failed and queued attempts are recorded too, so a vote that never landed
is visible rather than lost in a chat transcript.

It is a plain JSONL file, not a database. The authoritative record of a vote is
on Snapshot or on-chain; this exists so that you can audit what the agent did,
and so the agent can read its own precedent through `vote_log` before deciding.
The scheduler also uses it to guarantee it never votes twice on one proposal,
even across restarts.

```bash
jq -r '[.at, .venue, .choice, .outcome] | @tsv' data/votes.jsonl | column -t
```

## Unattended voting

`safe-mpc-watch` restores Minerva's cadence. It polls the spaces and DAOs you
name, queues each open proposal, and when a proposal is within
`VOTE_BEFORE_CLOSE` of its deadline it runs your agent command to decide and
vote. Voting late rather than on discovery means the decision reflects how
sentiment developed, and leaves room to retry before the deadline.

```bash
# In .env
WATCH_SNAPSHOT_SPACES=ens.eth,aavedao.eth
WATCH_TALLY_SLUGS=uniswap
VOTE_BEFORE_CLOSE=6h
POLL_INTERVAL=1h
AGENT_COMMAND=claude -p "{prompt}" --mcp-config .mcp.json --allowedTools mcp__safe-mpc__*
```

```bash
npm run watch:plan     # show what is queued and due, dispatch nothing
npm run watch          # poll continuously
node dist/watch.js --once   # a single pass, for system cron
```

`--once` is usually the better choice in production: let cron own the schedule
and the restarts.

```cron
*/30 * * * * cd /srv/safe-mpc && node dist/watch.js --once >> watch.log 2>&1
```

The queue lives in `data/schedule.json` and survives restarts. A proposal keeps
its status across passes, so a vote already cast is never repeated, and one that
failed stays pending and is retried on the next pass until its deadline. Run
`--plan` first, and keep `DRY_RUN=true` until the queue looks right.

### The agent command

`AGENT_COMMAND` is parsed into an argument list and run **without a shell**, so
nothing in it is interpreted by `sh`. These placeholders are substituted:
`{prompt}`, `{platform}`, `{proposalId}`, `{venue}`, `{endsAt}`.

The same values plus the proposal title are also passed in the environment as
`SAFE_MPC_PROMPT`, `SAFE_MPC_PLATFORM`, `SAFE_MPC_PROPOSAL_ID`,
`SAFE_MPC_VENUE`, `SAFE_MPC_PROPOSAL_TITLE` and `SAFE_MPC_ENDS_AT`, which is how
you drive an agent that takes its input from the environment.

Proposal titles are written by whoever submitted the proposal, so they are never
placed on the command line, only in the environment. Proposal ids and venues are
checked against a strict character allowlist before substitution, and a
dispatch is refused outright if either could alter how the command parses.

## Guardrails

An agent with a Safe owner key is a real capability, so the server constrains it
in four ways:

- **`ALLOWED_SNAPSHOT_SPACES` and `ALLOWED_GOVERNORS`** confine voting to named
  spaces and contracts. Anything else is refused before a signature is made.
  This is the single most effective control here; set it.
- **`DRY_RUN`** signs and submits nothing while still exercising every read and
  every validation.
- **Pre-flight checks** refuse votes that would be rejected or reverted anyway:
  closed proposals, zero voting power, a Governor proposal already voted on.
- **The Safe's own threshold** stays authoritative. Nothing here can execute
  past it.

- **The vote log** makes every attempt reviewable after the fact, including the
  ones that failed.

Beyond that, the agent key is an owner like any other: remove it in the Safe UI
to revoke access immediately.

Unattended voting deserves more care than on-demand voting, because nobody is
reading the agent's reasoning as it happens. Set the allowlists, keep
`VOTE_BEFORE_CLOSE` long enough that you can still intervene, and read the vote
log for the first few proposals.

## Development

```bash
npm run dev        # watch mode
npm run typecheck
npm run build
npm test           # offline, no network or keys needed
```

The tests cover the parts that fail silently rather than loudly. The most
important one checks that the EIP-712 hash viem derives (what the Safe SDK
signs) matches the hash ethers derives (what the Snapshot hub recomputes before
verifying the Safe's EIP-1271 signature), across all six Snapshot voting
systems. If those two ever diverge, votes are rejected at the hub with no
obvious cause.

The rest cover the scheduler's timing and its double-vote guard, and the command
dispatch path, including that a hostile proposal title cannot reach the command
line.

```
src/
  index.ts            MCP server entry, stdio transport
  config.ts           Environment validation and the allowlist guards
  chains.ts           Chain registry and RPC resolution
  safe.ts             Safe client construction and owner checks
  policy.ts           Reads the voting-policy documents
  prompts.ts          Prompts and policy resources
  voteLog.ts          Append-only JSONL record of every vote attempt
  schedule.ts         The scheduler's queue and its timing rules
  watcher.ts          Proposal discovery and agent dispatch
  watch.ts            safe-mpc-watch CLI
  duration.ts         Duration parsing for the config
  platforms/
    snapshot.ts       Hub queries, EIP-712 vote types, sequencer submission
    governor.ts       Governor ABI, calldata encoding, on-chain state reads
    tally.ts          Tally API for on-chain proposal discovery
  tools/
    safeTools.ts      safe_*
    snapshotTools.ts  snapshot_*
    governorTools.ts  governor_*
    logTools.ts       vote_log, vote_schedule
```

## Troubleshooting

**"is not an owner of Safe"** — the address in `SAFE_AGENT_PRIVATE_KEY` has not
been added as a Safe owner. `safe_info` prints the current owner list.

**"no voting power"** — the Safe did not hold or was not delegated the
governance token at the proposal's snapshot block. Delegation set up after that
block does not apply retroactively.

**"signed by 1 of 2 required owners"** — expected on a multi-owner Safe. The
message hash is in the result; once the other owners sign it in the Safe UI, call
`snapshot_submit_pending_vote` with it.

**Snapshot sequencer rejects the vote** — usually the space's validation, not the
signature: a minimum-balance requirement, or voting closed between the read and
the submission. The sequencer's own message is passed through verbatim.

**The watcher queues nothing** — `--plan` prints what each space returned. An
empty result usually means the space id is wrong, or nothing is open right now.
On-chain proposals also need `TALLY_API_KEY`, and only governors on
`SAFE_CHAIN_ID` are queued.

**The watcher dispatches but no vote appears** — the entry stays `pending` with
`lastError` set in `data/schedule.json`, and the agent's output tail is on
stderr. The usual cause is an agent command that cannot reach the MCP server, so
check that `--mcp-config` points at a file naming this server.

## License

MIT
