# Bashroom Architecture

## Current architecture (v2)

Bashroom is a per-user cloud shell for coding agents, backed by R2 and one
Cloudflare Sandbox per signed-in user. The MCP contract stays the same as
v1 — one tool, one function:

```text
bashroom({ command, stdin? })
  -> { stdout, stderr, exitCode, changed, changed_paths }
```

What the worker does on every MCP call:

```text
Agent
  -> MCP bashroom({ command, stdin? })
  -> Worker (src/index.ts)
       1. verifyAccount(token) via Registry DO -> user_id
       2. ensureSandboxReady(env, user_id)
            -> getSandbox(env.SANDBOXES, user_id)
            -> mountBucket("bashroom-rooms", "/rooms",
                           { prefix: "/users/<user_id>/" })   // idempotent
       3. sandbox.createSession({ id: "cmd-<uuid>", cwd: "/", env: { HOME }})
          session.exec(command, { stdin, timeout: 30_000 })
          sandbox.deleteSession(id) in finally
       4. registry.audit-append (best-effort)
```

The MCP tool runs **only real bash inside the sandbox**. There is no
worker-side intercept of room-control verbs. Room admin (create, join,
pair, delete, mounts, who, history) is a separate set of HTTP endpoints
under `/account/room-*` reachable only via the `bashroom` CLI on the
user's terminal. The agent has no path to these operations.

This is a deliberate product shift from v1. Bashroom v2 is a cloud shell
for agents, not only a small Markdown memory service. Real `bash`, real
`rg`, real `git`, real `find`, real `jq` — everything `cloudflare/sandbox`
ships in its base image, plus tools layered in via the custom Dockerfile.

## Component boundaries

### Worker (src/index.ts)

Owns request routing and trust boundaries.

- Verifies account tokens through the Registry DO.
- Resolves `user_id` and routes the MCP `bashroom({command})` call to
  that user's Sandbox. The MCP path runs nothing but real bash.
- Exposes `/account/room-*` HTTP endpoints (create, join, pair, delete,
  mounts, who, history) for the CLI only. These are not reachable
  through the MCP tool.
- Seeds room files directly into R2 during `room-create`.
- Writes per-exec audit rows back to the Registry DO.
- Never exposes R2 credentials or internal tokens to the sandbox.

### Registry Durable Object

Single source of truth for identity, membership, OAuth, and audit.

- `users`, `user_tokens` — account + bearer tokens.
- `user_rooms` — room ownership and per-room actor names.
- `wiki_pair_codes` — short-lived join invites (retained for v2.1 sharing).
- `device_codes` — OAuth device-flow state.
- `mcp_transport_states` — MCP transport session storage.
- `credit_buckets` — rate limiter.
- `audit` — every shell exec and every room-control HTTP call (new in v2;
  replaces the per-room audit tables that used to live in Room DOs).

The Registry never stores file content.

### R2 (`bashroom-rooms`)

Durable file store.

```text
users/<user_id>/<room>/<path>
```

One bucket, single-user-prefixed. Multi-tenant prefix isolation via
scoped R2 tokens is deferred — v2.0 uses the worker's bucket binding for
all access, and sandboxes mount the user's prefix through the binding.

### Cloudflare Sandbox

One sandbox per `user_id`, kept warm with `sleepAfter = "15m"`.

- Image: `docker.io/cloudflare/sandbox:0.10.2` (stock; no user-id baked
  into the image — the worker tells the sandbox who it's serving at mount
  time).
- `/rooms` is FUSE-mounted from R2 lazily on first request after a cold
  start. Subsequent calls reuse the warm mount.
- Outbound network: denied by default.
- Each MCP call uses a **fresh named session** inside the warm sandbox.
  `cwd`, environment variables, and `/tmp` do not leak between calls —
  only `/rooms` (R2-backed) persists. This matches v1 semantics and
  sidesteps the "sleep silently wipes warm state" trap that
  `defaultSession` would create.

### CLI (`bin/bashroom.js`)

The human admin surface. Subcommands:

- `bashroom login` — device-flow OAuth, stores account token at
  `~/.bashroom/config.json` (mode 0600).
- `bashroom rooms` — list rooms with role.
- `bashroom mounts` — list room mounts with actor + scopes.
- `bashroom create-room <name>` / `bashroom destroy <room> --yes` —
  room lifecycle. (`room create` is kept as a back-compat alias.)
- `bashroom join <invite>` / `bashroom pair <room>` — membership via
  short-lived pair codes.
- `bashroom who <room>` / `bashroom history <room>` — observability.
- `bashroom mcp` — stdio MCP server proxy.
- `bashroom '<bash>'` — raw bash passthrough to the sandbox (this is
  what the MCP proxy uses internally).

The CLI's room-admin subcommands hit `/account/room-*` HTTP endpoints
on the worker. They never share a code path with the MCP tool.

### `/web` (read-only browser view)

`/web/api/rooms` and `/web/api/snapshot` read directly from R2 + Registry.
Never touches the sandbox. The web view stays useful even if the FUSE
mount is broken.

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

## Wrangler config (`wrangler.jsonc`)

Bindings:

- `REGISTRY` durable object (class `Registry`, SQLite-backed)
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

## Security rules (carry-forward + v2 additions)

- Do not pass worker or R2 master credentials into user-visible shell state.
- Do not rely on a sandbox environment variable as an unobservable secret.
  Sandboxes do not call back to the worker — the worker handles every
  control-plane action directly. There is no in-sandbox `room` script.
- Outbound network is denied unless a deployment is explicitly opted in.
- Treat every shell command as untrusted code, even when it comes from a
  signed-in user's local MCP proxy. The sandbox provides Firecracker-level
  isolation between users; R2 binding + prefix mount provides tenant data
  isolation.

## v2 behavior

- MCP tool shape unchanged: `bashroom({ command, stdin? })`.
- Response shape unchanged. `changed_paths` is `[]` in v2.0 — FUSE
  does not natively surface per-file change events. Per-file change
  tracking is deferred (see below).
- Each MCP call is independent. `cd`, env vars, and `/tmp` files do not
  carry between calls. `/rooms` is the only durable surface.
- `room <subcommand>` is handled by the worker. Pipes, conditionals,
  `$(...)`, and backticks containing `room` are rejected with a clear
  error rather than partially executed.

## Deferred work

- Shared rooms across users (pair codes mint membership; v2.0 only
  mounts owned rooms).
- Sessions-as-git (`git init` per room plus daily commit cron — trivial
  to add later because `git` is already in the sandbox image).
- Per-file `changed_paths` precision (probably `find -newer` or inotify).
- Multi-tenant R2 prefix isolation via scoped tokens (single-user means
  the worker's bucket binding is the only access path for now).
- Custom Dockerfile additions (stock `0.10.2` is sufficient).
- Browser terminal feature via `sandbox.terminal()` — out of scope; the
  MCP path uses `session.exec()` only.
- Cleanup of the `_diag/` and `_diagnostic/` probe objects in R2 from
  the migration window. Safe to leave; harmless and bounded.

## Non-goals

These are explicit boundaries, not "later":

- Bashroom is not a general code-execution platform. The MCP tool is the
  only interface; the sandbox is an implementation detail.
- Bashroom is not a sandbox provider. We use Cloudflare's; we do not
  expose sandbox lifecycle, image config, or network policy to users.
- Bashroom does not own session export, transcript parsing, or model
  summarization. Those are CLI / external concerns.

## Migration history

v1 → v2 cutover: hard rewrite, single-user, one deploy. Migration script
`scripts/migrate-v1-to-r2.mjs` ran once to copy 11 rooms (103 files,
~640 KB) from per-room Room DOs into `users/<user_id>/<room>/<path>` in
the `bashroom-rooms` R2 bucket. Local backups in `./backup/` retained
during the cutover window. Room DO class deleted in the `v4` migration
tag once R2 round-trip was verified via the worker's R2 binding.

The migration token (`MIGRATION_TOKEN` wrangler secret) and the
`/internal/snapshot` + `/internal/r2-put` worker endpoints were
removed in the same deploy that landed the v2 code path. The secret
should also be deleted via `wrangler secret delete MIGRATION_TOKEN`
after final verification.

## Validation standard

Every implementation step must preserve:

- CLI surface compatibility: `bashroom login`, `bashroom rooms`,
  `bashroom room create`, `bashroom mcp`, raw bash passthrough.
- MCP contract compatibility: `bashroom({command, stdin?})` returns
  `{stdout, stderr, exitCode, changed, changed_paths}`.
- Account token never appears in model-visible tool arguments.
- Default network-denied commands fail closed.
- Migrated room files match the pre-migration snapshot byte-for-byte.
