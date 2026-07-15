// Local verification harness for the bashroom web UI.
// Serves the REAL WEB_INDEX_HTML (extracted from src/web-ui.ts, escapes
// undone) on every path, with mocked /web/api endpoints reproducing prod
// topology (18 rooms, staggered tree loads) plus a presence WS mock that
// mirrors the RoomHub contract. POST /test/emit {room, msg} broadcasts a
// presence frame and (for writes) bumps the file's revision so the SPA's
// live refetch observably changes content.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const src = readFileSync(process.argv[2], "utf8");
const start = src.indexOf("const WEB_INDEX_HTML = `") + "const WEB_INDEX_HTML = `".length;
const end = src.lastIndexOf("`;");
// Faithful template evaluation — serve EXACTLY what the deployed worker
// serves. (The old regex-unescape silently fixed escape bugs that then
// broke prod: \n inside the literal becomes a real newline in production.)
let HTML = new Function("return `" + src.slice(start, end) + "`;")();
// Anchor on the unique #app div, NOT on "<body>" — that string also appears
// inside a CSS comment in the <style> block, where injected scripts land as
// inert stylesheet text and never execute.
HTML = HTML.replace('<div id="app">', '<script>try{localStorage.setItem("bashroom.token","br_user_mockpreview")}catch(_){}</script><div id="app">');

const ROOMS = ["ant-takehome","milkdown-test","personal","sealist","quack","bashroom",
  "llmh-current","design","llmh-labs-mail","llmh-accel","vmux","geospot","jokegen",
  "learning","yecombinator","continualcode","stemplayer","longloop"];

function treeFor(room) {
  const n = room === "geospot" ? 0 : 24;
  const files = [];
  for (let i = 0; i < n; i++) files.push({ path: `notes/${room}-file-${String(i).padStart(2,"0")}.md`, updated_at: "2026-07-01T00:00:00Z", size_bytes: 1000 + i });
  files.push({ path: "index.md", updated_at: "2026-07-01T00:00:00Z", size_bytes: 500 });
  files.push({ path: "AGENTS.md", updated_at: "2026-07-01T00:00:00Z", size_bytes: 500 });
  if (room === "geospot") {
    for (const f of ["geozero.md","current-plan.md","reading-list.md","README.md"])
      files.push({ path: "notes/" + f, updated_at: "2026-06-03T00:00:00Z", size_bytes: 27000 });
  }
  return files;
}

let treeDelay = 0;
let putCount = 0;
const fileRev = new Map(); // "room/path" -> rev counter (bumped by /test/emit writes)
const roomSockets = new Map(); // room -> Set<ws>
const json = (res, obj) => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", c => b += c); req.on("end", () => resolve(b)); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/test/emit" && req.method === "POST") {
    const { room, msg } = JSON.parse(await readBody(req) || "{}");
    if (msg && msg.type === "write" && msg.path) {
      const key = room + "/" + msg.path;
      fileRev.set(key, (fileRev.get(key) || 0) + 1);
    }
    const sockets = roomSockets.get(room) || new Set();
    for (const ws of sockets) { try { ws.send(JSON.stringify(msg)); } catch (_) {} }
    return json(res, { ok: true, delivered: sockets.size });
  }
  if (url.pathname === "/web/api/file" && req.method === "PUT") {
    const p = JSON.parse(await readBody(req) || "{}");
    putCount += 1;
    return json(res, { ok: true, file: { path: p.path, content: p.content, etag: "e" + putCount, version: putCount + 3, size_bytes: (p.content || "").length, updated_at: new Date().toISOString(), is_binary: false } });
  }
  if (url.pathname === "/web/api/share" && req.method === "POST") {
    const p = JSON.parse(await readBody(req) || "{}");
    return json(res, { ok: true, slug: "mock-" + (p.role || "view"), role: p.role || "view", url: "http://localhost:" + (Number(process.env.PORT) || 8123) + "/s/mock-" + (p.role || "view") });
  }
  if (url.pathname === "/web/api/put-count") return json(res, { putCount });
  if (url.pathname === "/web/api/rooms") {
    const active = url.searchParams.get("active") || "";
    treeDelay = 0;
    return json(res, { ok: true, handle: "sdan", rooms: ROOMS.map(room => ({ room })), active: active || undefined, tree: active ? treeFor(active) : undefined });
  }
  if (url.pathname === "/web/api/tree") {
    const room = url.searchParams.get("room");
    treeDelay += 250;
    return setTimeout(() => json(res, { ok: true, files: treeFor(room) }), treeDelay);
  }
  if (url.pathname === "/web/api/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const results = [];
    for (const room of ROOMS) for (const f of treeFor(room)) {
      if (results.length >= 40) break;
      if (f.path.toLowerCase().includes(q) || room.includes(q)) results.push({ room, path: f.path, line: 3, preview: "mock line mentioning " + q + " inside " + f.path });
    }
    return setTimeout(() => json(res, { ok: true, query: q, results, truncated: false }), 150);
  }
  if (url.pathname === "/web/api/file") {
    const room = url.searchParams.get("room");
    const path = url.searchParams.get("path");
    const rev = fileRev.get(room + "/" + path) || 0;
    return json(res, { ok: true, file: { path, content: "# " + path + "\n\nMock body rev " + rev + " for **" + path + "**.\n\n- one\n- two\n\n```mermaid\nflowchart LR\n  Agent --> Bashroom\n  Bashroom --> Document\n```\n\n```ascii\nagent ---> shared document\n```\n", etag: "e1-r" + rev, version: 3 + rev, size_bytes: 123, updated_at: "2026-07-01T00:00:00Z", is_binary: false } });
  }
  // Mirrors prod: /s/<slug> edit links serve the same SPA with an injected
  // capability grant (single-document share mode, no sidebar).
  if (url.pathname.startsWith("/s/")) {
    const boot = '<script>window.BASHROOM_SHARE={slug:"mockslug",room:"ant-takehome",path:"index.md",role:"edit",'
      + 'file:{path:"index.md",content:"# index.md\\n\\nInlined by the grant — painted with zero fetches.\\n",etag:"e-inline",updated_at:"2026-07-01T00:00:00Z",size_bytes:64,is_binary:false}};</script>';
    return res.writeHead(200, { "content-type": "text/html" }).end(HTML.replace('<div id="app">', boot + '<div id="app">'));
  }
  res.writeHead(200, { "content-type": "text/html" }).end(HTML);
});

// Presence WS mock — mirrors RoomHub: echoes the non-tok subprotocol,
// requires a tok.* credential slot, sends a hello frame on connect.
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protos) => [...protos].find(p => !p.startsWith("tok.")) || false,
});
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/web/api/presence") return socket.destroy();
  const protos = String(req.headers["sec-websocket-protocol"] || "");
  if (!protos.split(",").some(p => p.trim().startsWith("tok."))) { socket.write("HTTP/1.1 401 unauthorized\r\n\r\n"); return socket.destroy(); }
  const room = url.searchParams.get("room") || "";
  // Actor identity for the relay: derive from the tok.* slot — the app's
  // real token maps to "sdan"; test sockets use tok.<name> to pose as others.
  const tokSlot = protos.split(",").map(p => p.trim()).find(p => p.startsWith("tok.")).slice(4);
  const viewer = tokSlot.startsWith("br_user_") ? "sdan" : tokSlot;
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!roomSockets.has(room)) roomSockets.set(room, new Set());
    roomSockets.get(room).add(ws);
    ws.on("close", () => roomSockets.get(room)?.delete(ws));
    ws.on("message", (m) => {
      const s = String(m);
      if (s === "ping") return ws.send("pong");
      // Draft relay, mirroring RoomHub: fan out to the room's OTHER sockets.
      try {
        const frame = JSON.parse(s);
        if (frame.type !== "draft" || typeof frame.path !== "string") return;
        const out = JSON.stringify({ type: "draft", actor: viewer, path: frame.path, caret: frame.caret || 0, content: frame.content || "", ts: Date.now() });
        for (const other of roomSockets.get(room)) { if (other !== ws) { try { other.send(out); } catch (_) {} } }
      } catch (_) {}
    });
    ws.send(JSON.stringify({
      type: "hello",
      recent: [{ ts: Date.now() - 120_000, actor: "codex", path: "notes/geozero.md", etag: "e-old" }],
      viewers: roomSockets.get(room).size + 2,
      // Mirrors the RoomHub roster: signed-in handles plus animals dealt to
      // anonymous share-link viewers.
      roster: [{ name: "sdan" }, { name: "otter", anon: true }, { name: "capybara", anon: true }],
      you: "sdan",
    }));
  });
});

const port = Number(process.env.PORT) || 8123;
server.listen(port, () => console.log("harness on http://localhost:" + port));
