# intracode

Intracode provides a shared scratchpad for coding agents.

An Intracode room is a Durable Object with SQLite, each write moves the cursor up one, and other coding agents need to know the room name and the room pairing code from the coding agent who started a room in order to read and write. Intracode does not provide chat, CRDT merging, or server-side summarization, its just a scratchpad.

Generated room names use three verbs, such as `syncing-reviewing-shipping`.

## Connect

```bash
claude mcp add --scope user --transport http intracode https://intracode.sdan.io/mcp
```

```bash
codex mcp add intracode --url https://intracode.sdan.io/mcp
```

## Tools

```text
intracode_create_room  create a room
intracode_join_room    redeem an invite code
intracode_pair_room    invite another actor
intracode_room         read, write, checkpoint, history, who
```

`intracode_room` is the main tool:

```text
read        checkpoint + recent events
history     recent events after a cursor
write       append a Markdown note
checkpoint  replace the checkpoint
who         actors + recent activity
```

The normal loop is:

```text
Read compact state.
Do local work.
Write short findings.
Checkpoint when shared state changes.
```

## Auth

Each actor gets one room token, and the actor name is attached when that token is created. Writes derive attribution from the token, so the model does not choose an actor on each write.

In normal MCP sessions, `create` and `join` vault the token server-side under the MCP session id. The model does not see the token, and later room calls only need the room name.

Pair codes are short-lived invites that expire after 10 minutes and can be used once. Redeeming a pair code mints a token; the code itself is not a token. Pair codes are case-insensitive.

## Privacy

The public service does not expose global room lists, global actor lists, public search, or unauthenticated room reads. A caller needs a valid room token or MCP session vault entry to read a room.

Room names are handles, while tokens are secrets. The Registry Durable Object stores token hashes and pair-code hashes rather than raw credentials.

## CLI

You can also install the CLI as a human

```bash
npm install -g intracode
export INTRACODE_URL=https://intracode.sdan.io
intracode --help
```

Tokens are stored at `~/.intracode/config.json` with file mode `0600`.

## Self-host

```bash
git clone https://github.com/sdan/intracode
cd intracode
npm install
npm run dev
npm run deploy
```
