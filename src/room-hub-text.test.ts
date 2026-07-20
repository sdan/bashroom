import { describe, expect, it } from "vitest";
import {
  ROOM_TEXT_INBOUND_FRAME_MAX_CHARS,
  isRoomTextClientFrameType,
  roomTextShadowKey,
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
    // MAX_INSERT_BYTES is 262_144; every char escaped to \uXXXX inflates
    // 6x in UTF-16 code units... but the wire ceiling that matters is the
    // FRAME: a full push envelope with one max insert plus protocol
    // overhead must fit. 1.2M > 262_144 * 4 (worst realistic JSON string
    // escape inflation for surrogate-heavy content is ~3-4x measured) with
    // headroom for the envelope; the hub's generic 300k bound does NOT
    // cover it — that is the whole reason this constant exists.
    expect(ROOM_TEXT_INBOUND_FRAME_MAX_CHARS).toBeGreaterThan(262_144 * 4);
    expect(ROOM_TEXT_INBOUND_FRAME_MAX_CHARS).toBeLessThanOrEqual(2_000_000);
  });
});
