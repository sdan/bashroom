# Bashroom Architecture

## Current architecture (v5)

Bashroom is a cloud shell for coding agents: save notes, share files,
and hand off work between running sessions. It is backed by R2 and one
Cloudflare Sandbox per signed-in user. The MCP contract has two layers:

```text
bashroom({ command, stdin? })
  -> { stdout, stderr, exitCode, changed, changed_paths }

bashroom_write({ path, content, encoding? })
  -> direct file write through the sandbox writeFile path

bashroom_tree/read/search/stat(...)
  -> direct bounded R2 metadata/read/search tools
```

What the worker does on `bashroom({ command })`:

```text
Agent
  -> MCP bashroom({ command, stdin? })
  -> Worker (src/index.ts)
       1. authorizeAccount(token)
            -> AccountDO("acct:<user_id>") for routeable tokens
            -> Registry fallback for legacy tokens during migration
       2. ensureSandboxReady(env, user_id)
            -> getSandbox(env.SANDBOXES, user_id)
            -> setOutboundByHost("bashroom.internal",
                                 "bashroomControl",
                                 { userId })
            -> mountBucket("bashroom-rooms", "/rooms",
                           { prefix: "/users/<user_id>/" })   // idempotent
       3. sandbox.createSession({ id: "cmd-<uuid>", cwd: "/", env: { HOME }})
          session.exec(command, { stdin, timeout: 30_000 })
          sandbox.deleteSession(id) in finally
       4. registry.audit-append (best-effort)
```

The `bashroom` MCP tool runs **only real bash inside the sandbox**. There is no
worker-side intercept of room-control verbs and no `mkdir` magic. Room admin is
available through a visible `/usr/local/bin/bashroom` helper inside the sandbox.
That helper calls `http://bashroom.internal/account/*`; Cloudflare Sandbox
outbound interception routes that host back into the Worker with the
authenticated `user_id` supplied as per-sandbox outbound params. No account
token enters the sandbox.

The structured MCP storage tools do not start bash and do not touch the
sandbox:

```text
Agent
  -> MCP bashroom_tree/read/search/stat(...)
  -> Worker
       1. authorizeAccount(token, includeRooms=true)
       2. check room membership + read scope
       3. use ROOMS_R2 binding directly
       4. return bounded JSON/text payload
```

This keeps execution (`bashroom`) separate from storage/context retrieval
(`tree`, `read`, `search`, `stat`).

This is a deliberate product shift from v1. Bashroom v3 is a cloud shell
for agents, not only a small Markdown memory service. Real `bash`, real
`rg`, real `git`, real `find`, real `jq` — everything `cloudflare/sandbox`
ships in its base image, plus tools layered in via the custom Dockerfile.

## Component boundaries

### Worker (src/index.ts)

Owns request routing and trust boundaries.

- Verifies routeable account tokens through the per-user AccountDO; legacy
  tokens fall back to Registry while old clients roll forward.
- Resolves `user_id` and routes the MCP `bashroom({command})` call to
  that user's Sandbox. The MCP path runs nothing but real bash.
- Serves structured MCP storage tools (`tree`, `read`, `search`, `stat`)
  directly from R2 after the same account gate and room-scope check.
- Exposes `/account/room-*` HTTP endpoints (create, join, pair, delete,
  mounts, who, history) for the laptop CLI.
- Exposes the same non-destructive room-control semantics to the sandbox
  helper through an internal outbound handler. `destroy` remains
  laptop-only.
- Seeds room files directly into R2 during `room-create`.
- Writes per-exec audit rows back to the Registry DO.
- Never exposes R2 credentials or internal tokens to the sandbox.

### Registry Durable Object (AuthDO / cold path)

Cold source of truth for OAuth/device login, global room coordination, pair
codes, legacy tokens, and audit. The hot MCP auth path should not require this
global object for newly issued routeable tokens.

- `users`, `user_tokens` — account + bearer tokens.
- `user_rooms` — room ownership and per-room actor names.
- `wiki_pair_codes` — short-lived join invites (retained for v2.1 sharing).
- `device_codes` — OAuth device-flow state.
- `mcp_transport_states` — MCP transport session storage.
- `credit_buckets` — legacy/global cold-path limiter.
- `audit` — every shell exec and every room-control HTTP call (replaces
  the per-room audit tables that used to live in Room DOs).
- Internal user-id based room operations used only by the Worker after
  Sandbox outbound interception has supplied the trusted `user_id`.

The Registry never stores file content.

### AccountDO Durable Object

Hot per-user auth, quota, and compact usage state. One deterministic object per
user:

```text
ACCOUNTS.getByName("acct:<user_id>")
```

New tokens are routeable (`br.<user_id>.<secret>`). The user id in the token is
only a routing hint; AccountDO verifies the full token hash before granting
access.

AccountDO owns:

- `account_profile` — user id + handle snapshot.
- `account_tokens` — token hashes, token ids, last seen, revocation.
- `account_rooms` — account-local mirror of room membership and scopes;
  canonical room lists still come from Registry during this migration.
- `rate_buckets` — per-user and per-token token buckets.
- `daily_usage` — compact per-route counters and byte totals.

AccountDO does not store command event logs or file content. It stores the
minimum durable state required to answer "is this request allowed?" in one
per-user coordination point.

### R2 (`bashroom-rooms`)

Durable file store.

```text
users/<user_id>/<room>/<path>
```

One bucket, single-user-prefixed. Multi-tenant prefix isolation via
scoped R2 tokens is deferred — current builds use the worker's bucket binding for
all access, and sandboxes mount the user's prefix through the binding.

### Cloudflare Sandbox

One sandbox per `user_id`, kept warm with `sleepAfter = "15m"`.

- Image: `docker.io/cloudflare/sandbox:0.10.2` (stock; no user-id baked
  into the image — the worker tells the sandbox who it's serving at mount
  time).
- `/rooms` is FUSE-mounted from R2 lazily on first request after a cold
  start. Subsequent calls reuse the warm mount.
- `/usr/local/bin/bashroom` is a sandbox-only helper. It supports
  `rooms`, `create-room`, `mounts`, `who`, `history`, `pair`, and `join`.
  For anything else it runs local `bash -lc ...` inside the current
  sandbox. `login`, `token`, `mcp`, and `destroy` are rejected.
- Outbound network: only `bashroom.internal` is intentionally handled by
  Worker code for control-plane calls. Do not pass public internet
  credentials into the sandbox.
- Each MCP call uses a **fresh named session** inside the warm sandbox.
  `cwd`, environment variables, and `/tmp` do not leak between calls —
  only `/rooms` (R2-backed) persists. This matches v1 semantics and
  sidesteps the "sleep silently wipes warm state" trap that
  `defaultSession` would create.

### Laptop CLI (`bin/bashroom.js`)

The human admin surface. Subcommands:

- `bashroom login` — device-flow OAuth, stores account token at
  `~/.bashroom/config.json` (mode 0600).
- `bashroom rooms` — list rooms with role.
- `bashroom mounts` — list room mounts with actor + scopes.
- `bashroom create-room <name>` / `bashroom destroy <room> --yes` —
  room lifecycle.
- `bashroom join <invite>` / `bashroom pair <room>` — membership via
  short-lived pair codes.
- `bashroom who <room>` / `bashroom history <room>` — observability.
- `bashroom mcp` — stdio MCP server proxy.
- `bashroom '<bash>'` — raw bash passthrough to the sandbox (this is
  what the MCP proxy uses internally).

### MCP tools

Model-facing tools:

- `bashroom` — real bash in the user's sandbox. Use for command execution,
  scripts, shell pipelines, and advanced `rg`/`find` workflows.
- `bashroom_write` — direct file write under `/rooms/<room>/...`, bypassing
  shell quoting and heredoc hazards. Hard cap: 5 MB per write.
- `bashroom_tree` — direct R2 prefix listing. `/rooms` lists mounted rooms;
  `/rooms/<room>/<prefix>` lists bounded file metadata.
- `bashroom_read` — direct bounded R2 text range read. Defaults to 64 KB,
  max 512 KB per call.
- `bashroom_search` — bounded literal text search over R2 objects. Defaults
  to 50 matches, 200 files, and 256 KB scanned per file.
- `bashroom_stat` — direct R2 metadata for one file: size, modified time,
  etag, version, content type, custom metadata.

Room lifecycle and destructive admin remain outside the model-facing MCP tool
surface. Agents can still use the visible sandbox CLI (`bashroom create-room`,
`bashroom pair`, etc.) through the shell when appropriate, while destructive
room deletion stays laptop-only.

The CLI's room-admin subcommands hit `/account/room-*` HTTP endpoints
on the worker. They never share a code path with the MCP tool.

### Sandbox CLI (`bin/sandbox-bashroom.js`)

The sandbox image copies this script to `/usr/local/bin/bashroom`.

- Sends POST JSON to `http://bashroom.internal/account/*` with no auth
  header. The outbound handler supplies identity from Worker-side
  per-sandbox params.
- Does not read `~/.bashroom/config.json`.
- Does not implement login, token printing, MCP stdio, or destructive
  room deletion.
- Falls back to local `bash -lc` for non-control commands, avoiding a
  recursive Worker -> Sandbox -> Worker remote-bash stack.

### `/web` (read-only browser view)

`/web/api/rooms`, `/web/api/tree`, and `/web/api/file` read directly from
R2 plus the account gate. For routeable tokens the Worker verifies through
AccountDO, then reads canonical room lists through Registry's internal
user-id path and heals the AccountDO room mirror. Never touches the sandbox.
The web view stays useful even if the FUSE mount is broken.

The browser path intentionally separates metadata from content:

```text
/web/api/rooms?active=<room>
  -> account rooms + optional active-room R2 metadata tree
/web/api/tree?room=<room>
  -> path, size_bytes, updated_at, etag, version, content_type
/web/api/file?room=<room>&path=<path>
  -> one selected file body + the same R2 metadata
```

There is intentionally no full-room content snapshot endpoint. Full-room
snapshots turn one click into "read every object in the room"; tree + file
keeps room navigation cheap and lets R2's object metadata (`uploaded`, `size`,
`etag`, `version`) be the source of truth for file modified time.

### Agent-readable endpoints

Two static-ish endpoints follow the [llms.txt convention](https://llmstxt.org/)
so an LLM can discover bashroom without HTML parsing:

- `/llms.txt` — table of contents per the spec: H1 + blockquote summary
  + H2 link sections pointing at README, skill, MCP, source.
- `/skill.md` — the bundled `skills/bashroom/SKILL.md` served verbatim.
  The worker imports the file at build time via wrangler's text-import
  rule (`type: "Text"`, `globs: ["**/*.md"]` in `wrangler.jsonc`), so
  there's no drift between the repo source and the served version.

Neither endpoint touches the sandbox or R2; they're string constants
emitted by the worker.

### OG / social-share image

`src/og.ts` exports `ogSvg()` — the single source for the 1200×630
social-preview image. `scripts/render-og.ts` imports it directly and
rasterizes via `rsvg-convert`, so `assets/og.png` never drifts from the
`/og.svg` the worker serves (both come from one function). The hero is the
room file-tree — the product mental model — with brand top-left and tagline
bottom-right on the fleet diagonal.

bashroom is the canonical reference for the fleet's **static OG lineage**
(one SVG → `rsvg-convert` → one PNG asset), shared with pingpong and quack.
The cross-site playbook — the one-centered-hero rule, the composition
grammar, the per-site palette freedom, the static-vs-dynamic render split,
and the font/URL/crop gotchas — lives in [`docs/OG-DESIGN.md`](docs/OG-DESIGN.md).
That doc is the shared design source so a new fleet site's OG lands in the
family without re-deriving it.

## Wrangler config (`wrangler.jsonc`)

Bindings:

- `REGISTRY` durable object (class `Registry`, SQLite-backed)
- `ACCOUNTS` durable object (class `AccountDO`, SQLite-backed)
- `SANDBOXES` durable object (class `Sandbox`, SQLite-backed via SDK)
- `ROOMS_R2` r2 bucket (`bashroom-rooms`)
- `containers[]` — image `./Dockerfile` (one-line `FROM
  docker.io/cloudflare/sandbox:0.10.2`), instance type `lite`, up to 50
  concurrent instances.

Migrations:

- `v1` — `new_sqlite_classes: ["Room"]` (legacy)
- `v2` — `new_sqlite_classes: ["Registry"]`
- `v3` — `new_sqlite_classes: ["Sandbox"]`
- `v4` — `deleted_classes: ["Room"]`
- `v5` — `new_sqlite_classes: ["AccountDO"]`

## Security rules (carry-forward + v3 additions)

- Do not pass worker or R2 master credentials into user-visible shell state.
- Do not rely on a sandbox environment variable as an unobservable secret.
  The sandbox control helper sends no bearer token; the outbound handler
  supplies identity from trusted Worker-side params.
- Do not add hidden pre-exec parsing to `runShellV2`. Control-plane
  behavior should stay visible as a real executable on `PATH`.
- Outbound network is denied unless a deployment is explicitly opted in
  or routed to a narrow internal handler like `bashroom.internal`.
- Treat every shell command as untrusted code, even when it comes from a
  signed-in user's local MCP proxy. The sandbox provides Firecracker-level
  isolation between users; R2 binding + prefix mount provides tenant data
  isolation.

## Current behavior

- MCP execution shape unchanged: `bashroom({ command, stdin? })`.
- MCP storage/context tools are direct R2 reads/lists, not shell wrappers.
- `bashroom` response shape unchanged. `changed_paths` is `[]` — FUSE
  does not natively surface per-file change events. Per-file change
  tracking is deferred (see below).
- Each MCP call is independent. `cd`, env vars, and `/tmp` files do not
  carry between calls. `/rooms` is the only durable surface.
- `bashroom <control-subcommand>` inside the sandbox is handled by the
  sandbox helper. Ordinary `bashroom <anything else>` runs local bash.
- The model can inspect per-file mtimes with shell tools like `stat`, but
  directory mtimes from the R2 FUSE mount are synthetic. Product UI should
  use R2 object metadata (`uploaded`) for last-modified displays.

## Deferred work

- Shared rooms across users (pair codes mint membership; current builds only
  mounts owned rooms).
- Sessions-as-git (`git init` per room plus daily commit cron — trivial
  to add later because `git` is already in the sandbox image).
- Per-file `changed_paths` precision (probably `find -newer` or inotify).
- Multi-tenant R2 prefix isolation via scoped tokens (single-user means
  the worker's bucket binding is the only access path for now).
- Browser terminal feature via `sandbox.terminal()` — out of scope; the
  MCP path uses `session.exec()` only.
- Cleanup of the `_diag/` and `_diagnostic/` probe objects in R2 from
  the migration window. Safe to leave; harmless and bounded.

## Non-goals

These are explicit boundaries, not "later":

- Bashroom is not a general code-execution platform. The MCP surface is the
  only interface; the sandbox is an implementation detail.
- Bashroom is not a sandbox provider. We use Cloudflare's; we do not
  expose sandbox lifecycle, image config, or network policy to users.
- Bashroom does not own session export, transcript parsing, or model
  summarization. Those are CLI / external concerns.

## Migration history

v1 → v2 was a hard cutover: single-user, one deploy, no soak period.
File contents moved from per-room Durable Object snapshots to
`users/<user_id>/<room>/<path>` in the `bashroom-rooms` R2 bucket. The
Room DO class is dropped in the `v4` migration tag (kept in the
migration log for replay safety; do not remove past tags).

## Validation standard

Every implementation step must preserve:

- CLI surface compatibility: `bashroom login`, `bashroom rooms`,
  `bashroom create-room`, `bashroom mcp`, raw bash passthrough.
- MCP contract compatibility: `bashroom({command, stdin?})` returns
  `{stdout, stderr, exitCode, changed, changed_paths}`.
- Account token never appears in model-visible tool arguments.
- In-sandbox room admin works through `/usr/local/bin/bashroom` without
  exposing a bearer token.
- Default network-denied commands fail closed, except the explicit
  `bashroom.internal` control channel.
- Migrated room files match the pre-migration snapshot byte-for-byte.
