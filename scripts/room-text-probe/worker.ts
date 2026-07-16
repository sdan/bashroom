import { DurableObject } from "cloudflare:workers";
import {
  RoomTextStore,
  isRetryableRoomTextFailure,
  type PushRoomTextInput,
  type RoomTextVersionArtifact,
} from "../../src/room-text-store";
import {
  encodeRoomText,
  roomTextDigestOfString,
  roomTextFromString,
  roomTextHashedLeaves,
  roomTextUpdateToken,
} from "../../src/room-text";
import {
  ROOM_TEXT_CLOSE_INCOMPATIBLE,
  type RoomTextBroadcastUpdate,
  type RoomTextClientFrame,
  type RoomTextServerFrame,
} from "../../src/room-text-client";
import { DocumentCollab, type RemapCommentAnchorInput } from "../../src/document-collab";
// Tie-test only (benchmarks/room-text/ab-tie.mjs): the CRDT contender behind
// the identical socket + durability pattern. Not a production dependency.
import { Model } from "json-joy/lib/json-crdt/index.js";
import { Patch } from "json-joy/lib/json-crdt-patch/index.js";

export { DocumentCollab };

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

type Env = {
  ROOM_TEXT_PROBE: DurableObjectNamespace<RoomTextProbe>;
  DOCUMENT_COLLAB_PROBE: DurableObjectNamespace<DocumentCollab>;
};

const janitorEncoder = new TextEncoder();
const janitorDecoder = new TextDecoder();

type MockR2Object = { bytes: Uint8Array; etag: string };

/**
 * Map-backed stand-in for R2 with etag CAS semantics: create-only put
 * (onlyIf null) and compare-and-swap put (onlyIf etag). Instance memory is
 * durable enough for a probe run because "crashes" are injected throws that
 * never tear down the isolate.
 */
class MockR2 {
  private readonly objects = new Map<string, MockR2Object>();
  private version = 0;

  get(key: string): MockR2Object | undefined {
    return this.objects.get(key);
  }

  /** onlyIf undefined = unconditional; null = create-only; string = etag CAS. */
  put(key: string, bytes: Uint8Array, onlyIf?: string | null): MockR2Object | null {
    const current = this.objects.get(key);
    if (onlyIf === null && current) return null;
    if (typeof onlyIf === "string" && current?.etag !== onlyIf) return null;
    const object = { bytes: bytes.slice(), etag: `mock-etag-${++this.version}` };
    this.objects.set(key, object);
    return object;
  }

  dump(): Record<string, { etag: string; size: number; base64: string }> {
    const objects: Record<string, { etag: string; size: number; base64: string }> = {};
    for (const [key, object] of this.objects) {
      objects[key] = { etag: object.etag, size: object.bytes.byteLength, base64: toBase64(object.bytes) };
    }
    return objects;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Deterministic single-object serialization of the store's artifact parts. */
function serializeArtifact(artifact: Extract<RoomTextVersionArtifact, { ok: true }>): Uint8Array {
  return janitorEncoder.encode(JSON.stringify({
    epoch: artifact.epoch,
    revision: artifact.revision,
    snapshot_base64: toBase64(new Uint8Array(artifact.snapshot_bytes)),
    composed_changes_json: artifact.composed_changes_json,
  }));
}

class InjectedCrash extends Error {}

/** Isolated workerd wrapper around the real RoomText SQLite adapter. */
export class RoomTextProbe extends DurableObject<Env> {
  private readonly texts: RoomTextStore;
  private readonly r2 = new MockR2();
  // Broadcast batching: updates accepted during one event-loop turn (one
  // socket message may carry a whole outbox) leave as ONE frame per file.
  // In-memory is safe — the queue always drains in the same turn it fills.
  private readonly pendingBroadcast: Array<{ fileId: string; epoch: number; update: RoomTextBroadcastUpdate }> = [];
  private broadcastScheduled = false;
  private janitorGate?: {
    state: "armed" | "paused" | "released";
    wait: Promise<void>;
    release: () => void;
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.texts = new RoomTextStore(ctx.storage);
  }

  private armJanitorGate(): Record<string, unknown> {
    if (this.janitorGate) return { ok: false, error: "janitor gate is already active" };
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.janitorGate = { state: "armed", wait, release };
    return { ok: true, state: "armed" };
  }

  private janitorGateStatus(): Record<string, unknown> {
    return { ok: true, state: this.janitorGate?.state ?? "idle" };
  }

  private releaseJanitorGate(): Record<string, unknown> {
    const gate = this.janitorGate;
    if (!gate || gate.state !== "paused") return { ok: false, error: "janitor is not paused" };
    gate.state = "released";
    gate.release();
    return { ok: true, state: "released" };
  }

  /** Probe-only yield immediately after an artifact PUT completes. */
  private async pauseAfterArtifactPut(): Promise<void> {
    const gate = this.janitorGate;
    if (!gate || gate.state !== "armed") return;
    gate.state = "paused";
    await gate.wait;
    if (this.janitorGate === gate) this.janitorGate = undefined;
  }

  /**
   * Probe-only, fixed fault points. SQLite triggers let the adversarial test
   * abort the REAL RoomText transaction after specific writes without adding
   * fault branches to production code or exposing an arbitrary SQL endpoint.
   */
  private disarmFaultTriggers(): void {
    this.ctx.storage.sql.exec(`
      DROP TRIGGER IF EXISTS room_text_probe_abort_head_update;
      DROP TRIGGER IF EXISTS room_text_probe_abort_digest_log_insert;
    `);
  }

  private armFaultTrigger(kind: string): { ok: true; kind: string } | { ok: false; error: string } {
    this.disarmFaultTriggers();
    if (kind === "abort-head-update") {
      this.ctx.storage.sql.exec(`
        CREATE TRIGGER room_text_probe_abort_head_update
        BEFORE UPDATE ON room_text_heads
        BEGIN
          SELECT RAISE(ABORT, 'room-text probe: abort head update');
        END;
      `);
      return { ok: true, kind };
    }
    if (kind === "abort-digest-log-insert") {
      this.ctx.storage.sql.exec(`
        CREATE TRIGGER room_text_probe_abort_digest_log_insert
        AFTER INSERT ON room_text_digest_log
        BEGIN
          SELECT RAISE(ABORT, 'room-text probe: abort digest log insert');
        END;
      `);
      return { ok: true, kind };
    }
    return { ok: false, error: "unknown fixed fault trigger" };
  }

  /** Exact durable state used to prove failed transactions left no fragments. */
  private faultState(fileId: string): Record<string, unknown> {
    const file = this.ctx.storage.sql.exec<{
      epoch: number;
      head_revision: number;
      history_floor: number;
      snapshot_revision: number;
      snapshot_bytes: ArrayBuffer;
      snapshot_utf16_length: number;
      byte_length: number;
      recovery_tail_bytes: number;
    }>(
      `SELECT epoch, head_revision, history_floor, snapshot_revision,
              snapshot_bytes, snapshot_utf16_length, byte_length,
              recovery_tail_bytes
         FROM room_text_files WHERE file_id = ?`,
      fileId,
    ).toArray()[0];
    const head = this.ctx.storage.sql.exec<{
      epoch: number;
      revision: number;
      content_bytes: ArrayBuffer;
      content_utf16_length: number;
    }>(
      `SELECT epoch, revision, content_bytes, content_utf16_length
         FROM room_text_heads WHERE file_id = ?`,
      fileId,
    ).toArray()[0];
    const digest = this.ctx.storage.sql.exec<{
      content_hash: string;
      byte_length: number;
      revision: number;
      first_seq: number;
      last_seq: number;
    }>(
      `SELECT content_hash, byte_length, revision, first_seq, last_seq
         FROM room_text_digests WHERE file_id = ?`,
      fileId,
    ).toArray()[0];
    const updates = this.ctx.storage.sql.exec<{
      revision: number;
      base_revision: number;
      update_token: string;
      changes_json: string;
      room_commit: number;
    }>(
      `SELECT revision, base_revision, update_token, changes_json, room_commit
         FROM room_text_updates WHERE file_id = ? ORDER BY revision`,
      fileId,
    ).toArray();
    const requests = this.ctx.storage.sql.exec<{
      client_id: string;
      request_id: string;
      revision: number;
    }>(
      `SELECT client_id, request_id, revision
         FROM room_text_requests WHERE file_id = ? ORDER BY revision`,
      fileId,
    ).toArray();
    const fileCommits = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM room_text_commits
        WHERE sequence IN (
          SELECT room_commit FROM room_text_updates WHERE file_id = ?
        )`,
      fileId,
    ).one().count;
    const globals = this.ctx.storage.sql.exec<{
      commits: number;
      digest_log_rows: number;
      digest_log_max_seq: number | null;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM room_text_commits) AS commits,
         (SELECT COUNT(*) FROM room_text_digest_log) AS digest_log_rows,
         (SELECT MAX(seq) FROM room_text_digest_log) AS digest_log_max_seq`,
    ).one();
    return {
      file: file ? {
        ...file,
        snapshot_bytes: toBase64(new Uint8Array(file.snapshot_bytes)),
      } : null,
      head: head ? {
        ...head,
        content_bytes: toBase64(new Uint8Array(head.content_bytes)),
      } : null,
      digest: digest ?? null,
      updates,
      requests,
      fileCommits,
      globals,
      roomDigest: this.texts.roomDigest(),
    };
  }

  /** Named corruptions reproduce fail-closed behavior without arbitrary SQL. */
  private injectCorruption(kind: string, fileId: string): Record<string, unknown> {
    if (kind === "flip-head-byte-same-length") {
      const row = this.ctx.storage.sql.exec<{ content_bytes: ArrayBuffer }>(
        "SELECT content_bytes FROM room_text_heads WHERE file_id = ?",
        fileId,
      ).toArray()[0];
      if (!row || row.content_bytes.byteLength === 0) {
        return { ok: false, error: "non-empty durable head required" };
      }
      const bytes = new Uint8Array(row.content_bytes).slice();
      const index = bytes.findIndex((byte) => byte >= 0x20 && byte <= 0x7e);
      if (index < 0) return { ok: false, error: "ASCII byte required" };
      const before = bytes[index];
      bytes[index] = before === 0x41 ? 0x42 : 0x41;
      this.ctx.storage.sql.exec(
        "UPDATE room_text_heads SET content_bytes = ? WHERE file_id = ?",
        bytes.buffer,
        fileId,
      );
      this.texts.clearCache();
      return { ok: true, kind, index, before, after: bytes[index] };
    }
    if (kind === "delete-latest-update") {
      const deleted = this.ctx.storage.sql.exec(
        `DELETE FROM room_text_updates
          WHERE file_id = ? AND revision = (
            SELECT MAX(revision) FROM room_text_updates WHERE file_id = ?
          )`,
        fileId,
        fileId,
      ).rowsWritten;
      this.texts.clearCache();
      return deleted === 1
        ? { ok: true, kind, deleted }
        : { ok: false, error: "latest update not found", deleted };
    }
    return { ok: false, error: "unknown fixed corruption" };
  }

  /** Hibernation-API message handler for the sync socket (/ws upgrade). */
  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message !== "string") return;
    let frame: RoomTextClientFrame;
    try {
      frame = JSON.parse(message) as RoomTextClientFrame;
    } catch {
      ws.close(1008, "malformed frame");
      return;
    }
    if (frame.type === "connect") {
      this.handleConnect(ws, frame);
    } else if (frame.type === "push") {
      // One message, N pushes, ONE broadcast flush — the batching contract.
      for (const push of Array.isArray(frame.pushes) ? frame.pushes : []) {
        this.handlePush(ws, push);
      }
    } else if (frame.type === "ping") {
      this.sendFrame(ws, { type: "pong", at: frame.at });
    } else if (typeof (frame as { type?: string }).type === "string" && (frame as { type: string }).type.startsWith("jj-")) {
      this.handleJJ(ws, frame as never);
    }
  }

  private handleConnect(ws: WebSocket, frame: Extract<RoomTextClientFrame, { type: "connect" }>): void {
    const result = this.texts.connectText({
      connectRequestId: frame.connectRequestId,
      protocolVersion: frame.protocolVersion,
      fileId: frame.fileId,
      epoch: frame.epoch,
      lastRevision: frame.lastRevision,
    });
    if (!result.ok) {
      if (result.error === "PROTOCOL_MISMATCH") {
        // Explicit incompatibility frame, then a server-declared close code
        // so the client's aggressive backoff ladder paces its re-checks.
        this.sendFrame(ws, {
          type: "incompatible",
          connectRequestId: frame.connectRequestId,
          serverProtocol: 1,
          ...(result.message ? { message: result.message } : {}),
        });
        ws.close(ROOM_TEXT_CLOSE_INCOMPATIBLE, "room-text protocol mismatch");
        return;
      }
      this.sendFrame(ws, {
        type: "connect-error",
        connectRequestId: frame.connectRequestId,
        code: result.error,
        ...(result.message ? { message: result.message } : {}),
      });
      return;
    }
    // The attachment scopes broadcasts and survives hibernation with the socket.
    ws.serializeAttachment({ fileId: result.fileId });
    this.sendFrame(ws, result.hydration === "delta"
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

  private handlePush(ws: WebSocket, push: PushRoomTextInput): void {
    const token = push && typeof push.clientId === "string" && typeof push.requestId === "string"
      ? roomTextUpdateToken(push.clientId, push.requestId)
      : "";
    const before = this.texts.openText(push ? push.fileId : "");
    const headBefore = before.ok ? before.revision : -1;
    const result = this.texts.pushText(push);
    if (!result.ok) {
      // Discard, keyed by the client's own token. retryable separates stale
      // sync state (re-hydrate, then decide) from terminal bad-args.
      this.sendFrame(ws, {
        type: "discard",
        updateToken: token,
        code: result.error,
        retryable: isRetryableRoomTextFailure(result.error),
        ...(result.message ? { message: result.message } : {}),
      });
      return;
    }
    if (result.revision > headBefore) {
      // Fresh commit: the batched broadcast is the ack. The sender finds its
      // own updateToken-tagged entry in the frame (echo-as-ack).
      this.queueBroadcast(result.fileId, result.epoch, {
        ...result.update,
        updateToken: roomTextUpdateToken(result.update.clientId, result.update.requestId),
      });
      return;
    }
    // Idempotent replay: the store surfaced the ORIGINAL commit verbatim.
    // Only the retrying socket hears it — everyone else saw the broadcast
    // when the update first committed. A racing first-transmission commit
    // cannot mis-order this: its broadcast flushes in the microtask before
    // the replay message's turn begins.
    const rebased = result.update.parentRevision > result.submittedBaseRevision;
    this.sendFrame(ws, {
      type: "ack",
      updateToken: token,
      status: "commit",
      revision: result.revision,
      ...(rebased ? { rebasedChanges: result.update.changes } : {}),
    });
  }

  private queueBroadcast(fileId: string, epoch: number, update: RoomTextBroadcastUpdate): void {
    this.pendingBroadcast.push({ fileId, epoch, update });
    if (this.broadcastScheduled) return;
    this.broadcastScheduled = true;
    // End-of-turn flush: every update accepted in this event-loop turn
    // leaves in one frame per file.
    queueMicrotask(() => this.flushBroadcast());
  }

  private flushBroadcast(): void {
    this.broadcastScheduled = false;
    const queued = this.pendingBroadcast.splice(0);
    const byFile = new Map<string, { epoch: number; updates: RoomTextBroadcastUpdate[] }>();
    for (const item of queued) {
      const group = byFile.get(item.fileId) ?? { epoch: item.epoch, updates: [] };
      group.epoch = item.epoch;
      group.updates.push(item.update);
      byFile.set(item.fileId, group);
    }
    for (const [fileId, group] of byFile) {
      const frame = JSON.stringify({
        type: "updates",
        fileId,
        epoch: group.epoch,
        headRevision: group.updates[group.updates.length - 1].revision,
        updates: group.updates,
      } satisfies RoomTextServerFrame);
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as { fileId?: string } | null;
        if (attachment?.fileId !== fileId) continue;
        try {
          socket.send(frame);
        } catch {
          // Peer already gone; its reconnect handshake will hydrate it.
        }
      }
    }
  }

  private sendFrame(ws: WebSocket, frame: RoomTextServerFrame): void {
    ws.send(JSON.stringify(frame));
  }

  // ── json-joy tie-test engine (benchmark-only, same socket, same DO) ──
  // Parity with the RoomText path: every accepted patch is persisted via a
  // synchronous sql.exec (the output gate holds the ack until durable) and
  // acceptance broadcasts to every attached socket, echo-as-ack included.
  // The canonical Model lives in memory and rebuilds from the patch log.
  private jjModels = new Map<string, InstanceType<typeof Model>>();

  private jjLoad(fileId: string) {
    let model = this.jjModels.get(fileId);
    if (model) return model;
    model = Model.create();
    const rows = this.ctx.storage.sql
      .exec<{ patch_hex: string }>("SELECT patch_hex FROM jj_patches WHERE file_id = ? ORDER BY seq", fileId)
      .toArray();
    for (const row of rows) model.applyPatch(Patch.fromBinary(hexToBytes(row.patch_hex)));
    this.jjModels.set(fileId, model);
    return model;
  }

  private handleJJ(ws: WebSocket, frame: { type: string; fileId: string; token?: string; patchHex?: string }): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS jj_patches (file_id TEXT NOT NULL, seq INTEGER NOT NULL, patch_hex TEXT NOT NULL, PRIMARY KEY (file_id, seq))",
    );
    if (frame.type === "jj-create") {
      const model = Model.create();
      model.api.set("");
      const patch = model.api.flush();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO jj_patches (file_id, seq, patch_hex) VALUES (?, 0, ?)",
        frame.fileId, bytesToHex(patch.toBinary()),
      );
      this.jjModels.set(frame.fileId, model);
      this.sendFrame(ws, { type: "jj-created", fileId: frame.fileId } as never);
      return;
    }
    const model = this.jjLoad(frame.fileId);
    if (frame.type === "jj-connect") {
      ws.serializeAttachment({ jjFile: frame.fileId });
      this.sendFrame(ws, { type: "jj-hydration", modelHex: bytesToHex(model.toBinary()) } as never);
      return;
    }
    if (frame.type === "jj-open") {
      this.sendFrame(ws, { type: "jj-content", content: model.view() } as never);
      return;
    }
    if (frame.type === "jj-push" && frame.patchHex) {
      model.applyPatch(Patch.fromBinary(hexToBytes(frame.patchHex)));
      const seq = Number(this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM jj_patches WHERE file_id = ?", frame.fileId)
        .one().n);
      this.ctx.storage.sql.exec(
        "INSERT INTO jj_patches (file_id, seq, patch_hex) VALUES (?, ?, ?)",
        frame.fileId, seq, frame.patchHex,
      );
      const out = JSON.stringify({ type: "jj-updates", updates: [{ token: frame.token, patchHex: frame.patchHex }] });
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = (socket.deserializeAttachment() || {}) as { jjFile?: string };
        if (attachment.jjFile === frame.fileId) {
          try { socket.send(out); } catch { /* mid-close */ }
        }
      }
    }
  }

  /** Real alarm wiring for the janitor; only the target read awaits storage. */
  async alarm(): Promise<void> {
    const target = await this.ctx.storage.get<{ room: string; file: string }>("janitor:target");
    if (target) await this.runJanitor(target.room, target.file, false);
  }

  /**
   * The history janitor: compact cold rows, export the version artifact,
   * make it durable (create-only PUT — artifacts are immutable once
   * written), flip HEAD (etag CAS, skipped when the manifest is already
   * visible), then advance the floor. This ordering makes a crash at any
   * point recoverable by simply firing again.
   */
  private async runJanitor(room: string, fileId: string, crashBeforeHeadFlip: boolean) {
    const compacted = this.texts.compactHistory(fileId);
    if (!compacted.ok) return compacted;
    const artifact = this.texts.exportVersionArtifact(fileId);
    if (!artifact.ok) return artifact;
    const manifest = this.texts.buildHeadManifest(fileId);
    if (!manifest.ok) return manifest;

    const prefix = `rooms/${room}/.history/${fileId}`;
    const artifactKey = `${prefix}/${artifact.epoch}@${artifact.revision}`;
    const headKey = `${prefix}/HEAD`;
    const artifactWritten = this.r2.put(artifactKey, serializeArtifact(artifact), null) !== null;
    await this.pauseAfterArtifactPut();
    if (crashBeforeHeadFlip) throw new InjectedCrash("injected crash between artifact PUT and HEAD flip");

    const currentHead = this.r2.get(headKey);
    let headFlip: "flipped" | "already-visible";
    if (currentHead && janitorDecoder.decode(currentHead.bytes) === manifest.manifestJson) {
      headFlip = "already-visible";
    } else {
      const flipped = this.r2.put(headKey, janitorEncoder.encode(manifest.manifestJson), currentHead ? currentHead.etag : null);
      // A lost CAS means another writer flipped concurrently; the next fire
      // reconciles against whatever HEAD it observes.
      if (!flipped) return { ok: false as const, error: "HEAD_CAS_LOST" };
      headFlip = "flipped";
    }

    const advanced = this.texts.advanceFloorAfterFlush(fileId, artifact.revision);
    if (!advanced.ok) return advanced;
    return {
      ok: true as const,
      revision: artifact.revision,
      artifactKey,
      artifactWritten,
      headFlip,
      compacted: { mode: compacted.mode, composedRows: compacted.composedRows },
      advanced: { historyFloor: advanced.historyFloor, prunedUpdates: advanced.prunedUpdates },
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const room = url.searchParams.get("room") || "probe-room";
      if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
        const pair = new WebSocketPair();
        // Hibernation API so the sync surface exercises the same socket
        // lifecycle a production mount would use.
        this.ctx.acceptWebSocket(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (request.method === "POST" && url.pathname === "/create") {
        const body = await request.json<{ fileId: string; path: string; content: string }>();
        return Response.json(this.texts.createText({
          fileId: body.fileId,
          path: body.path,
          // Validate before encoding; TextEncoder would silently turn a lone
          // surrogate into U+FFFD and make a lossy import look successful.
          bytes: encodeRoomText(roomTextFromString(body.content)),
        }));
      }
      if (request.method === "POST" && url.pathname === "/fault/arm") {
        const body = await request.json<{ kind?: string }>();
        return Response.json(this.armFaultTrigger(body.kind ?? ""));
      }
      if (request.method === "POST" && url.pathname === "/fault/disarm") {
        this.disarmFaultTriggers();
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/fault/state") {
        return Response.json({ ok: true, state: this.faultState(url.searchParams.get("file") ?? "") });
      }
      if (request.method === "POST" && url.pathname === "/fault/corrupt") {
        const body = await request.json<{ kind?: string; fileId?: string }>();
        return Response.json(this.injectCorruption(body.kind ?? "", body.fileId ?? ""));
      }
      if (request.method === "POST" && url.pathname === "/push") {
        const body = await request.json<PushRoomTextInput>();
        return Response.json(this.texts.pushText(body));
      }
      const fileId = url.searchParams.get("file") || "";
      if (request.method === "GET" && url.pathname === "/open") {
        return Response.json(this.texts.openText(fileId));
      }
      if (request.method === "GET" && url.pathname === "/pull") {
        return Response.json(this.texts.pullText(
          fileId,
          Number(url.searchParams.get("epoch")),
          Number(url.searchParams.get("after")),
        ));
      }
      if (request.method === "POST" && url.pathname === "/checkpoint") {
        return Response.json(this.texts.checkpointText(fileId));
      }
      if (request.method === "POST" && url.pathname === "/compact") {
        return Response.json(this.texts.compactHistory(fileId));
      }
      if (request.method === "GET" && url.pathname === "/export") {
        const artifact = this.texts.exportVersionArtifact(fileId);
        if (!artifact.ok) return Response.json(artifact);
        return Response.json({
          ok: true,
          epoch: artifact.epoch,
          revision: artifact.revision,
          snapshot_base64: toBase64(new Uint8Array(artifact.snapshot_bytes)),
          composed_changes_json: artifact.composed_changes_json,
        });
      }
      if (request.method === "POST" && url.pathname === "/advance") {
        return Response.json(this.texts.advanceFloorAfterFlush(fileId, Number(url.searchParams.get("revision"))));
      }
      if (request.method === "POST" && url.pathname === "/janitor/schedule") {
        const requestedDelay = Number(url.searchParams.get("delay") ?? "25");
        const delay = Number.isFinite(requestedDelay)
          ? Math.max(25, Math.min(5_000, requestedDelay))
          : 25;
        await this.ctx.storage.put("janitor:target", { room, file: fileId });
        await this.ctx.storage.setAlarm(Date.now() + delay);
        return Response.json({ ok: true, delay });
      }
      if (request.method === "POST" && url.pathname === "/janitor/gate/arm") {
        return Response.json(this.armJanitorGate());
      }
      if (request.method === "GET" && url.pathname === "/janitor/gate") {
        return Response.json(this.janitorGateStatus());
      }
      if (request.method === "POST" && url.pathname === "/janitor/gate/release") {
        return Response.json(this.releaseJanitorGate());
      }
      if (request.method === "POST" && url.pathname === "/janitor/fire") {
        const crash = url.searchParams.get("crash") === "before-head-flip";
        try {
          return Response.json(await this.runJanitor(room, fileId, crash));
        } catch (error) {
          if (error instanceof InjectedCrash) return Response.json({ ok: false, crashed: true });
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/janitor/r2") {
        return Response.json({ ok: true, objects: this.r2.dump() });
      }
      if (request.method === "GET" && url.pathname === "/digest") {
        return Response.json(this.texts.digestOf(fileId));
      }
      if (request.method === "GET" && url.pathname === "/digest/room") {
        return Response.json(this.texts.roomDigest());
      }
      if (request.method === "GET" && url.pathname === "/digest/diff") {
        return Response.json(this.texts.diffDigest(url.searchParams.get("root") ?? ""));
      }
      if (request.method === "GET" && url.pathname === "/digest/verify") {
        // The gate for both hash paths: the maintained digest row must equal
        // a from-scratch hash of the document's current content.
        const opened = this.texts.openText(fileId);
        if (!opened.ok) return Response.json(opened);
        const digest = this.texts.digestOf(fileId);
        if (!digest.ok) return Response.json(digest);
        const fromScratch = roomTextDigestOfString(opened.content);
        return Response.json({
          ok: true,
          contentHash: digest.contentHash,
          fromScratch,
          match: digest.contentHash === fromScratch,
          byteLength: digest.byteLength,
          revision: digest.revision,
        });
      }
      if (request.method === "GET" && url.pathname === "/digest/stats") {
        // Monotonic incremental-path leaf counter; probes assert on deltas.
        return Response.json({ ok: true, hashedLeaves: roomTextHashedLeaves() });
      }
      if (request.method === "POST" && url.pathname === "/evict") {
        this.texts.clearCache();
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/inspect") {
        return Response.json(this.texts.inspect(fileId));
      }
      return new Response("unknown probe route", { status: 404 });
    } catch (error) {
      return Response.json({
        ok: false,
        error: "UNCAUGHT",
        message: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") || "probe-room";
    // The real DocumentCollab class over RPC, so the anchor-remap contract
    // is exercised on workerd rather than mocked.
    if (url.pathname.startsWith("/comments/")) {
      const collab = env.DOCUMENT_COLLAB_PROBE.getByName(room);
      if (request.method === "POST" && url.pathname === "/comments/add") {
        return Response.json(await collab.addComment(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/comments/remap") {
        const body = await request.json<{ anchors: RemapCommentAnchorInput[] }>();
        return Response.json(await collab.remapCommentAnchors(body.anchors));
      }
      if (request.method === "POST" && url.pathname === "/comments/resolve") {
        return Response.json(await collab.resolveComment(await request.json()));
      }
      if (request.method === "GET" && url.pathname === "/comments/list") {
        return Response.json(await collab.listComments());
      }
      return new Response("unknown probe route", { status: 404 });
    }
    return env.ROOM_TEXT_PROBE.getByName(room).fetch(request);
  },
};
