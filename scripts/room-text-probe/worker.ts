import { DurableObject } from "cloudflare:workers";
import { RoomTextStore, type PushRoomTextInput } from "../../src/room-text-store";
import { encodeRoomText, roomTextFromString } from "../../src/room-text";
import { DocumentCollab, type RemapCommentAnchorInput } from "../../src/document-collab";

export { DocumentCollab };

type Env = {
  ROOM_TEXT_PROBE: DurableObjectNamespace<RoomTextProbe>;
  DOCUMENT_COLLAB_PROBE: DurableObjectNamespace<DocumentCollab>;
};

/** Isolated workerd wrapper around the real RoomText SQLite adapter. */
export class RoomTextProbe extends DurableObject<Env> {
  private readonly texts: RoomTextStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.texts = new RoomTextStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
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
