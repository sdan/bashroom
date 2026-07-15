// Cutover A/B: the scenario that breaks production today — an agent writes
// the whole file while a human is typing — run on both paths with identical
// timing and identical simulated network latency.
//
//   Path A (current production semantics, simulated in-driver): whole-file
//     etag-CAS saves + poke-triggered refetch, with constants taken from the
//     shipped clients (autosave debounce 700ms, presence refetch debounce
//     350ms, conflict = "load theirs" which discards the local buffer —
//     web-collab.ts behavior).
//   Path B (RoomText, real): the workerd WS probe — per-keystroke changeset
//     pushes, agent whole-file write as a replace changeset, rebase at the
//     server, echo-as-ack broadcasts.
//
// Pre-registered decision rule: cutover is justified only if Path B loses
// ZERO human keystrokes where Path A loses >0, AND Path B's writer-to-
// observer p50 latency is no worse than Path A's. Simulated one-way network
// latency: 25ms on every driver<->server hop, both paths equally.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const base = process.argv[2] || "http://localhost:8797";
const ONE_WAY_MS = 25;
const KEYSTROKE_MS = 80;
const KEYSTROKES = 60;
const AGENT_AT = 30; // agent writes after this many keystrokes
const AUTOSAVE_MS = 700; // web editor autosave cadence (path A)
const REFETCH_DEBOUNCE_MS = 350; // presence-triggered refetch debounce (path A)
const SENTENCE = "the quick brown fox jumps over the lazy dog and keeps typing on".slice(0, KEYSTROKES);
const AGENT_HEADER = "# agent header\n\n";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const net = () => sleep(ONE_WAY_MS);
const now = () => performance.now();

// ── Path A: current production semantics (simulated, same latency model) ──
async function runPathA() {
  const events = [];
  const t0 = now();
  const log = (type, detail) => events.push({ t: now() - t0, type, ...detail });

  // the "R2 object" + etag CAS
  let remote = { content: "", etag: 1 };
  const casPut = async (content, baseEtag) => {
    await net();
    const ok = remote.etag === baseEtag;
    if (ok) remote = { content, etag: remote.etag + 1 };
    const reply = { ok, etag: remote.etag, content: remote.content };
    await net();
    return reply;
  };
  const refetch = async () => { await net(); const r = { ...remote }; await net(); return r; };

  // observer: refetches REFETCH_DEBOUNCE_MS after any successful put (poke)
  let observerSeen = "";
  const poke = async (writtenAt) => {
    await sleep(REFETCH_DEBOUNCE_MS);
    const got = await refetch();
    observerSeen = got.content;
    log("observer-saw", { latency: now() - t0 - writtenAt, content: got.content });
  };
  const pokes = [];

  // human: local buffer, autosave loop
  let buffer = "";
  let lastAckedEtag = 1;
  let lastAckedContent = "";
  let lostKeystrokes = 0;
  let saveTimer = 0;
  let agentSurvived = false;

  const autosave = async () => {
    const attempt = buffer;
    const sentAt = now() - t0;
    const reply = await casPut(attempt, lastAckedEtag);
    if (reply.ok) {
      lastAckedEtag = reply.etag;
      lastAckedContent = attempt;
      log("human-saved", { chars: attempt.length });
      pokes.push(poke(sentAt));
    } else {
      // Production behavior: "Changed underneath you" -> load theirs.
      // Everything typed since the last acked save is discarded.
      const unsaved = buffer.length - lastAckedContent.length;
      lostKeystrokes += Math.max(0, unsaved);
      log("human-conflict-load-theirs", { lost: Math.max(0, unsaved) });
      buffer = reply.content; // reload with the agent's version
      lastAckedEtag = reply.etag;
      lastAckedContent = reply.content;
      agentSurvived = reply.content.startsWith(AGENT_HEADER);
    }
  };

  let agentDone;
  for (let i = 0; i < KEYSTROKES; i++) {
    buffer += SENTENCE[i];
    log("keystroke", { i });
    if (now() - t0 - saveTimer >= AUTOSAVE_MS) { saveTimer = now() - t0; await autosave(); }
    if (i === AGENT_AT) {
      agentDone = (async () => {
        // agent: read-modify-write of the whole file (bashroom_write today)
        const seen = await refetch();
        const reply = await casPut(AGENT_HEADER + seen.content, seen.etag);
        log("agent-wrote", { ok: reply.ok });
        if (reply.ok) pokes.push(poke(now() - t0));
        return reply.ok;
      })();
    }
    await sleep(KEYSTROKE_MS);
  }
  await autosave(); // final save
  const agentOk = await agentDone;
  await Promise.all(pokes);
  await sleep(REFETCH_DEBOUNCE_MS + 4 * ONE_WAY_MS);
  const final = await refetch();
  agentSurvived = agentSurvived || final.content.startsWith(AGENT_HEADER);

  const latencies = events.filter((e) => e.type === "observer-saw").map((e) => e.latency);
  return {
    path: "A: whole-file CAS + refetch (current prod semantics)",
    events,
    lostKeystrokes,
    agentSurvived,
    humanTextSurvived: final.content.includes(SENTENCE.slice(-Math.min(10, SENTENCE.length - lostKeystrokes)) ) && lostKeystrokes === 0,
    finalContent: final.content,
    observerLatencies: latencies,
  };
}

// ── Path B: RoomText over the real workerd WS probe ──
function peerOf(room) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?room=${room}`);
  const frames = [];
  const waiters = [];
  ws.on("message", async (data) => {
    await net(); // simulated inbound latency
    const frame = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(frame); else frames.push(frame);
  });
  return {
    ws,
    ready: new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }),
    async send(frame) { await net(); ws.send(JSON.stringify(frame)); }, // simulated outbound latency
    next(timeoutMs = 15_000) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
        waiters.push((f) => { clearTimeout(timer); resolve(f); });
      });
    },
    onFrame(handler) { ws.on("message", async (data) => { handler(JSON.parse(data.toString())); }); },
    close() { ws.close(); },
  };
}

async function runPathB() {
  const room = `ab-${Date.now()}`;
  const fileId = "ab-doc";
  const events = [];
  const t0 = now();
  const log = (type, detail) => events.push({ t: now() - t0, type, ...detail });

  const http = async (path, body) => {
    const r = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}room=${room}`, body === undefined
      ? undefined
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
  assert.equal((await http("/create", { fileId, path: "notes/ab.md", content: "" })).ok, true);

  const writer = peerOf(room);
  const agent = peerOf(room);
  const observer = peerOf(room);
  await Promise.all([writer.ready, agent.ready, observer.ready]);
  for (const p of [writer, agent, observer]) {
    await p.send({ type: "connect", connectRequestId: "c", protocolVersion: 1, fileId, epoch: 0, lastRevision: 0 });
    const h = await p.next();
    assert.equal(h.type, "hydration");
  }

  // observer state: applies broadcast changes; records latency vs send time
  const sendTimes = new Map(); // updateToken -> sent-at
  let observerLen = 0;
  const observerLatencies = [];
  let agentObserverLatency;
  const observerDone = (async () => {
    let seenRevisions = 0;
    while (seenRevisions < KEYSTROKES + 2) { // keystrokes + agent write + final marker
      const frame = await observer.next();
      if (frame.type !== "updates") continue;
      for (const update of frame.updates) {
        seenRevisions = update.revision;
        log("observer-update", { clientId: update.clientId, changes: update.changes });
        const sentAt = sendTimes.get(update.updateToken);
        if (sentAt !== undefined) {
          const latency = now() - t0 - sentAt;
          if (update.clientId === "agent") agentObserverLatency = latency;
          else observerLatencies.push(latency);
        }
      }
    }
  })();

  // writer: per-keystroke pushes, single in-flight (await echo before next)
  let revision = 0;
  let docLen = 0;
  let agentTask;
  const writerInbox = (async function* () { for (;;) yield await writer.next(); })();
  const pushAndAwait = async (clientId, requestId, changes, peer = writer) => {
    const tok = JSON.stringify([clientId, requestId]);
    sendTimes.set(tok, now() - t0);
    await peer.send({ type: "push", pushes: [{ protocol: 1, fileId, epoch: 1, baseRevision: revision, clientId, requestId, changes }] });
    for (;;) {
      const frame = clientId === "writer" ? (await writerInbox.next()).value : await peer.next();
      if (frame.type !== "updates") continue;
      for (const u of frame.updates) revision = Math.max(revision, u.revision);
      const mine = frame.updates.find((u) => u.updateToken === tok);
      if (mine) return mine;
    }
  };

  for (let i = 0; i < KEYSTROKES; i++) {
    const mine = await pushAndAwait("writer", `k${i}`, [{ from: docLen, to: docLen, insert: SENTENCE[i] }]);
    // rebased inserts may land shifted (agent prepended a header) — track real length
    docLen = docLen + 1 + (mine.changes[0].from - docLen);
    docLen = mine.changes[0].from + 1;
    log("keystroke", { i, revision: mine.revision });
    if (i === AGENT_AT) {
      agentTask = (async () => {
        const head = await http(`/open?file=${fileId}`);
        const mineA = await pushAndAwait("agent", "write", [{ from: 0, to: 0, insert: AGENT_HEADER }], agent);
        log("agent-wrote", { revision: mineA.revision });
        return true;
      })();
    }
    await sleep(Math.max(0, KEYSTROKE_MS - 2 * ONE_WAY_MS));
  }
  await agentTask;
  await pushAndAwait("writer", "fin", [{ from: docLen, to: docLen, insert: "." }]);

  await observerDone.catch(() => {});
  const final = await http(`/open?file=${fileId}`);
  writer.close(); agent.close(); observer.close();

  return {
    path: "B: RoomText rebase over WS (real workerd)",
    events,
    lostKeystrokes: final.content.includes(SENTENCE) ? 0 : KEYSTROKES - [...SENTENCE].filter((ch) => final.content.includes(ch)).length,
    agentSurvived: final.content.startsWith(AGENT_HEADER),
    humanTextSurvived: final.content.includes(SENTENCE),
    finalContent: final.content,
    observerLatencies,
    agentObserverLatency,
  };
}

const pct = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : NaN; };

const A = await runPathA();
const B = await runPathB();
const summary = (r) => ({
  path: r.path,
  "human keystrokes lost": r.lostKeystrokes,
  "agent write survived": r.agentSurvived,
  "human text survived": r.humanTextSurvived,
  "observer p50 ms": Math.round(pct(r.observerLatencies, 0.5)),
  "observer p95 ms": Math.round(pct(r.observerLatencies, 0.95)),
  "visible observer events": r.observerLatencies.length,
});
console.table([summary(A), summary(B)]);
console.log("A final:", JSON.stringify(A.finalContent.slice(0, 90)));
console.log("B final:", JSON.stringify(B.finalContent.slice(0, 90)));

writeFileSync(new URL("./ab-cutover-results.json", import.meta.url), JSON.stringify({
  config: { ONE_WAY_MS, KEYSTROKE_MS, KEYSTROKES, AGENT_AT, AUTOSAVE_MS, REFETCH_DEBOUNCE_MS },
  a: { ...A, events: A.events }, b: { ...B, events: B.events },
}, null, 1));
console.log("events written to ab-cutover-results.json");
