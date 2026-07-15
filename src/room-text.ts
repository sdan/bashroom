import { ChangeSet, Text, type ChangeDesc } from "@codemirror/state";
import { rebaseUpdates } from "@codemirror/collab";

// Keep the first version comfortably below Durable Object SQLite's 2 MB
// per-value/row limit. Larger and non-text files stay on the whole-blob path
// until snapshots are chunked.
export const ROOM_TEXT_MAX_BYTES = 1_000_000;
export const ROOM_TEXT_MAX_CHANGES = 1_000;
export const ROOM_TEXT_MAX_INSERT_BYTES = 262_144;

export type RoomTextErrorCode =
  | "INVALID_UTF8"
  | "INVALID_UNICODE"
  | "INVALID_CHANGE"
  | "TOO_MANY_CHANGES"
  | "INSERT_TOO_LARGE"
  | "REQUEST_TOO_LARGE"
  | "DOCUMENT_TOO_LARGE"
  | "STORAGE_CORRUPT";

export class RoomTextError extends Error {
  constructor(readonly code: RoomTextErrorCode, message: string) {
    super(message);
    this.name = "RoomTextError";
  }
}

/** A transport-level replacement range. Positions are UTF-16 code units. */
export type WireTextChange = {
  from: number;
  to: number;
  insert: string;
};

export type StoredTextUpdate = {
  revision: number;
  updateToken: string;
  changes: ChangeSet;
};

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", {
  fatal: true,
  // TextDecoder normally consumes an initial UTF-8 BOM. Treat it as content
  // so decode -> encode returns the exact input bytes.
  ignoreBOM: true,
});

/** Decode exact UTF-8 bytes without replacement characters or BOM stripping. */
export function decodeRoomText(bytes: ArrayBuffer | ArrayBufferView): Text {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let content: string;
  try {
    content = strictDecoder.decode(view);
  } catch {
    throw new RoomTextError("INVALID_UTF8", "document is not valid UTF-8");
  }
  assertUnicodeScalarString(content);
  return roomTextFromString(content);
}

/** Build CodeMirror's persistent text tree while preserving all line endings. */
export function roomTextFromString(content: string): Text {
  assertUnicodeScalarString(content);
  // CodeMirror stores `\n` as its structural separator. A CR in CRLF remains
  // a literal character, preserving CRLF, CR-only, and mixed-ending files.
  return Text.of(content.split("\n"));
}

/** Materialize exact UTF-8 only at snapshots and external API boundaries. */
export function encodeRoomText(doc: Text): Uint8Array {
  const content = doc.toString();
  assertUnicodeScalarString(content);
  return encoder.encode(content);
}

export function roomTextByteLength(doc: Text): number {
  // Iterate rope chunks instead of materializing + encoding the whole
  // document: no full-string allocation, no Uint8Array allocation.
  let bytes = 0;
  for (let iter = doc.iter(); !iter.next().done;) {
    bytes += utf8Length(iter.value);
  }
  return bytes;
}

export function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RoomTextError("INVALID_UNICODE", "text contains an unpaired high surrogate");
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RoomTextError("INVALID_UNICODE", "text contains an unpaired low surrogate");
    }
  }
}

/**
 * UTF-8 byte length by charCode arithmetic — one pass, zero allocation, and
 * it validates scalar well-formedness in the same loop (throws exactly like
 * assertUnicodeScalarString). Replaces the assert-then-encode pattern on hot
 * paths: TextEncoder.encode allocates a Uint8Array per call just to read
 * .byteLength, which dominated per-edit cost on the trace benchmarks.
 */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RoomTextError("INVALID_UNICODE", "text contains an unpaired high surrogate");
      }
      bytes += 4;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RoomTextError("INVALID_UNICODE", "text contains an unpaired low surrogate");
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Parse and bound the public range format into a CodeMirror ChangeSet. */
export function changeSetFromWire(changes: readonly WireTextChange[], baseLength: number): ChangeSet {
  if (!Number.isSafeInteger(baseLength) || baseLength < 0) {
    throw new RoomTextError("INVALID_CHANGE", "invalid base document length");
  }
  if (!Array.isArray(changes) || changes.length > ROOM_TEXT_MAX_CHANGES) {
    throw new RoomTextError("TOO_MANY_CHANGES", `at most ${ROOM_TEXT_MAX_CHANGES} ranges are allowed`);
  }

  let previousTo = 0;
  let insertedBytes = 0;
  const specs: Array<{ from: number; to: number; insert: string }> = [];
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!change || !Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to)
      || change.from < 0 || change.to < change.from || change.to > baseLength
      || (index > 0 && change.from < previousTo) || typeof change.insert !== "string") {
      throw new RoomTextError("INVALID_CHANGE", `invalid or overlapping change at index ${index}`);
    }
    insertedBytes += utf8Length(change.insert); // validates scalars in the same pass
    if (insertedBytes > ROOM_TEXT_MAX_INSERT_BYTES) {
      throw new RoomTextError("INSERT_TOO_LARGE", `inserted text exceeds ${ROOM_TEXT_MAX_INSERT_BYTES} bytes`);
    }
    specs.push({ from: change.from, to: change.to, insert: change.insert });
    previousTo = change.to;
  }

  try {
    return ChangeSet.of(specs, baseLength, "\n");
  } catch (error) {
    throw new RoomTextError(
      "INVALID_CHANGE",
      error instanceof Error ? error.message : "change set could not be constructed",
    );
  }
}

export function changeSetToWire(changes: ChangeSet): WireTextChange[] {
  const result: WireTextChange[] = [];
  changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
    result.push({ from, to, insert: inserted.toString() });
  }, true);
  return result;
}

/**
 * Move a stale client edit over canonical updates accepted since its base.
 * updateToken must uniquely identify this logical update. It deliberately is
 * not the long-lived actor ID: CodeMirror uses clientID to deduplicate updates.
 */
export function rebaseRoomTextChange(
  changes: ChangeSet,
  updateToken: string,
  over: readonly Pick<StoredTextUpdate, "updateToken" | "changes">[],
): ChangeSet {
  const rebased = rebaseUpdates(
    [{ changes, clientID: updateToken }],
    over.map((update) => ({ changes: update.changes.desc, clientID: update.updateToken })),
  );
  if (rebased.length !== 1) {
    throw new RoomTextError("STORAGE_CORRUPT", "logical update was unexpectedly deduplicated");
  }
  return rebased[0].changes;
}

/**
 * Host-observed positions (comment anchors) in head-document UTF-16 offsets.
 * The store maps these through each accepted update so anchor authority lives
 * with the same ChangeSet that moved the text — no substring guessing.
 */
export type RoomTextAnchor = {
  id: string;
  start: number;
  end: number;
};

/**
 * Map anchors through an accepted canonical ChangeSet. assoc -1 keeps the
 * start before text inserted exactly at it; assoc +1 pushes the end past text
 * inserted exactly at it — typing at either edge stays inside the anchor.
 * A deletion covering the whole span collapses it (start === end); the host
 * treats a collapsed anchor as drifted rather than re-anchoring by substring.
 * Out-of-range inputs are clamped: anchors are advisory observer state and
 * must never fail an already committed update.
 */
export function mapRoomTextAnchors(
  changes: ChangeSet | ChangeDesc,
  anchors: readonly RoomTextAnchor[],
): RoomTextAnchor[] {
  const clamp = (position: number) =>
    Math.max(0, Math.min(Number.isSafeInteger(position) ? position : 0, changes.length));
  return anchors.map((anchor) => {
    const start = changes.mapPos(clamp(anchor.start), -1);
    return {
      id: anchor.id,
      start,
      end: Math.max(start, changes.mapPos(clamp(anchor.end), 1)),
    };
  });
}

/**
 * Apply a canonical change and calculate its UTF-8 delta from changed spans
 * only. This avoids encoding/hashing an otherwise untouched large document.
 */
export function applyRoomTextChange(
  doc: Text,
  changes: ChangeSet,
  currentByteLength: number,
  maxBytes = ROOM_TEXT_MAX_BYTES,
): { doc: Text; byteLength: number; byteDelta: number } {
  if (changes.length !== doc.length) {
    throw new RoomTextError("STORAGE_CORRUPT", "change length does not match current document");
  }

  let deletedBytes = 0;
  let insertedBytes = 0;
  changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
    assertScalarBoundary(doc, from);
    assertScalarBoundary(doc, to);
    deletedBytes += utf8Length(doc.sliceString(from, to));
    insertedBytes += utf8Length(inserted.toString()); // validates scalars in the same pass
  }, true);

  const byteDelta = insertedBytes - deletedBytes;
  const byteLength = currentByteLength + byteDelta;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RoomTextError("STORAGE_CORRUPT", "invalid stored byte length");
  }
  if (byteLength > maxBytes) {
    throw new RoomTextError("DOCUMENT_TOO_LARGE", `document exceeds ${maxBytes} bytes`);
  }
  return { doc: changes.apply(doc), byteLength, byteDelta };
}

/** Rebuild a cold cache and fail closed if the persisted tail is malformed. */
export function replayRoomText(
  snapshot: Text,
  snapshotRevision: number,
  updates: readonly StoredTextUpdate[],
  snapshotByteLength = roomTextByteLength(snapshot),
): { doc: Text; revision: number; byteLength: number } {
  let doc = snapshot;
  let revision = snapshotRevision;
  let byteLength = snapshotByteLength;
  for (const update of updates) {
    if (update.revision !== revision + 1) {
      throw new RoomTextError("STORAGE_CORRUPT", `missing update after revision ${revision}`);
    }
    const applied = applyRoomTextChange(doc, update.changes, byteLength);
    doc = applied.doc;
    byteLength = applied.byteLength;
    revision = update.revision;
  }
  return { doc, revision, byteLength };
}

function assertScalarBoundary(doc: Text, position: number): void {
  if (!Number.isSafeInteger(position) || position < 0 || position > doc.length) {
    throw new RoomTextError("INVALID_CHANGE", "change position is outside the document");
  }
  if (position === 0 || position === doc.length) return;
  const pair = doc.sliceString(position - 1, position + 1);
  const left = pair.charCodeAt(0);
  const right = pair.charCodeAt(1);
  if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) {
    throw new RoomTextError("INVALID_CHANGE", "change position splits a Unicode surrogate pair");
  }
}
