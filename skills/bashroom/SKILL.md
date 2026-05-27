---
name: bashroom
description: Per-user Linux shell with a durable shared Markdown filesystem at /rooms backed by Cloudflare R2. Use when the task needs notes that persist across agent sessions, when handing off work between Claude / Codex / Cursor, when keeping a project scratch wiki, when other agents may continue this work, or when the user mentions "bashroom", "room", "shared notes", or "agent handoff".
---

# Bashroom

`bashroom({ command, stdin? })` runs real `bash` inside a per-user
Cloudflare Sandbox. Authorized rooms appear at `/rooms/<room>/...`,
FUSE-mounted from Cloudflare R2. Use it like any Linux shell — there
is no hidden command parser. Room admin is exposed through the visible
`bashroom` executable inside the sandbox.

## Start

```bash
ls /rooms                 # what rooms am I in?
tree /rooms/<room>        # deeper look at one room
```

If no room fits the task, create one yourself:

```bash
bashroom create-room my-room
```

## Room admin

```bash
bashroom rooms                    # list rooms you can access
bashroom create-room my-room      # create and seed a room
bashroom mounts                   # list mounted rooms with actor + scopes
bashroom who my-room              # list actors in a room
bashroom history my-room          # per-room audit log
bashroom pair my-room             # mint a short-lived invite
bashroom join <invite>            # redeem an invite
```

`bashroom login`, `bashroom token`, `bashroom mcp`, and
`bashroom destroy` are laptop-only.

## Read and write

```bash
cat /rooms/<room>/index.md
cat /rooms/<room>/log.md
ls /rooms/<room>/notes/
rg "thing I care about" /rooms/<room>

cat > /rooms/<room>/index.md <<'EOF'
# Project
Current state and next steps.
EOF

printf '%s\n' "## $(date +%H:%M) topic" >> /rooms/<room>/log.md
```

Writes flush to R2 through the FUSE mount and are immediately readable
from the next call.

## Tools

`bash`, `git`, `ripgrep` (`rg`), `jq`, `find`, `fd`, `less`, `tree`,
`vim-tiny`, `rsync`, `diff`, `ps`, `pgrep`, `pkill`, `top`, `file`,
`openssl`, `node`, `bun`, `zip`, `unzip`, `xz`, `curl`, `wget`.
Standard Linux utilities work as expected.

## Conventions

- Markdown only. No binaries.
- Default file shape: `index.md` (TOC), `log/YYYY-MM-DD.md` (dated
  entries, append `## HH:MM topic` sections), `notes/<topic>.md`
  (one file per subject). Each room ships an `AGENTS.md` with its own
  per-room rules — read it before writing.
- Append to log files (`>>`), do not overwrite (`>`) — preserves
  chronology. Other agents may be writing the same file.
- Keep entries short and structured for the next agent.
- Do not write secrets. Files are private but not encrypted at rest.

## Gotchas

- **Each MCP call is a fresh shell session.** `cwd`, environment
  variables, shell variables, and shell functions do NOT persist. Only
  `/rooms` (R2-backed) persists. Always use absolute paths.
- **`/tmp` is shared across this user's concurrent sessions**, unlike
  `cwd`/env. Don't rely on it for per-call scratch; use `/rooms` or
  unique temp names if you write to `/tmp`.
- **`rg /rooms` (all rooms) can time out** over the FUSE mount with
  many rooms or large trees. Scope to one room: `rg pattern /rooms/<room>`.
- **Outbound network is denied.** `curl https://...` will fail.
  The `bashroom` helper has a private internal control channel, but
  arbitrary outbound HTTP remains unavailable.
- **The 30-second command timeout** applies per call. Long-running work
  must be split, or it gets killed.
- **R2 is strongly consistent per key**, so a `cat` after `>>` in the
  next session sees the appended content. But `ls` listings may briefly
  lag a write — re-run if a freshly-written file isn't visible.
- **No hidden command interception.** `bashroom create-room ...` works
  because `/usr/local/bin/bashroom` is on `PATH`; ordinary commands still
  run as real bash.

## What this tool does NOT do

- Delete rooms — destructive room removal is laptop-only.
- Reach outbound network by default.
- Persist shell state between calls.
