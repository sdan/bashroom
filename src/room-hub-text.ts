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
  type PushRoomTextInput,
  type RoomTextFailure,
} from "./room-text-store";
import { roomTextUpdateToken } from "./room-text";
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
export const ROOM_TEXT_INBOUND_FRAME_MAX_CHARS = 1_200_000;

/** Max pushes handled per inbound frame; the real client sends one. */
export const ROOM_TEXT_MAX_PUSHES_PER_FRAME = 64;

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

  /** Route one parsed RoomText frame from the hub's webSocketMessage. */
  async handleFrame(ws: WebSocket, frame: RoomTextClientFrame): Promise<void> {
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
      // Cap the batch: without it a single 1.2MB frame of ~600k minimal
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
      // Ack to the sender for fresh commits AND idempotent replays alike;
      // rebasedChanges present only when the server moved the update.
      const rebased = result.update.parentRevision > result.submittedBaseRevision;
      this.send(ws, {
        type: "ack",
        updateToken: token,
        status: "commit",
        revision: result.revision,
        ...(rebased ? { rebasedChanges: result.update.changes } : {}),
      });
      if (result.revision > headBefore) {
        // Fresh commit: queue for the updates broadcast to OTHER sockets
        // bound to the same file. Replays broadcast nothing — everyone else
        // heard the update when it first committed.
        const group = freshByFile.get(result.fileId) ?? { epoch: result.epoch, updates: [] };
        group.epoch = result.epoch;
        group.updates.push({
          ...result.update,
          updateToken: roomTextUpdateToken(result.update.clientId, result.update.requestId),
        });
        freshByFile.set(result.fileId, group);
      }
    }
    for (const [fileId, group] of freshByFile) this.broadcastUpdates(ws, fileId, group);
    return freshByFile.size > 0;
  }

  /**
   * One updates frame per file per inbound message, to every OTHER socket
   * bound to that file. Reuses the hub's prefix-visibility predicate so a
   * share-scoped socket only ever hears about files under its prefix — the
   * same fence broadcast() applies to activity events.
   */
  private broadcastUpdates(
    sender: WebSocket,
    fileId: string,
    group: { epoch: number; updates: RoomTextBroadcastUpdate[] },
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
      if (socket === sender) continue;
      const attachment = (socket.deserializeAttachment() || {}) as RoomTextHostAttachment;
      if (attachment.rtFile !== fileId) continue;
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
      const result = await this.flushOne(meta, entry.fileId);
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

    // Artifacts are immutable once written: create-only PUT via the Headers
    // If-None-Match form (NEVER onlyIf.etagDoesNotMatch:'*', which miniflare
    // had reversed — workers-sdk#6411). A null result means an earlier fire
    // already made this exact artifact durable; that is success, not failure.
    await this.r2.put(artifactKey, serializeShadowArtifact(artifact), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });

    // Monotonic publication guard, decided at WRITE time against the exact
    // HEAD body just read, with the CAS paired to that same read — the
    // graduated fix for the 458/1000 flush-regression schedules.
    const currentHead = await this.r2.get(headKey);
    const currentJson = currentHead ? await currentHead.text() : null;
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
