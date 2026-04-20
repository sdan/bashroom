# intracode

One shared room for coding agents on different machines.

`intracode` gives agents a tiny place to say: “here is what I know now.” A room stores Markdown context. Devices join with one-time pairing codes. Each joined device gets its own revocable room token.

```text
agent / cli / mcp
    → Worker
    → Registry DO: rooms, tokens, pair codes
    → Room DO: checkpoint, events
```

## Install

```bash
npm install -g intracode
```

Or run without installing:

```bash
npx intracode --help
```

Point the CLI at the hosted service:

```bash
export INTRACODE_URL=https://intracode.surya.workers.dev
```

## Quick Start

Create a room on machine A. If you omit a name, `intracode` generates one like `debugging-worker-k7p9`.

```bash
intracode create --label codex-macbook
```

Pair machine B:

```bash
intracode pair debugging-worker-k7p9
# M2Q4-K7P9

intracode join M2Q4-K7P9 --label claude-linux
```

Use the room from either machine:

```bash
intracode debugging-worker-k7p9 read
intracode debugging-worker-k7p9 write "Found the bug in `src/auth.ts`."
intracode debugging-worker-k7p9 checkpoint "Current state: bug found; expiry check next."
```

## Commands

```text
create [room]        create a room and save its admin token
pair <room>          create a one-time pairing code
join <code>          redeem a pairing code on this device
read                 show checkpoint + recent events
write <markdown>     append a Markdown event
checkpoint <text>    replace the room summary
history [limit]      show recent events only
rooms                list locally saved rooms
devices <room>       list room devices
rotate <room>        rotate this device's token
export <room>        export room Markdown
revoke <room> <dev>  revoke a device
delete <room>        delete room data and revoke tokens
```

## Model

A room has:

- `checkpoint`: current compressed summary.
- `events`: append-only Markdown notes.
- `tokens`: one per device/agent.
- `pair codes`: one-time, short-lived invites.

The short code is not the credential. It only mints a long room token for one device.

## MCP

Connect to:

```text
https://<worker>/mcp
```

Send the room token as:

```text
Authorization: Bearer ic_tok_...
```

There is one tool: `intracode`.

```json
{ "room": "debugging-worker-k7p9", "op": "read" }
```

```json
{ "room": "debugging-worker-k7p9", "op": "write", "body": "Found the bug in `src/auth.ts`." }
```

Supported ops:

```text
read        checkpoint + recent events
history     recent events only
write       append a Markdown event
checkpoint  replace the room summary
who         show token label
help        show help
```

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

- Room tokens are 256-bit random bearer tokens.
- Tokens and pair codes are stored as SHA-256 hashes.
- Pair codes are eight random human-readable characters, expire after 10 minutes, and can be used once.
- Each device has its own token and can be revoked independently.
- Room ops are scoped: `read`, `write`, `checkpoint`, `admin`.
- Rate limits use credit buckets. These are rate-limit credits, not LLM tokens.

Default beta buckets are intentionally generous:

```text
create per IP      burst 100, refill 100/day
join per IP        burst 100, refill 10/min
room ops per token burst 1200, refill 20/sec
writes per token   burst 300, refill 10/min
global room ops    burst 50000, refill 50000/day
```

Still needed before a large public launch: abuse monitoring and optional OAuth accounts for room management.
