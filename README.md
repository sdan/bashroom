# Bashroom

Bashroom is a filesystem for agents: save notes, share files,
and hand off work between running sessions.

Agents get real `bash` plus structured R2-backed file/context tools. The
shell runs inside a Cloudflare Sandbox, with `/rooms` FUSE-mounted from
Cloudflare R2. The structured tools (`tree`, `read`, `search`, `stat`) read
directly from R2 without booting a sandbox. Bashroom handles access control,
durable room files, and audit. Room admin (create, join, pair, mounts, who,
history) is also available inside the sandbox through the visible `bashroom`
helper. Destructive room deletion stays on the laptop CLI.

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

The local MCP proxy reads `~/.bashroom/config.json` and sends auth to the hosted Worker. The model only sees Bashroom MCP tool calls, never the account token.

## Model

The MCP exposes six tools:

```text
bashroom({ command, stdin? })
bashroom_write({ path, content, encoding? })
bashroom_tree({ path, max_entries? })
bashroom_read({ path, offset?, max_bytes? })
bashroom_search({ path, query, case_sensitive?, max_matches?, max_files?, max_bytes_per_file? })
bashroom_stat({ path })
```

Use `bashroom` when you need real command execution. Use the structured tools
for routine file/context retrieval and exact writes; they are bounded and avoid
shell quoting hazards.

Inside bash, authorized rooms appear under `/rooms`:

```bash
ls /rooms
tree /rooms
cat /rooms/<room>/index.md
echo "## note" >> /rooms/<room>/log.md
rg "thing I care about" /rooms
bashroom create-room new-room
bashroom rooms
```

For bounded context:

```jsonc
bashroom_tree({ "path": "/rooms/my-room", "max_entries": 200 })
bashroom_read({ "path": "/rooms/my-room/index.md", "max_bytes": 64000 })
bashroom_search({ "path": "/rooms/my-room", "query": "decision" })
bashroom_stat({ "path": "/rooms/my-room/index.md" })
```

Each MCP call gets a fresh session — cwd, env, and `/tmp` do not leak
between calls. Only `/rooms` (R2-backed) persists. The sandbox stays warm
between calls for ~15 minutes, so subsequent calls skip the cold-start tax.

## Shell tools

The sandbox ships: `bash`, `git`, `ripgrep` (`rg`), `jq`, `curl`, `wget`,
`find`, `fd`, `less`, `tree`, `vim-tiny`, `rsync`, `diff`, `ps`, `pgrep`,
`pkill`, `top`, `file`, `openssl`, `node`, `bun`, `zip`, `unzip`, `xz`,
`ca-certificates`. Standard Linux utilities work as expected.

Outbound network is denied by default.

## Room admin

From the laptop CLI:

```bash
bashroom mounts                       # list your rooms
bashroom create-room <name>           # create a new room
bashroom join <invite>                # redeem a pair-code invite
bashroom pair <room>                  # mint an invite to share
bashroom destroy <room> --yes         # remove a room
bashroom who <room>                   # list actors in a room
bashroom history <room> [--limit N]   # per-room audit log
```

Inside the sandbox, `/usr/local/bin/bashroom` supports the non-destructive
control surface:

```bash
bashroom rooms
bashroom create-room <name>
bashroom mounts
bashroom who <room>
bashroom history <room> [--limit N]
bashroom pair <room>
bashroom join <invite>
```

The sandbox helper sends no account token. Calls to `bashroom.internal`
are intercepted by the Worker, which supplies identity from the
authenticated sandbox context. `bashroom destroy`, `bashroom login`,
`bashroom token`, and `bashroom mcp` remain laptop-only.

## Auth

Rooms are private by default. `bashroom login` creates an account token and stores it locally at `~/.bashroom/config.json` with file mode `0600`.

The recommended MCP setup is local stdio: `bashroom mcp` reads the local token and injects it into Worker requests. The token does not appear in model-visible tool arguments or room files.

Remote HTTP MCP is also available at `https://bashroom.sdan.io/mcp`.

Pair codes are one-time invites. They expire after 10 minutes and mint a token when redeemed. Pair codes are case-insensitive, and `join` accepts invite URIs such as `bashroom://join/syncing-reviewing-shipping?code=M2Q4-K7P9`.

The public service does not expose global room lists, global actor lists, public search, or unauthenticated reads.

## Network

Network is disabled in the public shell by default, except for the
private `bashroom.internal` control channel used by the sandbox helper.
A self-hosted deployment can opt into full `curl` support with:

```text
BASHROOM_ENABLE_FULL_NETWORK=1
```

This flag is intentionally explicit because full outbound network makes a public service behave like a proxy.

## CLI

The CLI is the human surface — both for room admin (above) and as a
fallback for the same bash that the MCP agent sees.

```bash
npm install -g bashroom
bashroom login
bashroom create-room my-room
bashroom mounts
bashroom mcp
bashroom 'ls /rooms'
bashroom 'cat /rooms/my-room/index.md'
```

The CLI stores account tokens and local MCP-style session ids at `~/.bashroom/config.json` with file mode `0600`.

## Web

A read-only browser view of your rooms is served at `/web`. Paste your account token (from `~/.bashroom/config.json`) once; the sidebar lists every room as a collapsible section, each expanding into a file tree. Clicking a file renders the Markdown in the content pane. No editor — agents write through MCP, humans read through the web.

Two panes, Notion-shape: sidebar plus content. Single inline HTML served from the worker — no build, no framework.

## Agent-readable

Two endpoints follow the [llms.txt convention](https://llmstxt.org/) so an
agent can discover and load bashroom without parsing HTML:

- `https://bashroom.sdan.io/llms.txt` — table of contents, links out to
  the README, skill, and MCP endpoint
- `https://bashroom.sdan.io/skill.md` — the bundled SKILL.md served
  verbatim, lets an agent pick up the contract without installing the
  skill locally

The SKILL.md served at `/skill.md` is the same file at
`skills/bashroom/SKILL.md` in this repo — bundled into the worker at
build time so there's one source of truth.

## Direction

Bashroom is a filesystem for agents: save notes, share files,
and hand off work between running sessions. The v3 architecture is documented
in `ARCHITECTURAL.md`; the product sequence is in `docs/product-roadmap.md`;
how the six-tool harness compares to Claude Code's is in
`docs/harness-vs-claude-code.md`.

## Self-host

```bash
git clone https://github.com/sdan/bashroom
cd bashroom
npm install
npm run dev
npm run deploy
```
