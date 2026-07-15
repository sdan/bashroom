import { describe, expect, it } from "vitest";
import {
  RoomTextError,
  applyRoomTextChange,
  changeSetFromWire,
  changeSetToWire,
  decodeRoomText,
  encodeRoomText,
  rebaseRoomTextChange,
  replayRoomText,
  roomTextByteLength,
  roomTextFromString,
} from "./room-text";

function expectCode(run: () => unknown, code: RoomTextError["code"]): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RoomTextError);
    expect((error as RoomTextError).code).toBe(code);
  }
}

describe("RoomText exact byte boundaries", () => {
  it.each([
    ["empty", ""],
    ["no final newline", "alpha"],
    ["final newline", "alpha\n"],
    ["CRLF and mixed endings", "one\r\ntwo\nthree\rfour\r\n"],
    ["whitespace", "\tleading\ntrailing  \n"],
    ["Unicode", "🙂 family 👩‍👩‍👧‍👦 e\u0301 é\n"],
    ["BOM", "\ufeff# title\n"],
  ])("round-trips %s without normalization", (_name, content) => {
    const original = new TextEncoder().encode(content);
    const roundTrip = encodeRoomText(decodeRoomText(original));
    expect([...roundTrip]).toEqual([...original]);
  });

  it("rejects malformed UTF-8 rather than inserting replacement characters", () => {
    expectCode(() => decodeRoomText(new Uint8Array([0xc3, 0x28])), "INVALID_UTF8");
  });

  it("rejects lone surrogate inserts and edits that split an emoji", () => {
    const doc = roomTextFromString("a🙂b");
    expectCode(
      () => changeSetFromWire([{ from: 1, to: 1, insert: "\ud800" }], doc.length),
      "INVALID_UNICODE",
    );
    const split = changeSetFromWire([{ from: 2, to: 2, insert: "x" }], doc.length);
    expectCode(() => applyRoomTextChange(doc, split, roomTextByteLength(doc)), "INVALID_CHANGE");
  });
});

describe("RoomText changes", () => {
  it("applies multi-range replacements and tracks UTF-8 bytes", () => {
    const before = roomTextFromString("hello 🙂 world");
    const changes = changeSetFromWire([
      { from: 0, to: 5, insert: "hi" },
      { from: 9, to: 14, insert: "世界" },
    ], before.length);
    const applied = applyRoomTextChange(before, changes, roomTextByteLength(before));

    expect(applied.doc.toString()).toBe("hi 🙂 世界");
    expect(applied.byteLength).toBe(new TextEncoder().encode("hi 🙂 世界").byteLength);
    expect(changeSetToWire(changes)).toEqual([
      { from: 0, to: 5, insert: "hi" },
      { from: 9, to: 14, insert: "世界" },
    ]);
  });

  it("rejects malformed ranges and results over the configured byte cap", () => {
    expectCode(
      () => changeSetFromWire([
        { from: 2, to: 4, insert: "x" },
        { from: 3, to: 3, insert: "y" },
      ], 5),
      "INVALID_CHANGE",
    );
    const doc = roomTextFromString("abc");
    const grow = changeSetFromWire([{ from: 3, to: 3, insert: "🙂" }], doc.length);
    expectCode(() => applyRoomTextChange(doc, grow, 3, 6), "DOCUMENT_TOO_LARGE");
  });

  it("rebases a stale insertion over an already accepted insertion", () => {
    const base = roomTextFromString("ab");
    const first = changeSetFromWire([{ from: 1, to: 1, insert: "X" }], base.length);
    const stale = changeSetFromWire([{ from: 1, to: 1, insert: "Y" }], base.length);
    const current = applyRoomTextChange(base, first, 2);
    const rebased = rebaseRoomTextChange(stale, "client-b/request-1", [
      { updateToken: "client-a/request-1", changes: first },
    ]);
    const final = applyRoomTextChange(current.doc, rebased, current.byteLength);

    expect(final.doc.toString()).toBe("aXYb");
    expect(rebased.length).toBe(current.doc.length);
  });

  it("replays a contiguous tail and rejects a missing revision", () => {
    const snapshot = roomTextFromString("a");
    const first = changeSetFromWire([{ from: 1, to: 1, insert: "b" }], 1);
    const second = changeSetFromWire([{ from: 2, to: 2, insert: "c" }], 2);
    const recovered = replayRoomText(snapshot, 7, [
      { revision: 8, updateToken: "a/1", changes: first },
      { revision: 9, updateToken: "a/2", changes: second },
    ]);
    expect(recovered).toMatchObject({ revision: 9, byteLength: 3 });
    expect(recovered.doc.toString()).toBe("abc");

    expectCode(() => replayRoomText(snapshot, 7, [
      { revision: 9, updateToken: "a/2", changes: second },
    ]), "STORAGE_CORRUPT");
  });
});

