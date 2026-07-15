# Bashroom Architecture

This file is the current-state truth. Dated measurements and the reasoning
behind load-bearing decisions live in [NOTES.md](NOTES.md); start there for
"why is it built this way".

## Mission

Bashroom gives an authenticated agent durable files plus a real Linux shell.
The product contract is deliberately narrow:

- R2 is the source of truth for files under `/rooms`.
- The Worker owns authentication, authorization, quotas, and tool contracts.
- Cloudflare Sandbox supplies disposable compute; it does not own durable data.
- MCP is the primary agent interface. The CLI and web app are adapters around
  the same Worker-owned behavior.

Bashroom is not a general sandbox product, a git host, or a file-versioning
system. `history` is an activity log and cannot restore old file contents.

## End-to-end shape

```text
MCP client
  -> local stdio adapter (optional, bin/bashroom.js)
  -> POST /mcp with bearer token
  -> Worker-owned tool contract
       -> tree/read/search/stat: authenticated R2 access
       -> write: authenticated, scope-checked R2 PUT with optional etag CAS
       -> bash: fresh process session in the user's warm Sandbox
            -> /rooms: credentialless R2-binding mount, user prefix only

Browser
  -> /web/api/*
  -> AccountDO authorization
  -> direct R2 reads/writes + RoomHub live activity

Role link (/s/<slug>)
  -> Registry capability lookup (one owner/room/document + role)
  -> View: anonymous rendered Markdown
  -> Comment/Edit: Bashroom identity required
       -> R2 file body + DocumentCollab inline comments
```

The stdio server does not declare its own tools. It uses the official MCP
client transport to forward `tools/list` and `tools/call` to the hosted
Worker. That makes `src/index.ts` the only MCP contract to maintain.

## Ownership map

| Component | Owns | Must not own |
| --- | --- | --- |
| Worker (`src/index.ts`) | Routes, MCP schemas, authorization, orchestration | Durable file bodies |
| AccountDO | Hot token verification, per-user quotas, room mirror | File bodies, event history |
| Registry DO | Users, OAuth/device state, canonical memberships, audit rows | File bodies |
| R2 (`ROOMS_R2`) | Durable room objects and object metadata | Auth policy |
| Sandbox DO/container | Warm Linux compute and `/rooms` FUSE mount | Credentials, canonical auth, durable state |
| RoomHub DO | Presence, recent write activity, ephemeral draft relay | File contents at rest |
| DocumentCollab DO | Inline comment anchors, bodies, and resolution state for one R2 document | File bodies, share capabilities |
| CLI (`bin/bashroom.js`) | Login/admin UX and transparent stdio transport | MCP tool definitions |

## MCP contract

The Worker exposes nine tools:

- `bashroom({ command, stdin? })`: real bash for pipelines, git, regex search,
  and multi-file operations.
- `bashroom_write({ path, content, encoding?, base_etag? })`: direct R2 write.
  The decoded payload is capped at 5 MB. The caller needs room `write` scope.
  `base_etag` turns replacement into compare-and-swap.
- `bashroom_tree({ path, max_entries? })`: bounded R2 prefix metadata.
- `bashroom_read({ path, offset?, max_bytes? })`: bounded text byte range.
- `bashroom_search(...)`: bounded literal search over eligible R2 text objects.
- `bashroom_stat({ path })`: R2 object metadata without the body.
- `bashroom_shared_read({ link, max_bytes? })`: bounded access to the exact
  document named by a Comment or Edit link, including etag and comments.
- `bashroom_shared_write({ link, content, base_etag })`: CAS-protected
  replacement through an Edit link.
- `bashroom_shared_comment({ link, quote, body, ... })`: add a quote-anchored
  inline comment through a Comment or Edit link.

The direct tools exist because starting Linux for one list, read, stat, or PUT
adds latency and expands authority for no customer benefit. Shell remains the
escape hatch for operations that genuinely need Unix semantics.

Every tool authorizes independently. The `/mcp` transport is stateless and
does not use an `Mcp-Session-Id`.

## Storage and room identity

R2 keys are:

```text
users/<user_id>/<room>/<path>
```

This is a per-user ownership model. Cross-account shared *rooms* are not a
supported product contract: a membership row alone cannot make two user
prefixes refer to the same canonical object set. Role links are intentionally
narrower: they authorize one owner-scoped document without creating a room
membership or a second storage identity.

R2 object `etag`, `version`, `uploaded`, and `size` are authoritative metadata.
Local/FUSE directory mtimes are not product truth.

### Write consistency

- Web writes and `bashroom_write` go directly to R2.
- Both enforce decoded byte limits and room `write` scope.
- Web sends the etag it read; MCP callers can send `base_etag`.
- A failed conditional PUT returns `conflict` instead of clobbering a newer
  object.
- Shell writes use FUSE and therefore retain normal shell behavior, but they do
  not currently expose per-file etags or changed-path precision.

## Sandbox boundary

There is one Sandbox DO per authenticated `user_id`, configured with
`sleepAfter = "15m"`. The container image is pinned to
`docker.io/cloudflare/sandbox:0.12.3` in `Dockerfile`.

On first shell use, the Worker mounts:

```text
binding: ROOMS_R2
prefix:  /users/<user_id>/
path:    /rooms
```

The mount uses Sandbox SDK R2-binding egress through the exported
`ContainerProxy`. No R2 access key or secret is written into the container.
A local sentinel forces warm containers with the former credential-bearing
mount to unmount and migrate once.

Each shell call creates a fresh named process session and reaps it after the
response. `cwd` and environment do not carry between calls. The container
filesystem is still warm and shared: `/tmp` may persist and is visible to
concurrent calls. Only `/rooms` is a durable product guarantee.

Outbound network is denied except for `bashroom.internal`. The sandbox helper
uses that internal route for non-destructive room control; the Worker supplies
the trusted user identity from the Sandbox binding, never from a container
token.

## Authentication and OAuth

Two Durable Objects split the hot and cold path:

- AccountDO verifies routeable bearer tokens, meters requests, and returns the
  account's room/scopes mirror.
- Registry owns GitHub/device OAuth, legacy tokens, canonical memberships,
  share capabilities, and audit events.

MCP OAuth implements discovery, dynamic client registration, authorization
code flow, and PKCE S256. Redirect registration accepts public HTTPS URLs and
loopback HTTP URLs only, with exact-match validation at authorize and token
exchange. GitHub receives only an opaque `mcp.<state>` value; the registered
redirect URI, client state, and short-lived authorization code remain in the
Registry row. This prevents callback-state tampering from selecting a redirect
target.

All deferred Worker work receives the current `ExecutionContext` explicitly.
There is no module-global request context because isolates may interleave
requests.

## Web and live activity

`/web` is a reader/editor backed directly by R2:

- `/web/api/rooms`, `/tree`, `/file`, `/raw`, and `/search` are authenticated.
- `PUT /web/api/file` requires `write` scope and uses etag CAS.
- `/s/<slug>` carries one immutable `view`, `comment`, or `edit` role. View
  links may expose a file or room prefix anonymously. Comment/Edit links are
  exact-file capabilities and require a separate Bashroom account identity.
- `DocumentCollab` is keyed by the canonical R2 document identity, so all role
  links for that file share one inline comment thread. Anchors keep rendered
  text offsets plus the selected quote; the client re-anchors a unique quote
  after nearby edits and marks ambiguous/missing anchors as moved.
- Active content types from shares are downgraded to text and rendered
  Markdown is sanitized under a restrictive CSP. Mermaid fences render in
  strict mode; ASCII/text diagram fences remain source-faithful.

RoomHub is keyed by `<user_id>:<room>`. It keeps a small activity ring and
relays ephemeral draft frames. Every outgoing write or draft is filtered
against each socket's share prefix. View/Comment sockets are receive-only;
an authenticated Edit socket may send drafts for its one document. Durable
saves still use R2 etag CAS rather than treating draft frames as storage.
Each draft carries the writer's Markdown-source caret offset. Readers map that
offset into sanitized rendered text and paint an actor-colored cursor; caret
movement is ephemeral and never enters R2 or the activity log.

## Audit truth

Audit rows record:

- room lifecycle/control events;
- direct MCP writes;
- direct web writes;
- role-link edits/comments with the recipient handle and account id; and
- shell commands, attributed to each room explicitly mentioned in the command
  (or to the account-level log when no room is mentioned).

This is observability, not version recovery. Shell changed paths are heuristic
and currently reported as empty. Do not claim that every filesystem mutation
is reconstructable.

## Build and source layout

Runtime source is committed, including:

```text
src/index.ts
src/security.ts
src/document-collab.ts
src/web-collab.ts
src/web-ui.ts
src/web-landing.ts
src/web-device.ts
bin/bashroom.js
bin/sandbox-bashroom.js
skills/bashroom/SKILL.md
```

The Worker bundles `skills/bashroom/SKILL.md` and serves the exact bytes at
`/skill.md`; the repo skill and hosted agent guidance therefore share one
source. `npm run check` runs TypeScript, focused security tests, and the CLI
smoke test. A clean checkout must pass the same command.

## Security invariants

- Never put bearer tokens, R2 credentials, or OAuth secrets in the sandbox.
- Parse and authorize the exact room before every direct R2 operation.
- Enforce limits on decoded bytes, not JavaScript character count.
- Use etag compare-and-swap for read/modify/write flows.
- Treat Markdown, filenames, WebSocket frames, and shell commands as untrusted.
- Keep public share events inside their authorized prefix.
- Never return owner storage coordinates or sibling paths to a role-link user.
- Keep destructive room deletion outside the model-facing MCP surface.

## Infrastructure tradeoffs

Why each layer is what it is, and what was deliberately rejected. Evidence
and dated measurements behind these calls live in NOTES.md.

**Files live in R2, not in Durable Objects, not in D1, not in S3.**
R2 is strongly consistent, S3-compatible (so the sandbox can FUSE-mount it
— the whole `/rooms` illusion depends on this), has commit-time conditional
puts (etag CAS + If-None-Match:* create-only), zero egress, and no
per-value size ceiling that fights 5MB documents. DO storage cannot be
mounted, costs more per byte, and funnels every read through a
single-threaded actor. D1 is one global database — our hot operations are
per-entity read-modify-write races, which sharded actors make atomic by
construction; the one global-database-shaped thing we have (Registry) is
our documented bottleneck, evidence against centralizing further. S3 would
match R2 semantically but adds egress fees and long-lived credentials the
binding-mode mounts just eliminated.

**Coordination is optimistic CAS, not CRDT, not consensus, not git.**
The decision rule is topology: (1) a single authority every writer can
reach exists (R2 behind one Worker) → consensus protocols are redundant —
Durable Objects already run consensus underneath; a DO IS a
platform-provided ordered actor. (2) Writers are never partitioned from
that authority (agents call our API) → CRDTs' coordination-free merging
buys nothing and costs merge semantics we can't control. (3) The workload
is handoff-shaped (agents take turns on shared live memory), not
parallel-attempt-shaped → git-style branch/fork/merge (Cloudflare
Artifacts, Mesa) solves a different product. Conflicts are rare and
explicit: losers get the current etag and retry. Escalation path if
conflict rates ever demand it: the measured per-room RoomText sequencer
described below, not a CRDT protocol.

**RoomText is a measured candidate, not production authority yet.** The
isolated implementation in `src/room-text.ts` and `src/room-text-store.ts`
stores one room's collaborative text as exact UTF-8 snapshot BLOBs plus a
contiguous canonical ChangeSet tail in DO SQLite. A bounded cache holds
immutable CodeMirror `Text` trees for active files; strings exist only at
open/export/checkpoint boundaries. Idempotent requests, revision advance,
canonical update, and room commit persist in one synchronous transaction.
Recovery checkpoints every 128 updates or 256 KB of tail; clients more than
256 updates or 1 MB of update payload behind reset to the current snapshot.
Checkpoints advance a history floor that retains 384 canonical updates or
8 MB as the live sync window; rows below the floor persist as cold history
for a flush janitor (probed in `scripts/room-text-probe/`, not yet mounted):
compact same-client runs strictly below the floor, export a deterministic
version artifact plus HEAD manifest for R2 (create-only PUT, etag-CAS
flip), then prune updates, retry pointers, and orphaned commits at one
atomic boundary. Re-fires and crashes between PUT and flip recover by
firing again.

The workerd and cross-library results are in
`benchmarks/room-text/RESULTS.md`. Do not wire RoomText into web/MCP writes
until the production cutover can make it the sole authority. Dual-writing R2
and SQLite cannot be atomic and would create split-brain. Until that cutover,
all current R2/etag behavior documented above remains the product truth.

**Durable Objects are small synchronous arbiters, never large
orchestrators.** Measured (NOTES.md): request delivery is strictly
serialized and storage-gated read-modify-write is atomic, but any
non-storage await is a yield point that loses concurrent updates. So DOs
here hold the atomic moment only — presence fan-out, comment threads,
counters, candidate RoomText sequencing — and all I/O composition stays in the
Worker. Granularity follows consistency boundaries: per-room where events
share a timeline (RoomHub), per-document where threads serialize
(DocumentCollab), per-user for isolation (AccountDO, Sandbox), global only
where unavoidable (Registry).

**The shell path trades integrity for zero ceremony, knowingly.** POSIX
write() cannot carry a precondition, so bash writes are unconditional
last-write-wins (see Known limits). The alternatives — commit ceremony
(git-shaped) or a custom CAS FUSE shim (gcsfuse-style, prior art in
NOTES.md) — are deliberately deferred until measured conflict rates
justify them. Mitigations shipped instead: agents are steered to
bashroom_write (CAS + create_only), and the seeded room conventions teach
create_only-based lock files.

## Known limits

- No cross-account canonical shared-room identity.
- No file-version recovery or CRDT merge layer.
- Concurrent divergent drafts do not merge: the latest live frame is shown,
  and competing durable saves still resolve through an explicit etag conflict.
- Shell writes bypass CAS: `echo > file` over the FUSE mount is an
  unconditional S3 put — POSIX write() carries no precondition slot, so the
  etag/create_only protections exist only on the MCP and web write paths
  (even `>>` is a whole-object read-modify-write under s3fs). Agents are
  steered to bashroom_write for anything contested.
- No exact changed-path capture for arbitrary shell commands.
- Ranged text reads use byte offsets; callers should page at UTF-8 boundaries.
- The global Registry remains on legacy/cold authorization paths and can still
  be a coordination bottleneck there.

Document role links provide scoped collaboration; they do not turn the room
into a shared filesystem or provide CRDT merging/version recovery.
