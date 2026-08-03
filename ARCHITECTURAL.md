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

Bashroom is not a git host or a general offline-first filesystem. Room
activity `history` remains an audit feed; file recovery is the separate,
page-scoped RoomText checkpoint contract below. The web app is offline-capable
through an explicit, receipt-backed device snapshot; RoomHub remains the
online write authority.

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

## Version history

Eligible RoomText files expose account-member-only checkpoint history:

- `GET /web/api/file/history` lists the latest immutable `{epoch, revision}`
  checkpoints plus the current head when it has not flushed yet.
- `GET /web/api/file/history/version` validates and reads one exact immutable
  R2 artifact. The artifact identity and path must match the request, base64
  must be canonical, and its snapshot must be valid bounded UTF-8.
- `POST /web/api/file/history/restore` requires room write scope and the
  current `base_version`. It applies historical bytes through the ordinary
  RoomText replacement path, so restore is a new monotonic revision rather
  than a rewind. A concurrent head change returns `412 conflict`.

Checkpoint bodies live at
`roomtext-shadow/users/<user>/<room>/.history/<file>/<epoch>@<revision>`.
Create-only writes make them immutable. R2 object metadata records byte size
and coarse provenance (`web`, `mcp`, `mixed`, or `unknown`); it never invents
an exact actor when a checkpoint coalesced edits or lacks durable identity.
Share capabilities cannot read history because an older snapshot may contain
material intentionally removed before the current page was shared.

## Private self profile

`/@<handle>` is an authenticated self-view inside the existing web shell, not
a public profile. Clicking the sidebar handle opens it; selecting a room file
returns to the editor. Opening the profile flushes any pending autosave, leaves
room presence, and never mounts historical or current file bytes into the
profile surface.

`GET /web/api/profile` composes two existing authorities without creating a
third analytics store:

- Registry supplies the canonical handle, GitHub login, account creation time,
  room count, and aggregate daily audit rows.
- One paginated `users/<user_id>/` R2 listing supplies current file count and
  stored bytes. RoomText history remains under `roomtext-shadow/`, so recovery
  artifacts cannot inflate the file total.

Activity means distinct paths with a recorded `write` or `shared_write` audit
event, grouped by UTC day. It is a best-effort product signal: audit appends are
deferred, and collaborator changes in an owner's room belong to that owner's
account history. The endpoint returns only counts and dates—never user ids,
paths, commands, or raw audit rows—and is always `Cache-Control: no-store`.
Public profiles would require a separate opt-in privacy contract.

## Web room tree

The room sidebar remains a path-first projection of `/web/api/rooms` and
`/web/api/tree`; it is not a second filesystem model. Expansion state is kept
by canonical `room:path` keys, cached metadata paints stale-while-revalidate,
and selecting a deep link opens its ancestor folders before rendering.

The renderer uses nested disclosure buttons rather than importing a second UI
runtime. File, folder, and room text is HTML-escaped before the inline SPA
inserts it. Enter/Space use native button behavior; arrow, Home, and End keys
move through visible rows. On viewports at or below 720px the same sidebar DOM
becomes a full-screen navigation surface and selecting a file returns to the
full-width document. There is no separate mobile tree to synchronize.

Bashroom owns this tree's visual skin and search contract; Pierre is a design
reference, not a runtime dependency. Local path search ranks matching rooms
first, treats implicit folders as first-class results, then shows files; the
existing bounded server scan streams content matches underneath.

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

## Plane mode

Plane mode has three deliberately separate layers:

```text
public app shell + pinned CDN graph     -> Service Worker Cache Storage
private rooms/files/links/edit outbox   -> account-scoped IndexedDB
printable disaster-recovery copy        -> one downloaded standalone HTML file
```

The user starts a prepare-for-flight sync from the web sidebar. It:

1. Requests persistent browser storage when the browser supports it.
2. Caches `/web`, the manifest, the offline helper, and the complete imported
   ESM dependency graph. Authenticated `/web/api/*` responses are never put in
   Cache Storage.
3. Lists every authorized room and downloads every file. Text bodies and
   binary blobs are kept under a SHA-256-derived account scope in IndexedDB.
4. Treats every external HTTP(S) document link as a depth-zero seed in a
   provenance graph. File-to-page and page-to-page edges retain why each URL
   exists in the archive.
5. Walks two breadth-first, same-origin discovery levels with a 500-page
   default budget and three page workers. Direct Bashroom links are never
   dropped by that budget. Tracking parameters and obvious image/media/bundle
   assets are excluded; graph truncation is explicit.
6. Uses the `BROWSER` Browser Run binding to produce searchable Markdown and
   an A4 PDF in parallel for each scheduled page. Rate limits and transient
   failures receive bounded retry/backoff; each derivative can succeed alone.
7. Writes a literal receipt: preparation time, storage-persistence result,
   room/file/page/PDF counts, graph nodes/edges/depth/cap, approximate Browser
   Run time, storage usage/quota, shell-cache errors, and individual misses.

The preparation UI does not invent a total before discovery finishes. It begins
with an indeterminate **Planning your offline library** track, becomes
determinate while room and file totals are known, and returns to an
indeterminate linked-page track because every rendered page can reveal more
same-origin children. While work is active the primary action becomes **Stop**;
that cancellation reaches the fetch pools and IndexedDB work rather than merely
hiding progress. Service-worker activation, shell caching, HTTP/body reads, and
IndexedDB operations all have explicit deadlines. A timeout returns the UI to a
retryable state, and shell or room-file misses cannot paint **Offline ready**.
Receipts carry the cache generation and preparation run ID. A running or failed
run invalidates the prior receipt before private file rows change, and Web Locks
make preparation single-writer across tabs. Reads refuse to cross that writer
boundary; queued offline edits remain a protected overlay over refreshed rows.

Installed-app assets use a generation-stamped URL and Cache Storage namespace.
The new worker activates from a four-resource core and retains the previous
complete shell as fallback. Only a successful full-graph receipt removes that
fallback. Current Bashroom helpers are network-first, while pinned third-party
modules remain cache-first. This prevents a fresh HTML shell from being paired
indefinitely with an older `/web-offline.js` contract.

External Markdown links are rewritten to `/web/offline?url=...`. Online, the
Worker redirects to the original URL. Offline, the service worker serves the
locally archived Markdown through pinned Marked + DOMPurify, rewrites child
links back through the graph, and exposes `/web/offline/pdf?url=...` when the
page has a PDF Blob. Publisher scripts, forms, media, and remote images never
run inside this reader. This cannot bypass a publisher's bot controls; missed
or rejected pages stay visible in the receipt.

The PWA manifest, square mask-safe icons, Apple mobile metadata, and root-scope
service worker make `/web` installable. Chrome/Android uses the native install
prompt. Safari/iOS uses Share -> Add to Home Screen. Installation is only the
shell; a receipt-backed preparation run is still required before flight.

The first-run offline feature guide is a non-modal, progressively disclosed
coachmark in the private web app. It targets only controls that currently
exist, stores dismissed step ids in the versioned local-only
`bashroom.feature-tour.offline-v1` key, and can be reset from the persistent
`?` control. Tutorial state is presentation state: it never enters RoomText,
R2, the offline snapshot, or account APIs.

The browser editor continues to use whole-file CAS. A network failure queues
`(room, path, content, base_etag)` locally. Reconnect replays that exact
precondition through `/web/api/file`; a moved server head stays queued and
enters the normal visible conflict flow. Plane mode never performs an implicit
merge or last-write-wins overwrite.

The standalone HTML export includes all cached text files and successfully
archived linked-page Markdown. It opens without Bashroom and can be printed as
one PDF. Individual publisher-layout PDFs remain device-local IndexedDB Blobs
and are opened through the installed app.
Signing out purges the current account's private IndexedDB snapshot and outbox;
the public app-shell cache may remain.

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
- Never cache bearer-authenticated API responses in the service-worker cache.
- Never archive local/private-network or credential-bearing URLs with Browser Run.
- Never replay an offline edit without its original authoritative version token.

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
  collaborative ChangeSet merging or version history.
- No cross-account canonical shared-room identity.
- Ranged reads use byte offsets; page at UTF-8 boundaries.
- Version history is bounded to the newest 100 checkpoints per response; the
  current UI has no deep pagination or named versions.
- Activity history is not version restore.
- Plane mode's binding-only crawler is intentionally bounded to depth two,
  same-origin descendants, 500 discovered pages beyond any larger direct-seed
  set, 5,000 graph nodes, and 20,000 graph edges. The receipt reports every
  cap. Cloudflare's larger asynchronous `/crawl` product is REST-only and would
  require a separate account API secret and durable job ingestion path.
- Browser Run respects publisher blocks and may miss paywalled, authenticated,
  bot-protected, or otherwise inaccessible pages; the receipt reports misses.
- Storage persistence is browser-controlled. The exported standalone HTML file
  is the durable fallback if the browser later evicts site data.
- Binary files are downloaded into the offline snapshot but the current web UI
  still directs ordinary binary inspection to the shell. Linked-page PDFs are
  the one binary type exposed directly by the offline reader.
