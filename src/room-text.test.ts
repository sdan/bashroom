import { describe, expect, it } from "vitest";
import {
  RoomTextError,
  applyRoomTextChange,
  changeSetFromWire,
  changeSetToWire,
  decodeRoomText,
  encodeRoomText,
  mapRoomTextAnchors,
  rebaseRoomTextChange,
  replayRoomText,
  roomTextByteLength,
  roomTextContentDigest,
  roomTextDigestOfString,
  roomTextFromString,
  roomTextHashedLeaves,
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

  it("maps comment anchors across insert-before, insert-inside, and insert-after", () => {
    // "hello world notes" with an anchor on "world" [6, 11).
    const anchor = { id: "c1", start: 6, end: 11 };
    const docLength = "hello world notes".length;

    const before = changeSetFromWire([{ from: 0, to: 0, insert: ">> " }], docLength);
    expect(mapRoomTextAnchors(before, [anchor])).toEqual([{ id: "c1", start: 9, end: 14 }]);

    const inside = changeSetFromWire([{ from: 8, to: 8, insert: "XX" }], docLength);
    expect(mapRoomTextAnchors(inside, [anchor])).toEqual([{ id: "c1", start: 6, end: 13 }]);

    const after = changeSetFromWire([{ from: 12, to: 12, insert: "more " }], docLength);
    expect(mapRoomTextAnchors(after, [anchor])).toEqual([{ id: "c1", start: 6, end: 11 }]);
  });

  it("absorbs typing at anchor edges: assoc -1 start, assoc +1 end", () => {
    const anchor = { id: "c1", start: 6, end: 11 };
    const docLength = "hello world notes".length;

    // Insert exactly at the start: the start stays put (assoc -1), so the
    // typed text lands inside the anchored range.
    const atStart = changeSetFromWire([{ from: 6, to: 6, insert: "aa" }], docLength);
    expect(mapRoomTextAnchors(atStart, [anchor])).toEqual([{ id: "c1", start: 6, end: 13 }]);

    // Insert exactly at the end: the end moves past it (assoc +1).
    const atEnd = changeSetFromWire([{ from: 11, to: 11, insert: "bb" }], docLength);
    expect(mapRoomTextAnchors(atEnd, [anchor])).toEqual([{ id: "c1", start: 6, end: 13 }]);
  });

  it("collapses an anchor whose text a deletion removed, and clamps stale offsets", () => {
    const anchor = { id: "c1", start: 6, end: 11 };
    const docLength = "hello world notes".length;

    const deletion = changeSetFromWire([{ from: 5, to: 12, insert: "" }], docLength);
    const collapsed = mapRoomTextAnchors(deletion, [anchor]);
    expect(collapsed).toEqual([{ id: "c1", start: 5, end: 5 }]);

    // Anchors are advisory observer state: out-of-range offsets clamp to the
    // document instead of failing an already committed update.
    const stale = mapRoomTextAnchors(deletion, [{ id: "c2", start: 500, end: 900 }]);
    expect(stale).toEqual([{ id: "c2", start: 10, end: 10 }]);
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

describe("RoomText content digest", () => {
  // Large enough to clear the 32 KB size gate onto the incremental path.
  const bigContent = Array.from({ length: 1_500 }, (_, line) => `line ${line} ${"x".repeat(40)}`).join("\n");

  it("gates on size but both paths agree with the from-scratch string hash", () => {
    for (const content of ["", "alpha\r\nbeta\n", "🙂 family 👩‍👩‍👧‍👦\n", bigContent]) {
      const doc = roomTextFromString(content);
      expect(roomTextContentDigest(doc, roomTextByteLength(doc))).toBe(roomTextDigestOfString(content));
    }
  });

  it("is structure-independent: differently shaped trees with equal content hash equally", () => {
    // Shape A: one balanced build from the full string. Shape B: grown by
    // appending chunks, so its rope carries a different node layout.
    const shaped = roomTextFromString(bigContent);
    let grown = roomTextFromString("");
    let byteLength = 0;
    for (let offset = 0; offset < bigContent.length; offset += 5_000) {
      const chunk = bigContent.slice(offset, offset + 5_000);
      const applied = applyRoomTextChange(
        grown,
        changeSetFromWire([{ from: grown.length, to: grown.length, insert: chunk }], grown.length),
        byteLength,
      );
      grown = applied.doc;
      byteLength = applied.byteLength;
    }
    expect(grown.toString()).toBe(bigContent);
    expect(roomTextContentDigest(grown, byteLength))
      .toBe(roomTextContentDigest(shaped, roomTextByteLength(shaped)));
  });

  it("folds length into the digest so NUL-prefixed strings cannot collide", () => {
    // A bare polynomial hashes "\0a" and "a" identically (leading zeros
    // vanish); the length suffix keeps the digests distinct.
    expect(roomTextDigestOfString("\0a")).not.toBe(roomTextDigestOfString("a"));
    expect(roomTextDigestOfString("\0")).not.toBe(roomTextDigestOfString("\0\0"));
  });

  it("rehashes the dirty spine on an edit, not the whole document", () => {
    const doc = roomTextFromString(bigContent);
    const before = roomTextHashedLeaves();
    roomTextContentDigest(doc, roomTextByteLength(doc));
    const fullHash = roomTextHashedLeaves() - before;
    expect(fullHash).toBeGreaterThan(16);

    // Same tree again: every node digest is already cached.
    roomTextContentDigest(doc, roomTextByteLength(doc));
    expect(roomTextHashedLeaves() - before).toBe(fullHash);

    // One small edit dirties a single leaf spine.
    const applied = applyRoomTextChange(
      doc,
      changeSetFromWire([{ from: 10, to: 10, insert: "!" }], doc.length),
      roomTextByteLength(doc),
    );
    const beforeEdit = roomTextHashedLeaves();
    roomTextContentDigest(applied.doc, applied.byteLength);
    const editHash = roomTextHashedLeaves() - beforeEdit;
    expect(editHash).toBeGreaterThan(0);
    expect(editHash * 8).toBeLessThan(fullHash);
  });
});

