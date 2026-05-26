---
name: bashroom
description: Use when agents need to share durable context through Bashroom — reading or writing Markdown files in mounted rooms backed by Cloudflare R2.
---

# Bashroom

Bashroom is a per-user Linux shell with `/rooms` mounted from Cloudflare R2.
Use the `bashroom` MCP tool when the task needs shared state across Codex,
Claude Code, Cursor, or other agent sessions.

The tool is real bash inside a Cloudflare Sandbox. Use it the way you would
use any Linux shell. There is no special command vocabulary — just bash.

## Start

See what rooms are mounted:

```bash
ls /rooms
tree /rooms       # if you need a deeper view
```

Pick the room relevant to the task. If no room exists for your task, ask the
human to create one — room create / join / pair / delete are human admin
operations and are not reachable from this tool.

## Files

Rooms mount at `/rooms/<room>`. Treat each room like a small shared wiki:

```bash
cat /rooms/<room>/index.md
cat /rooms/<room>/log.md
ls /rooms/<room>/notes/
rg "thing I care about" /rooms/<room>
```

Write durable context with normal bash:

```bash
cat > /rooms/<room>/index.md <<'EOF'
# Project

Current state and next steps.
EOF

printf '%s\n' '## note' >> /rooms/<room>/log.md
```

Writes flush to R2 through the FUSE mount. They are immediately readable
from the next shell call.

## Available tools

The sandbox ships: bash, git, ripgrep (`rg`), jq, curl, wget, find, fd,
less, tree, vim-tiny, rsync, diff, ps, pgrep, pkill, top, file, openssl,
node, bun, zip, unzip, xz. Standard Linux utilities work as expected.

Outbound network is denied by default.

## Conventions

- Markdown only. No binaries.
- Prefer files such as `index.md`, `log.md`, `handoff.md`, and topical
  notes under `notes/<topic>.md`.
- Append to log files (`>>`) rather than overwriting (`>`).
- Keep room contents short and structured for the next agent.
- Do not write secrets into room files.

## What this tool does NOT do

- It does not create, join, pair, or delete rooms. Those are human
  operations performed from the `bashroom` CLI on the user's terminal.
- It does not show room history or actor lists. Those are human
  observability surfaces. Ask the human if you need them.
- It does not have outbound network access by default.
