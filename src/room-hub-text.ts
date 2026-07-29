// ─── RoomHubText — the RoomText engine HOST inside the RoomHub DO ─────────
// This module is a HOST, not part of the pure trio: async and I/O are
// allowed here (and deliberately NOT in src/room-text{,-store,-client}.ts,
// whose discipline test forbids them). RoomHub delegates RoomText wire
// frames to this class; presence/draft/hello behavior stays byte-for-byte
// unchanged for sockets that never speak RoomText — the mount is dark.
//
// Wire contract (src/room-text-client.ts): client->server frames are
// connect/push/ping as JSON. The JSON {type:"ping"} is DIFFERENT from the
// raw-string "ping" keepalive answered by setWebSocketAutoResponse without
// waking the DO — the JSON ping MUST wake us and be answered here, because
// that wake is the client's intentional liveness probe of the engine.
import {
  ROOM_TEXT_PROTOCOL,
  RoomTextStore,
  decideRoomTextPublication,
  isRetryableRoomTextFailure,
  parseRoomTextPublication,
  type OpenRoomTextResult,
  type PushRoomTextInput,
  type PushRoomTextSuccess,
  type RoomTextFailure,
  type RoomTextMirrorState,
} from "./room-text-store";
import { ROOM_TEXT_MAX_BYTES, decodeRoomText, roomTextUpdateToken, type RoomTextAnchor } from "./room-text";
import type {
  RoomTextBroadcastUpdate,
  RoomTextClientFrame,
  RoomTextServerFrame,
} from "./room-text-client";

// Dedicated INBOUND size bound for RoomText frames, checked BEFORE the hub's
// generic 300k drop guard: JSON escaping of a legitimate 262_144-byte insert
// (every char escaped to \uXXXX is 6x) can exceed 300k, and a silent drop
// would wedge the client outbox in permanent retry — the outbox resends the
// same frame forever and never hears an ack or a discard. OUTBOUND frames
// are deliberately unbounded (snapshot hydration carries up to ~1MB of
// document); the hub's guard is inbound-only.
// Worst case JSON expands each one-byte control character to six characters
// (`\u0001`). Add room for 1,000 range envelopes and identity fields so every
// update accepted by ROOM_TEXT_MAX_INSERT_BYTES can actually reach the store.
export const ROOM_TEXT_INBOUND_FRAME_MAX_CHARS = 1_750_000;

/** Max pushes handled per inbound frame; the real client sends one. */
export const ROOM_TEXT_MAX_PUSHES_PER_FRAME = 64;

const PRIMARY_AUTHORITY = "roomtext-v1";
const PRIMARY_META_AUTHORITY = "br-authority";
const PRIMARY_META_EPOCH = "br-epoch";
const PRIMARY_META_REVISION = "br-revision";
const PRIMARY_META_SHA256 = "br-sha256";

const HISTORY_META_CLIENT_ID = "br-history-client";
const HISTORY_META_SOURCE = "br-history-source";
const HISTORY_META_SIZE = "br-history-size";
const HISTORY_SCAN_MAX_OBJECTS = 10_000;

const ROOM_TEXT_FRAME_TYPES: ReadonlySet<string> = new Set(["connect", "push", "ping"]);

/** True for the client->server RoomText frame types the host routes. */
export function isRoomTextClientFrameType(type: unknown): type is RoomTextClientFrame["type"] {
  return typeof type === "string" && ROOM_TEXT_FRAME_TYPES.has(type);
}

// The slice of the hub's hibernation attachment this host reads/writes.
// readonly is stamped Worker-side at upgrade time ('0' only for edit-role
// shares and write-scope members); rtFile is the one field this host adds —
// the file the socket bound via a successful connect. Kept to a single short
// string so attachment growth stays minimal.
type RoomTextHostAttachment = Record<string, unknown> & {
  prefix?: string;
  readonly?: boolean;
  rtFile?: string;
};

/**
 * RoomText frame handling for one RoomHub. The store is instantiated lazily
 * on the first frame that needs it, so presence-only rooms never pay for the
 * engine's tables. Prefix visibility is REUSED from the hub (the same
 * predicate broadcast() applies to activity events), so share-scope
 * isolation holds identically for document sync.
 */
export class RoomHubText {
  private store: RoomTextStore | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly r2: R2Bucket,
    private readonly pathVisible: (path: string, prefix: string) => boolean,
  ) {}

  /** Lazy store: presence-only rooms never create the RoomText tables. */
  texts(): RoomTextStore {
    if (!this.store) this.store = new RoomTextStore(this.ctx.storage);
    return this.store;
  }

  /**
   * Claim one exact R2 object for RoomText without transforming its bytes.
   * The same-byte conditional PUT is the migration fence: if R2 moved after
   * the Worker read it, no SQLite state is created and the caller must retry
   * from the new object. A crash after the PUT is recoverable because the R2
   * metadata carries the claimed generation and hash.
   */
  async importPrimary(input: RoomTextPrimaryImportInput): Promise<RoomTextPrimaryResult> {
    try {
      if (!validStorageIdentity(input.userId) || !validStorageIdentity(input.room)
        || !validPrimaryPath(input.path) || typeof input.sourceEtag !== "string"
        || !input.sourceEtag || !(input.bytes instanceof ArrayBuffer)) {
        return { ok: false, error: "INVALID_REQUEST" };
      }
      const key = primaryKey(input.userId, input.room, input.path);
      const source = new Uint8Array(input.bytes);
      const current = await this.r2.head(key);
      if (!current || current.etag !== input.sourceEtag || current.size !== source.byteLength) {
        return { ok: false, error: "SOURCE_MOVED" };
      }
      const sha256 = await sha256Bytes(source);
      const sourceText = decodePrimaryBytes(source);
      const texts = this.texts();
      let opened = texts.openText(input.path);
      if (opened.ok) {
        if (opened.epoch !== 1 || opened.revision !== 0 || opened.content !== sourceText) {
          return {
            ok: false,
            error: "MIGRATION_CONFLICT",
            message: "a different candidate document already occupies this path; neither copy was overwritten",
          };
        }
      } else if (opened.error !== "NOT_FOUND") {
        return primaryStoreFailure(opened);
      }

      const tagged = parsePrimaryMetadata(current.customMetadata);
      let claimed = current;
      if (tagged) {
        if (tagged.epoch !== 1 || tagged.revision !== 0 || tagged.sha256 !== sha256) {
          return { ok: false, error: "MIGRATION_CONFLICT", message: "R2 already carries a different RoomText generation" };
        }
      } else {
        const wrote = await this.r2.put(key, source, {
          onlyIf: { etagMatches: current.etag },
          httpMetadata: current.httpMetadata,
          customMetadata: {
            ...(current.customMetadata || {}),
            ...primaryMetadata(1, 0, sha256),
          },
        });
        if (!wrote) return { ok: false, error: "SOURCE_MOVED" };
        claimed = wrote;
      }

      if (!opened.ok && opened.error === "NOT_FOUND") {
        opened = texts.createText({ fileId: input.path, path: input.path, bytes: source });
      }
      if (!opened.ok) return primaryStoreFailure(opened);
      const mirrored = texts.setMirrorActive({
        fileId: opened.fileId,
        r2Etag: claimed.etag,
        epoch: opened.epoch,
        revision: opened.revision,
        sha256,
        updatedAt: claimed.uploaded.getTime(),
      });
      if (!mirrored.ok) return primaryStoreFailure(mirrored);
      if (!mirrored.mirror) return { ok: false, error: "STORAGE_CORRUPT", message: "mirror row disappeared after attach" };
      await this.ctx.storage.put("rt:room", { userId: input.userId, room: input.room });
      await this.armJanitor();
      return { ok: true, file: primaryFile(opened, mirrored.mirror) };
    } catch (error) {
      return { ok: false, error: "MIGRATION_FAILED", message: errorMessage(error) };
    }
  }

  async openPrimary(input: RoomTextPrimaryOpenInput): Promise<RoomTextPrimaryResult> {
    if (!validStorageIdentity(input.userId) || !validStorageIdentity(input.room)
      || !validPrimaryPath(input.path)) {
      return { ok: false, error: "INVALID_REQUEST" };
    }
    const texts = this.texts();
    const opened = texts.openText(input.path);
    if (!opened.ok) return opened.error === "NOT_FOUND"
      ? { ok: false, error: "NOT_IMPORTED" }
      : primaryStoreFailure(opened);
    const mirrored = texts.mirrorState(opened.fileId);
    if (!mirrored.ok) return primaryStoreFailure(mirrored);
    if (!mirrored.mirror) return { ok: false, error: "NOT_IMPORTED" };
    if (mirrored.mirror.status === "diverged") {
      return {
        ok: false,
        error: "R2_DIVERGED",
        message: "the R2 mirror changed outside RoomText; both copies were preserved and editing is disabled",
      };
    }
    return this.publishPrimary(input.userId, input.room, opened.fileId);
  }

  async replacePrimary(input: RoomTextPrimaryReplaceInput): Promise<RoomTextPrimaryMutationResult> {
    if (!input.intentHash || !input.clientId || !input.requestId || typeof input.content !== "string") {
      return { ok: false, error: "INVALID_REQUEST" };
    }
    const texts = this.texts();
    const replay = texts.replayIntent(input.clientId, input.requestId, input.intentHash);
    if (replay) {
      if (!replay.ok) return primaryStoreFailure(replay);
      const projected = await this.publishPrimary(input.userId, input.room, replay.fileId);
      return projected.ok
        ? { ...projected, replayed: true, update: replay.update, anchors: replay.anchors }
        : projected;
    }
    const current = await this.openPrimary(input);
    if (!current.ok) return current;
    const base = parseRoomTextVersionToken(input.baseVersion);
    if (!base || base.epoch !== current.file.epoch || base.revision !== current.file.revision) {
      return { ok: false, error: "CONFLICT", file: current.file };
    }
    if (input.content === current.file.content) return { ok: true, file: current.file, replayed: false };
    const headBefore = current.file.revision;
    const pushed = texts.pushText({
      protocol: ROOM_TEXT_PROTOCOL,
      fileId: current.file.fileId,
      epoch: current.file.epoch,
      baseRevision: current.file.revision,
      clientId: input.clientId,
      requestId: input.requestId,
      intentHash: input.intentHash,
      changes: [{ from: 0, to: current.file.content.length, insert: input.content }],
      anchors: input.anchors,
    });
    if (!pushed.ok) return primaryStoreFailure(pushed);
    if (pushed.revision > headBefore) this.broadcastPrimaryUpdate(pushed);
    const projected = await this.publishPrimary(input.userId, input.room, pushed.fileId);
    await this.armJanitor();
    return projected.ok
      ? { ...projected, replayed: pushed.revision <= headBefore, update: pushed.update, anchors: pushed.anchors }
      : { ...projected, committed: true, revision: pushed.revision };
  }

  async editPrimary(input: RoomTextPrimaryEditInput): Promise<RoomTextPrimaryMutationResult> {
    if (!input.intentHash || !input.clientId || !input.requestId || typeof input.oldText !== "string"
      || !input.oldText || typeof input.newText !== "string") {
      return { ok: false, error: "INVALID_REQUEST" };
    }
    const texts = this.texts();
    const replay = texts.replayIntent(input.clientId, input.requestId, input.intentHash);
    if (replay) {
      if (!replay.ok) return primaryStoreFailure(replay);
      const projected = await this.publishPrimary(input.userId, input.room, replay.fileId);
      return projected.ok
        ? { ...projected, replayed: true, update: replay.update, anchors: replay.anchors }
        : projected;
    }
    const current = await this.openPrimary(input);
    if (!current.ok) return current;
    const matches = literalMatches(
      current.file.content,
      input.oldText,
      input.before || "",
      input.after || "",
    );
    if (matches.length === 0) return { ok: false, error: "TARGET_NOT_FOUND", file: current.file };
    if (matches.length > 1) {
      return { ok: false, error: "TARGET_AMBIGUOUS", matchCount: matches.length, file: current.file };
    }
    const from = matches[0];
    const headBefore = current.file.revision;
    const pushed = texts.pushText({
      protocol: ROOM_TEXT_PROTOCOL,
      fileId: current.file.fileId,
      epoch: current.file.epoch,
      baseRevision: current.file.revision,
      clientId: input.clientId,
      requestId: input.requestId,
      intentHash: input.intentHash,
      changes: [{ from, to: from + input.oldText.length, insert: input.newText }],
      anchors: input.anchors,
    });
    if (!pushed.ok) return primaryStoreFailure(pushed);
    if (pushed.revision > headBefore) this.broadcastPrimaryUpdate(pushed);
    const projected = await this.publishPrimary(input.userId, input.room, pushed.fileId);
    await this.armJanitor();
    return projected.ok
      ? {
          ...projected,
          replayed: pushed.revision <= headBefore,
          matchedAt: from,
          update: pushed.update,
          anchors: pushed.anchors,
        }
      : { ...projected, committed: true, revision: pushed.revision };
  }

  private async publishPrimary(userId: string, room: string, fileId: string): Promise<RoomTextPrimaryResult> {
    const texts = this.texts();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const opened = texts.openText(fileId);
      if (!opened.ok) return primaryStoreFailure(opened);
      const mirrorResult = texts.mirrorState(fileId);
      if (!mirrorResult.ok) return primaryStoreFailure(mirrorResult);
      const mirror = mirrorResult.mirror;
      if (!mirror) return { ok: false, error: "NOT_IMPORTED" };
      if (mirror.status === "diverged") return { ok: false, error: "R2_DIVERGED" };
      const key = primaryKey(userId, room, opened.path);
      let current: R2Object | null;
      try {
        current = await this.r2.head(key);
      } catch (error) {
        return { ok: false, error: "PROJECTION_UNAVAILABLE", message: errorMessage(error) };
      }
      if (!current) return this.markPrimaryDiverged(fileId, "", "the R2 mirror disappeared");
      const metadata = parsePrimaryMetadata(current.customMetadata);
      if (!metadata) {
        return this.markPrimaryDiverged(fileId, current.etag, "the R2 object lost its RoomText ownership marker");
      }

      // An ETag mismatch may be a recovered successful publish or an
      // out-of-order publisher. Verify the bytes behind its metadata before
      // trusting it; a foreign writer that copied stale metadata cannot pass.
      if (current.etag !== mirror.r2Etag) {
        const body = await this.r2.get(key);
        if (!body) return this.markPrimaryDiverged(fileId, "", "the R2 mirror disappeared");
        const bodyHash = await sha256Bytes(new Uint8Array(await body.arrayBuffer()));
        if (bodyHash !== metadata.sha256) {
          return this.markPrimaryDiverged(fileId, current.etag, "the R2 bytes do not match their RoomText generation marker");
        }
      }

      const headHash = await sha256Text(opened.content);
      if (metadata.epoch !== opened.epoch || metadata.revision > opened.revision) {
        return this.markPrimaryDiverged(fileId, current.etag, "R2 advertises a generation newer than the Durable Object head");
      }
      if (metadata.revision === opened.revision) {
        if (metadata.sha256 !== headHash) {
          return this.markPrimaryDiverged(fileId, current.etag, "equal RoomText revisions contain different bytes");
        }
        const active = texts.setMirrorActive({
          fileId,
          r2Etag: current.etag,
          epoch: opened.epoch,
          revision: opened.revision,
          sha256: headHash,
          updatedAt: current.uploaded.getTime(),
        });
        if (!active.ok) return primaryStoreFailure(active);
        if (!active.mirror) return { ok: false, error: "STORAGE_CORRUPT", message: "mirror row disappeared after publish" };
        return { ok: true, file: primaryFile(opened, active.mirror) };
      }

      const wrote = await this.r2.put(key, new TextEncoder().encode(opened.content), {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: current.httpMetadata,
        customMetadata: {
          ...(current.customMetadata || {}),
          ...primaryMetadata(opened.epoch, opened.revision, headHash),
        },
      });
      if (!wrote) continue;
      const active = texts.setMirrorActive({
        fileId,
        r2Etag: wrote.etag,
        epoch: opened.epoch,
        revision: opened.revision,
        sha256: headHash,
        updatedAt: wrote.uploaded.getTime(),
      });
      if (!active.ok) return primaryStoreFailure(active);
      if (!active.mirror) return { ok: false, error: "STORAGE_CORRUPT", message: "mirror row disappeared after publish" };
      return { ok: true, file: primaryFile(opened, active.mirror) };
    }
    return { ok: false, error: "PROJECTION_BUSY", message: "R2 changed repeatedly; the RoomText commit remains durable and queued" };
  }

  private markPrimaryDiverged(fileId: string, observedEtag: string, message: string): RoomTextPrimaryResult {
    this.texts().markMirrorDiverged(fileId, observedEtag);
    return { ok: false, error: "R2_DIVERGED", message };
  }

  private broadcastPrimaryUpdate(result: PushRoomTextSuccess): void {
    this.broadcastUpdates(result.fileId, {
      epoch: result.epoch,
      updates: [{
        ...result.update,
        updateToken: roomTextUpdateToken(result.update.clientId, result.update.requestId),
      }],
    });
  }

  /** Route one parsed RoomText frame from the hub's webSocketMessage. */
  async handleFrame(
    ws: WebSocket,
    frame: RoomTextClientFrame,
    options: { allowPush?: boolean } = {},
  ): Promise<void> {
    if (frame.type === "ping") {
      // Intentional wake: the client's zombie detector needs a real
      // round-trip through the engine host, not the auto-response pair.
      // Answered without instantiating the store.
      this.send(ws, { type: "pong", at: typeof frame.at === "number" ? frame.at : 0 });
      return;
    }
    if (frame.type === "connect") {
      this.handleConnect(ws, frame);
      return;
    }
    if (frame.type === "push") {
      if (options.allowPush === false) {
        for (const push of frame.pushes.slice(0, ROOM_TEXT_MAX_PUSHES_PER_FRAME)) {
          this.send(ws, {
            type: "discard",
            updateToken: tokenFor(push),
            code: "INVALID_REQUEST",
            retryable: false,
            message: "RoomText writes are frozen for migration",
          });
        }
        return;
      }
      // Cap the batch: without it one maximum-size frame of tiny elements
      // elements would cost one reply frame per element (~60x outbound
      // amplification), reachable even from a view-slug socket via the
      // readonly-rejection loop. The real client sends one push at a time.
      const pushes = Array.isArray(frame.pushes) ? frame.pushes.slice(0, ROOM_TEXT_MAX_PUSHES_PER_FRAME) : [];
      if (pushes.length > 0 && this.handlePushes(ws, pushes)) {
        // Fresh commits marked files dirty; make sure a flush is scheduled.
        // Arming is idempotent (no-op when an alarm is already pending).
        await this.armJanitor();
      }
    }
  }

  private handleConnect(ws: WebSocket, frame: Extract<RoomTextClientFrame, { type: "connect" }>): void {
    const connectRequestId = typeof frame.connectRequestId === "string" ? frame.connectRequestId : "";
    const attachment = (ws.deserializeAttachment() || {}) as RoomTextHostAttachment;
    const texts = this.texts();

    // Prefix fence on the READ side too: hydration carries full document
    // content, so a share-scoped socket may only bind files under its
    // prefix. Answer NOT_FOUND rather than leaking that the file exists.
    const opened = texts.openText(String(frame.fileId ?? ""));
    if (opened.ok && !this.pathVisible(opened.path, String(attachment.prefix || ""))) {
      this.send(ws, { type: "connect-error", connectRequestId, code: "NOT_FOUND" });
      return;
    }

    const result = texts.connectText({
      connectRequestId: frame.connectRequestId,
      protocolVersion: frame.protocolVersion,
      fileId: frame.fileId,
      epoch: frame.epoch,
      lastRevision: frame.lastRevision,
    });
    if (!result.ok) {
      if (result.error === "PROTOCOL_MISMATCH") {
        // Explicit incompatibility frame. Unlike the dedicated probe socket,
        // this socket ALSO carries presence — do not close it; the client's
        // onIncompatible handler decides what to do with its session.
        this.send(ws, {
          type: "incompatible",
          connectRequestId,
          serverProtocol: ROOM_TEXT_PROTOCOL,
          ...(result.message ? { message: result.message } : {}),
        });
        return;
      }
      this.send(ws, {
        type: "connect-error",
        connectRequestId,
        code: result.error,
        ...(result.message ? { message: result.message } : {}),
      });
      return;
    }

    // Bind the socket to its file; survives hibernation with the socket.
    ws.serializeAttachment({ ...attachment, rtFile: result.fileId });
    this.send(ws, result.hydration === "delta"
      ? {
          type: "hydration",
          connectRequestId: result.connectRequestId,
          fileId: result.fileId,
          hydration: "delta",
          epoch: result.epoch,
          headRevision: result.headRevision,
          updates: result.updates,
        }
      : {
          type: "hydration",
          connectRequestId: result.connectRequestId,
          fileId: result.fileId,
          hydration: "snapshot",
          epoch: result.epoch,
          headRevision: result.headRevision,
          byteLength: result.byteLength,
          doc: result.doc,
        });
  }

  /** Returns true when at least one push produced a FRESH commit. */
  private handlePushes(ws: WebSocket, pushes: PushRoomTextInput[]): boolean {
    const attachment = (ws.deserializeAttachment() || {}) as RoomTextHostAttachment;
    if (attachment.readonly !== false) {
      // The one deliberate security wire of this mount: a push commits
      // durable document state, so it is accepted ONLY from sockets the
      // Worker stamped readonly === false (edit-role shares at upgrade,
      // write-scope members). View/comment sockets get a NON-retryable
      // discard — resubmitting can never succeed on this socket.
      for (const push of pushes) {
        this.send(ws, {
          type: "discard",
          updateToken: tokenFor(push),
          code: "INVALID_REQUEST",
          retryable: false,
          message: "read-only connection: pushes require edit access",
        });
      }
      return false;
    }
    const texts = this.texts();
    const freshByFile = new Map<string, { epoch: number; updates: RoomTextBroadcastUpdate[] }>();
    for (const push of pushes) {
      const token = tokenFor(push);
      const before = texts.openText(push ? String(push.fileId ?? "") : "");
      // Prefix fence on the WRITE side, symmetric with the connect fence: a
      // push needs no prior connect, so without this an edit-role share
      // scoped to docs/ could commit to any promoted file in the room by
      // guessing its path (adversarial-review finding). Same NOT_FOUND as
      // the read fence — no existence oracle either way.
      if (before.ok && !this.pathVisible(before.path, String(attachment.prefix || ""))) {
        this.send(ws, { type: "discard", updateToken: token, code: "NOT_FOUND", retryable: false });
        continue;
      }
      const headBefore = before.ok ? before.revision : -1;
      const result = texts.pushText(push);
      if (!result.ok) {
        this.send(ws, {
          type: "discard",
          updateToken: token,
          code: result.error,
          retryable: isRetryableRoomTextFailure(result.error),
          ...(result.message ? { message: result.message } : {}),
        });
        continue;
      }
      if (result.revision > headBefore) {
        // Fresh commit: the canonical broadcast goes to every socket,
        // INCLUDING the sender. RoomTextClient recognizes its updateToken in
        // that ordered stream as the acknowledgement; a separate direct ack
        // would confirm the speculative edit outside the revision stream and
        // force an unnecessary resync.
        const group = freshByFile.get(result.fileId) ?? { epoch: result.epoch, updates: [] };
        group.epoch = result.epoch;
        group.updates.push({
          ...result.update,
          updateToken: roomTextUpdateToken(result.update.clientId, result.update.requestId),
        });
        freshByFile.set(result.fileId, group);
      } else {
        // Idempotent replay: the original broadcast already happened, so a
        // direct ack is the only response that can retire a replay-only
        // outbox entry after snapshot recovery.
        const rebased = result.update.parentRevision > result.submittedBaseRevision;
        this.send(ws, {
          type: "ack",
          updateToken: token,
          status: "commit",
          revision: result.revision,
          ...(rebased ? { rebasedChanges: result.update.changes } : {}),
        });
      }
    }
    for (const [fileId, group] of freshByFile) this.broadcastUpdates(fileId, group, ws);
    return freshByFile.size > 0;
  }

  /**
   * One updates frame per file per inbound message, to every socket
   * bound to that file. Reuses the hub's prefix-visibility predicate so a
   * share-scoped socket only ever hears about files under its prefix — the
   * same fence broadcast() applies to activity events.
   */
  private broadcastUpdates(
    fileId: string,
    group: { epoch: number; updates: RoomTextBroadcastUpdate[] },
    sender?: WebSocket,
  ): void {
    const opened = this.texts().openText(fileId);
    const path = opened.ok ? opened.path : "";
    const frame = JSON.stringify({
      type: "updates",
      fileId,
      epoch: group.epoch,
      headRevision: group.updates[group.updates.length - 1].revision,
      updates: group.updates,
    } satisfies RoomTextServerFrame);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = (socket.deserializeAttachment() || {}) as RoomTextHostAttachment;
      // The sender may push before connect (the write-side prefix fence is
      // intentionally independent of read hydration). It still needs the
      // canonical echo as its ack. Everyone else must have explicitly bound
      // this file or a multi-file room broadcast would leak content.
      if (socket !== sender && attachment.rtFile !== fileId) continue;
      if (!this.pathVisible(path, String(attachment.prefix || ""))) continue;
      try { socket.send(frame); } catch (_) { /* socket mid-close; skip */ }
    }
  }

  private send(ws: WebSocket, frame: RoomTextServerFrame): void {
    try { ws.send(JSON.stringify(frame)); } catch (_) { /* socket mid-close; skip */ }
  }

  // ─── Promote / parity / shadow janitor (dark-mode validation surface) ───
  // The Worker calls these via hub RPC after its own auth (write-scope room
  // membership). Nothing here is reachable from a socket frame.

  /**
   * Promote one R2 file into the hot store. The Worker read the object and
   * forwards content + source etag; the hub records both so parity can later
   * prove the hot head still matches what was promoted. createText marks the
   * file dirty, so promotion itself exercises the shadow flush pipeline.
   */
  async promote(input: RoomTextPromoteInput): Promise<RoomTextPromoteResult> {
    const texts = this.texts();
    const created = texts.createText({
      fileId: input.path,
      path: input.path,
      bytes: new TextEncoder().encode(input.content),
    });
    if (!created.ok) {
      return { ok: false, error: created.error, ...(created.message ? { message: created.message } : {}) };
    }
    // Host-side bookkeeping in the DO's KV space (not the store's tables —
    // source etags are migration state, not engine state). rt:room is the
    // identity the janitor needs to build shadow keys: a DO cannot read its
    // own name, so the Worker tells it once, at first promote.
    await this.ctx.storage.put(`rt:src:${created.fileId}`, input.sourceEtag);
    await this.ctx.storage.put("rt:room", { userId: input.userId, room: input.room });
    await this.armJanitor();
    return { ok: true, fileId: created.fileId, revision: created.revision, byteLength: created.byteLength };
  }

  /**
   * Byte-parity report over every promoted file: the hot head's exact hash
   * and size next to the source etag recorded at promote. The Worker hashes
   * the R2 side and compares — content never round-trips twice.
   */
  async parity(): Promise<RoomTextParityResult> {
    const texts = this.texts();
    const sources = await this.ctx.storage.list<string>({ prefix: "rt:src:" });
    const dirty = new Set(texts.dirtyFiles(10_000).map((entry) => entry.fileId));
    const files: RoomTextParityRow[] = [];
    for (const [key, sourceEtag] of sources) {
      const fileId = key.slice("rt:src:".length);
      const opened = texts.openText(fileId);
      if (!opened.ok) {
        files.push({ path: fileId, ok: false, error: opened.error, sourceEtag, dirty: dirty.has(fileId) });
        continue;
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opened.content));
      files.push({
        path: opened.path,
        ok: true,
        epoch: opened.epoch,
        revision: opened.revision,
        byteLength: opened.byteLength,
        sha256: hex(digest),
        sourceEtag,
        dirty: dirty.has(opened.fileId),
      });
    }
    return { ok: true, files };
  }

  /**
   * Drain the durable dirty-set: flush up to `limit` files to SHADOW R2 keys
   * with the full lab-proven pipeline (compact -> immutable artifact PUT
   * (create-only) -> monotonic publication decision -> HEAD etag-CAS ->
   * advance floor -> clear the mark). A failed file keeps its dirty row and
   * the alarm re-arms, so nothing is silently dropped — the exact property
   * the scalar dirty-target lacked.
   */
  async janitorDrain(limit = 8): Promise<RoomTextJanitorSummary> {
    const meta = await this.ctx.storage.get<{ userId: string; room: string }>("rt:room");
    if (!meta) return { ok: true, flushed: 0, remaining: 0, results: [] };
    const texts = this.texts();
    const entries = texts.dirtyFiles(limit);
    const results: RoomTextJanitorFileResult[] = [];
    for (const entry of entries) {
      const mirror = texts.mirrorState(entry.fileId);
      const result = mirror.ok && mirror.mirror
        ? await this.flushPrimary(meta, entry.fileId)
        : await this.flushOne(meta, entry.fileId);
      // A failing file goes to the BACK of the FIFO so 8 poison rows can
      // never monopolize the drain window and starve siblings.
      if (!result.ok) texts.deferDirty(entry.fileId);
      results.push(result);
    }
    const remaining = texts.dirtyFiles(1).length;
    if (remaining > 0) {
      // Backoff when the whole window failed: a persistent per-file error
      // (HEAD_UNREADABLE, CAS storms) must not burn an alarm + 2 R2 ops
      // every 2s indefinitely.
      const allFailed = results.length > 0 && results.every((r) => !r.ok);
      await this.armJanitor(allFailed ? 30_000 : 2_000);
    }
    return { ok: true, flushed: results.filter((r) => r.ok).length, remaining, results };
  }

  private async flushPrimary(
    meta: { userId: string; room: string },
    fileId: string,
  ): Promise<RoomTextJanitorFileResult> {
    const projected = await this.publishPrimary(meta.userId, meta.room, fileId);
    if (!projected.ok) return { fileId, ok: false, error: projected.error };
    // The canonical key now contains the current bytes. Keep the existing
    // immutable history-artifact pipeline as a second recovery layer; it
    // checkpoints/compacts and clears the durable dirty mark only after both
    // projections are safe.
    return this.flushOne(meta, fileId);
  }

  private async flushOne(meta: { userId: string; room: string }, fileId: string): Promise<RoomTextJanitorFileResult> {
    const texts = this.texts();
    // Checkpoint FIRST: exportVersionArtifact publishes at snapshot_revision,
    // but pushes only checkpoint every 128 updates / 256KB of tail — without
    // this, an ordinary edit leaves the artifact at an older revision, the
    // dirty mark (minted at HEAD revision) never clears, and the alarm
    // re-fires at a fixed 2s forever republishing the same stale state
    // (found by adversarial review, reproduced against the real store).
    const checkpointed = texts.checkpointText(fileId);
    if (!checkpointed.ok) return { fileId, ok: false, error: checkpointed.error };
    const compacted = texts.compactHistory(fileId);
    if (!compacted.ok) return { fileId, ok: false, error: compacted.error };
    const artifact = texts.exportVersionArtifact(fileId);
    if (!artifact.ok) return { fileId, ok: false, error: artifact.error };
    const manifest = texts.buildHeadManifest(fileId);
    if (!manifest.ok) return { fileId, ok: false, error: manifest.error };

    const historyPrefix = shadowKey(meta.userId, meta.room, `.history/${fileId}`);
    const artifactKey = `${historyPrefix}/${artifact.epoch}@${artifact.revision}`;
    const headKey = `${historyPrefix}/HEAD`;

    // Read the exact publication boundary once. The same object/etag later
    // guards the HEAD CAS; its revision also limits provenance to edits made
    // since the previous visible checkpoint rather than the cumulative
    // retained update chain carried inside every artifact.
    const currentHead = await this.r2.get(headKey);
    const currentJson = currentHead ? await currentHead.text() : null;
    const currentPublication = currentJson === null ? null : parseRoomTextPublication(currentJson);
    const provenanceFloor = currentPublication?.epoch === artifact.epoch
      ? currentPublication.revision
      : -1;

    // Artifacts are immutable once written: create-only PUT via the Headers
    // If-None-Match form (NEVER onlyIf.etagDoesNotMatch:'*', which miniflare
    // had reversed — workers-sdk#6411). A null result means an earlier fire
    // already made this exact artifact durable; that is success, not failure.
    const provenance = historyProvenance(artifact.composed_changes_json, provenanceFloor);
    await this.r2.put(artifactKey, serializeShadowArtifact(artifact), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      customMetadata: {
        ...(provenance.clientId ? { [HISTORY_META_CLIENT_ID]: provenance.clientId } : {}),
        [HISTORY_META_SOURCE]: provenance.source,
        [HISTORY_META_SIZE]: String(artifact.snapshot_bytes.byteLength),
      },
    });

    // Monotonic publication guard, decided at WRITE time against the exact
    // HEAD body just read, with the CAS paired to that same read — the
    // graduated fix for the 458/1000 flush-regression schedules.
    const decision = decideRoomTextPublication(currentJson, { epoch: manifest.epoch, revision: manifest.revision });
    if (decision === "unreadable") return { fileId, ok: false, error: "HEAD_UNREADABLE" };
    let headFlip: "flipped" | "already-visible" | "stale-skip";
    if (decision === "publish") {
      const flipped = await this.r2.put(headKey, manifest.manifestJson, {
        onlyIf: currentHead ? { etagMatches: currentHead.etag } : new Headers({ "If-None-Match": "*" }),
      });
      // A lost CAS means another flush moved HEAD between our read and
      // write: keep the dirty row and re-observe on the next fire — never
      // blind-retry the PUT.
      if (!flipped) return { fileId, ok: false, error: "HEAD_CAS_LOST" };
      headFlip = "flipped";
    } else {
      // stale-skip still advances the floor: this flush's artifact is
      // durable and HEAD points at a strictly newer chain entry covering it.
      headFlip = decision === "stale" ? "stale-skip" : "already-visible";
    }

    const advanced = texts.advanceFloorAfterFlush(fileId, artifact.revision);
    if (!advanced.ok) return { fileId, ok: false, error: advanced.error };
    // Clear at the PUBLISHED revision: a mark minted mid-flush (newer edit)
    // survives and keeps the file scheduled.
    texts.clearDirty(fileId, artifact.revision);
    return { fileId, ok: true, revision: artifact.revision, headFlip };
  }

  /** Idempotent: schedules a flush only when no alarm is already pending. */
  private async armJanitor(delayMs = 2_000): Promise<void> {
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null) await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }
}

// ─── Shadow key scheme ──────────────────────────────────────────────────
// The janitor's ONLY key builder. The "roomtext-shadow/" literal is baked in
// here, so a production key (users/...) is structurally unreachable from any
// janitor write — the dark-mode isolation guarantee, enforced by shape, not
// by discipline. The prefix is also a sibling of "users/", so every
// production reader (list/tree/search scope to users/...) is blind to it.
// R2 keys are flat strings: "../" segments never normalize, so even a
// hostile fileId cannot escape the prefix (tested).
export function roomTextShadowKey(userId: string, room: string, suffix: string): string {
  return `roomtext-shadow/users/${userId}/${room}/${suffix}`;
}
const shadowKey = roomTextShadowKey;

export type RoomTextHistorySource = "web" | "mcp" | "mixed" | "unknown";

export type RoomTextHistoryVersion = {
  epoch: number;
  revision: number;
  version: string;
  created_at: string;
  client_id: string;
  source: RoomTextHistorySource;
  size_bytes: number | null;
};

export type RoomTextHistoryArtifact = RoomTextHistoryVersion & {
  fileId: string;
  path: string;
  content: string;
};

export type RoomTextHistoryListResult =
  | { ok: true; versions: RoomTextHistoryVersion[] }
  | { ok: false; error: "HISTORY_TOO_LARGE" | "HISTORY_UNAVAILABLE" };

export type RoomTextHistoryReadResult =
  | { ok: true; artifact: RoomTextHistoryArtifact }
  | { ok: false; error: "NOT_FOUND" | "INVALID_ARTIFACT" | "HISTORY_UNAVAILABLE" };

/** Exact R2 prefix for one file's immutable checkpoint objects. */
export function roomTextHistoryPrefix(userId: string, room: string, fileId: string): string {
  return roomTextShadowKey(userId, room, `.history/${fileId}/`);
}

/** Exact R2 key for one immutable `{epoch, revision}` checkpoint. */
export function roomTextHistoryArtifactKey(
  userId: string,
  room: string,
  fileId: string,
  epoch: number,
  revision: number,
): string {
  return `${roomTextHistoryPrefix(userId, room, fileId)}${epoch}@${revision}`;
}

/** Strictly parse the identity suffix; HEAD and malformed siblings are ignored. */
export function parseRoomTextHistoryIdentity(value: string): { epoch: number; revision: number } | null {
  const match = /^([1-9][0-9]*)@(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const epoch = Number(match[1]);
  const revision = Number(match[2]);
  return Number.isSafeInteger(epoch) && Number.isSafeInteger(revision)
    ? { epoch, revision }
    : null;
}

/** Product-safe provenance derived from the engine's stable client id. */
export function roomTextHistorySource(clientId: string): RoomTextHistorySource {
  if (clientId.startsWith("web:")) return "web";
  if (clientId.startsWith("mcp:")) return "mcp";
  return "unknown";
}

function historyProvenance(
  composedChangesJson: string,
  afterRevision = -1,
): { clientId: string; source: RoomTextHistorySource } {
  try {
    const entries = JSON.parse(composedChangesJson);
    if (!Array.isArray(entries)) return { clientId: "", source: "unknown" };
    const clientIds = new Set<string>();
    const sources = new Set<RoomTextHistorySource>();
    for (const entry of entries) {
      if (!entry || typeof entry.clientId !== "string"
        || !Number.isSafeInteger(entry.revision) || entry.revision <= afterRevision) continue;
      const clientId = String(entry.clientId);
      clientIds.add(clientId);
      sources.add(roomTextHistorySource(clientId));
    }
    if (sources.size > 1 || clientIds.size > 1) return { clientId: "", source: "mixed" };
    const source = sources.values().next().value as RoomTextHistorySource | undefined;
    return {
      // Multiple writers through the same surface are not one attributable
      // actor. Keep the durable source, but withhold an invented identity.
      clientId: clientIds.size === 1 ? [...clientIds][0] : "",
      source: source || "unknown",
    };
  } catch (_) {
    return { clientId: "", source: "unknown" };
  }
}

/**
 * List immutable artifacts, then sort numerically. R2 lists lexicographically
 * (`1@10` before `1@2`), so callers must never expose its raw order as a
 * timeline. We fail closed rather than silently return the wrong "latest"
 * checkpoint if a file ever exceeds the bounded MVP scan.
 */
export async function listRoomTextHistoryArtifacts(
  r2: R2Bucket,
  userId: string,
  room: string,
  fileId: string,
): Promise<RoomTextHistoryListResult> {
  const prefix = roomTextHistoryPrefix(userId, room, fileId);
  const versions: RoomTextHistoryVersion[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  try {
    do {
      const remaining = HISTORY_SCAN_MAX_OBJECTS - scanned;
      if (remaining <= 0) return { ok: false, error: "HISTORY_TOO_LARGE" };
      const page = await r2.list({
        prefix,
        cursor,
        limit: Math.min(1_000, remaining),
        include: ["customMetadata"],
      });
      scanned += page.objects.length;
      for (const object of page.objects) {
        const identity = parseRoomTextHistoryIdentity(object.key.slice(prefix.length));
        if (!identity) continue;
        const custom = object.customMetadata || {};
        const clientId = typeof custom[HISTORY_META_CLIENT_ID] === "string"
          ? custom[HISTORY_META_CLIENT_ID]
          : "";
        const storedSource = custom[HISTORY_META_SOURCE];
        const source = storedSource === "web" || storedSource === "mcp" || storedSource === "mixed"
          ? storedSource
          : roomTextHistorySource(clientId);
        const size = Number(custom[HISTORY_META_SIZE]);
        versions.push({
          ...identity,
          version: roomTextVersionToken(identity.epoch, identity.revision),
          created_at: object.uploaded.toISOString(),
          client_id: clientId,
          source,
          size_bytes: Number.isSafeInteger(size) && size >= 0 ? size : null,
        });
      }
      if (page.truncated && scanned >= HISTORY_SCAN_MAX_OBJECTS) {
        return { ok: false, error: "HISTORY_TOO_LARGE" };
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (_) {
    return { ok: false, error: "HISTORY_UNAVAILABLE" };
  }
  versions.sort((left, right) => right.epoch - left.epoch || right.revision - left.revision);
  return { ok: true, versions };
}

/** Read and validate one immutable artifact before exposing its bytes. */
export async function readRoomTextHistoryArtifact(
  r2: R2Bucket,
  userId: string,
  room: string,
  fileId: string,
  epoch: number,
  revision: number,
): Promise<RoomTextHistoryReadResult> {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(revision) || revision < 0) {
    return { ok: false, error: "INVALID_ARTIFACT" };
  }
  let object: R2ObjectBody | null;
  try {
    object = await r2.get(roomTextHistoryArtifactKey(userId, room, fileId, epoch, revision));
  } catch (_) {
    return { ok: false, error: "HISTORY_UNAVAILABLE" };
  }
  if (!object) return { ok: false, error: "NOT_FOUND" };
  try {
    const value = JSON.parse(await object.text()) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.fileId !== fileId || value.path !== fileId
      || value.epoch !== epoch || value.revision !== revision
      || typeof value.snapshot_b64 !== "string"
      || typeof value.composed_changes_json !== "string") {
      return { ok: false, error: "INVALID_ARTIFACT" };
    }
    const bytes = strictBase64(String(value.snapshot_b64));
    if (!bytes || bytes.byteLength > ROOM_TEXT_MAX_BYTES) {
      return { ok: false, error: "INVALID_ARTIFACT" };
    }
    // decodeRoomText is fatal UTF-8 and rejects malformed historical bytes.
    const content = decodeRoomText(bytes).toString();
    const bodyProvenance = historyProvenance(String(value.composed_changes_json));
    const custom = object.customMetadata || {};
    const clientId = typeof custom[HISTORY_META_CLIENT_ID] === "string"
      ? custom[HISTORY_META_CLIENT_ID]
      : bodyProvenance.clientId;
    const storedSource = custom[HISTORY_META_SOURCE];
    const source = storedSource === "web" || storedSource === "mcp" || storedSource === "mixed"
      ? storedSource
      : custom[HISTORY_META_CLIENT_ID]
        ? roomTextHistorySource(clientId)
        : bodyProvenance.source;
    return {
      ok: true,
      artifact: {
        fileId,
        path: fileId,
        epoch,
        revision,
        version: roomTextVersionToken(epoch, revision),
        created_at: object.uploaded.toISOString(),
        client_id: clientId,
        source,
        size_bytes: bytes.byteLength,
        content,
      },
    };
  } catch (_) {
    return { ok: false, error: "INVALID_ARTIFACT" };
  }
}

function strictBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch (_) {
    return null;
  }
}

/** Shadow artifact body: manifest fields + base64 snapshot, one JSON doc. */
function serializeShadowArtifact(artifact: {
  fileId: string;
  path: string;
  epoch: number;
  revision: number;
  snapshot_bytes: ArrayBuffer;
  composed_changes_json: string;
}): string {
  return JSON.stringify({
    fileId: artifact.fileId,
    path: artifact.path,
    epoch: artifact.epoch,
    revision: artifact.revision,
    snapshot_b64: base64(artifact.snapshot_bytes),
    composed_changes_json: artifact.composed_changes_json,
  });
}

/** Chunked base64 — String.fromCharCode(...1MB) would blow the stack. */
function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type RoomTextPrimaryOpenInput = {
  userId: string;
  room: string;
  path: string;
};

export type RoomTextPrimaryImportInput = RoomTextPrimaryOpenInput & {
  bytes: ArrayBuffer;
  sourceEtag: string;
};

type RoomTextPrimaryMutationBase = RoomTextPrimaryOpenInput & {
  clientId: string;
  requestId: string;
  intentHash: string;
  anchors?: readonly RoomTextAnchor[];
};

export type RoomTextPrimaryReplaceInput = RoomTextPrimaryMutationBase & {
  baseVersion: string;
  content: string;
};

export type RoomTextPrimaryEditInput = RoomTextPrimaryMutationBase & {
  oldText: string;
  newText: string;
  before?: string;
  after?: string;
};

export type RoomTextPrimaryFile = {
  fileId: string;
  path: string;
  epoch: number;
  revision: number;
  byteLength: number;
  content: string;
  version: string;
  r2Etag: string;
  sha256: string;
  updatedAt: number;
};

export type RoomTextPrimaryFailure = {
  ok: false;
  error: string;
  message?: string;
  file?: RoomTextPrimaryFile;
  matchCount?: number;
  committed?: boolean;
  revision?: number;
};

export type RoomTextPrimaryResult =
  | { ok: true; file: RoomTextPrimaryFile }
  | RoomTextPrimaryFailure;

export type RoomTextPrimaryMutationResult =
  | {
      ok: true;
      file: RoomTextPrimaryFile;
      replayed?: boolean;
      matchedAt?: number;
      update?: PushRoomTextSuccess["update"];
      anchors?: RoomTextAnchor[];
    }
  | RoomTextPrimaryFailure;

export function roomTextVersionToken(epoch: number, revision: number): string {
  return `rt1:${epoch}:${revision}`;
}

export function parseRoomTextVersionToken(value: unknown): { epoch: number; revision: number } | null {
  if (typeof value !== "string") return null;
  const match = /^rt1:([1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const epoch = Number(match[1]);
  const revision = Number(match[2]);
  return Number.isSafeInteger(epoch) && Number.isSafeInteger(revision) ? { epoch, revision } : null;
}

function primaryFile(
  opened: Extract<OpenRoomTextResult, { ok: true }>,
  mirror: RoomTextMirrorState,
): RoomTextPrimaryFile {
  return {
    fileId: opened.fileId,
    path: opened.path,
    epoch: opened.epoch,
    revision: opened.revision,
    byteLength: opened.byteLength,
    content: opened.content,
    version: roomTextVersionToken(opened.epoch, opened.revision),
    r2Etag: mirror.r2Etag,
    sha256: mirror.sha256,
    updatedAt: mirror.updatedAt,
  };
}

function primaryStoreFailure(value: { ok: false; error: string; message?: string }): RoomTextPrimaryFailure {
  return { ok: false, error: value.error, ...(value.message ? { message: value.message } : {}) };
}

function validStorageIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function validPrimaryPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024
    || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function primaryKey(userId: string, room: string, path: string): string {
  return `users/${userId}/${room}/${path}`;
}

function primaryMetadata(epoch: number, revision: number, sha256: string): Record<string, string> {
  return {
    [PRIMARY_META_AUTHORITY]: PRIMARY_AUTHORITY,
    [PRIMARY_META_EPOCH]: String(epoch),
    [PRIMARY_META_REVISION]: String(revision),
    [PRIMARY_META_SHA256]: sha256,
  };
}

function parsePrimaryMetadata(metadata: Record<string, string> | undefined): {
  epoch: number;
  revision: number;
  sha256: string;
} | null {
  if (!metadata || metadata[PRIMARY_META_AUTHORITY] !== PRIMARY_AUTHORITY) return null;
  const epoch = Number(metadata[PRIMARY_META_EPOCH]);
  const revision = Number(metadata[PRIMARY_META_REVISION]);
  const sha256 = metadata[PRIMARY_META_SHA256] || "";
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(revision) || revision < 0
    || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  return { epoch, revision, sha256 };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return hex(await crypto.subtle.digest("SHA-256", exact));
}

async function sha256Text(content: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(content));
}

function decodePrimaryBytes(bytes: Uint8Array): string {
  return decodeRoomText(bytes).toString();
}

function literalMatches(content: string, target: string, before: string, after: string): number[] {
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - target.length) {
    const at = content.indexOf(target, cursor);
    if (at < 0) break;
    const beforeMatches = !before || content.slice(Math.max(0, at - before.length), at) === before;
    const afterStart = at + target.length;
    const afterMatches = !after || content.slice(afterStart, afterStart + after.length) === after;
    if (beforeMatches && afterMatches) matches.push(at);
    cursor = at + Math.max(1, target.length);
  }
  return matches;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RoomTextPromoteInput = {
  userId: string;
  room: string;
  path: string;
  content: string;
  sourceEtag: string;
};

export type RoomTextPromoteResult =
  | { ok: true; fileId: string; revision: number; byteLength: number }
  | { ok: false; error: string; message?: string };

export type RoomTextParityRow =
  | { path: string; ok: true; epoch: number; revision: number; byteLength: number; sha256: string; sourceEtag: string; dirty: boolean }
  | { path: string; ok: false; error: string; sourceEtag: string; dirty: boolean };

export type RoomTextParityResult = { ok: true; files: RoomTextParityRow[] };

export type RoomTextJanitorFileResult =
  | { fileId: string; ok: true; revision: number; headFlip: "flipped" | "already-visible" | "stale-skip" }
  | { fileId: string; ok: false; error: string };

export type RoomTextJanitorSummary = { ok: true; flushed: number; remaining: number; results: RoomTextJanitorFileResult[] };

/** The client's own dedupe token for a push, or "" for malformed input. */
function tokenFor(push: PushRoomTextInput): string {
  return push && typeof push.clientId === "string" && typeof push.requestId === "string"
    ? roomTextUpdateToken(push.clientId, push.requestId)
    : "";
}

// Referenced so the type-only import survives isolatedModules linting paths
// that would otherwise flag RoomTextFailure as unused; it documents that
// discard/connect-error codes come from the store's failure union.
export type RoomTextHostDiscardCode = RoomTextFailure["error"];
