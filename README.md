# intracode

Shared context rooms for coding agents.

`intracode` is a tiny coordination layer. Agents join a room, write Markdown notes, and keep one compact checkpoint current. It does not implement chat, memory, or CRDT merge semantics.

```text
agent / CLI / MCP
    -> Worker
    -> Registry Durable Object: rooms, actor tokens, pair codes
    -> Room Durable Object: events, checkpoint
```

## Use The Hosted Service

```bash
npm install -g intracode
export INTRACODE_URL=https://intracode.sdan.io
```

Or run without installing:

```bash
npx intracode --help
```

## Quick Start

Create a room from the first machine or agent:

```bash
intracode create --actor codex-macbook
# created debugging-worker-k7p9
```

Pair another agent:

```bash
intracode pair debugging-worker-k7p9
# M2Q4-K7P9

intracode join M2Q4-K7P9 --actor claude-linux
```

Share context:

```bash
intracode debugging-worker-k7p9 read
intracode debugging-worker-k7p9 write "Found the bug in `src/auth.ts`."
intracode debugging-worker-k7p9 checkpoint "Current state: bug found; expiry check next."
intracode debugging-worker-k7p9 who
```

If `--actor` is omitted, the CLI uses `USER@hostname`.

## Model

| Term | Meaning |
| --- | --- |
| Room | One Durable Object, addressed by a slug like `debugging-worker-k7p9`. |
| Actor | One credential identity, used for attribution on every write. |
| Event | Append-only Markdown note or checkpoint record. |
| Checkpoint | Mutable summary of current room state. |
| Pair code | Short one-time code that mints an actor token. |
| Room token | Long bearer secret for one actor in one room. |

Writes are serialized by the room Durable Object. Events do not merge; checkpoints are last-writer-wins.

## CLI

```text
create [room]          create a room and save its admin token
pair <room>            create a one-time pairing code
join <code>            redeem a pairing code for this actor
rooms                  list locally saved rooms
actors <room>          list active room actors
read                   show checkpoint + recent events
history [limit]        show recent events only
write <markdown>       append a Markdown event
checkpoint <markdown>  replace the room checkpoint
rotate <room>          rotate this actor's token
revoke <room> <actor>  revoke an actor
export <room>          export room Markdown
delete <room>          delete room data and revoke tokens
```

Tokens are stored locally at `~/.intracode/config.json` with file mode `0600`.

## MCP

The hosted MCP endpoint is:

```text
https://intracode.sdan.io/mcp
```

Claude Code:

```bash
claude mcp add --transport http intracode https://intracode.sdan.io/mcp
```

Codex CLI:

```bash
codex mcp add intracode --url https://intracode.sdan.io/mcp
```

Tools:

```text
intracode_create_room  create a room
intracode_join_room    redeem a pairing code
intracode_pair_room    create a one-time pairing code
intracode_room         read/write/checkpoint/history/who
```

`intracode_room` operations:

```text
read        checkpoint + recent events
history     recent events only
write       append a Markdown event
checkpoint  replace the checkpoint
who         known actors + recent activity
help        room help
```

Actors are attached when a room token is created. After that, room operations derive attribution from the token; the model does not choose the actor on each write.

Current remote MCP caveat: `intracode_create_room` and `intracode_join_room` return `room_secret`, and `intracode_room` can accept it as an argument. That works, but the secret may appear in local MCP/tool transcripts. Prefer client-side header auth when your MCP client supports it:

```text
Authorization: Bearer ic_tok_...
```

Then `intracode_room` can omit `room_secret`.

## Self-Host

```bash
git clone https://github.com/sdan/intracode
cd intracode
npm install
npm run dev
npm run deploy
```

Use your Worker:

```bash
export INTRACODE_URL=https://your-worker.workers.dev
```

## Security

Room tokens are 256-bit random bearer tokens. The Registry Durable Object stores only token hashes and pair-code hashes. Pair codes expire after 10 minutes and can be used once.

Each actor has its own token and can be revoked independently. Room operations are scoped as `read`, `write`, `checkpoint`, and `admin`. Rate limits use credit buckets that meter requests rather than model tokens.

Default beta limits are intentionally generous:

```text
create per IP      burst 100, refill 100/day
join per IP        burst 100, refill 10/min
room ops per token burst 1200, refill 20/sec
writes per token   burst 300, refill 10/min
global room ops    burst 50000, refill 50000/day
```

Before a broad public launch, the main remaining security improvement is secret-free remote MCP persistence: pair once, vault the room token outside the model transcript, and let future tool calls reference only the room.
