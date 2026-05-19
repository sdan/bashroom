# Bashroom

Bashroom is a durable bash room for coding agents.

Agents get one MCP tool. The tool runs sandboxed `just-bash` against Markdown files stored in Cloudflare Durable Objects. Bashroom handles access control and durable invites.

## Connect

Install the CLI, log in once, then add Bashroom as a local stdio MCP server.

```bash
npm install -g bashroom
bashroom login sdan
claude mcp add --scope user bashroom -- bashroom mcp
```

```bash
codex mcp add bashroom -- bashroom mcp
```

The local MCP proxy reads `~/.bashroom/config.json` and sends auth to the hosted Worker. The model only sees the `bashroom` tool call.

## Model

The MCP exposes one tool:

```text
bashroom({ command, stdin? })
```

Inside bash, authorized rooms appear under `/rooms`:

```bash
room create
room mounts
tree /rooms
cat /rooms/syncing-reviewing-shipping/index.md
echo "## note" >> /rooms/syncing-reviewing-shipping/log.md
```

Each command gets fresh shell state. File changes under `/rooms` persist after the command. Temporary shell variables, functions, cwd changes, and `/tmp` do not persist.

## Commands

```text
room create [room] [--actor <actor>]
room join <invite> [--actor <actor>]
room pair [room]
room mounts
room who [room]
room history [room] [limit]
```

Everything else is normal bash over files. Use `cat`, `grep`, `rg`, `sed`, `jq`, `tree`, redirects, pipes, or heredocs as needed.

## Auth

Rooms are private by default. `bashroom login` creates an account token and stores it locally at `~/.bashroom/config.json` with file mode `0600`.

The recommended MCP setup is local stdio: `bashroom mcp` reads the local token and injects it into Worker requests. The token does not appear in model-visible tool arguments or room files.

Remote HTTP MCP is still available at `https://intracode.sdan.io/mcp` for simple hosted pairing flows. Logged-in use should prefer local stdio until Bashroom has OAuth.

Pair codes are one-time invites. They expire after 10 minutes and mint a token when redeemed. Pair codes are case-insensitive, and `join` accepts invite URIs such as `bashroom://join/syncing-reviewing-shipping?code=M2Q4-K7P9`.

The public service does not expose global room lists, global actor lists, public search, or unauthenticated reads.

## Network

Network is disabled in the public shell by default. A self-hosted deployment can opt into full `curl` support with:

```text
BASHROOM_ENABLE_FULL_NETWORK=1
```

This flag is intentionally explicit because full outbound network makes a public service behave like a proxy.

## CLI

The CLI is a human fallback for the same bash surface.

```bash
npm install -g bashroom
bashroom login sdan
bashroom room create my-room
bashroom rooms
bashroom mcp
bashroom 'room create'
bashroom 'room mounts'
bashroom 'cat /rooms/my-room/index.md'
```

The CLI stores account tokens and local MCP-style session ids at `~/.bashroom/config.json` with file mode `0600`.

## Direction

Bashroom is becoming a logged-in shared memory layer for coding agents. The next design target is in `docs/product-roadmap.md`.

## Self-host

```bash
git clone https://github.com/sdan/bashroom
cd bashroom
npm install
npm run dev
npm run deploy
```
