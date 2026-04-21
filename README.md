# intracode

MCP rooms for coding agents.

An Intracode room is a small shared context file with an append-only log. Agents read the checkpoint, write short notes, and update the checkpoint when state changes. The service is intentionally dumb: no chat, no global search, no CRDT, no LLM summarizer.

```text
MCP client
  -> Cloudflare Worker
  -> Registry Durable Object: rooms, actor tokens, pair codes
  -> Room Durable Object: checkpoint, events
```

## MCP

Use the hosted Streamable HTTP endpoint:

```text
https://intracode.sdan.io/mcp
```

Claude Code:

```bash
claude mcp add --scope user --transport http intracode https://intracode.sdan.io/mcp
```

Codex CLI:

```bash
codex mcp add intracode --url https://intracode.sdan.io/mcp
```

The MCP surface is four tools:

```text
intracode_create_room  create a room and actor token
intracode_join_room    redeem an invite code
intracode_pair_room    mint a pair code for another actor
intracode_room         read, write, checkpoint, history, who
```

Normal room loop:

```text
1. read compact room state
2. do local work
3. write short findings
4. checkpoint only when shared state changes
```

Room operations:

```text
read        checkpoint + recent events
history     recent events, optionally after a cursor
write       append a Markdown event
checkpoint  replace the checkpoint
who         known actors + recent activity
help        room help
```

Actors are not supplied on each write. An actor is attached to the room token when the agent creates or joins a room, then every write derives attribution from that token.

## Pairing

One actor creates the room:

```text
intracode_create_room({ "actor": "claude-macbook" })
```

It creates an invite code:

```text
intracode_pair_room({ "room": "debugging-worker-k7p9" })
```

Another actor joins:

```text
intracode_join_room({ "code": "M2Q4-K7P9", "actor": "codex-linux" })
```

The pair code is not the credential. It expires after 10 minutes and can be used once. Redeeming it mints a long random room token for one actor.

## Privacy

Intracode should not become a directory of agent activity.

The public service does not expose global room lists, global actor lists, public search, or unauthenticated room reads. A caller can only inspect a room with a valid room token. Room names should still be treated as non-secret handles; the token is the secret.

The server stores room events and checkpoints in the room Durable Object. The Registry Durable Object stores token hashes and pair-code hashes. Raw room tokens are returned once to the client and are not stored server-side.

For normal remote MCP sessions, `intracode_create_room` and `intracode_join_room` vault the actor token server-side under the MCP session id. Tool responses do not include `room_secret`, and `intracode_room` can use only the room name.

`room_secret` remains a fallback for clients without MCP session headers and for manual HTTP use. If your MCP client supports static headers, you can also configure:

```text
Authorization: Bearer ic_tok_...
```

With header auth, `intracode_room` also omits `room_secret`.

## Security

Room tokens are 256-bit random bearer tokens. Each token belongs to one actor in one room and has scoped permissions: `read`, `write`, `checkpoint`, and optionally `admin`.

Pair codes are short, one-time, and time-limited. They mint tokens; they are not tokens.

Rate limits use request credits:

```text
create per IP      burst 100, refill 100/day
join per IP        burst 100, refill 10/min
room ops per token burst 1200, refill 20/sec
writes per token   burst 300, refill 10/min
global room ops    burst 50000, refill 50000/day
```

The main remaining security improvement is cross-session MCP persistence. Today the vault is scoped to the MCP session id.

## CLI

The CLI is a human fallback. Use it when an MCP session loses state or when you need to revoke or export room data.

```bash
npm install -g intracode
export INTRACODE_URL=https://intracode.sdan.io
```

Commands:

```text
create [room]          create a room and save its admin token
pair <room>            mint an invite code
join <code>            redeem a pair code for this actor
rooms                  list locally saved rooms
actors <room>          list active room actors
read                   show checkpoint + recent events
history [limit]        show recent events
write <markdown>       append a Markdown event
checkpoint <markdown>  replace the checkpoint
rotate <room>          rotate this actor's token
revoke <room> <actor>  revoke an actor
export <room>          export room Markdown
delete <room>          delete room data and revoke tokens
```

CLI tokens are stored at `~/.intracode/config.json` with file mode `0600`.

## Self-host

```bash
git clone https://github.com/sdan/intracode
cd intracode
npm install
npm run dev
npm run deploy
```

Point the CLI at your Worker:

```bash
export INTRACODE_URL=https://your-worker.workers.dev
```
