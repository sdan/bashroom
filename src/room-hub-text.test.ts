import { describe, expect, it } from "vitest";
import {
  ROOM_TEXT_INBOUND_FRAME_MAX_CHARS,
  RoomHubText,
  isRoomTextClientFrameType,
  parseRoomTextVersionToken,
  roomTextShadowKey,
  roomTextVersionToken,
} from "./room-hub-text";

// The dark-mount isolation invariant: every key the shadow janitor can
// possibly build lives under roomtext-shadow/, a SIBLING of the production
// users/ prefix, so production readers (which scope to users/...) are blind
// to it and the janitor is structurally incapable of touching a real file.
describe("roomTextShadowKey", () => {
  it("always starts with the shadow prefix, never users/", () => {
    const key = roomTextShadowKey("u1", "notes", ".history/readme.md/HEAD");
    expect(key.startsWith("roomtext-shadow/")).toBe(true);
    expect(key.startsWith("users/")).toBe(false);
  });

  it("hostile path segments cannot escape the prefix (R2 keys are flat)", () => {
    // "../" has no meaning in an object key — nothing normalizes it. The
    // key stays under roomtext-shadow/ byte-for-byte, however hostile the
    // fileId, so a users/-prefixed key is unreachable from this builder.
    for (const hostile of [
      "../../../users/u1/notes/readme.md",
      "..%2f..%2fusers/x",
      "/users/absolute-looking",
      ".history/../../../../users/u1/notes/x",
    ]) {
      const key = roomTextShadowKey("u1", "notes", hostile);
      expect(key.startsWith("roomtext-shadow/users/u1/notes/")).toBe(true);
    }
  });
});

describe("isRoomTextClientFrameType", () => {
  it("routes exactly the engine's client frames", () => {
    expect(isRoomTextClientFrameType("connect")).toBe(true);
    expect(isRoomTextClientFrameType("push")).toBe(true);
    expect(isRoomTextClientFrameType("ping")).toBe(true);
  });

  it("never captures the hub's existing frame namespace", () => {
    // The hub owns draft (inbound) and hello/viewers/write/comment
    // (outbound). Draft is the only other INBOUND type today; the rest are
    // asserted anyway so a future rename collision fails loudly here.
    for (const hub of ["draft", "hello", "viewers", "write", "comment", "pong", "", undefined, 7]) {
      expect(isRoomTextClientFrameType(hub as unknown as string)).toBe(false);
    }
  });
});

describe("inbound frame bound", () => {
  it("covers worst-case JSON escaping of a maximum insert", () => {
    // U+0001 is one UTF-8 byte but JSON emits six characters (\\u0001).
    // Build the real one-push envelope so a legal paste can never be silently
    // dropped before the store gets a chance to validate it.
    const frame = JSON.stringify({
      type: "push",
      pushes: [{
        protocol: 1,
        fileId: "notes.md",
        epoch: 1,
        baseRevision: 0,
        clientId: "client-a",
        requestId: "request-a",
        changes: [{ from: 0, to: 0, insert: "\u0001".repeat(262_144) }],
      }],
    });
    expect(ROOM_TEXT_INBOUND_FRAME_MAX_CHARS).toBeGreaterThan(frame.length);
    expect(ROOM_TEXT_INBOUND_FRAME_MAX_CHARS).toBeLessThanOrEqual(2_000_000);
  });
});

describe("migration freeze", () => {
  it("rejects socket pushes before the store or R2 is touched", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const socket = {
      send(value: string) { sent.push(JSON.parse(value)); },
    } as unknown as WebSocket;
    const host = new RoomHubText(
      {} as DurableObjectState,
      {} as R2Bucket,
      () => true,
    );
    await host.handleFrame(socket, {
      type: "push",
      pushes: [{
        protocol: 1,
        fileId: "notes.md",
        epoch: 1,
        baseRevision: 0,
        clientId: "client-a",
        requestId: "request-a",
        changes: [{ from: 0, to: 0, insert: "blocked" }],
      }],
    }, { allowPush: false });
    expect(sent).toEqual([expect.objectContaining({
      type: "discard",
      code: "INVALID_REQUEST",
      retryable: false,
    })]);
  });
});

describe("RoomText version tokens", () => {
  it("round-trips only safe epoch/revision pairs", () => {
    expect(roomTextVersionToken(3, 41)).toBe("rt1:3:41");
    expect(parseRoomTextVersionToken("rt1:3:41")).toEqual({ epoch: 3, revision: 41 });
    for (const invalid of ["", "rt1:0:1", "rt1:1:-1", "rt2:1:1", "rt1:1:01", "etag"] ) {
      expect(parseRoomTextVersionToken(invalid)).toBeNull();
    }
  });
});
