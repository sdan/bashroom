import { describe, expect, it } from "vitest";
import {
  ROOM_TEXT_AGGRESSIVE_BACKOFF_MS,
  ROOM_TEXT_CLOSE_INCOMPATIBLE,
  ROOM_TEXT_CLOSE_ZOMBIE,
  ROOM_TEXT_NORMAL_BACKOFF_MS,
  RoomTextClient,
  type RoomTextClientFrame,
  type RoomTextClientState,
  type RoomTextServerFrame,
} from "./room-text-client";
import { roomTextUpdateToken, type WireTextChange } from "./room-text";
import type { PushRoomTextInput, RoomTextFailure } from "./room-text-store";

// Deterministic replacement for the injected schedule(): timers fire in time
// order when the test advances the clock, never on their own.
function fakeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; done: boolean }> = [];
  return {
    now: () => now,
    schedule(fn: () => void, delayMs: number): () => void {
      const timer = { at: now + delayMs, fn, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.done && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.done = true;
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  const clock = fakeClock();
  const log = {
    opened: 0,
    frames: [] as RoomTextClientFrame[],
    closes: [] as Array<[number, string]>,
    states: [] as RoomTextClientState[],
    acks: [] as Array<{ requestId: string; revision: number; rebasedChanges?: WireTextChange[] }>,
    discards: [] as Array<{ requestId: string; code: RoomTextFailure["error"]; retryable: boolean }>,
    remote: [] as number[],
    snapshots: [] as Array<{ doc: string; epoch: number; revision: number }>,
    orphaned: [] as WireTextChange[][],
    incompatible: [] as number[],
  };
  const client = new RoomTextClient({
    clientId: "c1",
    fileId: "f1",
    schedule: clock.schedule,
    now: clock.now,
    effects: {
      openSocket: () => log.opened++,
      sendFrame: (frame) => log.frames.push(frame),
      closeSocket: (code, reason) => log.closes.push([code, reason]),
      onStateChange: (state) => log.states.push(state),
      onAck: (ack) => log.acks.push(ack),
      onDiscard: (discard) => log.discards.push(discard),
      onRemoteUpdate: (update) => log.remote.push(update.revision),
      onSnapshot: (snapshot) => log.snapshots.push(snapshot),
      onLocalChangesOrphaned: (changes) => log.orphaned.push([...changes]),
      onIncompatible: (serverProtocol) => log.incompatible.push(serverProtocol),
    },
  });
  return { clock, log, client };
}

function lastConnect(h: Harness) {
  const frame = [...h.log.frames].reverse().find((sent) => sent.type === "connect");
  if (!frame || frame.type !== "connect") throw new Error("no connect frame sent");
  return frame;
}

function hydrateSnapshot(h: Harness, doc: string, revision = 0, epoch = 1): void {
  h.client.handleFrame({
    type: "hydration",
    connectRequestId: lastConnect(h).connectRequestId,
    fileId: "f1",
    hydration: "snapshot",
    epoch,
    headRevision: revision,
    byteLength: new TextEncoder().encode(doc).byteLength,
    doc,
  });
}

function connect(h: Harness, doc = "ab", revision = 0, epoch = 1): void {
  h.client.start();
  h.client.handleSocketOpen();
  hydrateSnapshot(h, doc, revision, epoch);
}

function pushes(h: Harness): PushRoomTextInput[][] {
  return h.log.frames.filter((frame) => frame.type === "push").map((frame) => frame.pushes);
}

function broadcast(
  revision: number,
  clientId: string,
  requestId: string,
  changes: WireTextChange[],
  parentRevision = revision - 1,
): RoomTextServerFrame {
  return {
    type: "updates",
    fileId: "f1",
    epoch: 1,
    headRevision: revision,
    updates: [{
      revision,
      parentRevision,
      clientId,
      requestId,
      changes,
      updateToken: roomTextUpdateToken(clientId, requestId),
    }],
  };
}

describe("RoomTextClient handshake and FSM", () => {
  it("opens, handshakes with protocol 1, and hydrates from a snapshot", () => {
    const h = makeHarness();
    h.client.start();
    expect(h.log.opened).toBe(1);
    h.client.handleSocketOpen();
    const frame = lastConnect(h);
    expect(frame).toMatchObject({ protocolVersion: 1, fileId: "f1", epoch: 0, lastRevision: 0 });
    hydrateSnapshot(h, "hello world");
    expect(h.client.state()).toBe("connected");
    expect(h.client.localText()).toBe("hello world");
    expect(h.log.snapshots).toEqual([{ doc: "hello world", epoch: 1, revision: 0 }]);
  });

  it("walks the normal backoff ladder and resets it on a successful hydration", () => {
    const h = makeHarness();
    connect(h);
    const expected = [...ROOM_TEXT_NORMAL_BACKOFF_MS, 10_000, 10_000];
    for (const delay of expected) {
      const before = h.log.opened;
      h.client.handleSocketClose(1006);
      expect(h.client.state()).toBe("backoff");
      h.clock.advance(delay - 1);
      expect(h.log.opened).toBe(before);
      h.clock.advance(1);
      expect(h.log.opened).toBe(before + 1);
      h.client.handleSocketOpen();
    }
    // Successful hydration resets the attempt counter to the ladder's foot.
    hydrateSnapshot(h, "ab");
    h.client.handleSocketClose(1006);
    const before = h.log.opened;
    h.clock.advance(250);
    expect(h.log.opened).toBe(before + 1);
  });

  it("switches to the aggressive ladder on server-error close codes", () => {
    const h = makeHarness();
    connect(h);
    const expected = [...ROOM_TEXT_AGGRESSIVE_BACKOFF_MS, 300_000];
    for (const delay of expected) {
      const before = h.log.opened;
      h.client.handleSocketClose(4400);
      h.clock.advance(delay - 1);
      expect(h.log.opened).toBe(before);
      h.clock.advance(1);
      expect(h.log.opened).toBe(before + 1);
      h.client.handleSocketOpen();
    }
  });

  it("surfaces an incompatibility frame, closes, and backs off aggressively", () => {
    const h = makeHarness();
    h.client.start();
    h.client.handleSocketOpen();
    h.client.handleFrame({
      type: "incompatible",
      connectRequestId: lastConnect(h).connectRequestId,
      serverProtocol: 2,
    });
    expect(h.log.incompatible).toEqual([2]);
    expect(h.log.closes.at(-1)?.[0]).toBe(ROOM_TEXT_CLOSE_INCOMPATIBLE);
    expect(h.client.state()).toBe("backoff");
    const before = h.log.opened;
    h.clock.advance(ROOM_TEXT_AGGRESSIVE_BACKOFF_MS[0]);
    expect(h.log.opened).toBe(before + 1);
  });

  it("pings after 30s idle and declares a zombie when nothing answers in 2s", () => {
    const h = makeHarness();
    connect(h);
    h.clock.advance(30_000);
    expect(h.log.frames.at(-1)).toMatchObject({ type: "ping" });
    h.clock.advance(2_000);
    expect(h.log.closes.at(-1)?.[0]).toBe(ROOM_TEXT_CLOSE_ZOMBIE);
    expect(h.client.state()).toBe("backoff");
    // A zombie is a client-declared death: the NORMAL ladder paces it.
    const before = h.log.opened;
    h.clock.advance(250);
    expect(h.log.opened).toBe(before + 1);
  });

  it("treats a pong — or any other frame — as proof of life", () => {
    const h = makeHarness();
    connect(h);
    h.clock.advance(30_000);
    h.client.handleFrame({ type: "pong", at: 0 });
    h.clock.advance(2_000);
    expect(h.log.closes).toEqual([]);
    expect(h.client.state()).toBe("connected");
    // Activity re-arms the full interval: the next ping fires 30s after the
    // pong, not 30s after the previous ping.
    h.clock.advance(27_999);
    expect(h.log.frames.filter((frame) => frame.type === "ping")).toHaveLength(1);
    h.clock.advance(1);
    expect(h.log.frames.filter((frame) => frame.type === "ping")).toHaveLength(2);
  });
});

describe("RoomTextClient compose buffer and outbox", () => {
  it("composes edits losslessly for 100ms and sends ONE update", () => {
    const h = makeHarness();
    connect(h, "ab");
    h.client.edit([{ from: 1, to: 1, insert: "X" }]);
    h.clock.advance(50);
    h.client.edit([{ from: 2, to: 2, insert: "Y" }]);
    expect(pushes(h)).toHaveLength(0);
    h.clock.advance(50);
    const sent = pushes(h);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({
      protocol: 1,
      clientId: "c1",
      baseRevision: 0,
      changes: [{ from: 1, to: 1, insert: "XY" }],
    });
    expect(h.client.localText()).toBe("aXYb");
  });

  it("takes the broadcast echo as the commit ack (fast path, no rebase)", () => {
    const h = makeHarness();
    connect(h, "ab");
    h.client.edit([{ from: 1, to: 1, insert: "X" }]);
    h.clock.advance(100);
    const [push] = pushes(h)[0];
    h.client.handleFrame(broadcast(1, "c1", push.requestId, [{ from: 1, to: 1, insert: "X" }]));
    expect(h.log.acks).toEqual([{ requestId: push.requestId, revision: 1 }]);
    expect(h.client.outboxSize()).toBe(0);
    expect(h.client.revision()).toBe(1);
    expect(h.client.localText()).toBe("aXb");
  });

  it("rebases the pending chain over a remote update, then converges on its echo", () => {
    const h = makeHarness();
    connect(h, "ab");
    h.client.edit([{ from: 1, to: 1, insert: "Y" }]);
    h.clock.advance(100);
    // A remote insert lands first at the same position: canonical order puts
    // the accepted X before our pending Y (the store's rebase invariant).
    h.client.handleFrame(broadcast(1, "other", "r1", [{ from: 1, to: 1, insert: "X" }]));
    expect(h.log.remote).toEqual([1]);
    expect(h.client.localText()).toBe("aXYb");
    // The server's canonical echo carries the rebased position; parent 1 is
    // past our submitted base 0, so the ack reports rebasedChanges.
    const [push] = pushes(h)[0];
    h.client.handleFrame(broadcast(2, "c1", push.requestId, [{ from: 2, to: 2, insert: "Y" }], 1));
    expect(h.log.acks).toEqual([{
      requestId: push.requestId,
      revision: 2,
      rebasedChanges: [{ from: 2, to: 2, insert: "Y" }],
    }]);
    expect(h.client.outboxSize()).toBe(0);
    expect(h.client.localText()).toBe("aXYb");
  });

  it("confirms an already-committed entry from the hydration delta without resending", () => {
    const h = makeHarness();
    connect(h, "ab");
    h.client.edit([{ from: 1, to: 1, insert: "X" }]);
    h.clock.advance(100);
    const [push] = pushes(h)[0];
    // The commit happened but the ack died with the socket.
    h.client.handleSocketClose(1006);
    h.clock.advance(250);
    h.client.handleSocketOpen();
    expect(lastConnect(h)).toMatchObject({ epoch: 1, lastRevision: 0 });
    const framesBefore = h.log.frames.length;
    h.client.handleFrame({
      type: "hydration",
      connectRequestId: lastConnect(h).connectRequestId,
      fileId: "f1",
      hydration: "delta",
      epoch: 1,
      headRevision: 1,
      updates: [{
        revision: 1,
        parentRevision: 0,
        clientId: "c1",
        requestId: push.requestId,
        changes: [{ from: 1, to: 1, insert: "X" }],
      }],
    });
    expect(h.log.acks).toEqual([{ requestId: push.requestId, revision: 1 }]);
    expect(h.client.outboxSize()).toBe(0);
    expect(h.log.frames.length).toBe(framesBefore); // no resend, nothing else
    expect(h.client.localText()).toBe("aXb");
  });

  it("rebases an unconfirmed entry over the hydration delta and resends its ORIGINAL token", () => {
    const h = makeHarness();
    connect(h, "ab");
    h.client.edit([{ from: 1, to: 1, insert: "Y" }]);
    h.clock.advance(100);
    const [push] = pushes(h)[0];
    h.client.handleSocketClose(1006);
    h.clock.advance(250);
    h.client.handleSocketOpen();
    // The delta carries only a remote update; ours was never committed.
    h.client.handleFrame({
      type: "hydration",
      connectRequestId: lastConnect(h).connectRequestId,
      fileId: "f1",
      hydration: "delta",
      epoch: 1,
      headRevision: 1,
      updates: [{
        revision: 1,
        parentRevision: 0,
        clientId: "other",
        requestId: "r1",
        changes: [{ from: 1, to: 1, insert: "X" }],
      }],
    });
    const resent = pushes(h).at(-1);
    expect(resent).toHaveLength(1);
    expect(resent?.[0]).toMatchObject({
      requestId: push.requestId, // ORIGINAL token
      baseRevision: 1,
      changes: [{ from: 2, to: 2, insert: "Y" }], // rebased over the delta
    });
    expect(h.client.localText()).toBe("aXYb");
  });

  it("replays a sent entry verbatim after a snapshot hydration and orphans unsent work", () => {
    const h = makeHarness();
    connect(h, "ab");
    h.client.edit([{ from: 1, to: 1, insert: "X" }]);
    h.clock.advance(100);
    const [push] = pushes(h)[0];
    h.client.handleSocketClose(1006);
    // Typed while offline: this entry is flushed but never transmitted.
    h.client.edit([{ from: 3, to: 3, insert: "Z" }]);
    h.clock.advance(250);
    h.client.handleSocketOpen();
    hydrateSnapshot(h, "aXb", 5, 1);
    // The unsent entry has no lineage onto the snapshot: surfaced, not resent.
    expect(h.log.orphaned).toEqual([[{ from: 3, to: 3, insert: "Z" }]]);
    expect(h.client.localText()).toBe("aXb");
    const resent = pushes(h).at(-1);
    expect(resent?.[0]).toEqual(pushes(h)[0][0]); // verbatim original payload
    // The idempotency row answers with the original commit; the snapshot
    // already contains its text, so the entry simply leaves the outbox.
    h.client.handleFrame({
      type: "ack",
      updateToken: roomTextUpdateToken("c1", push.requestId),
      status: "commit",
      revision: 1,
    });
    expect(h.log.acks).toEqual([{ requestId: push.requestId, revision: 1 }]);
    expect(h.client.outboxSize()).toBe(0);
  });

  it("drops a discarded entry plus the speculative chain built on it", () => {
    const h = makeHarness();
    connect(h, "ab");
    h.client.edit([{ from: 1, to: 1, insert: "X" }]);
    h.clock.advance(100);
    h.client.edit([{ from: 2, to: 2, insert: "Y" }]);
    h.clock.advance(100);
    const [first] = pushes(h)[0];
    h.client.handleFrame({
      type: "discard",
      updateToken: roomTextUpdateToken("c1", first.requestId),
      code: "INVALID_CHANGE",
      retryable: false,
    });
    expect(h.log.discards).toEqual([{ requestId: first.requestId, code: "INVALID_CHANGE", retryable: false }]);
    expect(h.log.orphaned).toEqual([[{ from: 2, to: 2, insert: "Y" }]]);
    expect(h.client.outboxSize()).toBe(0);
    expect(h.client.localText()).toBe("ab");
  });

  it("ignores duplicate broadcasts and resyncs on a revision gap", () => {
    const h = makeHarness();
    connect(h, "ab", 3);
    h.client.handleFrame(broadcast(3, "other", "r0", [{ from: 0, to: 0, insert: "!" }]));
    expect(h.client.revision()).toBe(3);
    expect(h.client.localText()).toBe("ab");
    // Revision 5 without 4 cannot chain: declare desync and reconnect.
    h.client.handleFrame(broadcast(5, "other", "r5", [{ from: 0, to: 0, insert: "!" }]));
    expect(h.client.state()).toBe("backoff");
  });
});
