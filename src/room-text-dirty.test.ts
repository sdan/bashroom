// Vitest runs on Node; node:sqlite's synchronous DatabaseSync stands in for
// the DO's SQLite so the REAL RoomTextStore runs unmodified. The shim
// implements exactly the DurableObjectStorage surface the store touches:
// sql.exec(query, ...bindings) -> { toArray, one, rowsWritten } and
// transactionSync. Durability tests reuse one shim across store instances.
// @ts-expect-error -- node builtin without @types/node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ROOM_TEXT_PROTOCOL,
  RoomTextStore,
  type PushRoomTextInput,
} from "./room-text-store";
import { encodeRoomText, roomTextFromString } from "./room-text";

type Row = Record<string, unknown>;

/** Minimal DurableObjectStorage stand-in over node:sqlite (in-memory). */
function testStorage(): DurableObjectStorage {
  const db = new DatabaseSync(":memory:");
  const mapBinding = (value: unknown) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const cursor = (rows: Row[], rowsWritten: number) => ({
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
    rowsWritten,
  });
  const exec = (query: string, ...bindings: unknown[]) => {
    // Multi-statement scripts (schema setup) cannot be prepared; run them
    // through exec(). Single statements prepare + all(), which executes DML
    // too and surfaces RETURNING rows.
    const body = query.trim().replace(/;\s*$/, "");
    if (bindings.length === 0 && body.includes(";")) {
      db.exec(query);
      return cursor([], 0);
    }
    const rows = db.prepare(query).all(...bindings.map(mapBinding)) as Row[];
    const changes = (db.prepare("SELECT changes() AS n").get() as { n: number }).n;
    return cursor(rows, changes);
  };
  const storage = {
    sql: { exec },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return storage as unknown as DurableObjectStorage;
}

function createFile(store: RoomTextStore, fileId: string, path: string, content: string): void {
  const created = store.createText({
    fileId,
    path,
    bytes: encodeRoomText(roomTextFromString(content)),
  });
  expect(created.ok).toBe(true);
}

function push(
  fileId: string,
  baseRevision: number,
  requestId: string,
  insert: string,
): PushRoomTextInput {
  return {
    protocol: ROOM_TEXT_PROTOCOL,
    fileId,
    epoch: 1,
    baseRevision,
    clientId: "client-a",
    requestId,
    changes: [{ from: 0, to: 0, insert }],
  };
}

describe("room-text durable dirty-set", () => {
  it("marks on create and advances the mark on push", () => {
    const store = new RoomTextStore(testStorage());
    createFile(store, "f1", "notes.md", "hello");

    // createText itself is a head mutation the janitor must publish.
    expect(store.dirtyFiles(10)).toMatchObject([{ fileId: "f1", epoch: 1, revision: 0 }]);

    const pushed = store.pushText(push("f1", 0, "req-1", "x"));
    expect(pushed.ok).toBe(true);
    const dirty = store.dirtyFiles(10);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({ fileId: "f1", epoch: 1, revision: 1 });
  });

  it("keeps one row per file across a multi-push batch (the scalar-pointer lab bug)", () => {
    const store = new RoomTextStore(testStorage());
    createFile(store, "f1", "a.md", "one");
    createFile(store, "f2", "b.md", "two");
    createFile(store, "f3", "c.md", "three");
    expect(store.clearDirty("f1", 0)).toBe(1);
    expect(store.clearDirty("f2", 0)).toBe(1);
    expect(store.clearDirty("f3", 0)).toBe(1);

    // One batch touching three files, one of them twice: the dirty SET holds
    // every touched file (the scalar janitor target dropped 2/3 of these),
    // and the twice-pushed file collapses to ONE row at its final revision.
    const results = store.pushTextBatch([
      push("f1", 0, "req-b1", "x"),
      push("f2", 0, "req-b2", "y"),
      push("f3", 0, "req-b3", "z"),
      push("f1", 1, "req-b4", "w"),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    const dirty = store.dirtyFiles(10);
    expect(dirty).toHaveLength(3);
    expect(dirty.map((entry) => entry.fileId).sort()).toEqual(["f1", "f2", "f3"]);
    expect(dirty.find((entry) => entry.fileId === "f1")).toMatchObject({ revision: 2 });
  });

  it("clearDirty respects a newer mark: flushing rev N never retires a rev N+1 mark", () => {
    const store = new RoomTextStore(testStorage());
    createFile(store, "f1", "notes.md", "hello");
    expect(store.pushText(push("f1", 0, "req-1", "x")).ok).toBe(true);

    // Janitor read the mark at revision 1, then an edit landed at revision 2
    // mid-flush. Clearing at the published revision (1) must leave the newer
    // mark in place or the second edit would silently never publish.
    expect(store.pushText(push("f1", 1, "req-2", "y")).ok).toBe(true);
    expect(store.clearDirty("f1", 1)).toBe(0);
    expect(store.dirtyFiles(10)).toMatchObject([{ fileId: "f1", revision: 2 }]);

    expect(store.clearDirty("f1", 2)).toBe(1);
    expect(store.dirtyFiles(10)).toEqual([]);
  });

  it("does not re-mark on an idempotent replay", () => {
    const store = new RoomTextStore(testStorage());
    createFile(store, "f1", "notes.md", "hello");
    expect(store.pushText(push("f1", 0, "req-1", "x")).ok).toBe(true);
    expect(store.clearDirty("f1", 1)).toBe(1);

    // Same (clientId, requestId): the store answers from its idempotency row
    // without a head mutation, so no new dirty mark may appear.
    const replay = store.pushText(push("f1", 0, "req-1", "x"));
    expect(replay.ok).toBe(true);
    expect(store.dirtyFiles(10)).toEqual([]);
  });

  it("drains FIFO by first mark and preserves order across re-marks", () => {
    const store = new RoomTextStore(testStorage());
    createFile(store, "f1", "a.md", "one");
    createFile(store, "f2", "b.md", "two");

    // Re-marking f1 (a newer push) must not move it behind f2: marked_at
    // keeps its original mint so a constantly-edited file cannot starve.
    expect(store.pushText(push("f1", 0, "req-1", "x")).ok).toBe(true);
    expect(store.dirtyFiles(10).map((entry) => entry.fileId)).toEqual(["f1", "f2"]);
    expect(store.dirtyFiles(1).map((entry) => entry.fileId)).toEqual(["f1"]);
  });

  it("marks survive across store instances over the same storage (durable)", () => {
    const storage = testStorage();
    const first = new RoomTextStore(storage);
    createFile(first, "f1", "notes.md", "hello");
    expect(first.pushText(push("f1", 0, "req-1", "x")).ok).toBe(true);

    // A fresh instance (hibernation / eviction) sees the same durable set.
    const second = new RoomTextStore(storage);
    expect(second.dirtyFiles(10)).toMatchObject([{ fileId: "f1", epoch: 1, revision: 1 }]);
    expect(second.clearDirty("f1", 1)).toBe(1);
    expect(second.dirtyFiles(10)).toEqual([]);
  });

  it("rejects invalid clearDirty inputs without touching the set", () => {
    const store = new RoomTextStore(testStorage());
    createFile(store, "f1", "notes.md", "hello");
    expect(store.clearDirty("", 0)).toBe(0);
    expect(store.clearDirty("f1", -1)).toBe(0);
    expect(store.clearDirty("f1", 0.5)).toBe(0);
    expect(store.dirtyFiles(10)).toHaveLength(1);
  });
});
