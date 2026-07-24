---
name: bashroom
description: A filesystem for agents — durable shared Markdown at /rooms, sequenced by RoomText and mirrored to Cloudflare R2. Use for persistent notes, handoffs, project scratch wikis, and collaborative agent edits.
---

# Bashroom

`bashroom({ command, stdin? })` runs real `bash` inside a per-user
Cloudflare Sandbox. Authorized rooms appear read-only at
`/rooms/<room>/...`. Use the shell for inspection, regex, and computation;
durable writes go through the structured edit/write tools so conflicts cannot
silently clobber another collaborator. Room admin is exposed through the
visible `bashroom` executable inside the sandbox.

`bashroom_edit({ path, old_text, new_text, before?, after?, request_id })`
changes one unique span of Markdown through the room sequencer.
`bashroom_write({ path, content, encoding?, base_etag?, create_only? })`
creates or replaces one complete file.

Read-only context tools (`bashroom_tree`, `bashroom_read`,
`bashroom_search`, `bashroom_stat`) read authoritative state without
starting bash. Prefer them over `tree`, `cat`, or broad `rg` when you
want bounded, predictable model context.

Role-link tools (`bashroom_shared_read`, `bashroom_shared_write`,
`bashroom_shared_comment`) open one document another Bashroom user shared
without mounting that user's room. The link grants scope; your own Bashroom
token supplies the audited actor identity.

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
bashroom history my-room          # per-room activity log (not file versions)
```

`bashroom login`, `bashroom token`, `bashroom mcp`, and
`bashroom destroy` are laptop-only. Destructive room deletion is currently
disabled while RoomText owns files so a partial Registry/R2/SQLite delete
cannot strand or lose data.

## Read and write

Prefer structured tools for routine context retrieval:

```jsonc
bashroom_tree({ "path": "/rooms/my-room", "max_entries": 200 })
bashroom_read({ "path": "/rooms/my-room/index.md", "max_bytes": 64000 })
bashroom_search({ "path": "/rooms/my-room", "query": "decision" })
bashroom_stat({ "path": "/rooms/my-room/index.md" })
```

Use shell when you need real read/computation behavior:

```bash
cat /rooms/<room>/index.md
cat /rooms/<room>/log.md
ls /rooms/<room>/notes/
rg "thing I care about" /rooms/<room>
```

`/rooms` is intentionally read-only. Do not use redirection, `sed -i`, `mv`,
or `rm` there.

## bashroom_edit

Prefer a targeted edit for existing Markdown. The server resolves the literal
against the current head inside RoomText, so an insertion elsewhere does not
stale a numeric offset.

```jsonc
bashroom_edit({
  "path": "/rooms/my-room/index.md",
  "old_text": "Status: draft",
  "new_text": "Status: approved",
  "before": "## Launch\n",
  "request_id": "approve-launch-v1"
})
```

- `old_text` plus optional immediate `before`/`after` context must identify
  exactly one span. Zero or multiple matches change nothing.
- `request_id` is the idempotency key. Reuse it only when retrying that exact
  operation.
- An edit is one canonical ChangeSet and is broadcast to connected editors.

## bashroom_write

When file content contains quotes, backticks, `$variables`, or arbitrary
bytes, heredocs and `echo >` get mangled by shell quoting. Use the
`bashroom_write` tool instead — it routes the authorized file through
RoomText or its explicit R2 fallback without starting the sandbox:

```jsonc
bashroom_write({
  "path": "/rooms/my-room/notes/snippet.md",  // must be under /rooms/<room>/
  "content": "anything: `backticks`, $vars, \"quotes\", newlines — all literal",
  "encoding": "utf-8",  // "utf-8" (default) | "base64" for binary
  "base_etag": "version from bashroom_read or bashroom_stat" // replacement guard
})
```

- **Path must name a file under `/rooms/<room>/`**, and the caller must have
  that room's `write` scope.
- **5 MB decoded-byte cap** per write. Base64 is validated before decoding.
- **Pass `base_etag` for replacements.** Existing RoomText Markdown requires
  the version returned by read/stat; a stale version returns `conflict`.
- **Use `create_only=true` for a new path.** It fails with `exists` if another
  collaborator created the file first.

Prefer `bashroom_edit` for a small change; use `bashroom_write` when the whole
document is the intended unit.

## Read-only context tools

- `bashroom_tree({ path, max_entries? })` lists rooms when `path` is
  `/rooms`, or file metadata under `/rooms/<room>/<prefix>`.
- `bashroom_read({ path, offset?, max_bytes? })` reads a bounded text
  range. Default `max_bytes` is 64 KB; hard cap is 512 KB.
- `bashroom_search({ path, query, case_sensitive?, max_matches?,
  max_files?, max_bytes_per_file? })` performs bounded literal search
  over text files. Use `bashroom` + `rg` for regex or advanced search.
- `bashroom_stat({ path })` returns authoritative metadata for one file without
  reading its body.

## Shared document links

When the user gives you a Bashroom Comment or Edit link, do not look for its
document under `/rooms`; role links deliberately do not create room membership.

```jsonc
bashroom_shared_read({ "link": "https://bashroom.sdan.io/s/<slug>" })
bashroom_shared_write({
  "link": "https://bashroom.sdan.io/s/<slug>",
  "content": "complete replacement body",
  "base_etag": "etag from bashroom_shared_read"
})
bashroom_shared_comment({
  "link": "https://bashroom.sdan.io/s/<slug>",
  "quote": "exact substring of the raw Markdown source",
  "body": "the inline comment",
  "document_etag": "version from bashroom_shared_read",
  "anchor_start": 42
})
```

- View links are anonymous browser links and are not accepted by shared MCP
  mutation tools.
- Comment links permit read + inline comment. Edit links also permit CAS
  replacement.
- Always read first and pass `base_etag` when editing. A stale save returns
  `conflict`, never a silent overwrite.
- Stored raw-Markdown source offsets are the anchor authority; there is no quote
  re-anchoring. A comment whose offsets no longer match its `quote` shows as
  drifted ("Text moved") in the share page rather than highlighting a guess.

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
- Append logically by reading the current file and using a unique
  `bashroom_edit` anchor, or replace with `bashroom_write` plus its version.
  Shell redirection under `/rooms` is unavailable.
- Keep entries short and structured for the next agent.
- Do not write secrets. Files are private but not encrypted at rest.

## Handoff (end of session / before compaction)

> **Canonical source:** the live, authoritative version of this template is
> `/rooms/bashroom/notes/handoff-template.md` in the apex `bashroom` room.
> The copy below is a snapshot for offline reference. If the two differ, the
> room file wins — re-sync this section from it rather than the reverse.

Write a handoff when context quality starts to degrade (roughly past ~120k
tokens, or before ~30% of a 1M window), at the end of a work session, before
a `/clear` or compaction, or when handing the baton to another agent
(Codex / Cursor) or machine.

**The one rule that matters.** Before writing any line, ask: *can the next
agent get this by reading the code, `git log`, or `CLAUDE.md`/`AGENTS.md`?*
If yes — cut it, or replace it with a pointer (a path or a commit hash). A
handoff is *only* the things that live in your head and nowhere else: the
why, the dead ends, the next move.

- **Coordinates over content.** Prefer commit hashes + file paths over pasted
  code. Cheaper in tokens, and never goes stale.
- **No secrets.** No keys, tokens, or PII. Activity history is not file
  version recovery.

**Where.** Add the handoff to the project room's `log/YYYY-MM-DD.md` under a
`## HH:MM <topic> — handoff` heading using `bashroom_edit` or a versioned
whole-file write. Update `index.md` only if its tree changed.

**Skeleton:**

```
## HH:MM <topic> — handoff

### Coordinates
- Branch: <name> (base: <main>), N commits ahead, pushed? <yes/no>
- Key commits: <hash> <one-line>, ...
- Touched: <path>, <path>   (full picture: `git log -p <base>..HEAD`)

### Goal
<one line — what we're actually trying to achieve>

### Status
- Done: ...
- In progress: ...
- Not started: ...

### Decisions + why
- <decision> — <rationale>   (only the non-obvious ones)

### What to avoid
- <failed attempt / dead end / out-of-scope thing the next agent might retry>

### Blockers / open questions
- <needs a human decision, or an unresolved unknown>

### Next best step
1. <the single immediate action>
2. <then the ordered backlog>

### Resume prompt
<a pasteable one-liner for the next session — see below>
```

**Trigger prompt** (paste at the end of a session):

> Write a handoff into <room> following bashroom/notes/handoff-template.md:
> coordinates, goal, status (done/in-progress/todo), key decisions + why, what
> to avoid, blockers, next step, and a resume prompt. Prefer commit hashes and
> file paths over pasted code. Include only what the next agent can't get from
> the code, git log, or CLAUDE.md. Append to today's log; don't overwrite.

**Resume prompt** (paste at the start of the next session):

> Read the latest handoff in <room>/log/. Start with a 2-line summary of your
> understanding, then continue from the "Next best step" — don't restart from
> scratch.

## Gotchas

- **Each MCP call is a fresh process session.** `cwd`, environment
  variables, shell variables, and shell functions do NOT persist. The warm
  sandbox filesystem can persist; `/rooms` is a durable read projection. Always use absolute
  paths.
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
- **RoomText reads are strong** for eligible Markdown; R2 remains the guarded
  mirror and the authority for unsupported files.
- **No hidden command interception.** `bashroom create-room ...` works
  because `/usr/local/bin/bashroom` is on `PATH`; ordinary commands still
  run as real bash.

## What this tool does NOT do

- Delete rooms while RoomText owns files — the service rejects partial
  Registry/R2/SQLite deletion.
- Reach outbound network by default.
- Persist shell state between calls.
