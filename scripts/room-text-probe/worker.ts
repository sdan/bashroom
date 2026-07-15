import { DurableObject } from "cloudflare:workers";
import {
  RoomTextStore,
  isRetryableRoomTextFailure,
  type PushRoomTextInput,
  type RoomTextVersionArtifact,
} from "../../src/room-text-store";
import { encodeRoomText, roomTextFromString, roomTextUpdateToken } from "../../src/room-text";
import {
  ROOM_TEXT_CLOSE_INCOMPATIBLE,
  type RoomTextBroadcastUpdate,
  type RoomTextClientFrame,
  type RoomTextServerFrame,
} from "../../src/room-text-client";
import { DocumentCollab, type RemapCommentAnchorInput } from "../../src/document-collab";

export { DocumentCollab };

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.texts = new RoomTextStore(ctx.storage);
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

  /** Real alarm wiring for the janitor; only the target read awaits storage. */
  async alarm(): Promise<void> {
    const target = await this.ctx.storage.get<{ room: string; file: string }>("janitor:target");
    if (target) this.runJanitor(target.room, target.file, false);
  }

  /**
   * The history janitor: compact cold rows, export the version artifact,
   * make it durable (create-only PUT — artifacts are immutable once
   * written), flip HEAD (etag CAS, skipped when the manifest is already
   * visible), then advance the floor. This ordering makes a crash at any
   * point recoverable by simply firing again.
   */
  private runJanitor(room: string, fileId: string, crashBeforeHeadFlip: boolean) {
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
        await this.ctx.storage.put("janitor:target", { room, file: fileId });
        await this.ctx.storage.setAlarm(Date.now() + 25);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/janitor/fire") {
        const crash = url.searchParams.get("crash") === "before-head-flip";
        try {
          return Response.json(this.runJanitor(room, fileId, crash));
        } catch (error) {
          if (error instanceof InjectedCrash) return Response.json({ ok: false, crashed: true });
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/janitor/r2") {
        return Response.json({ ok: true, objects: this.r2.dump() });
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
