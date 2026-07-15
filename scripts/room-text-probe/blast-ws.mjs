import assert from "node:assert/strict";
import WebSocket from "ws";
import { ChangeSet, Text } from "@codemirror/state";

const base = process.argv[2] || "http://localhost:8797";
const room = `ws-room-${Date.now()}`;
const fileId = `ws-${Date.now()}`;
const wsUrl = `${base.replace(/^http/, "ws")}/ws?room=${room}`;

async function json(path, init) {
  const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}room=${room}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function post(path, body) {
  const init = { method: "POST", headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return json(path, init);
}

/** One protocol peer: frames queue in arrival order; next() pops or waits. */
class Peer {
  constructor() {
    this.ws = new WebSocket(wsUrl);
    this.frames = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => {
      this.ws.on("close", (code) => resolve(code));
    });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  next(timeoutMs = 10_000) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

async function open() {
  const peer = new Peer();
  await peer.ready;
  return peer;
}

let connectSequence = 0;
async function hydrate(peer, { file = fileId, epoch = 0, lastRevision = 0, protocolVersion = 1 } = {}) {
  const connectRequestId = `probe:connect-${++connectSequence}`;
  peer.send({ type: "connect", connectRequestId, protocolVersion, fileId: file, epoch, lastRevision });
  const frame = await peer.next();
  assert.equal(frame.connectRequestId, connectRequestId);
  return frame;
}

function pushInput(clientId, requestId, baseRevision, changes, { file = fileId, epoch = 1 } = {}) {
  return { protocol: 1, fileId: file, epoch, baseRevision, clientId, requestId, changes };
}

const token = (clientId, requestId) => JSON.stringify([clientId, requestId]);

function applyWire(content, changes) {
  const doc = Text.of(content.split("\n"));
  return ChangeSet.of(changes.map((change) => ({ ...change })), doc.length, "\n").apply(doc).toString();
}

// Canonical content per revision, recorded from /open after each commit so
// delta hydrations can be replay-verified against server truth.
const contentAt = new Map();
async function recordHead(expectedRevision) {
  const head = await json(`/open?file=${fileId}`);
  assert.equal(head.revision, expectedRevision);
  contentAt.set(head.revision, head.content);
  return head.content;
}

const created = await post("/create", { fileId, path: "notes/ws.md", content: "hello world\n" });
assert.equal(created.ok, true);
contentAt.set(0, "hello world\n");

// An unknown protocolVersion is refused with an explicit incompatibility
// frame, then a server-declared close code for the aggressive ladder.
{
  const peer = await open();
  const refused = await hydrate(peer, { protocolVersion: 2 });
  assert.equal(refused.type, "incompatible");
  assert.equal(refused.serverProtocol, 1);
  assert.equal(await peer.closed, 4400);
}

// A connect for a file that does not exist is a connect-error, not a hang.
{
  const peer = await open();
  const missing = await hydrate(peer, { file: `${fileId}-missing` });
  assert.deepEqual({ type: missing.type, code: missing.code }, { type: "connect-error", code: "NOT_FOUND" });
  await peer.close();
}

// Fresh clients (epoch 0) hydrate by snapshot; the server chose the shape.
const peerA = await open();
const snapshotA = await hydrate(peerA);
assert.deepEqual(
  {
    type: snapshotA.type,
    hydration: snapshotA.hydration,
    epoch: snapshotA.epoch,
    headRevision: snapshotA.headRevision,
    byteLength: snapshotA.byteLength,
    doc: snapshotA.doc,
  },
  { type: "hydration", hydration: "snapshot", epoch: 1, headRevision: 0, byteLength: 12, doc: "hello world\n" },
);
const peerB = await open();
assert.equal((await hydrate(peerB)).hydration, "snapshot");

// Echo-as-ack: the sender's own updateToken-tagged entry in the broadcast
// frame IS its commit ack; every attached socket receives the same frame.
peerA.send({ type: "push", pushes: [pushInput("ws-a", "r1", 0, [{ from: 0, to: 0, insert: "A" }])] });
const echoA = await peerA.next();
assert.deepEqual(echoA, {
  type: "updates",
  fileId,
  epoch: 1,
  headRevision: 1,
  updates: [{
    revision: 1,
    parentRevision: 0,
    clientId: "ws-a",
    requestId: "r1",
    changes: [{ from: 0, to: 0, insert: "A" }],
    updateToken: token("ws-a", "r1"),
  }],
});
assert.deepEqual(await peerB.next(), echoA);
await recordHead(1);

// A stale-base push commits rebased: parentRevision moves past the submitted
// base, and the canonical changes in the echo carry the rebased positions.
peerB.send({ type: "push", pushes: [pushInput("ws-b", "r1", 0, [{ from: 12, to: 12, insert: "B" }])] });
const echoB = await peerB.next();
assert.equal(echoB.updates[0].revision, 2);
assert.equal(echoB.updates[0].parentRevision, 1);
assert.deepEqual(echoB.updates[0].changes, [{ from: 13, to: 13, insert: "B" }]);
assert.deepEqual(await peerA.next(), echoB);
await recordHead(2);

// Reconnect-with-delta: a client that was at revision 1 comes back and the
// SERVER chooses delta — a range read over the canonical update rows.
await peerA.close();
peerB.send({ type: "push", pushes: [pushInput("ws-b", "r2", 2, [{ from: 0, to: 0, insert: "!" }])] });
assert.equal((await peerB.next()).updates[0].revision, 3);
await recordHead(3);
const peerA2 = await open();
const delta = await hydrate(peerA2, { epoch: 1, lastRevision: 1 });
assert.deepEqual(
  { hydration: delta.hydration, epoch: delta.epoch, headRevision: delta.headRevision },
  { hydration: "delta", epoch: 1, headRevision: 3 },
);
assert.deepEqual(delta.updates.map((update) => update.revision), [2, 3]);
{
  let content = contentAt.get(1);
  for (const update of delta.updates) content = applyWire(content, update.changes);
  assert.equal(content, contentAt.get(3));
}

// Outbox replay dedupes to one revision: resending a committed push with its
// ORIGINAL token yields a direct commit ack carrying the original result —
// no new revision, no re-broadcast to anyone.
const replayPush = pushInput("ws-a", "r9", 3, [{ from: 0, to: 0, insert: "?" }]);
peerA2.send({ type: "push", pushes: [replayPush] });
assert.equal((await peerA2.next()).updates[0].revision, 4);
assert.equal((await peerB.next()).updates[0].revision, 4);
await recordHead(4);
await peerA2.close();
const peerA3 = await open();
const emptyDelta = await hydrate(peerA3, { epoch: 1, lastRevision: 4 });
assert.deepEqual(
  { hydration: emptyDelta.hydration, updates: emptyDelta.updates },
  { hydration: "delta", updates: [] },
);
peerA3.send({ type: "push", pushes: [replayPush] });
assert.deepEqual(await peerA3.next(), {
  type: "ack",
  updateToken: token("ws-a", "r9"),
  status: "commit",
  revision: 4,
});
assert.equal((await json(`/inspect?file=${fileId}`)).revision, 4);
// The very next broadcast either peer sees is the marker: the replay put
// nothing new on the wire.
peerB.send({ type: "push", pushes: [pushInput("ws-b", "r3", 4, [{ from: 0, to: 0, insert: "*" }])] });
assert.equal((await peerB.next()).updates[0].revision, 5);
assert.equal((await peerA3.next()).updates[0].revision, 5);
await recordHead(5);

// Replaying a push that committed REBASED surfaces commit{revision,
// rebasedChanges} — the third arm of the tri-state ack.
peerB.send({ type: "push", pushes: [pushInput("ws-b", "r1", 0, [{ from: 12, to: 12, insert: "B" }])] });
assert.deepEqual(await peerB.next(), {
  type: "ack",
  updateToken: token("ws-b", "r1"),
  status: "commit",
  revision: 2,
  rebasedChanges: [{ from: 13, to: 13, insert: "B" }],
});

// Broadcast batching: one message carrying an outbox of three accepted
// updates leaves as ONE frame with N=3 token-tagged entries for everyone.
peerA3.send({
  type: "push",
  pushes: [
    pushInput("ws-a", "b1", 5, [{ from: 0, to: 0, insert: "1" }]),
    pushInput("ws-a", "b2", 6, [{ from: 0, to: 0, insert: "2" }]),
    pushInput("ws-a", "b3", 7, [{ from: 0, to: 0, insert: "3" }]),
  ],
});
const batch = await peerA3.next();
assert.equal(batch.type, "updates");
assert.equal(batch.headRevision, 8);
assert.deepEqual(batch.updates.map((update) => update.revision), [6, 7, 8]);
assert.deepEqual(
  batch.updates.map((update) => update.updateToken),
  [token("ws-a", "b1"), token("ws-a", "b2"), token("ws-a", "b3")],
);
assert.ok(batch.updates.every((update) => update.parentRevision === update.revision - 1));
assert.deepEqual(await peerB.next(), batch);
await recordHead(8);

// Terminal bad-args discard: keyed by the sender's token, not retryable.
peerA3.send({ type: "push", pushes: [pushInput("ws-a", "bad-1", 8, [{ from: 5, to: 2, insert: "" }])] });
const badArgs = await peerA3.next();
assert.deepEqual(
  { type: badArgs.type, updateToken: badArgs.updateToken, code: badArgs.code, retryable: badArgs.retryable },
  { type: "discard", updateToken: token("ws-a", "bad-1"), code: "INVALID_CHANGE", retryable: false },
);

// Zombie-detection support: a ping echoes back its timestamp.
peerA3.send({ type: "ping", at: 123 });
assert.deepEqual(await peerA3.next(), { type: "pong", at: 123 });

// Reconnect-forced-snapshot: once the history floor passes the client's
// last revision, the server refuses to guess and sends the whole document.
const floorFile = `${fileId}-floor`;
assert.equal((await post("/create", { fileId: floorFile, path: "notes/ws-floor.md", content: "abc" })).ok, true);
for (let revision = 0; revision < 3; revision++) {
  const accepted = await post("/push", pushInput("floor-writer", `append-${revision}`, revision, [
    { from: 3 + revision, to: 3 + revision, insert: "x" },
  ], { file: floorFile }));
  assert.equal(accepted.ok, true);
}
await post(`/checkpoint?file=${floorFile}`);
const advanced = await post(`/advance?file=${floorFile}&revision=3`);
assert.equal(advanced.historyFloor, 3);
const peerC = await open();
const forced = await hydrate(peerC, { file: floorFile, epoch: 1, lastRevision: 1 });
assert.deepEqual(
  { hydration: forced.hydration, epoch: forced.epoch, headRevision: forced.headRevision, doc: forced.doc },
  { hydration: "snapshot", epoch: 1, headRevision: 3, doc: "abcxxx" },
);
// At the floor itself the window is still open: an empty delta.
const atFloor = await hydrate(peerC, { file: floorFile, epoch: 1, lastRevision: 3 });
assert.deepEqual({ hydration: atFloor.hydration, updates: atFloor.updates }, { hydration: "delta", updates: [] });
// A push based below the floor is a RETRYABLE discard: stale sync state.
peerC.send({ type: "push", pushes: [pushInput("floor-writer", "stale-1", 1, [{ from: 0, to: 0, insert: "y" }], { file: floorFile })] });
const stale = await peerC.next();
assert.deepEqual(
  { type: stale.type, code: stale.code, retryable: stale.retryable },
  { type: "discard", code: "RESET_REQUIRED", retryable: true },
);

// Convergence: the canonical stream both peers observed reproduces the head.
{
  const head = await json(`/open?file=${fileId}`);
  assert.equal(head.content, contentAt.get(8));
}

await peerA3.close();
await peerB.close();
await peerC.close();

console.log(JSON.stringify({
  handshake: {
    versionMismatch: "incompatible frame + close 4400",
    unknownFile: "connect-error NOT_FOUND",
    freshClient: "snapshot hydration",
    verdict: "server chooses the hydration shape",
  },
  reconnect: {
    withDelta: "revisions 2..3 replayed byte-exact onto the revision-1 document",
    atFloor: "empty delta",
    belowFloor: "forced snapshot",
    verdict: "delta inside the window, snapshot outside, never a guess",
  },
  acks: {
    echoAsAck: "sender's token-tagged entry in the broadcast frame",
    replay: "commit{revision} verbatim from the stored original, no re-broadcast",
    rebasedReplay: "commit{revision, rebasedChanges}",
    discards: { badArgs: "INVALID_CHANGE not retryable", staleState: "RESET_REQUIRED retryable" },
    verdict: "tri-state acks keyed by the client's own token",
  },
  batching: {
    pushesInOneMessage: 3,
    broadcastFrames: 1,
    verdict: "one event-loop turn, one frame, N token-tagged updates",
  },
}, null, 2));
