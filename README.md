# Bashroom

Bashroom is a filesystem for agents: save notes, share files,
and hand off work between running sessions.

Agents get real read-oriented `bash` plus structured file/context tools.
Eligible Markdown is ordered in a per-room Durable Object and mirrored
byte-for-byte to R2; unsupported and binary files remain R2-owned. The shell
runs inside a Cloudflare Sandbox with `/rooms` mounted read-only, so durable
mutations always carry explicit concurrency through `bashroom_edit` or
`bashroom_write`.

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

The MCP exposes ten tools:

```text
bashroom({ command, stdin? })
bashroom_write({ path, content, encoding?, base_etag? })
bashroom_edit({ path, old_text, new_text, before?, after?, request_id })
bashroom_tree({ path, max_entries? })
bashroom_read({ path, offset?, max_bytes? })
bashroom_search({ path, query, case_sensitive?, max_matches?, max_files?, max_bytes_per_file? })
bashroom_stat({ path })
bashroom_shared_read({ link, max_bytes? })
bashroom_shared_write({ link, content, base_etag })
bashroom_shared_comment({ link, quote, body, document_etag?, anchor_start? })
```

Use `bashroom` for read pipelines, regex, and computation. Use
`bashroom_edit` for one uniquely anchored Markdown change and
`bashroom_write` for create or whole-file replacement.

Inside bash, authorized rooms appear under `/rooms`:

```bash
ls /rooms
tree /rooms
cat /rooms/<room>/index.md
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

Each MCP call gets a fresh process session, so cwd and environment variables
do not carry over. The warm sandbox filesystem is shared: `/rooms` is a
durable read projection and `/tmp` may survive or be visible to concurrent
calls. Never use `/tmp` for secrets or coordination. The sandbox stays warm
for ~15 minutes.

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
bashroom destroy <room> --yes         # unavailable while RoomText owns files
bashroom who <room>                   # list actors in a room
bashroom history <room> [--limit N]   # per-room activity log (not versions)
```

Inside the sandbox, `/usr/local/bin/bashroom` supports the non-destructive
control surface:

```bash
bashroom rooms
bashroom create-room <name>
bashroom mounts
bashroom who <room>
bashroom history <room> [--limit N]
```

The sandbox helper sends no account token. Calls to `bashroom.internal`
are intercepted by the Worker, which supplies identity from the
authenticated sandbox context. `bashroom destroy`, `bashroom login`,
`bashroom token`, and `bashroom mcp` remain laptop-only.

## Auth

Rooms are private by default. `bashroom login` creates an account token and stores it locally at `~/.bashroom/config.json` with file mode `0600`.

The recommended MCP setup is local stdio: `bashroom mcp` reads the local token and injects it into Worker requests. The token does not appear in model-visible tool arguments or room files.

Remote HTTP MCP is also available at `https://bashroom.sdan.io/mcp`.

Cross-account shared rooms are not a supported contract yet. Pair/join was
removed because the current per-user R2 ownership model cannot provide a
correct shared storage identity. Role links are narrower and supported: a
View link is anonymous, while Comment and Edit links require the recipient's
own Bashroom account and grant access to exactly one owner-scoped document.
Agents use the `bashroom_shared_*` tools with the same links; they are not
mounted into the owner's room.

The public service does not expose global room lists, global actor lists, public search, or unauthenticated reads.

## Network

Network is disabled in the public shell except for the private
`bashroom.internal` control channel used by the sandbox helper.

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

The CLI stores account tokens at `~/.bashroom/config.json` with file mode `0600`.

## Web

A browser reader/editor is served at `/web`. Paste your account token once;
the sidebar lists your rooms and file trees. Members with `write` scope save
through RoomText version checks; stale whole-document drafts remain visible
and return an explicit conflict. Read-only members can only view.

The Share menu creates separate View, Comment, and Edit links. Inline comments
are quote-anchored and keep actor identity. Shared pages show viewer count,
ephemeral live drafts, and an actor-labeled live cursor. Durable saves use
strict version conflicts rather than CRDT merging. Mermaid fences render in
strict mode; `ascii`, `text`, `diagram`, and `art` fences preserve diagram
spacing. Use Preview in the private editor to render these richer blocks.

Two panes, Notion-shape: sidebar plus content. Single inline HTML served from the worker — no build, no framework.

Click your `@handle` in the sidebar to open the private self profile at
`/@<handle>`. It summarizes current rooms/files, stored bytes, and a year of
best-effort durable-change activity. The view is account-authenticated and
returns aggregate counts only; it is not a public profile or billing report.

### Offline / plane mode

Click **Offline** in the web sidebar before departure. Bashroom downloads the
app, every authorized room file, and every directly referenced external page.
It then follows two same-site link levels breadth-first, up to 500 pages beyond
any larger direct reading list. Each page is stored as searchable Markdown and,
when Browser Run succeeds, an A4 PDF. The button becomes **Offline ready** only
after the run produces a receipt; its tooltip shows files, pages, PDFs, misses,
and whether the graph hit a cap. Offline search and reading use this snapshot.
Preparation first shows an indeterminate planning track while Bashroom discovers
the workload, then a determinate bar for known room/file totals. Linked-page
capture returns to discovery motion because rendered pages can reveal more links.

Install Bashroom on a phone with the **Install** action. Chrome/Android opens
the native install prompt; on iPhone/iPad it explains Safari's Share -> Add to
Home Screen flow. Launching the icon works offline after preparation. Links
inside archived pages stay inside the local graph, and **Open PDF** serves the
device-local PDF without a network request.

On the first signed-in visit, a short feature guide points to **Offline**,
offline search, **Install**, and **Export** as each control becomes available.
Every tip can be dismissed. Use the **?** button beside the theme control to
replay the guide at any time; its completion state stays only on that device.

Edits made without a network are stored on the device with the file version
they were based on. They sync after reconnect; if the server copy moved,
Bashroom preserves the draft and shows a conflict instead of overwriting.

Click **Export** for one standalone HTML archive of all cached text and linked
page Markdown. It can be opened independently or printed as one PDF. Individual
publisher-layout PDFs remain in the installed app because embedding hundreds
of PDFs into one HTML file would duplicate storage. Browser storage can still
be cleared by the browser or user, so the standalone export remains the durable
text fallback.

The recursive walk stays on each seed's origin, ignores obvious asset links,
and has explicit depth/page/node/edge limits. It is a prepared reading library,
not an unbounded mirror of the public web.

`bashroom history` is an activity log for shell commands and direct web/MCP
writes. It is not file version history and cannot restore deleted content.

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
how the tool harness compares to Claude Code's is in
`docs/harness-vs-claude-code.md`.

## Self-host

```bash
git clone https://github.com/sdan/bashroom
cd bashroom
npm install
npm run dev
npm run deploy
```
