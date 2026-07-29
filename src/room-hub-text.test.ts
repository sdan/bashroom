// @ts-expect-error -- node builtin without @types/node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ROOM_TEXT_INBOUND_FRAME_MAX_CHARS,
  RoomHubText,
  isRoomTextClientFrameType,
  listRoomTextHistoryArtifacts,
  parseRoomTextHistoryIdentity,
  parseRoomTextVersionToken,
  readRoomTextHistoryArtifact,
  roomTextHistoryArtifactKey,
  roomTextHistorySource,
  roomTextShadowKey,
  roomTextVersionToken,
} from "./room-hub-text";

type SqlRow = Record<string, unknown>;

function durableObjectHarness(): DurableObjectState {
  const db = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  const mapBinding = (value: unknown) => value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const cursor = (rows: SqlRow[], rowsWritten: number) => ({
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
    rowsWritten,
  });
  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const body = query.trim().replace(/;\s*$/, "");
        if (bindings.length === 0 && body.includes(";")) {
          db.exec(query);
          return cursor([], 0);
        }
        const rows = db.prepare(query).all(...bindings.map(mapBinding)) as SqlRow[];
        const changes = (db.prepare("SELECT changes() AS n").get() as { n: number }).n;
        return cursor(rows, changes);
      },
    },
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
    async put(key: string, value: unknown) { kv.set(key, value); },
    async get<T>(key: string) { return kv.get(key) as T | undefined; },
    async list<T>({ prefix = "" }: { prefix?: string } = {}) {
      return new Map([...kv].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
    },
    async getAlarm() { return alarm; },
    async setAlarm(value: number) { alarm = value; },
  };
  return {
    storage,
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
}

class MemoryR2 {
  private readonly objects = new Map<string, {
    bytes: Uint8Array;
    etag: string;
    uploaded: Date;
    customMetadata: Record<string, string>;
    httpMetadata: R2HTTPMetadata;
  }>();
  private generation = 0;

  async head(key: string): Promise<R2Object | null> {
    const object = this.objects.get(key);
    return object ? this.metadata(key, object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const metadata = this.metadata(key, object);
    return {
      ...metadata,
      body: null,
      bodyUsed: false,
      arrayBuffer: async () => object.bytes.buffer.slice(
        object.bytes.byteOffset,
        object.bytes.byteOffset + object.bytes.byteLength,
      ) as ArrayBuffer,
      text: async () => new TextDecoder().decode(object.bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(object.bytes)) as T,
      blob: async () => new Blob([object.bytes]),
      writeHttpMetadata() {},
    } as unknown as R2ObjectBody;
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options: R2PutOptions = {}): Promise<R2Object | null> {
    const current = this.objects.get(key);
    const conditional = options.onlyIf;
    if (conditional instanceof Headers) {
      if (conditional.get("If-None-Match") === "*" && current) return null;
    } else if (conditional?.etagMatches && current?.etag !== conditional.etagMatches) {
      return null;
    }
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const object = {
      bytes: new Uint8Array(bytes),
      etag: `etag-${++this.generation}`,
      uploaded: new Date(1_700_000_000_000 + this.generation),
      customMetadata: options.customMetadata || {},
      httpMetadata: options.httpMetadata instanceof Headers ? {} : options.httpMetadata || {},
    };
    this.objects.set(key, object);
    return this.metadata(key, object);
  }

  private metadata(key: string, object: {
    bytes: Uint8Array;
    etag: string;
    uploaded: Date;
    customMetadata: Record<string, string>;
    httpMetadata: R2HTTPMetadata;
  }): R2Object {
    return {
      key,
      version: object.etag,
      size: object.bytes.byteLength,
      etag: object.etag,
      httpEtag: `\"${object.etag}\"`,
      uploaded: object.uploaded,
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
      checksums: {} as R2Checksums,
      storageClass: "Standard",
      writeHttpMetadata() {},
    } as R2Object;
  }
}

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

describe("RoomText checkpoint history", () => {
  const uploaded = new Date("2026-07-28T16:30:00.000Z");

  it("parses exact artifact identities and product provenance", () => {
    expect(parseRoomTextHistoryIdentity("3@41")).toEqual({ epoch: 3, revision: 41 });
    for (const invalid of ["HEAD", "0@1", "1@-1", "1@01", "1@2/extra", "x@y"]) {
      expect(parseRoomTextHistoryIdentity(invalid)).toBeNull();
    }
    expect(roomTextHistorySource("web:user-1")).toBe("web");
    expect(roomTextHistorySource("mcp:user-1")).toBe("mcp");
    expect(roomTextHistorySource("socket:abc")).toBe("unknown");
  });

  it("sorts R2's lexical listing numerically and ignores HEAD", async () => {
    const prefix = "roomtext-shadow/users/u1/notes/.history/readme.md/";
    const listed = (suffix: string, customMetadata: Record<string, string> = {}) => ({
      key: `${prefix}${suffix}`,
      size: 100,
      etag: suffix,
      httpEtag: `\"${suffix}\"`,
      uploaded,
      customMetadata,
    });
    const r2 = {
      async list() {
        // Deliberately mirrors R2 lexical order, not timeline order.
        return {
          objects: [
            listed("1@10", { "br-history-client": "mcp:u1", "br-history-source": "mcp", "br-history-size": "12" }),
            listed("1@2", { "br-history-client": "web:u1", "br-history-size": "4" }),
            listed("1@1"), // old artifact, before provenance metadata shipped
            listed("HEAD"),
          ],
          truncated: false,
          delimitedPrefixes: [],
        };
      },
    } as unknown as R2Bucket;

    const result = await listRoomTextHistoryArtifacts(r2, "u1", "notes", "readme.md");
    expect(result).toEqual({
      ok: true,
      versions: [
        expect.objectContaining({ epoch: 1, revision: 10, version: "rt1:1:10", source: "mcp", size_bytes: 12 }),
        expect.objectContaining({ epoch: 1, revision: 2, version: "rt1:1:2", source: "web", size_bytes: 4 }),
        expect.objectContaining({ epoch: 1, revision: 1, version: "rt1:1:1", source: "unknown", size_bytes: null }),
      ],
    });
  });

  it("reads an exact immutable snapshot and falls back to body provenance", async () => {
    const expectedKey = roomTextHistoryArtifactKey("u1", "notes", "readme.md", 1, 7);
    let requested = "";
    const content = "# old\n\ncheckpoint 🙂\n";
    const bytes = new TextEncoder().encode(content);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const r2 = {
      async get(key: string) {
        requested = key;
        return {
          uploaded,
          customMetadata: {},
          async text() {
            return JSON.stringify({
              fileId: "readme.md",
              path: "readme.md",
              epoch: 1,
              revision: 7,
              snapshot_b64: btoa(binary),
              composed_changes_json: JSON.stringify([
                { revision: 7, clientId: "mcp:u1", requestId: "r7", changes: [] },
              ]),
            });
          },
        };
      },
    } as unknown as R2Bucket;

    const result = await readRoomTextHistoryArtifact(r2, "u1", "notes", "readme.md", 1, 7);
    expect(requested).toBe(expectedKey);
    expect(result).toEqual({
      ok: true,
      artifact: expect.objectContaining({
        epoch: 1,
        revision: 7,
        version: "rt1:1:7",
        content,
        source: "mcp",
        client_id: "mcp:u1",
        size_bytes: bytes.byteLength,
      }),
    });
  });

  it("fails closed on an identity mismatch or malformed historical UTF-8", async () => {
    const body = (overrides: Record<string, unknown>) => JSON.stringify({
      fileId: "readme.md",
      path: "readme.md",
      epoch: 1,
      revision: 7,
      snapshot_b64: btoa("ok"),
      composed_changes_json: "[]",
      ...overrides,
    });
    const withBody = (value: string) => ({
      async get() {
        return { uploaded, customMetadata: {}, async text() { return value; } };
      },
    }) as unknown as R2Bucket;

    await expect(readRoomTextHistoryArtifact(
      withBody(body({ path: "private.md" })), "u1", "notes", "readme.md", 1, 7,
    )).resolves.toEqual({ ok: false, error: "INVALID_ARTIFACT" });
    await expect(readRoomTextHistoryArtifact(
      withBody(body({ snapshot_b64: "wyg=" })), "u1", "notes", "readme.md", 1, 7,
    )).resolves.toEqual({ ok: false, error: "INVALID_ARTIFACT" });
  });

  it("marks a coalesced human-and-agent checkpoint as mixed, never the latest writer", async () => {
    const r2 = {
      async get() {
        return {
          uploaded,
          customMetadata: {},
          async text() {
            return JSON.stringify({
              fileId: "readme.md",
              path: "readme.md",
              epoch: 1,
              revision: 2,
              snapshot_b64: btoa("two writers"),
              composed_changes_json: JSON.stringify([
                { revision: 1, clientId: "web:u1", requestId: "human", changes: [] },
                { revision: 2, clientId: "mcp:u1", requestId: "agent", changes: [] },
              ]),
            });
          },
        };
      },
    } as unknown as R2Bucket;
    await expect(readRoomTextHistoryArtifact(r2, "u1", "notes", "readme.md", 1, 2)).resolves.toMatchObject({
      ok: true,
      artifact: { source: "mixed", client_id: "" },
    });
  });

  it("attributes new artifacts only to edits since the previous published checkpoint", async () => {
    const ctx = durableObjectHarness();
    const r2 = new MemoryR2();
    const key = "users/u1/notes/readme.md";
    const source = new TextEncoder().encode("initial");
    const seeded = await r2.put(key, source, { httpMetadata: { contentType: "text/markdown" } });
    expect(seeded).not.toBeNull();
    const host = new RoomHubText(ctx, r2 as unknown as R2Bucket, () => true);
    const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    await expect(host.importPrimary({
      userId: "u1", room: "notes", path: "readme.md", bytes: sourceBytes, sourceEtag: seeded!.etag,
    })).resolves.toMatchObject({ ok: true, file: { revision: 0 } });
    await expect(host.janitorDrain(), "initial checkpoint flush").resolves.toMatchObject({ ok: true, flushed: 1 });

    const replace = (clientId: string, revision: number, content: string) => host.replacePrimary({
      userId: "u1",
      room: "notes",
      path: "readme.md",
      baseVersion: `rt1:1:${revision}`,
      content,
      clientId,
      requestId: `${clientId}:${revision + 1}`,
      intentHash: String(revision + 1).padStart(64, "0"),
    });

    const webReplacement = await replace("web:u1", 0, "human checkpoint");
    expect(webReplacement.ok, `web replacement: ${JSON.stringify(webReplacement)}`).toBe(true);
    await expect(host.janitorDrain(), "web checkpoint flush").resolves.toMatchObject({ ok: true, flushed: 1 });
    await expect(readRoomTextHistoryArtifact(r2 as unknown as R2Bucket, "u1", "notes", "readme.md", 1, 1))
      .resolves.toMatchObject({ ok: true, artifact: { source: "web", client_id: "web:u1" } });

    await expect(replace("mcp:u1", 1, "agent checkpoint"), "agent replacement").resolves.toMatchObject({ ok: true });
    await expect(host.janitorDrain(), "agent checkpoint flush").resolves.toMatchObject({ ok: true, flushed: 1 });
    await expect(readRoomTextHistoryArtifact(r2 as unknown as R2Bucket, "u1", "notes", "readme.md", 1, 2))
      .resolves.toMatchObject({ ok: true, artifact: { source: "mcp", client_id: "mcp:u1" } });

    await expect(replace("web:u1", 2, "coalesced human edit"), "coalesced web replacement").resolves.toMatchObject({ ok: true });
    await expect(replace("mcp:u1", 3, "coalesced agent edit"), "coalesced agent replacement").resolves.toMatchObject({ ok: true });
    await expect(host.janitorDrain(), "mixed checkpoint flush").resolves.toMatchObject({ ok: true, flushed: 1 });
    await expect(readRoomTextHistoryArtifact(r2 as unknown as R2Bucket, "u1", "notes", "readme.md", 1, 4))
      .resolves.toMatchObject({ ok: true, artifact: { source: "mixed", client_id: "" } });
  });

  it("allows an empty document checkpoint", async () => {
    const r2 = {
      async get() {
        return {
          uploaded,
          customMetadata: {},
          async text() {
            return JSON.stringify({
              fileId: "empty.md",
              path: "empty.md",
              epoch: 1,
              revision: 0,
              snapshot_b64: "",
              composed_changes_json: "[]",
            });
          },
        };
      },
    } as unknown as R2Bucket;
    await expect(readRoomTextHistoryArtifact(r2, "u1", "notes", "empty.md", 1, 0)).resolves.toMatchObject({
      ok: true,
      artifact: { content: "", size_bytes: 0 },
    });
  });
});

describe("RoomText restore retry", () => {
  it("returns the original accepted revision before checking the now-stale CAS base", async () => {
    const ctx = durableObjectHarness();
    const r2 = new MemoryR2();
    const key = "users/u1/notes/readme.md";
    const source = new TextEncoder().encode("current");
    const seeded = await r2.put(key, source, { httpMetadata: { contentType: "text/markdown" } });
    expect(seeded).not.toBeNull();
    const host = new RoomHubText(ctx, r2 as unknown as R2Bucket, () => true);
    const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    const imported = await host.importPrimary({
      userId: "u1",
      room: "notes",
      path: "readme.md",
      bytes: sourceBytes,
      sourceEtag: seeded!.etag,
    });
    expect(imported).toMatchObject({ ok: true, file: { revision: 0, content: "current" } });

    const restore = {
      userId: "u1",
      room: "notes",
      path: "readme.md",
      baseVersion: "rt1:1:0",
      content: "historical",
      clientId: "web:u1",
      requestId: "restore:1@7:rt1:1:0",
      intentHash: "restore-intent-1",
    };
    const accepted = await host.replacePrimary(restore);
    expect(accepted).toMatchObject({ ok: true, replayed: false, file: { revision: 1, content: "historical" } });

    // The document is now revision 1, so baseVersion revision 0 is stale.
    // Same request identity must replay before CAS and return revision 1.
    const retried = await host.replacePrimary(restore);
    expect(retried).toMatchObject({ ok: true, replayed: true, file: { revision: 1, content: "historical" } });

    // A genuinely new request with the same stale base is still rejected.
    const stale = await host.replacePrimary({
      ...restore,
      requestId: "new-restore-request",
      intentHash: "new-restore-intent",
    });
    expect(stale).toMatchObject({ ok: false, error: "CONFLICT", file: { revision: 1 } });
  });
});
