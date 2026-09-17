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

- [How voting works](#how-voting-works)
- [Where the Safe votes](#where-the-safe-votes)
- [Setup](#setup)
- [Which account needs ETH](#which-account-needs-eth)
- [Tools](#tools)
- [Vote log](#vote-log)
- [Unattended voting](#unattended-voting)
- [Guardrails](#guardrails)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

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

Proposals are discovered by reading `ProposalCreated` logs from the Governor
contract, so no third-party indexer sits anywhere in the path, and no API key is
needed to find a proposal. Nothing here depends on a hosted governance API
staying up.

The EIP-712 vote types match `@snapshot-labs/snapshot.js` field for field,
including the three distinct shapes Snapshot uses (`uint32` for single-choice
and basic, `uint32[]` for approval and ranked-choice, a JSON string for weighted
and quadratic). The hub re-derives the typed-data hash from the payload it
receives, so this has to agree exactly.

## Where the Safe votes

You should not have to hand the agent a list of DAOs. Safe-MPC works out where
the Safe can vote and asks it to vote there.

`snapshot_spaces_with_voting_power` assembles the candidates from four places —
the spaces the Safe **follows** on Snapshot, the spaces it has **voted in
before**, the spaces you configured, and the test space — then reads the Safe's
voting power in each and keeps the ones where it has any.
`snapshot_open_proposals` turns that into the Safe's actual ballot: every
proposal open for a vote across those spaces, soonest deadline first.

```
> Which DAOs can this Safe vote in, and is anything open?

  snapshot_spaces_with_voting_power → 2 spaces
  snapshot_open_proposals           → 3 proposals, one closing in 4h
```

The scheduler uses the same discovery. With `WATCH_SNAPSHOT_AUTO=true`, which is
the default, `safe-mpc-watch` re-resolves the watched spaces on **every pass**,
so a Safe that is delegated voting power in a new space starts being asked to
vote there without anyone editing a config file. `WATCH_SNAPSHOT_SPACES` still
names spaces explicitly, and those are watched even at zero voting power,
because a space you named on purpose may be about to grant the Safe weight.

Voting power here is read at the current block, which answers "is this space
worth watching". Whether a particular vote will count is a different question,
asked again per proposal at that proposal's snapshot block before anything is
signed.

`SNAPSHOT_TEST_SPACE` defaults to `staging.daoplomats.eth`: a space that is
always tested and always watched, so a fresh install has somewhere to exercise
the whole path end to end before being pointed at a DAO that matters. Set it
empty in `.env` to drop it.

If `ALLOWED_SNAPSHOT_SPACES` is set, it wins over all of this. Spaces outside
the allowlist are never tested, never watched, and never voted in.

## Setup

### 1. Install

```bash
git clone https://github.com/Zoldenburg-me/Safe-MPC.git
cd Safe-MPC
npm install
npm run build
```

### 2. Run setup

There is no web UI to pick a Safe in. Safe-MPC is a headless stdio process, so
this command is the setup screen:

```bash
npm run setup
```

It generates the agent's EOA, shows you the address to add as a Safe owner,
asks for the Safe and chain, and writes `.env` with mode 600. Votes are live from
the start: setup writes `DRY_RUN=false`, and `--dry-run` is how you opt into a
rehearsal instead. For scripts and containers there is a non-interactive form:

```bash
node dist/setup.js --safe 0xYourSafe --chain 1 --rpc https://... --api-key ...
node dist/setup.js --safe 0xYourSafe --space mydao.eth --dry-run
node dist/setup.js --new-key      # just print a fresh keypair, write nothing
npm run check                     # verify readiness against the live chain
```

`npm run check` is worth running before you wire up any agent. It reports the
chain, both addresses, the agent's ETH balance, whether the agent is an owner,
the threshold, **every Snapshot space the Safe holds voting power in**, and, if a
Safe API key is set, every Safe the agent owns on that chain. It exits non-zero
and names what is missing when the agent cannot vote — including a Safe with no
voting power anywhere, which is the failure that otherwise only shows up when a
vote is rejected.

The server and the watcher both read `.env` from the working directory and then
from the package root, so you do not have to repeat the config in your MCP
client. Real environment variables always win over the file.

### 3. Add the agent as a Safe owner

Setup prints the agent address. Add it at
[app.safe.global](https://app.safe.global), under Settings, then Setup, then Add
new owner. That is the only screen involved, and it is Safe's, not ours. The
agent key never holds the treasury — it only signs.

The Safe's **threshold** decides how much the agent can do alone:

| Threshold | What a vote tool does |
| --- | --- |
| 1 | Casts the vote outright. |
| 2 or more | Queues the vote and reports what is still needed. Other owners confirm in the Safe UI, then `snapshot_submit_pending_vote` or `safe_confirm_transaction` finishes it. |

A 1-of-N Safe gives the agent full autonomy. Raise the threshold to put a human
in the loop without changing anything here.

### 4. Configure the rest

Setup writes the essentials. `.env.example` documents every other setting, and
`cp .env.example .env` is the manual route if you would rather not use setup at
all.

**You need a `SAFE_API_KEY` from
[developer.safe.global](https://developer.safe.global).** The key is free. The
Safe SDK builds its Transaction Service client before any request is made, and
that constructor refuses a missing key, so every tool that touches the Safe
needs one. That includes `governor_vote` from a threshold-1 Safe, which executes
straight over RPC and never calls the service. Read-only discovery works without
a key, but voting does not, so the server refuses to start without either
`SAFE_API_KEY` or a self-hosted `SAFE_TX_SERVICE_URL`.

**Votes are live unless you ask otherwise.** `DRY_RUN` is off by default and
setup writes `DRY_RUN=false`. Set it to `true` — or run setup with `--dry-run` —
and every vote tool returns the exact payload it would have submitted, signing
nothing. A dry run reports blocked votes too, payload included, so the path can
be demonstrated on a Safe that has no voting power yet.

A variable set in the process environment beats `.env`. An MCP client that
launches the server with `"DRY_RUN": "true"` in its own config keeps winning over
the file however many times you edit it, and a plain restart may not reload that
config — the server entry has to be updated. `safe_info` reports both the value
in force and where it came from, so this is visible rather than baffling.

### 5. Write a voting policy

Drop your operating values into `knowledge/` as Markdown. Those files are served
as MCP resources and inlined into the voting prompts, so the agent votes to a
stated policy rather than improvising. See `knowledge/README.md`.

### 6. Connect an agent

Claude Code, which picks up the project's `.env` on its own:

```bash
claude mcp add safe-mpc -- node /absolute/path/to/Safe-MPC/dist/index.js
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
        "SAFE_API_KEY": "..."
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

Step-by-step guides for hosting the server beside a self-hosted agent:

- [docs/running-the-server.md](docs/running-the-server.md) — the combined
  quick path for both OpenClaw and Grok, with links into the detail below.
- [docs/openclaw.md](docs/openclaw.md) — OpenClaw, over stdio on one box.
- [docs/grokbot.md](docs/grokbot.md) — Grok Build over stdio, and why Grok Bot
  needs a hosted endpoint this repo does not ship yet.

## Which account needs ETH

The Safe does not pay gas for its own votes. The account that calls
`execTransaction` pays, and that is the agent's EOA. Funding the Safe instead is
the common mistake and does nothing for voting.

| Case | Needs ETH | Why |
| --- | --- | --- |
| Snapshot votes | No | Signing is off-chain and verification is an `eth_call`. Entirely gasless. |
| Governor votes | The agent EOA | It submits `execTransaction` and pays the gas. |
| The Safe itself | No | Only the governance token, or a delegation, for voting power. |

So a Safe voting only on Snapshot needs no ETH anywhere. For on-chain voting,
send a small amount of ETH to the agent EOA and top it up as it drains.

`safe_info` reports both balances and says plainly whether on-chain voting will
work. `governor_vote` refuses before signing if the agent has no ETH, naming the
cause rather than surfacing an opaque RPC rejection.

Safe supports refunding the executor out of the Safe's own balance, via the
`gasPrice`, `gasToken` and `refundReceiver` transaction fields. Safe-MPC leaves
those at zero, so no refund happens and the accounting stays simple.

## Vetoing a Snapshot X proposal

Snapshot X (snapshot.box) is Snapshot's fully on-chain protocol: a space is a
contract, and cancelling a proposal means the space's **controller** — usually
the DAO's Safe — calling `cancel(proposalId)` on it. Done by hand, that is the
worst flow in DAO operations: someone opens app.safe.global, bridges
snapshot.box into the Safe over WalletConnect, double-checks they are acting as
the Safe and not their own wallet, clicks Cancel proposal, signs, and then
posts the calldata in the group chat so every co-signer can verify the bytes
before confirming.

`snapshot_x_cancel_proposal` collapses the first half of that into one call.
Given a snapshot.box proposal URL — or the space and proposal number — it
verifies the Safe is the space controller, simulates the cancel from the Safe's
address so the chain itself vets the call, then proposes the transaction to the
Safe:

```
> Cancel https://snapshot.box/#/eth:0x594E…/proposal/3 — it duplicates #2.

  snapshot_x_proposal        → status VotingPeriod, this Safe controls the space
  snapshot_x_cancel_proposal → queued as 0xf00…, needs 4 more of 5 signatures
```

At threshold 1 the cancel executes immediately. Above that, the tool reports
the queued `safeTxHash`, a link to the Safe's queue, and the exact
`to` / `data` / `value` the transaction must show — the same checklist
co-signers used to assemble by hand, now generated from the transaction that
was actually proposed. The other owners just open the queue, compare, and
confirm; the final signature executes the cancel. `snapshot_x_proposal` read
afterwards confirms the proposal is `Cancelled`.

Every attempt is recorded in the vote log with platform `snapshot-x`, and
`DRY_RUN` behaves as everywhere else: the tool returns the transaction it would
have proposed, blockers included, without signing anything.

## Tools

| Tool | Reads or writes | What it does |
| --- | --- | --- |
| `safe_info` | read | Chain, owners, threshold, nonce, balance, and whether the agent can vote alone. Needs the API key. |
| `safe_pending_transactions` | read | Transactions queued on the Safe. Needs the API key. |
| `safe_confirm_transaction` | write | Adds the agent's signature to a queued transaction, executing it if that meets the threshold. Needs the API key. |
| `snapshot_spaces_with_voting_power` | read | Every Snapshot space this Safe can vote in, found without being told where to look. |
| `snapshot_open_proposals` | read | Everything open for a vote across those spaces, soonest deadline first. |
| `snapshot_list_proposals` | read | Proposals in a space, open ones by default. |
| `snapshot_get_proposal` | read | Full body, indexed choices, scores, the Safe's voting power, and any vote it already cast. |
| `snapshot_voting_power` | read | The Safe's voting power on one proposal, by strategy. |
| `snapshot_query` | read | Any GraphQL query against the Snapshot hub, for everything the fixed reads don't cover. |
| `snapshot_vote` | write | Casts an off-chain Snapshot vote as the Safe. Needs the API key. |
| `snapshot_submit_pending_vote` | write | Submits a vote whose Safe message needed more signatures. Needs the API key. |
| `snapshot_x_proposal` | read | A Snapshot X proposal's live status, read from the space contract, and whether this Safe controls the space. No API key. |
| `snapshot_x_cancel_proposal` | write | Vetoes a Snapshot X proposal by proposing `Space.cancel` from the Safe. Needs the API key. |
| `governor_find_proposals` | read | On-chain proposals, read from `ProposalCreated` logs. No API key. |
| `governor_list_proposals` | read | Legacy: proposals via a hosted indexer API. Needs a key. |
| `governor_get_proposal` | read | Legacy: title, description and vote counts via the same API. |
| `governor_proposal_state` | read | Live Governor state, read straight from the contract. No API key needed. |
| `governor_vote` | write | Casts `castVoteWithReason` on-chain from the Safe. Needs the API key, even at threshold 1. |
| `vote_log` | read | Every vote this Safe has cast, with the choice and reason, so decisions stay consistent with precedent. |
| `vote_schedule` | read | Proposals the scheduler has queued, and which are due now. |

Tools marked "Needs the API key" build a Safe client and fail without
`SAFE_API_KEY` or `SAFE_TX_SERVICE_URL`. The rest are plain RPC or Snapshot
hub reads and work with neither.

Four prompts wrap the tools into a reviewed workflow:
`vote_on_snapshot_proposal`, `vote_on_governor_proposal`,
`vote_on_every_open_proposal`, which works through the Safe's whole ballot, and
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

`safe-mpc-watch` is the unattended path. It polls every Snapshot space the Safe
can vote in — plus any space or Governor you name — queues each open proposal,
and when a proposal is within `VOTE_BEFORE_CLOSE` of its deadline it runs your
agent command to decide and vote. Voting late rather than on discovery means the
decision reflects how sentiment developed, and leaves room to retry before the
deadline.

```bash
# In .env. Snapshot spaces are discovered automatically; everything here is
# optional except the agent command.
WATCH_SNAPSHOT_AUTO=true                # watch wherever the Safe has voting power
WATCH_SNAPSHOT_SPACES=ens.eth,aavedao.eth   # watched as well, power or not
WATCH_GOVERNORS=0x408ED6354d4973f66138C91495F2f2FCbd8724C3
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
`--plan` first, and set `DRY_RUN=true` for the first live pass if you want to
read the agent's reasoning before any vote is real.

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

### On-chain discovery and its limits

`governor_find_proposals` and the scheduler's Governor path both scan
`ProposalCreated` logs, then filter by the contract's live `state()`.

**The scan window comes from the Governor, not from a guess.** A proposal can
only be open if it was created within `votingDelay + votingPeriod` of now, so
that is exactly how far back the scan reaches, plus
`GOVERNOR_LOOKBACK_MARGIN`. A DAO with a one-day delay and a three-day voting
period is scanned six days back, not a fixed month. Every result reports the
window it used and where that came from. `GOVERNOR_LOOKBACK` is only the
fallback for a Governor fork that does not expose those two methods, and the
`lookback` argument overrides both.

This does mean a proposal created before that window is invisible, which
matters only if the DAO shortened its voting period very recently. Widen
`GOVERNOR_LOOKBACK_MARGIN` or pass an explicit `lookback` if so.

**Deadlines are estimated on a Governor that counts in blocks.** OpenZeppelin
Governor v5 and later can report time in seconds via ERC-6372, and those
deadlines are exact. Older Governors and Compound Bravo count in block numbers,
so the deadline is derived from the chain's recent average block time, measured
by sampling two blocks rather than from a hardcoded table. Results flag this
with `endsAtIsEstimate`, and the estimate drifts as block times change. Leave
enough room in `VOTE_BEFORE_CLOSE` to absorb that drift.

Scans are chunked because most RPC providers cap the block span of a single
`eth_getLogs` call. Deriving the window from the contract keeps that cost
proportionate: on a chain producing a block every quarter second, a three-day
voting period is a far smaller scan than a blanket month would be. A scan
needing more than `GOVERNOR_MAX_LOG_CHUNKS` calls is still refused, reporting
the measured block time and where the window came from, rather than quietly
hammering your provider.

One known gap: a Governor fork that changed the `ProposalCreated` parameter
*types* would need its own event definition. Renaming parameters is fine, which
is why one definition covers both OpenZeppelin and Compound Bravo.

## Guardrails

An agent with a Safe owner key is a real capability, so the server constrains it
in five ways:

- **`ALLOWED_SNAPSHOT_SPACES` and `ALLOWED_GOVERNORS`** confine voting to named
  spaces and contracts. Anything else is refused before a signature is made.
  This is the single most effective control here; set it.
- **`DRY_RUN`** signs and submits nothing while still exercising every read and
  every validation. It is off by default — votes are real unless you turn it on.
- **Pre-flight checks** refuse votes that would be rejected or reverted anyway:
  closed proposals, zero voting power, a Governor proposal already voted on.
  Under `DRY_RUN` these become reported blockers rather than refusals, and the
  payload comes back anyway, so a rehearsal still shows you what it would sign.
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
  setup.ts            safe-mpc-setup CLI: key generation, .env, readiness check
  dotenv.ts           Minimal .env loader, so config is not duplicated per client
  policy.ts           Reads the voting-policy documents
  prompts.ts          Prompts and policy resources
  voteLog.ts          Append-only JSONL record of every vote attempt
  schedule.ts         The scheduler's queue and its timing rules
  watcher.ts          Proposal discovery and agent dispatch
  watch.ts            safe-mpc-watch CLI
  duration.ts         Duration parsing for the config
  platforms/
    snapshot.ts       Hub queries, EIP-712 vote types, sequencer submission
    snapshotX.ts      Snapshot X space ABI, cancel calldata, on-chain reads
    governor.ts       Governor ABI, calldata encoding, on-chain state reads
    governorIndexer.ts  On-chain discovery from ProposalCreated logs
    tally.ts          Legacy hosted-indexer client, superseded by governorIndexer
  tools/
    safeTools.ts      safe_*
    snapshotTools.ts  snapshot_*
    snapshotXTools.ts snapshot_x_*
    governorTools.ts  governor_*
    logTools.ts       vote_log, vote_schedule
    shared.ts         Tool result helpers and the in-band error guard
```

## Troubleshooting

**"SAFE_API_KEY is not set"** at startup — the Safe SDK needs a Transaction
Service key to construct its client, even for paths that never call the service.
Get one free at [developer.safe.global](https://developer.safe.global), or set
`SAFE_TX_SERVICE_URL` if you run your own service.

**"is not an owner of Safe"** — the address in `SAFE_AGENT_PRIVATE_KEY` has not
been added as a Safe owner. `safe_info` prints the current owner list.

**"holds no ETH"** — the agent EOA, not the Safe, pays gas for on-chain votes.
Send ETH to the address `safe_info` reports as `agentSigner`. Snapshot voting is
unaffected and needs no ETH at all.

**"no voting power"** — the Safe did not hold or was not delegated the
governance token at the proposal's snapshot block. Delegation set up after that
block does not apply retroactively. `snapshot_spaces_with_voting_power` with
`includeZero: true` shows every space that was tested and what each returned,
which is the quickest way to tell "wrong space" from "no tokens". Under
`DRY_RUN` the vote tool returns the payload anyway, flagged as blocked, so the
path can still be demonstrated.

**`dryRun: true` when `.env` says otherwise** — a variable in the process
environment beats the file, and MCP clients pass their own `env` block to the
server. Editing `.env` cannot fix that, and neither can a restart if the client
re-reads its cached config: remove `DRY_RUN` from the client's server entry, or
set it there to `"false"`. `safe_info` reports `dryRunSource`, which says which
of the two is in force.

**"signed by 1 of 2 required owners"** — expected on a multi-owner Safe. The
message hash is in the result; once the other owners sign it in the Safe UI, call
`snapshot_submit_pending_vote` with it.

**Snapshot sequencer rejects the vote** — usually the space's validation, not the
signature: a minimum-balance requirement, or voting closed between the read and
the submission. The sequencer's own message is passed through verbatim.

**The watcher queues nothing** — `--plan` prints the spaces it resolved, the
Safe's voting power in each, and what every space and governor returned. An empty
result usually means the Safe has no voting power anywhere and no space was named
explicitly, or the space id or governor address is wrong, or nothing is open
right now. For on-chain proposals, the log line
reports the scan window that was used; check that it reaches back past the
proposal's creation, and that the governor is on `SAFE_CHAIN_ID`.

**"needs N eth_getLogs calls"** — the window is too wide for this chain's block
time. The error names where the window came from. If it was derived from the
Governor, the DAO genuinely has a long voting period, so raise
`GOVERNOR_LOG_CHUNK_BLOCKS` if your provider allows wider ranges. If it fell
back to `GOVERNOR_LOOKBACK`, shorten that instead.

**The watcher dispatches but no vote appears** — the entry stays `pending` with
`lastError` set in `data/schedule.json`, and the agent's output tail is on
stderr. The usual cause is an agent command that cannot reach the MCP server, so
check that `--mcp-config` points at a file naming this server.

## License

MIT
