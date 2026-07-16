import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ChangeSet, Text } from "@codemirror/state";
import { rebaseUpdates } from "@codemirror/collab";

const root = path.resolve(import.meta.dirname, "../..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
const wranglerConfig = path.join(root, "scripts", "room-text-probe", "wrangler.jsonc");
const encoder = new TextEncoder();
const require = createRequire(import.meta.url);
const editingTracesRoot = path.dirname(require.resolve("editing-traces/package.json"));

const smoke = process.env.ROOM_TEXT_REALISTIC_SMOKE === "1";
const profile = process.env.ROOM_TEXT_REALISTIC_PROFILE || (smoke ? "smoke" : "medium");
assert.ok(["smoke", "medium", "full"].includes(profile), "profile must be smoke, medium, or full");

const defaults = profile === "smoke"
  ? { traceLimit: 12, repeats: 1, roomScale: 0.02, backlogDepth: 4, cacheEvery: 6, retryEvery: 5, foreignEvery: 4,
      pressureUpdates: 8, pressureSweepEvery: 4, pressureBurst: 8 }
  : profile === "full"
    ? { traceLimit: Number.MAX_SAFE_INTEGER, repeats: 2, roomScale: 1, backlogDepth: 32, cacheEvery: 128, retryEvery: 47, foreignEvery: 37,
        pressureUpdates: 256, pressureSweepEvery: 16, pressureBurst: 50 }
    : { traceLimit: 256, repeats: 1, roomScale: 1, backlogDepth: 16, cacheEvery: 64, retryEvery: 41, foreignEvery: 37,
        pressureUpdates: 64, pressureSweepEvery: 16, pressureBurst: 25 };

function envInteger(name, fallback, minimum = 1) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(Number.isSafeInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}`);
  return value;
}

function envNumber(name, fallback, minimum, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(Number.isFinite(value) && value >= minimum && value <= maximum,
    `${name} must be between ${minimum} and ${maximum}`);
  return value;
}

const config = {
  profile,
  traceName: process.env.ROOM_TEXT_REALISTIC_TRACE || "friendsforever_flat",
  traceLimit: envInteger("ROOM_TEXT_REALISTIC_TRACE_LIMIT", defaults.traceLimit),
  repeats: envInteger("ROOM_TEXT_REALISTIC_REPEATS", defaults.repeats),
  roomScale: envNumber("ROOM_TEXT_REALISTIC_ROOM_SCALE", defaults.roomScale, 0.001, 1),
  backlogDepth: envInteger("ROOM_TEXT_REALISTIC_BACKLOG_DEPTH", defaults.backlogDepth),
  cacheEvery: envInteger("ROOM_TEXT_REALISTIC_CACHE_EVERY", defaults.cacheEvery),
  retryEvery: envInteger("ROOM_TEXT_REALISTIC_RETRY_EVERY", defaults.retryEvery),
  foreignEvery: envInteger("ROOM_TEXT_REALISTIC_FOREIGN_EVERY", defaults.foreignEvery),
  pressureUpdates: envInteger("ROOM_TEXT_REALISTIC_PRESSURE_UPDATES", defaults.pressureUpdates),
  pressureSweepEvery: envInteger("ROOM_TEXT_REALISTIC_PRESSURE_SWEEP_EVERY", defaults.pressureSweepEvery),
  pressureBurst: envInteger("ROOM_TEXT_REALISTIC_PRESSURE_BURST", defaults.pressureBurst),
  roomConcurrency: envInteger("ROOM_TEXT_REALISTIC_ROOM_CONCURRENCY", smoke ? 4 : 16),
  sizes: (process.env.ROOM_TEXT_REALISTIC_SIZES || "8192,100000,900000").split(",").map(Number),
};
assert.ok(config.sizes.length > 0 && config.sizes.every((size) =>
  Number.isSafeInteger(size) && size >= 1_024 && size <= 900_000),
"ROOM_TEXT_REALISTIC_SIZES must be comma-separated byte sizes from 1024 through 900000");

const rawResultPath = process.env.ROOM_TEXT_REALISTIC_RESULT_PATH
  || path.join(os.tmpdir(), `bashroom-room-text-realistic-${process.pid}-${Date.now()}.json`);

function round(value) {
  return Number(value.toFixed(3));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function latencySummary(values) {
  if (values.length === 0) return { samples: 0, totalMs: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    totalMs: round(total),
    meanMs: round(total / values.length),
    p50Ms: round(percentile(values, 0.50)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(Math.max(...values)),
  };
}

function exactText(content) {
  return Text.of(content.split("\n"));
}

function fixture(size, seed) {
  const line = `# ${seed}\nThe quick brown fox edits durable Markdown state.\r\n\r\n`;
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

function wireChanges(changes) {
  const wire = [];
  changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
    wire.push({ from, to, insert: inserted.toString() });
  }, true);
  return wire;
}

function updateToken(clientId, requestId) {
  return JSON.stringify([clientId, requestId]);
}

function transactionChange(doc, patches) {
  let combined;
  let workingLength = doc.length;
  for (const [position, remove, insert] of patches) {
    assert.ok(Number.isSafeInteger(position) && Number.isSafeInteger(remove)
      && position >= 0 && remove >= 0 && position + remove <= workingLength,
    `trace patch ${position}/${remove} is outside ${workingLength}`);
    const next = ChangeSet.of({ from: position, to: position + remove, insert }, workingLength, "\n");
    combined = combined ? combined.compose(next) : next;
    workingLength = next.newLength;
  }
  return combined || ChangeSet.empty(doc.length);
}

function translateChange(changes, offset, fullLength) {
  return ChangeSet.of(wireChanges(changes).map((change) => ({
    from: change.from + offset,
    to: change.to + offset,
    insert: change.insert,
  })), fullLength, "\n");
}

async function loadTrace(name) {
  assert.ok(/^[a-z0-9_-]+$/.test(name), "trace name is invalid");
  const filename = path.join(editingTracesRoot, "sequential_traces", `${name}.json.gz`);
  const compressed = await readFile(filename);
  const trace = JSON.parse(gunzipSync(compressed).toString("utf8"));
  assert.equal(typeof trace.startContent, "string");
  assert.equal(trace.startContent, "", "the realistic padded replay currently requires an empty trace start");
  assert.ok(Array.isArray(trace.txns) && trace.txns.length > 0);
  return trace;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForReady(child, base, output, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}:\n${output.value}`);
    try {
      await fetch(base);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`wrangler did not become ready:\n${output.value}`);
}

async function startServer(persistence) {
  const [port, inspectorPort] = await Promise.all([freePort(), freePort()]);
  const output = { value: "" };
  const child = spawn(wrangler, [
    "dev",
    "-c", wranglerConfig,
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--inspector-port", String(inspectorPort),
    "--persist-to", persistence,
    "--log-level", "error",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: persistence,
      WRANGLER_LOG_PATH: path.join(persistence, "wrangler.log"),
    },
  });
  const capture = (chunk) => {
    output.value = (output.value + chunk.toString()).slice(-40_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(child, base, output);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  }
  return {
    base,
    output,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
  };
}

async function requestJson(server, room, route, init) {
  const url = new URL(route, server.base);
  url.searchParams.set("room", room);
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${response.status} ${route}: non-JSON response ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`${response.status} ${route}: ${JSON.stringify(body)}`);
  return body;
}

function get(server, room, route) {
  return requestJson(server, room, route);
}

function post(server, room, route, body) {
  return requestJson(server, room, route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, latencyMs: performance.now() - started };
}

async function mapLimit(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  }));
  return results;
}

const empiricalBins = [
  { name: "lte-8k", originalCount: 580, min: 256, max: 8_192 },
  { name: "8k-16k", originalCount: 78, min: 8_193, max: 16_384 },
  { name: "16k-64k", originalCount: 16, min: 16_385, max: 65_536 },
  { name: "64k-256k", originalCount: 4, min: 65_537, max: 262_144 },
  { name: "420652", originalCount: 1, min: 420_652, max: 420_652 },
];

// Read-only census on 2026-07-16. `longloop` excludes its one 1,157,721-byte
// file because RoomText deliberately caps text heads at 1,000,000 bytes.
const empiricalRooms = [
  { name: "milkdown-test", originalCount: 6, supportedBytes: 2_424 },
  { name: "quack", originalCount: 5, supportedBytes: 4_922 },
  { name: "jokegen", originalCount: 7, supportedBytes: 6_856 },
  { name: "llmh-current", originalCount: 7, supportedBytes: 8_117 },
  { name: "continualcode", originalCount: 6, supportedBytes: 12_564 },
  { name: "stemplayer", originalCount: 8, supportedBytes: 21_381 },
  { name: "vmux", originalCount: 8, supportedBytes: 27_936 },
  { name: "llmh-darkpool", originalCount: 10, supportedBytes: 33_223 },
  { name: "bashroom", originalCount: 11, supportedBytes: 36_754 },
  { name: "yecombinator", originalCount: 10, supportedBytes: 41_353 },
  { name: "llmh-labs-mail", originalCount: 14, supportedBytes: 44_896 },
  { name: "design", originalCount: 106, supportedBytes: 52_315 },
  { name: "llmh-accel", originalCount: 14, supportedBytes: 69_861 },
  { name: "ant-takehome", originalCount: 18, supportedBytes: 77_257 },
  { name: "personal", originalCount: 15, supportedBytes: 78_023 },
  { name: "learning", originalCount: 18, supportedBytes: 102_819 },
  { name: "geospot", originalCount: 13, supportedBytes: 109_460 },
  { name: "sealist", originalCount: 41, supportedBytes: 241_290 },
  { name: "longloop", originalCount: 362, supportedBytes: 3_167_044 },
];

function scaledCount(originalCount) {
  if (originalCount === 1) return 1;
  return Math.max(1, Math.round(originalCount * config.roomScale));
}

function sizeInBin(bin, index, count) {
  if (bin.min === bin.max || count === 1) return bin.max;
  const fraction = index / (count - 1);
  return Math.round(bin.min + (bin.max - bin.min) * fraction);
}

function roomShapeFiles() {
  return empiricalBins.flatMap((bin) => {
    const count = scaledCount(bin.originalCount);
    return Array.from({ length: count }, (_, index) => ({
      bin: bin.name,
      fileId: `shape-${bin.name}-${index}`,
      path: `shape/${bin.name}/${String(index).padStart(4, "0")}.md`,
      size: sizeInBin(bin, index, count),
    }));
  });
}

function fleetFiles(repeat) {
  return empiricalRooms.flatMap((roomProfile) => {
    const count = Math.max(1, Math.round(roomProfile.originalCount * config.roomScale));
    const targetBytes = Math.max(
      count,
      Math.round(roomProfile.supportedBytes * count / roomProfile.originalCount),
    );
    const baseSize = Math.floor(targetBytes / count);
    const remainder = targetBytes % count;
    const room = `realistic-fleet-${repeat}-${roomProfile.name}-${process.pid}`;
    return Array.from({ length: count }, (_, index) => ({
      room,
      sourceRoom: roomProfile.name,
      fileId: `fleet-${roomProfile.name}-${index}`,
      path: `fleet/${String(index).padStart(4, "0")}.md`,
      size: baseSize + (index < remainder ? 1 : 0),
    }));
  });
}

async function createFleet(server, repeat) {
  const files = fleetFiles(repeat);
  const started = performance.now();
  const samples = await mapLimit(files, config.roomConcurrency, async (file) => {
    const content = fixture(file.size, file.fileId);
    const measured = await timed(() => post(server, file.room, "/create", {
      fileId: file.fileId,
      path: file.path,
      content,
    }));
    assert.equal(measured.value.ok, true, JSON.stringify(measured.value));
    assert.equal(measured.value.byteLength, file.size);
    return {
      room: file.sourceRoom,
      fileId: file.fileId,
      bytes: file.size,
      latencyMs: round(measured.latencyMs),
    };
  });
  return {
    files,
    report: {
      rooms: empiricalRooms.length,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      scale: config.roomScale,
      wallMs: round(performance.now() - started),
      createLatency: latencySummary(samples.map((sample) => sample.latencyMs)),
      rawCreateSamples: samples,
      note: "Fleet topology preserves measured per-room file counts and total supported bytes; synthetic contents avoid copying private room text.",
    },
  };
}

async function createRoomShape(server, repeat) {
  const room = `realistic-shape-${repeat}-${process.pid}`;
  const files = roomShapeFiles();
  const samples = await mapLimit(files, config.roomConcurrency, async (file) => {
    const content = fixture(file.size, file.fileId);
    const measured = await timed(() => post(server, room, "/create", {
      fileId: file.fileId,
      path: file.path,
      content,
    }));
    assert.equal(measured.value.ok, true, JSON.stringify(measured.value));
    assert.equal(measured.value.byteLength, file.size);
    file.expected = content;
    file.revision = 0;
    return { fileId: file.fileId, bin: file.bin, bytes: file.size, latencyMs: round(measured.latencyMs) };
  });
  return {
    room,
    files,
    report: {
      empiricalFiles: 680,
      includedEmpiricalFiles: 679,
      skippedOversizeFiles: 1,
      scale: config.roomScale,
      createdFiles: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      binCounts: Object.fromEntries(empiricalBins.map((bin) => [bin.name, scaledCount(bin.originalCount)])),
      createLatency: latencySummary(samples.map((sample) => sample.latencyMs)),
      rawCreateSamples: samples,
      note: "Per-file creates share one room DO. The probe has no multi-file atomic commit route; this does not simulate one.",
    },
  };
}

async function runConcentratedPressure(server, shape, repeat) {
  const target = shape.files.reduce((largest, file) => file.size > largest.size ? file : largest);
  let doc = exactText(target.expected);
  let revision = target.revision;
  const updates = [];
  const retries = [];
  const sweeps = [];

  for (let index = 0; index < config.pressureUpdates; index++) {
    const position = (index * 7_919) % Math.max(1, doc.length);
    const insert = doc.sliceString(position, Math.min(position + 1, doc.length)) === "x" ? "y" : "x";
    const change = ChangeSet.of({
      from: position,
      to: Math.min(position + 1, doc.length),
      insert,
    }, doc.length, "\n");
    const body = {
      protocol: 1,
      fileId: target.fileId,
      epoch: 1,
      baseRevision: revision,
      clientId: `pressure-client-${repeat}`,
      requestId: `sequential-${index}`,
      changes: wireChanges(change),
    };
    const accepted = await pushMeasured(server, shape.room, body);
    revision = accepted.result.revision;
    doc = change.apply(doc);
    updates.push({
      index,
      revision,
      headBytes: accepted.result.byteLength,
      latencyMs: round(accepted.latencyMs),
    });

    if ((index + 1) % config.retryEvery === 0) {
      const retried = await pushMeasured(server, shape.room, body);
      assert.equal(retried.result.revision, accepted.result.revision);
      assert.equal(retried.result.roomCommit, accepted.result.roomCommit);
      retries.push({ index, revision, latencyMs: round(retried.latencyMs) });
    }

    if ((index + 1) % config.pressureSweepEvery === 0) {
      const candidates = shape.files.filter((file) => file.fileId !== target.fileId).slice(0, 40);
      const started = performance.now();
      await mapLimit(candidates, config.roomConcurrency, async (file) => {
        const opened = await get(server, shape.room, `/open?file=${encodeURIComponent(file.fileId)}`);
        assert.equal(opened.ok, true);
        assert.equal(opened.revision, file.revision);
        assert.equal(opened.content, file.expected);
      });
      sweeps.push({ after: index, files: candidates.length, elapsedMs: round(performance.now() - started) });
    }
  }

  const burstBase = revision;
  const preBurstExpected = doc.toString();
  const submittedBurstMarkers = Array.from(
    { length: config.pressureBurst },
    (_, index) => String.fromCharCode(65 + (index % 26)),
  );
  const burstStarted = performance.now();
  const burst = await Promise.all(submittedBurstMarkers.map(async (marker, index) => {
    const measured = await timed(() => post(server, shape.room, "/push", {
      protocol: 1,
      fileId: target.fileId,
      epoch: 1,
      baseRevision: burstBase,
      clientId: `pressure-burst-${repeat}-${index}`,
      requestId: "stale-wall",
      changes: [{ from: 0, to: 0, insert: marker }],
    }));
    assert.equal(measured.value.ok, true, JSON.stringify(measured.value));
    return { result: measured.value, latencyMs: round(measured.latencyMs) };
  }));
  const burstElapsedMs = performance.now() - burstStarted;
  const burstRevisions = burst.map(({ result }) => result.revision).sort((a, b) => a - b);
  assert.deepEqual(
    burstRevisions,
    Array.from({ length: config.pressureBurst }, (_, index) => burstBase + index + 1),
  );
  for (const { result } of [...burst].sort((left, right) => left.result.revision - right.result.revision)) {
    const canonical = ChangeSet.of(result.update.changes, doc.length, "\n");
    doc = canonical.apply(doc);
  }
  revision += config.pressureBurst;

  const expected = doc.toString();
  const burstPrefix = expected.slice(0, config.pressureBurst);
  assert.equal(expected.slice(config.pressureBurst), preBurstExpected,
    "stale-writer burst changed content outside its insertion prefix");
  assert.deepEqual([...burstPrefix].sort(), [...submittedBurstMarkers].sort(),
    "stale-writer burst did not preserve every submitted marker exactly once");
  await assertOpen(server, shape.room, target.fileId, expected, revision);
  assert.equal((await get(server, shape.room, `/digest/verify?file=${target.fileId}`)).match, true);
  target.expected = expected;
  target.revision = revision;
  target.size = encoder.encode(expected).byteLength;

  return {
    repeat,
    roomFiles: shape.files.length,
    targetInitialBytes: updates[0]?.headBytes ?? target.size,
    finalBytes: target.size,
    sequentialUpdates: updates.length,
    staleBurstWriters: config.pressureBurst,
    finalRevision: revision,
    logicalHeadBytes: updates.reduce((sum, sample) => sum + sample.headBytes, 0)
      + burst.reduce((sum, sample) => sum + sample.result.byteLength, 0),
    updateLatency: latencySummary(updates.map((sample) => sample.latencyMs)),
    retryLatency: latencySummary(retries.map((sample) => sample.latencyMs)),
    burst: {
      elapsedMs: round(burstElapsedMs),
      acceptedPerSecond: Math.round(config.pressureBurst * 1_000 / burstElapsedMs),
      latency: latencySummary(burst.map((sample) => sample.latencyMs)),
    },
    cacheSweeps: sweeps,
    exactFinalBytes: true,
    independentBurstOracleMatched: true,
    raw: { updates, retries, burst: burst.map((sample) => ({
      revision: sample.result.revision,
      headBytes: sample.result.byteLength,
      latencyMs: sample.latencyMs,
    })) },
  };
}

async function pushMeasured(server, room, body) {
  const measured = await timed(() => post(server, room, "/push", body));
  assert.equal(measured.value.ok, true, JSON.stringify(measured.value));
  return { result: measured.value, latencyMs: measured.latencyMs };
}

async function assertOpen(server, room, fileId, expected, revision) {
  const measured = await timed(() => get(server, room, `/open?file=${encodeURIComponent(fileId)}`));
  assert.equal(measured.value.ok, true, JSON.stringify(measured.value));
  assert.equal(measured.value.revision, revision);
  assert.equal(measured.value.content, expected);
  assert.equal(measured.value.byteLength, encoder.encode(expected).byteLength);
  return measured.latencyMs;
}

async function cacheClearCheck(server, room, fileId, expected, revision, after) {
  const evicted = await timed(() => post(server, room, `/evict?file=${encodeURIComponent(fileId)}`));
  assert.equal(evicted.value.ok, true);
  const openMs = await assertOpen(server, room, fileId, expected, revision);
  return { after, evictMs: round(evicted.latencyMs), openMs: round(openMs) };
}

async function runPaddedTrace(server, trace, size, repeat) {
  const room = `realistic-trace-${repeat}-${size}-${process.pid}`;
  const fileId = "document";
  const guard = "<!-- foreign edits stay before this guard -->\n";
  assert.ok(size > guard.length);
  const suffix = fixture(size - guard.length, `trace-${size}`);
  let canonical = exactText(guard + suffix);
  let logical = Text.empty;
  let traceOffset = guard.length;
  let revision = 0;
  const clientId = `trace-client-${repeat}-${size}`;
  const updates = [];
  const foreign = [];
  const foreignMarkers = [];
  const retries = [];
  const cacheClears = [];
  let skippedEmpty = 0;

  const created = await post(server, room, "/create", {
    fileId,
    path: `traces/${config.traceName}-${size}.md`,
    content: canonical.toString(),
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.byteLength, size);

  const limit = Math.min(config.traceLimit, trace.txns.length);
  for (let index = 0; index < limit; index++) {
    const patches = trace.txns[index].patches;
    const logicalChange = transactionChange(logical, patches);
    logical = logicalChange.apply(logical);
    if (logicalChange.empty) {
      skippedEmpty++;
      continue;
    }

    const fullChange = translateChange(logicalChange, traceOffset, canonical.length);
    const requestId = `trace-${index}`;
    const body = {
      protocol: 1,
      fileId,
      epoch: 1,
      baseRevision: revision,
      clientId,
      requestId,
      changes: wireChanges(fullChange),
    };
    const submittedBaseRevision = revision;
    let canonicalChange = fullChange;
    let staleOverForeign = false;

    if ((index + 1) % config.foreignEvery === 0) {
      const foreignClientId = `foreign-${repeat}-${size}`;
      const foreignRequestId = `foreign-${index}`;
      const marker = `F${index}:`;
      foreignMarkers.push(marker);
      const foreignChange = ChangeSet.of({ from: 0, to: 0, insert: marker }, canonical.length, "\n");
      const foreignBody = {
        protocol: 1,
        fileId,
        epoch: 1,
        baseRevision: revision,
        clientId: foreignClientId,
        requestId: foreignRequestId,
        changes: wireChanges(foreignChange),
      };
      const acceptedForeign = await pushMeasured(server, room, foreignBody);
      revision = acceptedForeign.result.revision;
      canonical = foreignChange.apply(canonical);
      traceOffset += marker.length;
      canonicalChange = rebaseUpdates(
        [{ changes: fullChange, clientID: updateToken(clientId, requestId) }],
        [{ changes: foreignChange.desc, clientID: updateToken(foreignClientId, foreignRequestId) }],
      )[0].changes;
      foreign.push({
        beforeTraceTransaction: index,
        revision,
        markerBytes: encoder.encode(marker).byteLength,
        headBytes: acceptedForeign.result.byteLength,
        latencyMs: round(acceptedForeign.latencyMs),
      });
      staleOverForeign = true;
    }

    const accepted = await pushMeasured(server, room, body);
    revision = accepted.result.revision;
    assert.equal(accepted.result.submittedBaseRevision, submittedBaseRevision);
    assert.deepEqual(accepted.result.update.changes, wireChanges(canonicalChange));
    canonical = canonicalChange.apply(canonical);
    updates.push({
      traceTransaction: index,
      patches: patches.length,
      submittedBaseRevision,
      revision,
      staleOverForeign,
      headBytes: accepted.result.byteLength,
      latencyMs: round(accepted.latencyMs),
    });

    if ((index + 1) % config.retryEvery === 0) {
      const retried = await pushMeasured(server, room, body);
      assert.equal(retried.result.revision, accepted.result.revision);
      assert.equal(retried.result.roomCommit, accepted.result.roomCommit);
      assert.deepEqual(retried.result.update, accepted.result.update);
      retries.push({ traceTransaction: index, revision, latencyMs: round(retried.latencyMs) });
    }

    if ((index + 1) % config.cacheEvery === 0) {
      cacheClears.push(await cacheClearCheck(
        server, room, fileId, canonical.toString(), revision, index,
      ));
    }
  }

  const expected = canonical.toString();
  const independentExpected = `${[...foreignMarkers].reverse().join("")}${guard}${logical.toString()}${suffix}`;
  assert.equal(expected, independentExpected, "foreign rebase missed the independently constructed final string");
  assert.ok(expected.endsWith(suffix), "trace replay modified the protected padding suffix");
  assert.equal(expected.slice(traceOffset, traceOffset + logical.length), logical.toString());
  const corpusOracleMatched = limit === trace.txns.length
    ? logical.toString() === trace.endContent
    : null;
  if (corpusOracleMatched !== null) {
    assert.equal(corpusOracleMatched, true, `${config.traceName}: final trace content missed the corpus oracle`);
  }
  await assertOpen(server, room, fileId, expected, revision);
  const inspected = await get(server, room, `/inspect?file=${fileId}`);
  assert.equal(inspected.revision, revision);
  assert.equal(inspected.updateCount, revision);

  return {
    recovery: { room, fileId, expected, revision },
    report: {
      repeat,
      initialBytes: size,
      finalBytes: encoder.encode(expected).byteLength,
      trace: config.traceName,
      traceTransactionsConsidered: Math.min(config.traceLimit, trace.txns.length),
      acceptedTraceUpdates: updates.length,
      skippedEmpty,
      foreignUpdates: foreign.length,
      finalRevision: revision,
      logicalHeadBytes: updates.reduce((sum, sample) => sum + sample.headBytes, 0)
        + foreign.reduce((sum, sample) => sum + sample.headBytes, 0),
      updateLatency: latencySummary(updates.map((sample) => sample.latencyMs)),
      foreignLatency: latencySummary(foreign.map((sample) => sample.latencyMs)),
      retryLatency: latencySummary(retries.map((sample) => sample.latencyMs)),
      cacheColdOpenLatency: latencySummary(cacheClears.map((sample) => sample.openMs)),
      inspect: inspected,
      raw: { updates, foreign, retries, cacheClears },
      exactFinalBytes: true,
      corpusOracleMatched,
      independentForeignOracleMatched: true,
    },
  };
}

function makeOfflineChain(base, depth, clientId) {
  const updates = [];
  let doc = base;
  for (let index = 0; index < depth; index++) {
    const requestId = `offline-${index}`;
    const position = Math.min(doc.length, 32 + ((index * 7_919) % Math.max(1, doc.length - 32)));
    const remove = index % 4 === 0 && position < doc.length ? 1 : 0;
    const insert = index % 3 === 0 ? `λ${index}` : index % 3 === 1 ? `local-${index}` : "x";
    const changes = ChangeSet.of({ from: position, to: position + remove, insert }, doc.length, "\n");
    updates.push({ changes, clientID: updateToken(clientId, requestId), requestId });
    doc = changes.apply(doc);
  }
  return updates;
}

async function runBacklog(server, size, repeat) {
  const room = `realistic-backlog-${repeat}-${size}-${process.pid}`;
  const fileId = "document";
  const initial = fixture(size, `backlog-${size}`);
  const base = exactText(initial);
  let canonical = base;
  let revision = 0;
  const clientId = `offline-client-${repeat}-${size}`;
  const original = makeOfflineChain(base, config.backlogDepth, clientId);
  let offlineOracle = base;
  for (const update of original) offlineOracle = update.changes.apply(offlineOracle);
  const foreignMarkers = [];
  const initialForeign = [];
  const foreignSamples = [];
  const updateSamples = [];
  const retrySamples = [];
  const cacheClears = [];

  const created = await post(server, room, "/create", {
    fileId,
    path: `backlog/${size}.md`,
    content: initial,
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  for (let index = 0; index < 3; index++) {
    const foreignClientId = `offline-foreign-${repeat}-${size}`;
    const requestId = `before-${index}`;
    const marker = `R${index}:`;
    foreignMarkers.push(marker);
    const changes = ChangeSet.of({ from: 0, to: 0, insert: marker }, canonical.length, "\n");
    const accepted = await pushMeasured(server, room, {
      protocol: 1, fileId, epoch: 1, baseRevision: revision,
      clientId: foreignClientId, requestId, changes: wireChanges(changes),
    });
    revision = accepted.result.revision;
    canonical = changes.apply(canonical);
    initialForeign.push({ changes: changes.desc, clientID: updateToken(foreignClientId, requestId) });
    foreignSamples.push({
      phase: "before-reconnect",
      index,
      revision,
      headBytes: accepted.result.byteLength,
      latencyMs: round(accepted.latencyMs),
    });
  }

  let pending = rebaseUpdates(original.map(({ changes, clientID }) => ({ changes, clientID })), initialForeign)
    .map((update, index) => ({ ...update, requestId: original[index].requestId }));
  let acceptedLocals = 0;
  let first = true;
  while (pending.length > 0) {
    if (!first && acceptedLocals === Math.floor(config.backlogDepth / 2)) {
      const foreignClientId = `offline-foreign-${repeat}-${size}`;
      const requestId = "mid-drain";
      const marker = "MID:";
      foreignMarkers.push(marker);
      const changes = ChangeSet.of({ from: 0, to: 0, insert: marker }, canonical.length, "\n");
      const accepted = await pushMeasured(server, room, {
        protocol: 1, fileId, epoch: 1, baseRevision: revision,
        clientId: foreignClientId, requestId, changes: wireChanges(changes),
      });
      revision = accepted.result.revision;
      canonical = changes.apply(canonical);
      pending = rebaseUpdates(pending, [
        { changes: changes.desc, clientID: updateToken(foreignClientId, requestId) },
      ]).map((update, index) => ({ ...update, requestId: pending[index].requestId }));
      foreignSamples.push({
        phase: "mid-drain",
        index: acceptedLocals,
        revision,
        headBytes: accepted.result.byteLength,
        latencyMs: round(accepted.latencyMs),
      });
    }

    const next = pending.shift();
    assert.ok(next);
    const originalUpdate = original[acceptedLocals];
    const staleFirstHead = first;
    const submittedChanges = staleFirstHead ? originalUpdate.changes : next.changes;
    const baseRevision = staleFirstHead ? 0 : revision;
    const body = {
      protocol: 1,
      fileId,
      epoch: 1,
      baseRevision,
      clientId,
      requestId: next.requestId,
      changes: wireChanges(submittedChanges),
    };
    const accepted = await pushMeasured(server, room, body);
    assert.deepEqual(accepted.result.update.changes, wireChanges(next.changes));
    revision = accepted.result.revision;
    canonical = next.changes.apply(canonical);
    updateSamples.push({
      offlineIndex: acceptedLocals,
      staleFirstHead,
      submittedBaseRevision: baseRevision,
      revision,
      headBytes: accepted.result.byteLength,
      latencyMs: round(accepted.latencyMs),
    });
    if (acceptedLocals === 0 || acceptedLocals === config.backlogDepth - 1) {
      const retried = await pushMeasured(server, room, body);
      assert.equal(retried.result.revision, accepted.result.revision);
      assert.equal(retried.result.roomCommit, accepted.result.roomCommit);
      retrySamples.push({ offlineIndex: acceptedLocals, revision, latencyMs: round(retried.latencyMs) });
    }
    acceptedLocals++;
    first = false;
    if (acceptedLocals === Math.ceil(config.backlogDepth / 2)) {
      cacheClears.push(await cacheClearCheck(
        server, room, fileId, canonical.toString(), revision, acceptedLocals,
      ));
    }
  }

  assert.equal(acceptedLocals, config.backlogDepth);
  const expected = canonical.toString();
  const independentExpected = `${[...foreignMarkers].reverse().join("")}${offlineOracle.toString()}`;
  assert.equal(expected, independentExpected, "offline rebase missed the independently constructed final string");
  await assertOpen(server, room, fileId, expected, revision);
  const inspected = await get(server, room, `/inspect?file=${fileId}`);
  assert.equal(inspected.revision, revision);

  return {
    recovery: { room, fileId, expected, revision },
    report: {
      repeat,
      initialBytes: size,
      backlogDepth: config.backlogDepth,
      initialForeignUpdates: initialForeign.length,
      midDrainForeignUpdates: 1,
      finalBytes: encoder.encode(expected).byteLength,
      finalRevision: revision,
      logicalHeadBytes: updateSamples.reduce((sum, sample) => sum + sample.headBytes, 0)
        + foreignSamples.reduce((sum, sample) => sum + sample.headBytes, 0),
      updateLatency: latencySummary(updateSamples.map((sample) => sample.latencyMs)),
      foreignLatency: latencySummary(foreignSamples.map((sample) => sample.latencyMs)),
      retryLatency: latencySummary(retrySamples.map((sample) => sample.latencyMs)),
      cacheColdOpenLatency: latencySummary(cacheClears.map((sample) => sample.openMs)),
      inspect: inspected,
      raw: { updates: updateSamples, foreign: foreignSamples, retries: retrySamples, cacheClears },
      exactFinalBytes: true,
      independentForeignOracleMatched: true,
      protocolNote: "Dependent offline edits drain one acknowledged head at a time. The current protocol does not accept an atomic fresh-update chain.",
    },
  };
}

async function recoverRoomShape(server, shape) {
  const samples = await mapLimit(shape.files, config.roomConcurrency, async (file) => {
    const measured = await timed(() => get(server, shape.room, `/open?file=${encodeURIComponent(file.fileId)}`));
    assert.equal(measured.value.ok, true, JSON.stringify(measured.value));
    assert.equal(measured.value.revision, file.revision);
    assert.equal(measured.value.byteLength, file.size);
    assert.equal(measured.value.content, file.expected);
    return { fileId: file.fileId, bin: file.bin, bytes: file.size, latencyMs: round(measured.latencyMs) };
  });
  return {
    files: samples.length,
    exact: true,
    latency: latencySummary(samples.map((sample) => sample.latencyMs)),
    rawSamples: samples,
  };
}

async function recoverFleet(server, fleet) {
  const samples = await mapLimit(fleet.files, config.roomConcurrency, async (file) => {
    const measured = await timed(() => get(
      server,
      file.room,
      `/open?file=${encodeURIComponent(file.fileId)}`,
    ));
    assert.equal(measured.value.ok, true, JSON.stringify(measured.value));
    assert.equal(measured.value.revision, 0);
    assert.equal(measured.value.byteLength, file.size);
    assert.equal(measured.value.content, fixture(file.size, file.fileId));
    return {
      room: file.sourceRoom,
      fileId: file.fileId,
      bytes: file.size,
      latencyMs: round(measured.latencyMs),
    };
  });
  return {
    rooms: new Set(fleet.files.map((file) => file.room)).size,
    files: samples.length,
    exact: true,
    latency: latencySummary(samples.map((sample) => sample.latencyMs)),
    rawSamples: samples,
  };
}

async function recoverHotFiles(server, recoveries) {
  const samples = [];
  for (const recovery of recoveries) {
    const latencyMs = await assertOpen(
      server, recovery.room, recovery.fileId, recovery.expected, recovery.revision,
    );
    samples.push({
      room: recovery.room,
      fileId: recovery.fileId,
      revision: recovery.revision,
      bytes: encoder.encode(recovery.expected).byteLength,
      latencyMs: round(latencyMs),
    });
  }
  return {
    files: samples.length,
    exact: true,
    latency: latencySummary(samples.map((sample) => sample.latencyMs)),
    rawSamples: samples,
  };
}

async function seedRestartIdempotency(server) {
  const room = `realistic-restart-idempotency-${process.pid}`;
  const fileId = "restart-document";
  const initial = "restart";
  assert.equal((await post(server, room, "/create", {
    fileId,
    path: "restart/idempotency.md",
    content: initial,
  })).ok, true);
  const body = {
    protocol: 1,
    fileId,
    epoch: 1,
    baseRevision: 0,
    clientId: "restart-client",
    requestId: "before-process-death",
    changes: [{ from: initial.length, to: initial.length, insert: "!" }],
  };
  const accepted = await post(server, room, "/push", body);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.revision, 1);
  return { room, fileId, body, accepted, expected: `${initial}!` };
}

async function verifyRestartIdempotency(server, seeded) {
  const replay = await post(server, seeded.room, "/push", seeded.body);
  assert.deepEqual(replay, seeded.accepted, "process restart changed the stored idempotent result");
  const afterReplay = await get(server, seeded.room, `/inspect?file=${seeded.fileId}`);
  assert.equal(afterReplay.revision, 1);
  assert.equal(afterReplay.updateCount, 1);

  const next = await post(server, seeded.room, "/push", {
    protocol: 1,
    fileId: seeded.fileId,
    epoch: 1,
    baseRevision: 1,
    clientId: "restart-client",
    requestId: "after-process-death",
    changes: [{ from: seeded.expected.length, to: seeded.expected.length, insert: "?" }],
  });
  assert.equal(next.ok, true);
  assert.equal(next.revision, 2);
  await assertOpen(server, seeded.room, seeded.fileId, `${seeded.expected}?`, 2);
  return {
    originalRevision: seeded.accepted.revision,
    replayRevision: replay.revision,
    nextRevision: next.revision,
    updateCountAfterReplay: afterReplay.updateCount,
    exact: true,
  };
}

const trace = await loadTrace(config.traceName);
config.traceLimit = Math.min(config.traceLimit, trace.txns.length);
const persistence = await mkdtemp(path.join(os.tmpdir(), "bashroom-room-text-realistic-workerd-"));
let server;
const shapeRuns = [];
const fleetRuns = [];
const pressureRuns = [];
const traceRuns = [];
const backlogRuns = [];
const hotRecoveries = [];
let restartIdempotency;
const startedAt = new Date().toISOString();
const benchmarkStarted = performance.now();

try {
  server = await startServer(persistence);
  for (let repeat = 0; repeat < config.repeats; repeat++) {
    const shape = await createRoomShape(server, repeat);
    shapeRuns.push(shape);
    pressureRuns.push(await runConcentratedPressure(server, shape, repeat));
    fleetRuns.push(await createFleet(server, repeat));
    const orderedSizes = repeat % 2 === 0 ? config.sizes : [...config.sizes].reverse();
    for (const size of orderedSizes) {
      const result = await runPaddedTrace(server, trace, size, repeat);
      traceRuns.push(result.report);
      hotRecoveries.push(result.recovery);
    }
    for (const size of orderedSizes.filter((value) => value >= 100_000)) {
      const result = await runBacklog(server, size, repeat);
      backlogRuns.push(result.report);
      hotRecoveries.push(result.recovery);
    }
  }
  restartIdempotency = await seedRestartIdempotency(server);

  // A process restart preserves the exact same local SQLite state while
  // discarding every application object/cache. This is stronger than /evict,
  // though the host OS page cache can still be warm.
  await server.stop();
  server = await startServer(persistence);
  const recovery = {
    processRestart: true,
    concentratedCorpora: [],
    fleets: [],
    hotFiles: await recoverHotFiles(server, hotRecoveries),
    idempotency: await verifyRestartIdempotency(server, restartIdempotency),
  };
  for (const shape of shapeRuns) recovery.concentratedCorpora.push(await recoverRoomShape(server, shape));
  for (const fleet of fleetRuns) recovery.fleets.push(await recoverFleet(server, fleet));

  const report = {
    benchmark: "RoomText realistic B-only workerd workload",
    startedAt,
    runtime: `Node ${process.version}; workerd via Wrangler`,
    traceCorpusRevision: "71c6d73",
    config,
    elapsedMs: round(performance.now() - benchmarkStarted),
    concentratedCorpus: shapeRuns.map((run) => run.report),
    fleet: fleetRuns.map((run) => run.report),
    concentratedPressure: pressureRuns,
    traceRuns,
    backlogRuns,
    recovery,
    work: {
      freshUpdates: traceRuns.reduce((sum, run) => sum + run.finalRevision, 0)
        + backlogRuns.reduce((sum, run) => sum + run.finalRevision, 0)
        + pressureRuns.reduce((sum, run) => sum + run.finalRevision, 0),
      idempotentRetries: traceRuns.reduce((sum, run) => sum + run.raw.retries.length, 0)
        + backlogRuns.reduce((sum, run) => sum + run.raw.retries.length, 0)
        + pressureRuns.reduce((sum, run) => sum + run.raw.retries.length, 0),
      logicalHeadBytes: traceRuns.reduce((sum, run) => sum + run.logicalHeadBytes, 0)
        + backlogRuns.reduce((sum, run) => sum + run.logicalHeadBytes, 0)
        + pressureRuns.reduce((sum, run) => sum + run.logicalHeadBytes, 0),
      cacheClears: traceRuns.reduce((sum, run) => sum + run.raw.cacheClears.length, 0)
        + backlogRuns.reduce((sum, run) => sum + run.raw.cacheClears.length, 0),
      roomCacheSweeps: pressureRuns.reduce((sum, run) => sum + run.cacheSweeps.length, 0),
    },
    guarantees: {
      exactFinalUtf8: true,
      independentForeignOracles: true,
      retryIdempotency: true,
      staleForeignRebase: true,
      processRestartRecovery: true,
      processRestartIdempotency: true,
    },
    caveats: [
      "Local workerd timings are directional, not Cloudflare production SLOs.",
      "The process restart drops application caches but may retain the host OS page cache.",
      "The fixed probe routes expose per-file commits only; no multi-file atomic shell commit is simulated.",
      "Backlogged dependent edits drain one acknowledged head at a time because that is the current client protocol.",
      "The measured corpus spans 19 rooms. The concentrated phase deliberately puts 679 supported files in one worst-case DO; the >1 MB file is skipped.",
    ],
  };
  await writeFile(rawResultPath, `${JSON.stringify(report, null, 2)}\n`);

  const summary = {
    benchmark: report.benchmark,
    rawResultPath,
    config,
    elapsedMs: report.elapsedMs,
    concentratedCorpus: report.concentratedCorpus.map((run) => ({
      createdFiles: run.createdFiles,
      bytes: run.bytes,
      createLatency: run.createLatency,
    })),
    fleet: report.fleet.map((run) => ({
      rooms: run.rooms,
      files: run.files,
      bytes: run.bytes,
      wallMs: run.wallMs,
      createLatency: run.createLatency,
    })),
    concentratedPressure: report.concentratedPressure.map((run) => ({
      repeat: run.repeat,
      roomFiles: run.roomFiles,
      targetInitialBytes: run.targetInitialBytes,
      sequentialUpdates: run.sequentialUpdates,
      staleBurstWriters: run.staleBurstWriters,
      finalRevision: run.finalRevision,
      logicalHeadBytes: run.logicalHeadBytes,
      updateLatency: run.updateLatency,
      burst: run.burst,
      cacheSweeps: run.cacheSweeps.length,
      independentBurstOracleMatched: run.independentBurstOracleMatched,
    })),
    traces: report.traceRuns.map((run) => ({
      repeat: run.repeat,
      initialBytes: run.initialBytes,
      acceptedTraceUpdates: run.acceptedTraceUpdates,
      foreignUpdates: run.foreignUpdates,
      finalRevision: run.finalRevision,
      logicalHeadBytes: run.logicalHeadBytes,
      corpusOracleMatched: run.corpusOracleMatched,
      independentForeignOracleMatched: run.independentForeignOracleMatched,
      updateLatency: run.updateLatency,
      cacheColdOpenLatency: run.cacheColdOpenLatency,
    })),
    backlogs: report.backlogRuns.map((run) => ({
      repeat: run.repeat,
      initialBytes: run.initialBytes,
      backlogDepth: run.backlogDepth,
      finalRevision: run.finalRevision,
      logicalHeadBytes: run.logicalHeadBytes,
      independentForeignOracleMatched: run.independentForeignOracleMatched,
      updateLatency: run.updateLatency,
    })),
    restartRecovery: {
      concentratedFiles: recovery.concentratedCorpora.reduce((sum, run) => sum + run.files, 0),
      hotFiles: recovery.hotFiles.files,
      fleetFiles: recovery.fleets.reduce((sum, run) => sum + run.files, 0),
      exact: recovery.hotFiles.exact
        && recovery.concentratedCorpora.every((run) => run.exact)
        && recovery.fleets.every((run) => run.exact),
      idempotency: recovery.idempotency,
    },
    work: report.work,
    caveat: report.caveats[0],
  };
  console.log(JSON.stringify(process.env.ROOM_TEXT_REALISTIC_RAW_STDOUT === "1" ? report : summary, null, 2));
} finally {
  await server?.stop();
  await rm(persistence, { recursive: true, force: true });
}
