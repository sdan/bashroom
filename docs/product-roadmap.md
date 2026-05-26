# Bashroom Product Roadmap

Bashroom is the shared cloud shell and memory layer for coding agents.

It should let coding agents and humans exchange durable project context through
a bash-addressable filesystem. Rooms are the product primitive. In v2, the bash
surface is a real Cloudflare Sandbox backed by R2-mounted room files.

## Goal

Build a logged-in service where a user owns rooms. Each agent joins as an actor. Every room is mounted as files under `/rooms/<room>`.

Agents should be able to read and write:

```text
/rooms/<room>/index.md
/rooms/<room>/log.md
/rooms/<room>/handoff.md
/rooms/<room>/sessions/
```

## Product Boundary

Bashroom owns:

- user accounts and room membership
- durable shared room files
- per-user cloud shell execution
- actor attribution and audit logs
- local CLI and MCP access
- syncing session history into rooms

Bashroom does not own:

- a transcript viewer
- a local FUSE filesystem on the user's machine
- model summarization as a required runtime dependency

## Identity Model

Use one user account as the root identity.

```text
user:  sdan
actor: codex-macbook-7f3a
actor: claude-llmdev-a19c
room:  suryad
```

Room ownership and account-level limits attach to the user. Writes are attributed to actors.

Pair codes remain useful for inviting another agent or machine into a room. They
should mint scoped actor credentials. The user's account token should stay
local.

V2 initially mounts only rooms owned by the signed-in user. Shared rooms remain
in the Registry schema but are deferred until the v2.1 storage model is chosen.

## Local MCP

Remote HTTP MCP works for simple pairing, but logged-in use should prefer a local stdio MCP proxy.

```bash
bashroom login
bashroom mcp
```

The local proxy can read `~/.bashroom/config.json`, inject user auth, and keep room tokens out of model-visible tool arguments.

## Session History

Session sync should import local Claude and Codex work into room files.

Use convx as the first backend because its output model is close to what Bashroom needs:

```text
history/<user>/<source>/<machine>/<path>/<session>.md
history/<user>/<source>/<machine>/<path>/.<session>.json
```

Bashroom should sync the Markdown history into:

```text
/rooms/<room>/sessions/<user>/<source>/<path>/<session>.md
```

Known convx gaps to handle before shipping:

- Codex JSONL parsing can crash on malformed rollout fragments.
- Claude orphan subagents may be missed when the parent main session is unavailable.
- Convx should remain a session export backend. Bashroom should own authorization, room state, and cloud sync.

## Phases

### Phase 1: Account Rooms

- `bashroom login` creates a local account token.
- `bashroom rooms` lists rooms owned by the account.
- `bashroom room create <name>` creates an account-owned room.
- User credentials are stored locally with file mode `0600`.
- Keep existing pair-code room joins.

### Phase 2: Local MCP Proxy

- Add `bashroom mcp`.
- Expose one MCP tool: `bashroom({ command, stdin? })`.
- Forward commands to the hosted Worker with user auth.
- Preserve the current bash room surface.

Status: implemented in the CLI. This is now the default logged-in MCP path.

### Phase 3: Session Export

- Add `bashroom sessions export --backend convx --project .`.
- Write exports to a local `.bashroom/history` or user-selected output path.
- Patch or wrap convx so one malformed Codex file does not fail the full export.

### Phase 4: Session Sync

- Add `bashroom sessions sync --room <room>`.
- Upload changed Markdown transcripts into `/rooms/<room>/sessions`.
- Write `/rooms/<room>/sessions/index.md`.

### Phase 5: Handoff Files

- Add conventions for `index.md`, `log.md`, `handoff.md`, and `sessions/index.md`.
- Let agents maintain concise summaries after raw transcripts are synced.

### Phase 6: Cloud Shell v2

- Add an R2 bucket for room files using `users/<user_id>/<room>/<path>`.
- Add a Cloudflare Sandbox binding and image with bash, coreutils, ripgrep, git, jq, and curl.
- Route flagged users from the existing MCP tool to `runShellV2()`.
- Preserve v1 as rollback until migrated users have soaked.
- Move command audit to the Registry Durable Object.
- Keep outbound network disabled by default.

## Near-Term Rule

Keep the hosted Worker small where possible, but v2 intentionally moves command
execution into a managed cloud shell. Put local transcript parsing and stdio MCP
in the CLI; put remote shell execution, room mounting, and audit in the Worker
and Sandbox stack.
