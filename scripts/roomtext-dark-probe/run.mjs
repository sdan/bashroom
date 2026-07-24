// Dark-mount validation: promote R2 files into the real RoomHub's RoomText
// engine, verify byte parity, edit over a real hibernating WebSocket, flush
// the shadow janitor, and PROVE production keys were never touched.
// Usage: node scripts/roomtext-dark-probe/run.mjs   (port 8865)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.env.PORT) || 8865;
const BASE = `http://127.0.0.1:${PORT}`;
// Fresh room per run: wrangler dev persists local DO + R2 state across
// boots, so a fixed room name would find files already promoted/edited.
// A unique room gives every run an empty DO and empty R2 prefix.
const ROOM = `dark-${process.pid}-${Date.now().toString(36)}`;
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

function wsClient(params, room = ROOM) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${encodeURIComponent(room)}&${params}`);
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
  const usersPrefix = `users/darkuser/${ROOM}/`;
  const before = await get(`/r2-list?prefix=${usersPrefix}`);
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
  const shadow = await get(`/r2-list?prefix=roomtext-shadow/users/darkuser/${ROOM}/`);
  const afterSeed = await get(`/r2-list?prefix=${usersPrefix}`);
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
  const selfUpdate = await editor.next((f) => f.type === "updates");
  const ackRevision = selfUpdate.updates[0]?.revision;
  phase("push: canonical echo acknowledges sender", ackRevision === hydA.headRevision + 1, { revision: ackRevision });
  const upd = await watcher.next((f) => f.type === "updates");
  phase("push: updates broadcast to other same-file socket", upd.fileId === "index.md" && upd.updates.length === 1, { headRevision: upd.headRevision });

  // idempotent replay: same (clientId, requestId) must ack identically, no re-broadcast
  editor.send({ type: "push", pushes: [{ protocol: 1, fileId: "index.md", epoch: hydA.epoch, baseRevision: hydA.headRevision, clientId: "alice", requestId: "r1", changes: [{ from: 0, to: 0, insert: "EDITED: " }] }] });
  const replayAck = await editor.next((f) => f.type === "ack");
  phase("push: idempotent replay acks same revision", replayAck.revision === ackRevision, replayAck);

  // readonly socket: push must be refused with a non-retryable discard
  viewer.send({ type: "push", pushes: [{ protocol: 1, fileId: "index.md", epoch: hydA.epoch, baseRevision: ackRevision, clientId: "carol", requestId: "rx", changes: [{ from: 0, to: 0, insert: "HACK" }] }] });
  const discard = await viewer.next((f) => f.type === "discard");
  phase("readonly socket: push refused, non-retryable", discard.retryable === false, discard);

  // JSON ping answered at app level (distinct from the raw-string keepalive)
  editor.send({ type: "ping", at: 12345 });
  const pong = await editor.next((f) => f.type === "pong");
  phase("json ping answered by engine host", pong.at === 12345, pong);

  editor.ws.close(); watcher.ws.close(); viewer.ws.close();

  // E2. prefix-scoped EDIT socket (edit-role share): can write inside its
  // prefix, must be fenced out of the rest of the room — the write-side
  // fence the adversarial review found missing. No prior connect needed for
  // a push, so this is exactly the capability-escape attack.
  const eve = wsClient("viewer=eve&readonly=0&prefix=notes");
  await eve.open();
  await eve.next((f) => f.type === "hello");
  eve.send({ type: "push", pushes: [{ protocol: 1, fileId: "index.md", epoch: hydA.epoch, baseRevision: ackRevision, clientId: "eve", requestId: "e1", changes: [{ from: 0, to: 0, insert: "ESCAPED" }] }] });
  const fenced = await eve.next((f) => f.type === "discard");
  phase("prefix fence: out-of-prefix push refused (no oracle)", fenced.code === "NOT_FOUND" && fenced.retryable === false, fenced);
  eve.send({ type: "push", pushes: [{ protocol: 1, fileId: "notes/crlf.md", epoch: 1, baseRevision: 0, clientId: "eve", requestId: "e2", changes: [{ from: 0, to: 0, insert: "in-prefix: " }] }] });
  const inPrefix = await eve.next((f) => f.type === "updates");
  phase("prefix fence: in-prefix push commits", inPrefix.updates[0]?.revision === 1, inPrefix);
  eve.ws.close();

  // F. flush after edit: hot diverges from source (expected in dark mode),
  // production keys STILL untouched, shadow HEAD advances
  await post("/flush", { room: ROOM });
  const parity2 = await get(`/parity?room=${ROOM}`);
  const indexRow = parity2.files.find((f) => f.path === "index.md");
  // index.md (alice) and notes/crlf.md (eve) were both edited; the other
  // two were never touched and must still match their R2 source exactly.
  const editedPaths = new Set(["index.md", "notes/crlf.md"]);
  const untouchedStillMatch = parity2.files.filter((f) => !editedPaths.has(f.path)).every((f) => f.match);
  phase("after edit: hot head diverged, source etag unmoved (dark)", indexRow && !indexRow.match && !indexRow.etag_moved && indexRow.revision === ackRevision, { revision: indexRow?.revision });
  phase("after edit: untouched files still 100% match", untouchedStillMatch, {});
  const finalUsers = await get(`/r2-list?prefix=${usersPrefix}`);
  phase("final: production keys byte-for-byte untouched", finalUsers.keys.length === FILES.length && finalUsers.keys.every((k) => [...seededEtags.values()].includes(k.etag)), { keys: finalUsers.keys.length });

  // G. the janitor RETIRES its work — the phase that would have caught the
  // infinite-loop bug: after a full drain, the shadow HEAD must sit at the
  // edited head revision, the dirty set must be EMPTY, and a further flush
  // must be a no-op. (Pre-fix: artifact exported at snapshot_revision 0,
  // clearDirty(0) retired nothing, alarm re-fired every 2s forever.)
  const head = await get(`/shadow-head?room=${ROOM}&path=index.md`);
  phase("janitor: shadow HEAD advanced to edited revision", head.ok && head.manifest.revision === ackRevision, head.manifest);
  const drain2 = await post("/flush", { room: ROOM });
  phase("janitor: dirty set fully retired (no loop)", drain2.remaining === 0 && drain2.results.length === 0, drain2);
  const parity3 = await get(`/parity?room=${ROOM}`);
  phase("janitor: no file left dirty after drain", parity3.files.every((f) => f.dirty === false), parity3.files.map((f) => ({ path: f.path, dirty: f.dirty })));

  // H. Production-primary migration path: conditional same-byte claim,
  // literal edit, exact canonical projection, idempotent retry, and foreign
  // writer quarantine. Both copies must survive the adversarial final step.
  const primaryRoom = `${ROOM}-primary`;
  const primaryPath = "index.md";
  const primarySource = "# primary\n\nStatus: draft\n";
  await post("/seed", { room: primaryRoom, path: primaryPath, content: primarySource });
  const imported = await post("/primary-import", { room: primaryRoom, path: primaryPath });
  phase("primary: exact R2 bytes imported at revision zero", imported.ok && imported.file.content === primarySource && imported.file.version === "rt1:1:0", {
    version: imported.file?.version,
  });
  const claimed = await get(`/r2-get?room=${encodeURIComponent(primaryRoom)}&path=${encodeURIComponent(primaryPath)}`);
  phase("primary: R2 source claimed without changing bytes", claimed.content === primarySource && claimed.customMetadata["br-authority"] === "roomtext-v1", {
    authority: claimed.customMetadata["br-authority"],
  });

  const literal = await post("/primary-edit", {
    room: primaryRoom,
    path: primaryPath,
    requestId: "literal-1",
    intentHash: "b".repeat(64),
    oldText: "draft",
    newText: "approved",
    before: "Status: ",
  });
  phase("primary: literal edit commits one new revision", literal.ok && literal.file.version === "rt1:1:1" && literal.file.content.includes("approved"), {
    version: literal.file?.version,
  });
  const projected = await get(`/r2-get?room=${encodeURIComponent(primaryRoom)}&path=${encodeURIComponent(primaryPath)}`);
  phase("primary: canonical R2 projection matches RoomText head", projected.content === literal.file.content && projected.customMetadata["br-revision"] === "1", {
    revision: projected.customMetadata["br-revision"],
  });

  const retry = await post("/primary-edit", {
    room: primaryRoom,
    path: primaryPath,
    requestId: "literal-1",
    intentHash: "b".repeat(64),
    oldText: "draft",
    newText: "approved",
    before: "Status: ",
  });
  phase("primary: lost-response retry replays instead of resolving twice", retry.ok && retry.replayed === true && retry.file.version === "rt1:1:1", {
    replayed: retry.replayed,
  });

  const staleReplace = await post("/primary-replace", {
    room: primaryRoom,
    path: primaryPath,
    baseVersion: "rt1:1:0",
    requestId: "replace-stale",
    intentHash: "c".repeat(64),
    content: "stale overwrite",
  });
  phase("primary: stale whole-file replacement conflicts safely", staleReplace.ok === false && staleReplace.error === "CONFLICT" && staleReplace.file.content.includes("approved"), {
    error: staleReplace.error,
  });

  const foreign = "FOREIGN R2 COPY — preserve me\n";
  await post("/foreign-write", { room: primaryRoom, path: primaryPath, content: foreign });
  const quarantined = await post("/primary-open", { room: primaryRoom, path: primaryPath });
  const foreignStillThere = await get(`/r2-get?room=${encodeURIComponent(primaryRoom)}&path=${encodeURIComponent(primaryPath)}`);
  phase("primary: foreign R2 write quarantines instead of overwriting", quarantined.ok === false && quarantined.error === "R2_DIVERGED" && foreignStillThere.content === foreign, {
    error: quarantined.error,
  });
  const preserved = wsClient("viewer=recovery&readonly=1", primaryRoom);
  await preserved.open();
  await preserved.next((f) => f.type === "hello");
  preserved.send({ type: "connect", connectRequestId: "recover", protocolVersion: 1, fileId: primaryPath, epoch: 0, lastRevision: 0 });
  const preservedHead = await preserved.next((f) => f.type === "hydration" && f.connectRequestId === "recover");
  phase("primary: RoomText copy also survives divergence", preservedHead.doc === literal.file.content && preservedHead.headRevision === 1, {
    revision: preservedHead.headRevision,
  });
  preserved.ws.close();

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
