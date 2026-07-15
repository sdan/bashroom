import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const base = process.argv[2] || "http://localhost:8792";
const room = `workerd-bench-${process.pid}-${Date.now()}`;
const fileId = `file-${Date.now()}`;

async function json(path, init) {
  const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}room=${room}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function post(path, body) {
  const init = { method: "POST", headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return json(path, init);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function latencySummary(values) {
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    p99Ms: Number(percentile(values, 0.99).toFixed(3)),
  };
}

assert.equal((await post("/create", { fileId, path: "bench/document.md", content: "" })).ok, true);

const sequentialCount = 200;
const sequentialLatencies = [];
let revision = 0;
for (let index = 0; index < sequentialCount; index++) {
  const started = performance.now();
  const result = await post("/push", {
    protocol: 1,
    fileId,
    epoch: 1,
    baseRevision: revision,
    clientId: "sequential-writer",
    requestId: `sequential-${index}`,
    changes: [{ from: revision, to: revision, insert: "x" }],
  });
  sequentialLatencies.push(performance.now() - started);
  assert.equal(result.ok, true);
  revision = result.revision;
}

const burstCount = 50;
const burstBase = revision;
const burstStarted = performance.now();
const burst = await Promise.all(Array.from({ length: burstCount }, async (_, index) => {
  const started = performance.now();
  const result = await post("/push", {
    protocol: 1,
    fileId,
    epoch: 1,
    baseRevision: burstBase,
    clientId: `burst-writer-${index}`,
    requestId: "burst-1",
    changes: [{ from: burstBase, to: burstBase, insert: "y" }],
  });
  return { result, latency: performance.now() - started };
}));
const burstElapsed = performance.now() - burstStarted;
assert.ok(burst.every(({ result }) => result.ok));
revision = Math.max(...burst.map(({ result }) => result.revision));

const beforeEvict = await json(`/open?file=${fileId}`);
await post(`/evict?file=${fileId}`);
const coldTailStarted = performance.now();
const afterTailReplay = await json(`/open?file=${fileId}`);
const coldTailMs = performance.now() - coldTailStarted;
assert.deepEqual(afterTailReplay, beforeEvict);
const statsBeforeManualCheckpoint = await json(`/inspect?file=${fileId}`);

await post(`/checkpoint?file=${fileId}`);
await post(`/evict?file=${fileId}`);
const coldSnapshotStarted = performance.now();
const afterSnapshot = await json(`/open?file=${fileId}`);
const coldSnapshotMs = performance.now() - coldSnapshotStarted;
assert.deepEqual(afterSnapshot, beforeEvict);

console.log(JSON.stringify({
  system: "bashroom-roomtext-workerd",
  runtime: "workerd via wrangler",
  durableAck: {
    sequentialRequests: sequentialCount,
    ...latencySummary(sequentialLatencies),
  },
  staleBurst: {
    writers: burstCount,
    baseRevision: burstBase,
    finalRevision: revision,
    elapsedMs: Number(burstElapsed.toFixed(3)),
    acceptedPerSecond: Math.round(burstCount * 1_000 / burstElapsed),
    ...latencySummary(burst.map(({ latency }) => latency)),
  },
  recovery: {
    revision,
    tailUpdatesBeforeManualCheckpoint: revision - statsBeforeManualCheckpoint.snapshotRevision,
    coldTailReplayMs: Number(coldTailMs.toFixed(3)),
    coldSnapshotOpenMs: Number(coldSnapshotMs.toFixed(3)),
    exact: true,
  },
  caveat: "Durable ack includes local HTTP + DO + SQLite; no WebSocket observer fanout in this probe.",
}, null, 2));
