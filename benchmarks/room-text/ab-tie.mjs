// The tie test: json-joy mounted behind the SAME WebSocket surface, same DO,
// same durability pattern (patch persisted via sql.exec behind the output
// gate), same simulated 25ms one-way network, same scenario as ab-cutover
// Path B (60 keystrokes, agent whole-file header write at #30).
//
// PRE-REGISTERED PREDICTION (stated before first run): observer p50 within
// ±10ms of RoomText's measured 54ms, zero keystrokes lost for both. The tie
// is the result — at system scale the engine vanishes behind the network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const { Model } = require("json-joy/lib/json-crdt/index.js");
const { Patch } = require("json-joy/lib/json-crdt-patch/index.js");

const base = process.argv[2] || "http://localhost:8797";
const room = `tie-${Date.now()}`;
const fileId = "tie-doc";
const ONE_WAY_MS = 25;
const KEYSTROKE_MS = 80;
const KEYSTROKES = 60;
const AGENT_AT = 30;
const SENTENCE = "the quick brown fox jumps over the lazy dog and keeps typing on".slice(0, KEYSTROKES);
const AGENT_HEADER = "# agent header\n\n";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const net = () => sleep(ONE_WAY_MS);
const now = () => performance.now();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));

function peer() {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?room=${room}`);
  const frames = [];
  const waiters = [];
  ws.on("message", async (data) => {
    await net();
    const frame = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(frame); else frames.push(frame);
  });
  return {
    ready: new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }),
    async send(frame) { await net(); ws.send(JSON.stringify(frame)); },
    next(timeoutMs = 15_000) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
        waiters.push((f) => { clearTimeout(timer); resolve(f); });
      });
    },
    close() { ws.close(); },
  };
}

const t0 = now();
const writer = peer(), agent = peer(), observer = peer();
await Promise.all([writer.ready, agent.ready, observer.ready]);

await writer.send({ type: "jj-create", fileId });
assert.equal((await writer.next()).type, "jj-created");

// hydrate: each peer forks its replica from the canonical model binary
async function hydrate(p) {
  await p.send({ type: "jj-connect", fileId });
  const frame = await p.next();
  assert.equal(frame.type, "jj-hydration");
  return Model.fromBinary(unhex(frame.modelHex)).fork();
}
const writerModel = await hydrate(writer);
const agentModel = await hydrate(agent);
const observerModel = await hydrate(observer);

const sendTimes = new Map();
const observerLatencies = [];
let agentObserverLatency;
const observerDone = (async () => {
  let applied = 0;
  while (applied < KEYSTROKES + 1) {
    const frame = await observer.next();
    if (frame.type !== "jj-updates") continue;
    for (const update of frame.updates) {
      observerModel.applyPatch(Patch.fromBinary(unhex(update.patchHex)));
      applied++;
      const sentAt = sendTimes.get(update.token);
      if (sentAt !== undefined) {
        const latency = now() - t0 - sentAt;
        if (update.token.startsWith("agent")) agentObserverLatency = latency;
        else observerLatencies.push(latency);
      }
    }
  }
})();

async function pushPatch(p, model, token) {
  const patch = model.api.flush();
  sendTimes.set(token, now() - t0);
  await p.send({ type: "jj-push", fileId, token, patchHex: hex(patch.toBinary()) });
  // echo-as-ack: wait for own token (skipping others', applying them locally)
  for (;;) {
    const frame = await p.next();
    if (frame.type !== "jj-updates") continue;
    for (const update of frame.updates) {
      if (update.token !== token) model.applyPatch(Patch.fromBinary(unhex(update.patchHex)));
    }
    if (frame.updates.some((u) => u.token === token)) return;
  }
}

let agentTask;
const writerStr = () => writerModel.api.str([]);
for (let i = 0; i < KEYSTROKES; i++) {
  const content = writerModel.view();
  writerStr().ins(content.length, SENTENCE[i]); // append at own replica's end
  await pushPatch(writer, writerModel, `w:${i}`);
  if (i === AGENT_AT) {
    agentTask = (async () => {
      agentModel.api.str([]).ins(0, AGENT_HEADER);
      await pushPatch(agent, agentModel, "agent:write");
    })();
  }
  await sleep(Math.max(0, KEYSTROKE_MS - 2 * ONE_WAY_MS));
}
await agentTask;
await observerDone;

await writer.send({ type: "jj-open", fileId });
let final;
for (;;) { const f = await writer.next(); if (f.type === "jj-content") { final = f.content; break; } }
writer.close(); agent.close(); observer.close();

const pct = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
const result = {
  engine: "json-joy behind the identical WS surface (workerd DO, patches persisted)",
  lostKeystrokes: final.includes(SENTENCE) ? 0 : KEYSTROKES,
  agentSurvived: final.startsWith(AGENT_HEADER),
  humanTextSurvived: final.includes(SENTENCE),
  observer_p50_ms: Math.round(pct(observerLatencies, 0.5)),
  observer_p95_ms: Math.round(pct(observerLatencies, 0.95)),
  agent_write_observer_ms: Math.round(agentObserverLatency ?? NaN),
  events: observerLatencies.length,
};
console.table([result]);
console.log("final:", JSON.stringify(final.slice(0, 90)));
console.log("RoomText same scenario (ab-cutover Path B): p50 54ms / p95 67ms / lost 0");
