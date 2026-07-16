// Group-commit lab (dependent-update chain): does committing N canonical
// revisions with ONE materialized-head encode+write per batch cut head-write
// amplification ~Nx while leaving single-push latency unchanged?
//
// Arms (identical deterministic edit schedules on separate files):
//   baseline  — N sequential POST /push        (per-push head write)
//   batch-1   — N sequential POST /push-batch  (batch path, size 1)
//   batch-4/16/64 — schedule chunked into batches
//
// Ground truth for amplification: the store's monotonic blob-write counters
// (roomTextStoreWriteStats), read via GET /write-stats before/after each arm.
// Convergence oracles: byte-exact final content across every arm vs a local
// string oracle (after cache eviction, so the DEFERRED durable head row is
// what answers), digest self-verification, stale-writer batch vs sequential
// equality, per-push failure isolation inside a batch, and SQLite-trigger
// crash injection proving all-or-nothing batch rollback.
//
// Port isolation: this lane owns 8850-8859; this harness uses 8853 (+8854
// inspector). Override with GROUP_COMMIT_PORT / GROUP_COMMIT_INSPECTOR_PORT.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "../..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
const wranglerConfig = path.join(root, "scripts", "room-text-probe", "wrangler.jsonc");
const encoder = new TextEncoder();

const PORT = Number(process.env.GROUP_COMMIT_PORT ?? 8853);
const INSPECTOR_PORT = Number(process.env.GROUP_COMMIT_INSPECTOR_PORT ?? 8854);
const REVISIONS = Number(process.env.GROUP_COMMIT_REVISIONS ?? 256);
const RUNS = Number(process.env.GROUP_COMMIT_RUNS ?? 2);
const HEAD_BYTES = Number(process.env.GROUP_COMMIT_HEAD_BYTES ?? 420_652);
const BATCH_SIZES = [1, 4, 16, 64];
const RESULT_PATH = process.env.GROUP_COMMIT_RESULT_PATH
  || path.join(os.tmpdir(), `bashroom-group-commit-${process.pid}-${Date.now()}.json`);

assert.equal(REVISIONS % 64, 0, "REVISIONS must be divisible by every batch size");

function round(value) {
  return Number(value.toFixed(3));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function latencySummary(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    totalMs: round(total),
    meanMs: round(total / values.length),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(Math.max(...values)),
  };
}

function fixture(size, seed) {
  const line = `# ${seed}\nThe quick brown fox edits durable Markdown state.\n`;
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Deterministic dependent-edit schedule: single-character replacements at
// spread positions. Constant length keeps the head at exactly HEAD_BYTES so
// per-revision blob byte accounting divides evenly.
function buildSchedule(content, revisions) {
  const schedule = [];
  let doc = content;
  for (let index = 0; index < revisions; index++) {
    const pos = (index * 7_919) % (doc.length - 1);
    const currentChar = doc[pos];
    const insert = currentChar === "x" ? "y" : "x";
    schedule.push({ from: pos, to: pos + 1, insert });
    doc = doc.slice(0, pos) + insert + doc.slice(pos + 1);
  }
  return { schedule, finalContent: doc };
}

async function waitForReady(child, base, output, timeoutMs = 90_000) {
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
  const output = { value: "" };
  const child = spawn(wrangler, [
    "dev",
    "-c", wranglerConfig,
    "--ip", "127.0.0.1",
    "--port", String(PORT),
    "--inspector-port", String(INSPECTOR_PORT),
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
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await waitForReady(child, base, output);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  }
  return {
    base,
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

// Long single-server sessions occasionally wedge one kept-alive connection
// (observed as UND_ERR_HEADERS_TIMEOUT after thousands of requests while
// sibling lanes load the machine). Network-level flakes retry with a fresh
// request; HTTP-level results never do. Pushes are idempotent by design
// ((clientId, requestId) replays return the original commit), so a retry
// after an ambiguous timeout is semantically safe and adds no blob writes.
class HttpError extends Error {}
let networkRetries = 0;

function isNetworkFlake(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError"
    || /fetch failed|non-JSON response|terminated|socket/i.test(String(error?.message ?? ""));
}

async function requestJson(server, room, route, init, allowFailureStatus = false) {
  const url = new URL(route, server.base);
  url.searchParams.set("room", room);
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${response.status} ${route}: non-JSON response ${text.slice(0, 300)}`);
      }
      if (!response.ok && !allowFailureStatus) {
        throw new HttpError(`${response.status} ${route}: ${JSON.stringify(body)}`);
      }
      return { status: response.status, body, attempt };
    } catch (error) {
      if (error instanceof HttpError || attempt >= 3 || !isNetworkFlake(error)) throw error;
      networkRetries++;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

const get = async (server, room, route) => (await requestJson(server, room, route)).body;
const post = async (server, room, route, body) => (await requestJson(server, room, route, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
})).body;

function pushBody(fileId, baseRevision, clientId, requestId, changes) {
  return { protocol: 1, fileId, epoch: 1, baseRevision, clientId, requestId, changes };
}

// Create with retry-ambiguity tolerance: if the first attempt timed out
// after actually committing, the retry sees ALREADY_EXISTS — acceptable
// because room names are unique per invocation (fresh persistence dir).
async function createFile(server, room, fileId, filePath, content) {
  const { body, attempt } = await requestJson(server, room, "/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileId, path: filePath, content }),
  });
  if (body.ok !== true) {
    assert.ok(attempt > 1 && body.error === "ALREADY_EXISTS", JSON.stringify(body));
  }
  return body;
}

async function verifyFinalState(server, room, fileId, expectedContent, expectedRevision) {
  // Evict first: the deferred durable head row (not the memory cache) must
  // answer the read byte-exactly.
  assert.equal((await post(server, room, `/evict?file=${encodeURIComponent(fileId)}`)).ok, true);
  const opened = await get(server, room, `/open?file=${encodeURIComponent(fileId)}`);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.revision, expectedRevision);
  assert.equal(opened.content, expectedContent, "durable head content diverged from the local oracle");
  assert.equal(opened.byteLength, encoder.encode(expectedContent).byteLength);
  const verified = await get(server, room, `/digest/verify?file=${encodeURIComponent(fileId)}`);
  assert.equal(verified.match, true, "maintained digest row diverged from from-scratch hash");
  const inspected = await get(server, room, `/inspect?file=${encodeURIComponent(fileId)}`);
  assert.equal(inspected.revision, expectedRevision);
  assert.equal(inspected.updateCount, expectedRevision, "canonical update log must hold one row per revision");
  return inspected;
}

async function runArm(server, run, arm, batchSize) {
  const room = `gc-run${run}-${arm}`;
  const fileId = "doc";
  // One shared seed across arms: identical initial content -> identical
  // schedule -> the cross-arm sha check proves byte-exact convergence.
  const content = fixture(HEAD_BYTES, "gc-shared");
  const { schedule, finalContent } = buildSchedule(content, REVISIONS);

  const created = await createFile(server, room, fileId, "gc/doc.md", content);
  if (created.ok) assert.equal(created.byteLength, HEAD_BYTES);

  const statsBefore = await get(server, room, "/write-stats");
  const latencies = [];
  const started = performance.now();

  if (arm === "baseline") {
    for (let index = 0; index < REVISIONS; index++) {
      const body = pushBody(fileId, index, "gc-client", `r-${index}`, [schedule[index]]);
      const t0 = performance.now();
      const accepted = await post(server, room, "/push", body);
      latencies.push(performance.now() - t0);
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      assert.equal(accepted.revision, index + 1);
    }
  } else {
    for (let start = 0; start < REVISIONS; start += batchSize) {
      const pushes = [];
      for (let index = start; index < start + batchSize; index++) {
        pushes.push(pushBody(fileId, index, "gc-client", `r-${index}`, [schedule[index]]));
      }
      const t0 = performance.now();
      const { body: response, attempt } = await requestJson(server, room, "/push-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pushes }),
      });
      latencies.push(performance.now() - t0);
      assert.equal(response.ok, true, JSON.stringify(response).slice(0, 300));
      assert.equal(response.results.length, batchSize);
      for (let offset = 0; offset < batchSize; offset++) {
        const result = response.results[offset];
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.revision, start + offset + 1);
        // A retried batch replays idempotently; `fresh` marks first commits.
        if (attempt === 1) assert.equal(result.fresh, true);
      }
    }
  }
  const wallMs = performance.now() - started;
  const statsAfter = await get(server, room, "/write-stats");
  await verifyFinalState(server, room, fileId, finalContent, REVISIONS);

  const headBytesDelta = statsAfter.headBlobBytes - statsBefore.headBlobBytes;
  const headWritesDelta = statsAfter.headBlobWrites - statsBefore.headBlobWrites;
  const snapshotBytesDelta = statsAfter.snapshotBlobBytes - statsBefore.snapshotBlobBytes;
  const snapshotWritesDelta = statsAfter.snapshotBlobWrites - statsBefore.snapshotBlobWrites;
  return {
    arm,
    batchSize: arm === "baseline" ? 1 : batchSize,
    revisions: REVISIONS,
    requests: latencies.length,
    wallMs: round(wallMs),
    revisionsPerSecond: round(REVISIONS * 1_000 / wallMs),
    headBlobWrites: headWritesDelta,
    headBlobBytes: headBytesDelta,
    headBytesPerRevision: round(headBytesDelta / REVISIONS),
    snapshotBlobWrites: snapshotWritesDelta,
    snapshotBlobBytes: snapshotBytesDelta,
    requestLatency: latencySummary(latencies),
    perRevisionMs: round(wallMs / REVISIONS),
    finalContentSha256: sha256(finalContent),
  };
}

// Stale-writer oracle: 16 pushes all based on revision 0 from distinct
// clients — sequentially via /push in room A, as ONE batch in room B. The
// rebase pipeline must produce identical final content.
async function runStaleWriterOracle(server) {
  const content = fixture(HEAD_BYTES, "gc-stale");
  const fileId = "doc";
  const pushesFor = () => Array.from({ length: 16 }, (_, index) =>
    pushBody(fileId, 0, `stale-writer-${index}`, "wall", [{ from: 0, to: 0, insert: `<${index}>` }]));

  const roomA = "gc-stale-sequential";
  await createFile(server, roomA, fileId, "gc/doc.md", content);
  for (const body of pushesFor()) {
    const accepted = await post(server, roomA, "/push", body);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
  }
  const roomB = "gc-stale-batched";
  await createFile(server, roomB, fileId, "gc/doc.md", content);
  const batched = await post(server, roomB, "/push-batch", { pushes: pushesFor() });
  assert.equal(batched.ok, true);
  for (const result of batched.results) assert.equal(result.ok, true, JSON.stringify(result));

  for (const room of [roomA, roomB]) {
    assert.equal((await post(server, room, `/evict?file=${fileId}`)).ok, true);
  }
  const openedA = await get(server, roomA, `/open?file=${fileId}`);
  const openedB = await get(server, roomB, `/open?file=${fileId}`);
  assert.equal(openedA.ok, true);
  assert.equal(openedB.ok, true);
  assert.equal(openedA.content, openedB.content, "batched stale-writer rebase diverged from sequential");
  assert.equal(openedA.revision, 16);
  assert.equal(openedB.revision, 16);
  assert.equal((await get(server, roomB, `/digest/verify?file=${fileId}`)).match, true);
  return { staleWriters: 16, converged: true, revision: 16 };
}

// Per-push failure isolation: one rejected push (FUTURE_REVISION) inside a
// batch must not abort its siblings' commits.
async function runFailureIsolation(server) {
  const room = "gc-failure-isolation";
  const fileId = "doc";
  const content = fixture(8_192, room);
  await createFile(server, room, fileId, "gc/doc.md", content);
  const pushes = [
    pushBody(fileId, 0, "iso", "p0", [{ from: 0, to: 0, insert: "A" }]),
    pushBody(fileId, 1, "iso", "p1", [{ from: 0, to: 0, insert: "B" }]),
    pushBody(fileId, 999, "iso", "p2", [{ from: 0, to: 0, insert: "C" }]), // FUTURE_REVISION
    pushBody(fileId, 2, "iso", "p3", [{ from: 0, to: 0, insert: "D" }]),
    pushBody(fileId, 3, "iso", "p4", [{ from: 0, to: 0, insert: "E" }]),
  ];
  const response = await post(server, room, "/push-batch", { pushes });
  assert.equal(response.ok, true);
  const codes = response.results.map((result) => result.ok ? "ok" : result.error);
  assert.deepEqual(codes, ["ok", "ok", "FUTURE_REVISION", "ok", "ok"]);
  assert.equal((await post(server, room, `/evict?file=${fileId}`)).ok, true);
  const opened = await get(server, room, `/open?file=${fileId}`);
  assert.equal(opened.revision, 4);
  assert.equal(opened.content, `EDBA${content}`);
  return { results: codes, finalRevision: 4, isolated: true };
}

// Crash injection: the probe's SQLite trigger aborts the deferred head
// UPDATE, which fires at the BATCH BOUNDARY — the whole batch must roll
// back with zero fragments (all-or-nothing per batch, the documented
// semantic change), and the identical batch must succeed after disarm.
async function runCrashInjection(server) {
  const room = "gc-crash";
  const fileId = "doc";
  const content = fixture(HEAD_BYTES, room);
  await createFile(server, room, fileId, "gc/doc.md", content);
  const warm = await post(server, room, "/push",
    pushBody(fileId, 0, "crash", "warm-0", [{ from: 0, to: 0, insert: "W" }]));
  assert.equal(warm.ok, true);

  // Baseline single-push crash first (per-push rollback, unchanged semantics).
  assert.equal((await post(server, room, "/fault/arm", { kind: "abort-head-update" })).ok, true);
  const singleCrash = await requestJson(server, room, "/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pushBody(fileId, 1, "crash", "single-crash", [{ from: 0, to: 0, insert: "S" }])),
  }, true);
  assert.equal(singleCrash.status, 500, "injected single-push abort must surface as a 500");

  // Mid-batch crash: 8 dependent pushes, trigger fires on the ONE deferred
  // head write at the batch end -> everything rolls back.
  const batchPushes = Array.from({ length: 8 }, (_, index) =>
    pushBody(fileId, 1 + index, "crash", `b-${index}`, [{ from: 0, to: 0, insert: String(index) }]));
  const batchCrash = await requestJson(server, room, "/push-batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pushes: batchPushes }),
  }, true);
  assert.equal(batchCrash.status, 500, "injected batch abort must surface as a 500");

  const afterCrash = await get(server, room, `/inspect?file=${fileId}`);
  assert.equal(afterCrash.revision, 1, "crashed batch must leave the head untouched");
  assert.equal(afterCrash.updateCount, 1, "crashed batch must leave zero canonical rows");
  assert.equal((await post(server, room, `/evict?file=${fileId}`)).ok, true);
  const openedAfterCrash = await get(server, room, `/open?file=${fileId}`);
  assert.equal(openedAfterCrash.content, `W${content}`, "crashed batch must leave pre-batch content");
  assert.equal((await get(server, room, `/digest/verify?file=${fileId}`)).match, true);

  assert.equal((await post(server, room, "/fault/disarm", {})).ok, true);
  const retried = await post(server, room, "/push-batch", { pushes: batchPushes });
  assert.equal(retried.ok, true);
  for (const result of retried.results) assert.equal(result.ok, true, JSON.stringify(result));
  const afterRetry = await get(server, room, `/inspect?file=${fileId}`);
  assert.equal(afterRetry.revision, 9);
  assert.equal((await post(server, room, `/evict?file=${fileId}`)).ok, true);
  const openedAfterRetry = await get(server, room, `/open?file=${fileId}`);
  assert.equal(openedAfterRetry.content, `76543210W${content}`);
  return { batchRolledBackAtomically: true, retriedAfterDisarm: true, finalRevision: 9 };
}

const persistence = await mkdtemp(path.join(os.tmpdir(), "bashroom-group-commit-"));
let server;
try {
  server = await startServer(persistence);
  const runs = [];
  for (let run = 0; run < RUNS; run++) {
    const arms = [];
    arms.push(await runArm(server, run, "baseline", 1));
    for (const size of BATCH_SIZES) {
      arms.push(await runArm(server, run, `batch-${size}`, size));
    }
    // Byte-exact convergence across every arm of this run: identical
    // schedule -> identical final head (asserted vs local oracle above; the
    // shared sha proves cross-arm identity too).
    const hashes = new Set(arms.map((arm) => arm.finalContentSha256));
    assert.equal(hashes.size, 1, "arms diverged despite identical schedules");
    const baseline = arms.find((arm) => arm.arm === "baseline");
    const summary = {};
    for (const arm of arms) {
      if (arm.arm === "baseline") continue;
      summary[arm.arm] = {
        amplificationReduction: round(baseline.headBytesPerRevision / arm.headBytesPerRevision),
        headBytesPerRevision: arm.headBytesPerRevision,
        batchCommitP50Ms: arm.requestLatency.p50Ms,
        perRevisionMs: arm.perRevisionMs,
      };
    }
    runs.push({
      run,
      arms,
      baselineHeadBytesPerRevision: baseline.headBytesPerRevision,
      baselinePushP50Ms: baseline.requestLatency.p50Ms,
      batch1PushP50Ms: arms.find((arm) => arm.arm === "batch-1").requestLatency.p50Ms,
      batchSummary: summary,
    });
  }

  const oracles = {
    staleWriter: await runStaleWriterOracle(server),
    failureIsolation: await runFailureIsolation(server),
    crashInjection: await runCrashInjection(server),
  };

  // Decision rule (pre-registered): supports iff amplification reduction
  // >= 3x at batch >= 4 AND batch=1 p50 latency within +/-10% of baseline
  // AND all convergence oracles pass.
  const decisions = runs.map((run) => {
    const amp4 = run.batchSummary["batch-4"].amplificationReduction;
    const amp16 = run.batchSummary["batch-16"].amplificationReduction;
    const amp64 = run.batchSummary["batch-64"].amplificationReduction;
    const latencyRatio = round(run.batch1PushP50Ms / run.baselinePushP50Ms);
    return {
      run: run.run,
      amplificationReduction: { "batch-4": amp4, "batch-16": amp16, "batch-64": amp64 },
      ampRulePassed: amp4 >= 3 && amp16 >= 3 && amp64 >= 3,
      batch1LatencyRatio: latencyRatio,
      latencyRulePassed: latencyRatio >= 0.9 && latencyRatio <= 1.1,
    };
  });

  const report = {
    benchmark: "RoomText group-commit (deferred head write) lab",
    startedAt: new Date().toISOString(),
    runtime: `Node ${process.version}; workerd via Wrangler`,
    config: { port: PORT, revisions: REVISIONS, runs: RUNS, headBytes: HEAD_BYTES, batchSizes: BATCH_SIZES },
    runs,
    oracles,
    decisions,
    oraclesPassed: true,
    networkRetries,
    semanticChange: "Crash atomicity widens from per-push to per-batch: an invariant failure mid-batch rolls back every push in the batch (proven by crashInjection). Per-push REJECTIONS still fail independently (proven by failureIsolation).",
  };
  await writeFile(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    resultPath: RESULT_PATH,
    decisions,
    oracles,
    runs: runs.map((run) => ({
      run: run.run,
      baselineHeadBytesPerRevision: run.baselineHeadBytesPerRevision,
      baselinePushP50Ms: run.baselinePushP50Ms,
      batch1PushP50Ms: run.batch1PushP50Ms,
      batchSummary: run.batchSummary,
    })),
  }, null, 2));
} finally {
  await server?.stop();
  await rm(persistence, { recursive: true, force: true });
}
