# Bashroom Architecture

This is the current-state contract. Dated measurements and rejected designs
live in [NOTES.md](NOTES.md).

## Mission

Bashroom gives authenticated humans and agents durable shared files plus a
real Linux shell. The product stays deliberately narrow:

- Eligible Markdown is strongly ordered by one room Durable Object.
- R2 is a guarded byte-for-byte mirror and recovery copy for that Markdown.
- Files RoomText cannot represent remain explicitly R2-owned; they are never
  coerced, truncated, or silently skipped.
- Cloudflare Sandbox supplies disposable compute. `/rooms` is a read-only
  filesystem projection, not a write authority.
- MCP is the primary agent interface. The web app and CLI use the same Worker
  authorization and storage paths.

Bashroom is not a git host or a general offline-first filesystem. Activity
`history` is audit data, not file-version recovery.

## End-to-end shape

```text
MCP / web / role link
        |
        v
Worker: authenticate -> authorize exact room/path -> validate limits
        |
        +-- Markdown <= 1,000,000 bytes, exact UTF-8
        |      |
        |      v
        |   RoomHub(<user_id>:<room>)
        |      - RoomText SQLite head + bounded ChangeSet log
        |      - idempotency, ordering, digest, dirty set
        |      - hibernating sockets and presence
        |      |
        |      +-- guarded same-byte/current-head projection -> R2
        |      +-- canonical update broadcast -> connected editors
        |
        +-- other files / oversized Markdown -> R2 authority

Sandbox
  -> fresh process per shell call
  -> read-only /rooms mount of the user's R2 prefix
```

One RoomHub is the consistency boundary for a room. There is no per-document
DO registry or parallel room authority.

## Authority classes

| File | Authority | Read/write token |
| --- | --- | --- |
| `.md` / `.markdown`, exact UTF-8, <= 1,000,000 bytes | RoomHub SQLite | `rt1:<epoch>:<revision>` |
| Oversized Markdown | R2 | R2 etag |
| Non-Markdown or binary | R2 | R2 etag |

An unsupported file stays readable and byte-identical in R2. Moving a file
between classes is explicit: a small eligible R2 file is conditionally
claimed by RoomText; an existing RoomText file is never silently demoted.

R2 keys remain:

```text
users/<user_id>/<room>/<path>
```

For a RoomText-owned file that key is a current recovery mirror. Its custom
metadata records:

```text
br-authority = roomtext-v1
br-epoch
br-revision
br-sha256
```

RoomText also writes immutable recovery artifacts below
`roomtext-shadow/users/.../.history/`. Neither projection is the SQLite
sequencer.

## RoomText storage

`RoomTextStore` uses the RoomHub's SQLite database:

- `room_text_heads`: exact current UTF-8 BLOB; ordinary reads decode one row.
- `room_text_updates`: ordered canonical CodeMirror ChangeSets.
- `room_text_files`: epoch, head revision, checkpoint, history floor, sizes.
- `room_text_requests`: idempotency envelope and replayable anchor result.
- `room_text_commits`: room-wide commit order.
- `room_text_digests` and `room_text_digest_log`: content and room roots.
- `room_text_dirty`: durable projection work.
- `room_text_mirrors`: expected R2 etag/version/hash and quarantine status.

The current document is never rebuilt by replaying its full history. Each
accepted edit writes the new head BLOB once. The log exists for stale-client
rebasing, reconnect deltas, idempotency, anchor mapping, and recovery export.

All mutation-critical work is synchronous inside one SQLite transaction:

```text
dedupe request
-> validate base revision
-> rebase over intervening ChangeSets
-> apply to current head
-> append canonical update
-> replace head
-> advance digest/version
-> record replay result and dirty mark
```

No timer, fetch, R2 call, or other Durable Object RPC occurs inside that
critical section. A non-storage `await` is a DO yield point.

After the SQLite commit, the host conditionally publishes the exact head to
R2. A lost response is safe: the caller retries the same `(client_id,
request_id, intent_hash)` and receives the original accepted result.

## Write contracts

The Worker exposes ten MCP tools. The two mutation shapes are intentionally
different:

- `bashroom_edit({ path, old_text, new_text, before?, after?, request_id })`
  resolves a literal anchor against the current head inside RoomHub. Exactly
  one match becomes one ChangeSet. Zero or multiple matches change nothing.
- `bashroom_write({ path, content, encoding?, base_etag?, create_only? })`
  replaces a whole file. Existing RoomText Markdown requires the version read
  by the caller; stale replacements return `conflict`. New files can use
  `create_only`.

Web and shared-document saves use the same strict whole-file CAS path. The
headless `RoomTextClient` and WebSocket protocol support delta hydration,
rebasing, durable outbox replay, and canonical broadcasts, but the current web
UI still autosaves whole-file drafts. It preserves a conflicting draft and
asks the user to resolve it; it does not silently overwrite.

## Comments

Comment bodies and resolution state remain in one `DocumentCollab` DO per
document. Before a text mutation, the Worker reads open source-coordinate
anchors. RoomText maps them through the exact accepted ChangeSet. The mapped
result is stored with the RoomText idempotency row before the commit returns,
then persisted to DocumentCollab.

That makes a failed cross-DO remap repairable: retrying the same file edit
returns the original absolute anchor positions, so applying them again is
idempotent. Comment bodies are never deleted by text migration. Resolved
comments keep their historical offsets.

## Migration and rollback

`ROOM_TEXT_MODE` is the deployment fence:

| Mode | Behavior |
| --- | --- |
| `off` | Legacy R2 authority; RoomText code is dark. |
| `freeze` | Reads continue; content writes and room create/delete are rejected; `/rooms` is read-only; migration is enabled. |
| `on` | Eligible Markdown uses RoomText; unsupported files remain R2-owned; `/rooms` stays read-only. |

Migration of one file is lossless by construction:

1. Read the R2 object and its etag.
2. Validate size and exact UTF-8 representation.
3. SHA-256 the original bytes.
4. Conditional-PUT the identical bytes with the RoomText ownership marker.
5. Create or verify SQLite revision 0 from those exact bytes.
6. Persist the expected R2 generation in `room_text_mirrors`.
7. Re-open through RoomText and verify before enabling writes.

If R2 moves before step 4, no SQLite candidate is accepted. If the Worker
stops after step 4, the metadata makes the import resumable. Incompatible files
stay in R2. Migration errors block the `on` deployment.

Before cutover, production R2 is copied create-only to a separate bucket and
every source/destination object is SHA-256 compared. The source bucket and
backup are retained after cutover.

If the canonical R2 key changes outside RoomText, RoomHub does not choose a
winner. It marks the mirror `diverged`, retains both copies, and rejects reads
and writes for that file until an operator reconciles them.

## Sandbox boundary

There is one Sandbox DO per authenticated `user_id`. Each command gets a fresh
process session; cwd and environment do not persist. The warm container and
`/tmp` may be shared between concurrent calls and are not durable state.

The Worker mounts only `/users/<user_id>/` at `/rooms` through the R2 binding.
No R2 credential enters Linux. In `freeze` and `on`, the mount is read-only.
Before starting a shell, the Worker drains pending RoomText projections for
the user's rooms; a quarantined projection prevents the shell from starting.

Use shell for read pipelines, regex, and computation. File mutations use
`bashroom_edit` or `bashroom_write`; POSIX writes cannot carry RoomText version
preconditions.

Outbound network is denied except for `bashroom.internal`, the identity-bound
control channel used by the visible sandbox helper.

## Component ownership

| Component | Owns | Must not own |
| --- | --- | --- |
| Worker | Routes, tool schemas, auth, orchestration | A second file authority |
| RoomHub | RoomText SQLite, ordering, sockets, presence | Global membership |
| DocumentCollab | Comment bodies/resolution | File bodies |
| R2 | Guarded Markdown mirrors; unsupported files | RoomText ordering |
| AccountDO | Token hot path, quotas, room mirror | File contents |
| Registry | OAuth, users, memberships, shares, audit | File contents |
| Sandbox | Disposable Linux compute, read projection | Credentials or durability |
| CLI | Login/admin UX and MCP forwarding | Tool definitions |

## Authentication and sharing

Every tool independently authorizes the exact room and path. AccountDO serves
routeable-token hot authorization; Registry owns OAuth, canonical membership,
share capabilities, and cold/legacy token lookup. `/mcp` is stateless.

Cross-account shared rooms are not supported. A role link grants one
owner-scoped document or view prefix without creating another storage identity.
View links are anonymous; Comment/Edit mutation requires the recipient's own
Bashroom identity. All RoomHub socket output is filtered by the link prefix.

## Security invariants

- Never expose bearer tokens, R2 credentials, or OAuth secrets to a sandbox.
- Authorize the exact room/path before touching R2 or RoomHub.
- Enforce decoded-byte and frame limits before persistence.
- Never accept a stale whole-file RoomText replacement.
- Never resolve an ambiguous literal edit by guessing.
- Preserve incompatible bytes in R2; quarantine divergence rather than pick a
  silent winner.
- Keep destructive room deletion outside model-facing MCP.
- Treat Markdown, paths, WebSocket frames, and commands as untrusted.

## Build and verification

Runtime source includes `src/index.ts`, `src/room-hub-text.ts`,
`src/room-text-store.ts`, `src/room-text-client.ts`, `src/room-text.ts`, the web
modules, CLI, and `skills/bashroom/SKILL.md`. Wrangler-generated binding types
live in `worker-configuration.d.ts`.

`npm run check` runs TypeScript, focused tests, the real local workerd
RoomText probe, web checks, and CLI smoke test. The dark integration probe in
`scripts/roomtext-dark-probe/` additionally exercises exact import, R2
projection, lost-response replay, stale replacement rejection, and external
R2 divergence.

## Known limits

- The production web UI still submits whole-file CAS saves; the delta client
  is not yet mounted into the browser editor.
- Comment storage is a separate DO. Retryable anchor remapping is safe, but it
  is not one SQLite transaction with text.
- RoomText has no production rename/delete or atomic multi-file mutation API.
  `/rooms` is therefore read-only rather than pretending POSIX writes are safe.
- Oversized Markdown and non-Markdown files remain R2-owned and do not receive
  collaborative ChangeSet merging.
- No cross-account canonical shared-room identity.
- Ranged reads use byte offsets; page at UTF-8 boundaries.
- Activity history is not version restore.
