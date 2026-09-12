# Running Safe-MPC with Grok

Read this section before following any steps, because which Grok product you
mean changes the answer completely.

**Grok Bot cannot connect to Safe-MPC today.** Grok Bot runs from a persistent
cloud machine and attaches only MCP servers reachable over the public internet.
It does not spawn stdio servers and cannot reach anything on localhost. Safe-MPC
currently ships a stdio transport only, so there is nothing for Grok Bot to
attach to. Making it work means hosting Safe-MPC behind a public HTTPS endpoint,
which is code this repo does not have yet. See
[What Grok Bot would need](#what-grok-bot-would-need).

**Grok Build works today.** xAI's terminal coding agent supports stdio servers,
so it connects the same way every other local MCP client does. Start here.

## Grok Build, over stdio

### 1. Install and build

```bash
git clone https://github.com/Zoldenburg-me/Safe-MPC.git /srv/safe-mpc
cd /srv/safe-mpc
npm install
npm run build
```

Node 20 or newer. You also need a Safe Transaction Service API key, free from
[developer.safe.global](https://developer.safe.global). The server refuses to
start without one, and that applies to on-chain Governor voting too, not just
Snapshot.

### 2. Configure

```bash
node dist/setup.js --safe 0xYourSafeAddress --chain 1
```

This generates the agent key on this machine, writes `.env` at mode 600 with
absolute state paths, and leaves `DRY_RUN=true`. Add your API key and an RPC URL
to `.env` afterwards. Then add the printed agent address as an owner of your Safe
at [app.safe.global](https://app.safe.global), and verify:

```bash
npm run check
```

### 3. Register the server

Grok Build reads an `mcpServers` map in the same shape every other MCP client
uses:

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

Check the file path and exact key names against xAI's own Grok Build
documentation, which is the authority on where its config lives.

No secrets go in this file. The server loads `.env` from its own package root as
well as the working directory, so credentials stay in one mode-600 file.

### 4. Verify and then stay read-only

Ask it to run `safe_info`. That reports the chain, owners, threshold, both
relevant balances, and whether the agent can vote alone. Then use the read-only
tools and the `review_open_proposals` prompt, which recommends votes without
casting any, until you trust what it produces.

The full setup path, including the voting policy in `knowledge/`, going live,
unattended scheduling, and troubleshooting, is the same as for any local client.
[docs/openclaw.md](./openclaw.md) covers all of it step by step, from step 6
onward, and applies unchanged here.

## What Grok Bot would need

Grok Bot is not a configuration problem. It needs Safe-MPC to be a hosted
service, which means three pieces that do not exist yet:

**An HTTP transport.** The SDK version already in `package.json` ships
`StreamableHTTPServerTransport`, so this is a second entry point next to
`src/index.ts` rather than a rewrite. Roughly sixty lines: build the same
`McpServer`, hand it the HTTP transport instead of the stdio one, keep one
transport per session, and enable DNS rebinding protection with a real host
allowlist.

**Authentication.** This is the part that matters. An MCP endpoint for this
server is a button that votes with your Safe's tokens. Unauthenticated, it is a
public button. A bearer token compared in constant time is the floor; the SDK
also ships OAuth helpers under `server/auth` if you want real identity. Grok
Bot's custom-server form takes a URL and a credential, so a bearer token fits.

**TLS and a reverse proxy.** Bind the Node process to loopback and terminate TLS
in Caddy or nginx. Grok Bot connects from xAI's infrastructure over the public
internet, so the certificate has to be real.

### Think about this before building it

Hosting changes the risk in a way the stdio setup does not. Over stdio, the
owner key is reachable only by the parent process on your own machine. Behind a
public endpoint, the key is reachable by anything that gets the token, and the
agent holding that token runs on infrastructure you do not control.

If you go this route:

- Keep the Safe threshold above 1, so a compromised token cannot complete a vote
  on its own. This is worth more than every other control combined.
- Set `ALLOWED_SNAPSHOT_SPACES` and `ALLOWED_GOVERNORS`. Empty means unrestricted.
- Treat the token as a signing credential. Rotate it, scope it to one client,
  and never put it in the repo.
- Remember that one deployment serves exactly one Safe. `loadConfig` memoizes a
  single config and there is one signer key per process, so multi-tenant hosting
  is a much larger change than adding a transport.

### Grok Build as the alternative

If what you want is a Grok model voting from your Safe, and not specifically the
cloud bot, Grok Build gives you that today with no public endpoint, no token to
leak, and the key staying on your own machine. That is a better trade for this
particular server unless you specifically need the always-on cloud agent.

## Sources

The Grok Bot limitation above is drawn from xAI's MCP documentation and
corroborated by third-party integration guides, because it is the one constraint
that determines whether any of this works. Verify it against
[docs.x.ai](https://docs.x.ai/build/features/mcp-servers) before investing in the
hosting work, since product behaviour changes.
