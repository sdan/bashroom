// Driver worker for the dark-mount validation. It re-exports the REAL
// RoomHub (the production class, with the RoomText mount) and exposes thin
// unauthenticated driver endpoints that mirror what the authenticated
// /web/api/roomtext/* Worker routes do — auth is validated by review; this
// probe validates the DO mount, engine, and shadow-janitor behavior in real
// workerd against a local R2 simulation. Local validation only.
export { RoomHub } from "../../src/index";

type Env = {
  ROOM_HUBS: DurableObjectNamespace;
  ROOMS_R2: R2Bucket;
};

const USER = "darkuser";
const enc = new TextEncoder();

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The stub is intentionally any-typed: the probe config cannot carry the
    // full production Env generics, but the RPC surface is the real class.
    const hub = (room: string) =>
      env.ROOM_HUBS.get(env.ROOM_HUBS.idFromName(`${USER}:${room}`)) as unknown as {
        fetch(req: Request): Promise<Response>;
        rtPromote(input: unknown): Promise<{ ok: boolean; [k: string]: unknown }>;
        rtParity(): Promise<{ ok: true; files: Array<Record<string, unknown> & { ok: boolean; path: string; sha256?: string; sourceEtag?: string }> }>;
        rtFlush(): Promise<unknown>;
        rtPrimaryImport(input: unknown): Promise<{ ok: boolean; [k: string]: unknown }>;
        rtPrimaryOpen(input: unknown): Promise<{ ok: boolean; [k: string]: unknown }>;
        rtPrimaryReplace(input: unknown): Promise<{ ok: boolean; [k: string]: unknown }>;
        rtPrimaryEdit(input: unknown): Promise<{ ok: boolean; [k: string]: unknown }>;
      };
    try {
      if (url.pathname === "/ws") {
        // Forward the upgrade exactly like the production /web/api/presence
        // route does after auth: params become the socket's attachment.
        const room = url.searchParams.get("room") || "dark";
        const forward = new URL("https://hub.local/connect");
        for (const key of ["viewer", "prefix", "readonly"]) {
          const value = url.searchParams.get(key);
          if (value !== null) forward.searchParams.set(key, value);
        }
        return hub(room).fetch(new Request(forward.toString(), request));
      }
      const body: Record<string, unknown> =
        request.method === "POST" ? await request.json() : {};
      const room = String(body.room || url.searchParams.get("room") || "dark");
      const path = String(body.path || "");

      if (url.pathname === "/seed" && request.method === "POST") {
        const put = await env.ROOMS_R2.put(`users/${USER}/${room}/${path}`, String(body.content ?? ""));
        return json({ ok: true, etag: put ? put.etag : null });
      }
      if (url.pathname === "/promote" && request.method === "POST") {
        const object = await env.ROOMS_R2.get(`users/${USER}/${room}/${path}`);
        if (!object) return json({ ok: false, error: "not_found" }, 404);
        const content = await object.text();
        return json(await hub(room).rtPromote({ userId: USER, room, path, content, sourceEtag: object.etag }));
      }
      if (url.pathname === "/primary-import" && request.method === "POST") {
        const object = await env.ROOMS_R2.get(`users/${USER}/${room}/${path}`);
        if (!object) return json({ ok: false, error: "not_found" }, 404);
        return json(await hub(room).rtPrimaryImport({
          userId: USER,
          room,
          path,
          bytes: await object.arrayBuffer(),
          sourceEtag: object.etag,
        }));
      }
      if (url.pathname === "/primary-open" && request.method === "POST") {
        return json(await hub(room).rtPrimaryOpen({ userId: USER, room, path }));
      }
      if (url.pathname === "/primary-replace" && request.method === "POST") {
        return json(await hub(room).rtPrimaryReplace({
          userId: USER,
          room,
          path,
          clientId: String(body.clientId || "probe"),
          requestId: String(body.requestId || "replace-1"),
          intentHash: String(body.intentHash || "a".repeat(64)),
          baseVersion: String(body.baseVersion || ""),
          content: String(body.content ?? ""),
        }));
      }
      if (url.pathname === "/primary-edit" && request.method === "POST") {
        return json(await hub(room).rtPrimaryEdit({
          userId: USER,
          room,
          path,
          clientId: String(body.clientId || "probe"),
          requestId: String(body.requestId || "edit-1"),
          intentHash: String(body.intentHash || "b".repeat(64)),
          oldText: String(body.oldText || ""),
          newText: String(body.newText ?? ""),
          before: typeof body.before === "string" ? body.before : undefined,
          after: typeof body.after === "string" ? body.after : undefined,
        }));
      }
      if (url.pathname === "/foreign-write" && request.method === "POST") {
        const put = await env.ROOMS_R2.put(`users/${USER}/${room}/${path}`, String(body.content ?? ""));
        return json({ ok: Boolean(put), etag: put?.etag || null });
      }
      if (url.pathname === "/r2-get") {
        const object = await env.ROOMS_R2.get(`users/${USER}/${room}/${url.searchParams.get("path") || path}`);
        if (!object) return json({ ok: false, error: "not_found" }, 404);
        return json({
          ok: true,
          etag: object.etag,
          content: await object.text(),
          customMetadata: object.customMetadata || {},
        });
      }
      if (url.pathname === "/flush" && request.method === "POST") {
        return json(await hub(room).rtFlush());
      }
      if (url.pathname === "/parity") {
        // Same comparison the production parity route performs.
        const report = await hub(room).rtParity();
        const files: unknown[] = [];
        for (const row of report.files) {
          if (!row.ok) { files.push(row); continue; }
          const object = await env.ROOMS_R2.get(`users/${USER}/${room}/${row.path}`);
          const r2Sha = object ? await sha256(await object.text()) : "";
          files.push({
            ...row,
            r2_etag: object ? object.etag : null,
            match: Boolean(r2Sha) && r2Sha === row.sha256,
            etag_moved: Boolean(object && object.etag !== row.sourceEtag),
          });
        }
        return json({ ok: true, room, files });
      }
      if (url.pathname === "/shadow-head") {
        const object = await env.ROOMS_R2.get(
          `roomtext-shadow/users/${USER}/${room}/.history/${url.searchParams.get("path") || ""}/HEAD`,
        );
        if (!object) return json({ ok: false, error: "no_shadow_head" }, 404);
        return json({ ok: true, manifest: JSON.parse(await object.text()) });
      }
      if (url.pathname === "/r2-list") {
        const listed = await env.ROOMS_R2.list({ prefix: url.searchParams.get("prefix") || "", limit: 500 });
        return json({ ok: true, keys: listed.objects.map((o) => ({ key: o.key, etag: o.etag })) });
      }
      return json({ ok: false, error: "unknown route" }, 404);
    } catch (error) {
      return json({ ok: false, error: String(error) }, 500);
    }
  },
};
