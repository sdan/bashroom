import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { Model } from "json-joy/lib/json-crdt/index.js";
import {
  applyRoomTextChange,
  changeSetFromWire,
  roomTextByteLength,
  roomTextFromString,
} from "../../src/room-text.ts";

type TracePatch = [position: number, remove: number, insert: string];

type SequentialTrace = {
  startContent: string;
  endContent: string;
  txns: Array<{ patches: TracePatch[] }>;
};

type TraceRun = {
  content: string;
  byteLength: number;
};

type TraceMeasurement = {
  system: string;
  trace: string;
  transactions: number;
  patches: number;
  medianMilliseconds: number;
  p95Milliseconds: number;
  transactionsPerSecond: number;
  patchesPerSecond: number;
  finalBytes: number;
};

const textEncoder = new TextEncoder();
const require = createRequire(import.meta.url);
const editingTracesRoot = dirname(require.resolve("editing-traces/package.json"));
const traceNames = [
  "friendsforever_flat",
  "sveltecomponent",
  "rustcode",
  "seph-blog1",
  "automerge-paper",
  "json-crdt-patch",
  "json-crdt-blog-post",
] as const;
let blackhole = 0;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function loadTrace(name: string): SequentialTrace {
  const filename = join(editingTracesRoot, "sequential_traces", `${name}.json.gz`);
  const trace = JSON.parse(gunzipSync(readFileSync(filename)).toString("utf8")) as SequentialTrace;
  assert.equal(typeof trace.startContent, "string", `${name}: startContent must be a string`);
  assert.equal(typeof trace.endContent, "string", `${name}: endContent must be a string`);
  assert.ok(Array.isArray(trace.txns), `${name}: txns must be an array`);
  return trace;
}

function replayRoomTextTrace(trace: SequentialTrace): TraceRun {
  let doc = roomTextFromString(trace.startContent);
  let byteLength = roomTextByteLength(doc);

  for (const transaction of trace.txns) {
    let combined: ReturnType<typeof changeSetFromWire> | undefined;
    let workingLength = doc.length;
    for (const [position, remove, insert] of transaction.patches) {
      const next = changeSetFromWire(
        [{ from: position, to: position + remove, insert }],
        workingLength,
      );
      combined = combined ? combined.compose(next) : next;
      workingLength = next.newLength;
    }
    if (!combined) continue;
    const applied = applyRoomTextChange(doc, combined, byteLength);
    doc = applied.doc;
    byteLength = applied.byteLength;
  }

  const content = doc.toString();
  blackhole ^= content.length + byteLength;
  return { content, byteLength };
}

function replayJsonJoyTrace(trace: SequentialTrace): TraceRun {
  const model = Model.create();
  model.api.set(trace.startContent);
  const text = model.api.str([]);
  for (const transaction of trace.txns) {
    for (const [position, remove, insert] of transaction.patches) {
      if (remove) text.del(position, remove);
      if (insert) text.ins(position, insert);
    }
  }
  const content = text.view();
  const byteLength = textEncoder.encode(content).byteLength;
  blackhole ^= content.length + byteLength;
  return { content, byteLength };
}

function measureTrace(
  system: string,
  name: string,
  trace: SequentialTrace,
  replay: (trace: SequentialTrace) => TraceRun,
  samples: number,
): TraceMeasurement {
  const expectedBytes = textEncoder.encode(trace.endContent);
  const patchCount = trace.txns.reduce((total, transaction) => total + transaction.patches.length, 0);
  const measurements: number[] = [];

  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc?.();
    const started = performance.now();
    const result = replay(trace);
    const elapsed = performance.now() - started;
    assert.equal(result.content, trace.endContent, `${system}/${name}: final text mismatch`);
    assert.equal(result.byteLength, expectedBytes.byteLength, `${system}/${name}: final byte count mismatch`);
    assert.deepEqual(textEncoder.encode(result.content), expectedBytes, `${system}/${name}: final UTF-8 mismatch`);
    measurements.push(elapsed);
  }

  const medianMilliseconds = percentile(measurements, 0.5);
  return {
    system,
    trace: name,
    transactions: trace.txns.length,
    patches: patchCount,
    medianMilliseconds: Number(medianMilliseconds.toFixed(3)),
    p95Milliseconds: Number(percentile(measurements, 0.95).toFixed(3)),
    transactionsPerSecond: Math.round(trace.txns.length / (medianMilliseconds / 1_000)),
    patchesPerSecond: Math.round(patchCount / (medianMilliseconds / 1_000)),
    finalBytes: expectedBytes.byteLength,
  };
}

const samples = Number.parseInt(process.env.ROOM_TEXT_TRACE_SAMPLES || "7", 10);
assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 50, "trace samples must be 1..50");
console.log(JSON.stringify({
  benchmark: "Bashroom real editing-trace comparison",
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  samples,
  note: "Fresh model per sample; final materialization included; SQLite/network excluded.",
}, null, 2));

const rows: TraceMeasurement[] = [];
for (const traceName of traceNames) {
  const trace = loadTrace(traceName);
  rows.push(measureTrace("Bashroom", traceName, trace, replayRoomTextTrace, samples));
  rows.push(measureTrace("JSON Joy", traceName, trace, replayJsonJoyTrace, samples));
}

console.table(rows.map((row) => ({
  system: row.system,
  trace: row.trace,
  txns: row.transactions.toLocaleString("en-US"),
  patches: row.patches.toLocaleString("en-US"),
  "median ms": row.medianMilliseconds,
  "p95 ms": row.p95Milliseconds,
  "txns/s": row.transactionsPerSecond.toLocaleString("en-US"),
  "patches/s": row.patchesPerSecond.toLocaleString("en-US"),
  "final bytes": row.finalBytes.toLocaleString("en-US"),
})));

if (blackhole === Number.MIN_SAFE_INTEGER) console.error("unreachable", blackhole);
