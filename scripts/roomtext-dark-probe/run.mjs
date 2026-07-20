// Dark-mount validation: promote R2 files into the real RoomHub's RoomText
// engine, verify byte parity, edit over a real hibernating WebSocket, flush
// the shadow janitor, and PROVE production keys were never touched.
// Usage: node scripts/roomtext-dark-probe/run.mjs   (port 8865)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.env.PORT) || 8865;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = "dark";
const results = { phases: [], failures: [] };

function phase(name, ok, detail) {
  results.phases.push({ name, ok, detail });
  if (!ok) results.failures.push({ name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + JSON.stringify(detail).slice(0, 300) : ""}`);
}
const post = async (p, body) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const get = async (p) => (await fetch(BASE + p)).json();

// Fixture files: multi-byte content, a large body, and plain markdown — the
// shapes production rooms actually hold.
const FILES = [
  { path: "index.md", content: "# dark probe\n\nhello from the dark mount\n" },
  { path: "notes/emoji.md", content: "family: 👨‍👩‍👧‍👦 flag: 🏳️‍🌈 cjk: 漢字テスト 한국어\n".repeat(40) },
  { path: "notes/large.md", content: ("x".repeat(120) + "\n").repeat(4000) }, // ~484KB
  { path: "notes/crlf.md", content: "line one\r\nline two\r\nmixed\rendings\n" },
];

function wsClient(params) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}&${params}`);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.match(frame));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(frame);
    else inbox.push(frame);
  });
  return {
    ws,
    open: () => new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }),
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (match, ms = 8000) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
        waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
  };
}

// ─── boot wrangler dev ────────────────────────────────────────────────────
console.log(`booting wrangler dev on :${PORT} ...`);
const dev = spawn("npx", ["wrangler", "dev", "--config", "scripts/roomtext-dark-probe/wrangler.jsonc", "--port", String(PORT), "--local"], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let devLog = "";
dev.stdout.on("data", (d) => { devLog += d; });
dev.stderr.on("data", (d) => { devLog += d; });
let ready = false;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  try { await fetch(BASE + "/r2-list"); ready = true; break; } catch { /* not yet */ }
}
if (!ready) { console.error("wrangler did not become ready\n" + devLog.slice(-2000)); process.exit(1); }

try {
  // A. seed production-shaped keys and record their etags
  const seededEtags = new Map();
  for (const f of FILES) {
    const r = await post("/seed", { room: ROOM, path: f.path, content: f.content });
    seededEtags.set(f.path, r.etag);
  }
  const before = await get("/r2-list?prefix=users/");
  phase("seed: 4 production-shaped keys", before.keys.length === FILES.length, { keys: before.keys.length });

  // B. promote each file; re-promote must be refused, not clobbered
  let promoted = 0;
  for (const f of FILES) {
    const r = await post("/promote", { room: ROOM, path: f.path });
    if (r.ok) promoted++;
    else phase(`promote ${f.path}`, false, r);
  }
  phase("promote: all files enter the hot store", promoted === FILES.length, { promoted });
  const rePromote = await post("/promote", { room: ROOM, path: "index.md" });
  phase("re-promote refused (no clobber)", rePromote.ok === false, { error: rePromote.error });

  // C. parity: every hot head byte-identical to its R2 source
  const parity1 = await get(`/parity?room=${ROOM}`);
  const allMatch = parity1.files.length === FILES.length && parity1.files.every((f) => f.ok && f.match && !f.etag_moved);
  phase("parity after promote: 100% byte match", allMatch, parity1.files.map((f) => ({ path: f.path, match: f.match, dirty: f.dirty })));

  // D. flush: shadow keys appear; production keys byte-for-byte untouched
  const flush1 = await post("/flush", { room: ROOM });
  const shadow = await get("/r2-list?prefix=roomtext-shadow/");
  const afterSeed = await get("/r2-list?prefix=users/");
  const etagsUntouched = afterSeed.keys.length === FILES.length && afterSeed.keys.every((k) => [...seededEtags.values()].includes(k.etag));
  phase("flush: publishes to shadow prefix", shadow.keys.length >= FILES.length * 2, { shadowKeys: shadow.keys.length, flush: flush1.flushed });
  phase("flush: production users/ keys untouched", etagsUntouched, { keys: afterSeed.keys.length });
  const headKeys = shadow.keys.filter((k) => k.key.endsWith("/HEAD")).length;
  phase("flush: one HEAD manifest per file", headKeys === FILES.length, { headKeys });

  // E. live edit over a real hibernating WebSocket
  const editor = wsClient("viewer=alice&readonly=0");
  const watcher = wsClient("viewer=bob&readonly=0");
  const viewer = wsClient("viewer=carol&readonly=1");
  await Promise.all([editor.open(), watcher.open(), viewer.open()]);
  for (const c of [editor, watcher, viewer]) await c.next((f) => f.type === "hello");

  const connect = (c, id) => {
    c.send({ type: "connect", connectRequestId: id, protocolVersion: 1, fileId: "index.md", epoch: 0, lastRevision: 0 });
    return c.next((f) => f.type === "hydration" && f.connectRequestId === id);
  };
  const hydA = await connect(editor, "c-alice");
  phase("connect: snapshot hydration with exact bytes", hydA.hydration === "snapshot" && hydA.doc === FILES[0].content, { revision: hydA.headRevision });
  await connect(watcher, "c-bob");
  await connect(viewer, "c-carol");

  editor.send({ type: "push", pushes: [{ protocol: 1, fileId: "index.md", epoch: hydA.epoch, baseRevision: hydA.headRevision, clientId: "alice", requestId: "r1", changes: [{ from: 0, to: 0, insert: "EDITED: " }] }] });
  const ack = await editor.next((f) => f.type === "ack");
  phase("push: echo-as-ack commit to sender", ack.status === "commit" && ack.revision === hydA.headRevision + 1, ack);
  const upd = await watcher.next((f) => f.type === "updates");
  phase("push: updates broadcast to other same-file socket", upd.fileId === "index.md" && upd.updates.length === 1, { headRevision: upd.headRevision });

  // idempotent replay: same (clientId, requestId) must ack identically, no re-broadcast
  editor.send({ type: "push", pushes: [{ protocol: 1, fileId: "index.md", epoch: hydA.epoch, baseRevision: hydA.headRevision, clientId: "alice", requestId: "r1", changes: [{ from: 0, to: 0, insert: "EDITED: " }] }] });
  const replayAck = await editor.next((f) => f.type === "ack");
  phase("push: idempotent replay acks same revision", replayAck.revision === ack.revision, replayAck);

  // readonly socket: push must be refused with a non-retryable discard
  viewer.send({ type: "push", pushes: [{ protocol: 1, fileId: "index.md", epoch: hydA.epoch, baseRevision: ack.revision, clientId: "carol", requestId: "rx", changes: [{ from: 0, to: 0, insert: "HACK" }] }] });
  const discard = await viewer.next((f) => f.type === "discard");
  phase("readonly socket: push refused, non-retryable", discard.retryable === false, discard);

  // JSON ping answered at app level (distinct from the raw-string keepalive)
  editor.send({ type: "ping", at: 12345 });
  const pong = await editor.next((f) => f.type === "pong");
  phase("json ping answered by engine host", pong.at === 12345, pong);

  editor.ws.close(); watcher.ws.close(); viewer.ws.close();

  // F. flush after edit: hot diverges from source (expected in dark mode),
  // production keys STILL untouched, shadow HEAD advances
  await post("/flush", { room: ROOM });
  const parity2 = await get(`/parity?room=${ROOM}`);
  const indexRow = parity2.files.find((f) => f.path === "index.md");
  const othersStillMatch = parity2.files.filter((f) => f.path !== "index.md").every((f) => f.match);
  phase("after edit: hot head diverged, source etag unmoved (dark)", indexRow && !indexRow.match && !indexRow.etag_moved && indexRow.revision === ack.revision, { revision: indexRow?.revision });
  phase("after edit: untouched files still 100% match", othersStillMatch, {});
  const finalUsers = await get("/r2-list?prefix=users/");
  phase("final: production keys byte-for-byte untouched", finalUsers.keys.every((k) => [...seededEtags.values()].includes(k.etag)), {});

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify({ passed: results.phases.filter((p) => p.ok).length, failed: results.failures.length, failures: results.failures }, null, 2));
  process.exitCode = results.failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error("HARNESS ERROR:", error);
  console.error(devLog.slice(-1500));
  process.exitCode = 1;
} finally {
  dev.kill("SIGTERM");
  await sleep(500);
  dev.kill("SIGKILL");
}
