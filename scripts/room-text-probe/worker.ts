import { DurableObject } from "cloudflare:workers";
import {
  RoomTextStore,
  type PushRoomTextInput,
  type RoomTextVersionArtifact,
} from "../../src/room-text-store";
import {
  encodeRoomText,
  roomTextDigestOfString,
  roomTextFromString,
  roomTextHashedLeaves,
} from "../../src/room-text";
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.texts = new RoomTextStore(ctx.storage);
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
