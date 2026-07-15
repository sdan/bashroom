import { performance } from "node:perf_hooks";
import process from "node:process";
import * as Y from "yjs";
import { Model, s } from "json-joy/lib/json-crdt/index.js";
import { Writer } from "@jsonjoy.com/buffers/lib/Writer.js";
import { JsonEncoder } from "@jsonjoy.com/json-pack/lib/json/JsonEncoder.js";
import { JsonDecoder } from "@jsonjoy.com/json-pack/lib/json/JsonDecoder.js";
import { CborEncoder } from "@jsonjoy.com/json-pack/lib/cbor/CborEncoder.js";
import { CborDecoder } from "@jsonjoy.com/json-pack/lib/cbor/CborDecoder.js";
import { MsgPackEncoder } from "@jsonjoy.com/json-pack/lib/msgpack/MsgPackEncoder.js";
import { MsgPackDecoder } from "@jsonjoy.com/json-pack/lib/msgpack/MsgPackDecoder.js";
import {
  applyRoomTextChange,
  changeSetFromWire,
  encodeRoomText,
  rebaseRoomTextChange,
  roomTextByteLength,
  roomTextFromString,
} from "../../src/room-text.ts";

type Measurement = {
  name: string;
  opsPerSecond: number;
  microsecondsPerOp: number;
  p95MicrosecondsPerOp: number;
  iterationsPerSample: number;
};

let blackhole = 0;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function markdownFixture(bytes: number): string {
  const line = "- exact markdown line with `code`, tabs\t, and punctuation.\r\n";
  let value = "\ufeff# RoomText benchmark\r\n\r\n";
  while (value.length + line.length <= bytes) value += line;
  return (value + "x".repeat(Math.max(0, bytes - value.length))).slice(0, bytes);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function measure(name: string, operation: () => void, targetSampleMs = 180): Measurement {
  const warmUntil = performance.now() + 50;
  while (performance.now() < warmUntil) operation();

  let iterations = 1;
  while (true) {
    const started = performance.now();
    for (let index = 0; index < iterations; index++) operation();
    const elapsed = performance.now() - started;
    if (elapsed >= 20 || iterations >= 1_000_000) {
      iterations = Math.max(1, Math.min(2_000_000, Math.round(iterations * targetSampleMs / Math.max(elapsed, 0.01))));
      break;
    }
    iterations *= 10;
  }

  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    globalThis.gc?.();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) operation();
    samples.push((performance.now() - started) / iterations);
  }
  const medianMs = percentile(samples, 0.5);
  return {
    name,
    opsPerSecond: Math.round(1_000 / medianMs),
    microsecondsPerOp: Number((medianMs * 1_000).toFixed(3)),
    p95MicrosecondsPerOp: Number((percentile(samples, 0.95) * 1_000).toFixed(3)),
    iterationsPerSample: iterations,
  };
}

// Stateful CRDTs retain edit history. Recreate each engine per sample and run
// a fixed, realistic session length so one very fast engine cannot accumulate
// millions more tombstones simply because calibration gave it more iterations.
function measureStateful(name: string, factory: () => () => void, iterations = 20_000): Measurement {
  const warm = factory();
  for (let index = 0; index < Math.min(iterations, 2_000); index++) warm();
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    globalThis.gc?.();
    const operation = factory();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) operation();
    samples.push((performance.now() - started) / iterations);
  }
  const medianMs = percentile(samples, 0.5);
  return {
    name,
    opsPerSecond: Math.round(1_000 / medianMs),
    microsecondsPerOp: Number((medianMs * 1_000).toFixed(3)),
    p95MicrosecondsPerOp: Number((percentile(samples, 0.95) * 1_000).toFixed(3)),
    iterationsPerSample: iterations,
  };
}

function bashroomEditCycle(source: string): () => void {
  let doc = roomTextFromString(source);
  let byteLength = roomTextByteLength(doc);
  let inserted = false;
  const position = Math.floor(doc.length / 2);
  return () => {
    const changes = changeSetFromWire([inserted
      ? { from: position, to: position + 1, insert: "" }
      : { from: position, to: position, insert: "x" }], doc.length);
    const next = applyRoomTextChange(doc, changes, byteLength);
    doc = next.doc;
    byteLength = next.byteLength;
    inserted = !inserted;
    blackhole ^= doc.length + byteLength;
  };
}

function yjsEditCycle(source: string): { operation: () => void; doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText("text");
  text.insert(0, source);
  let inserted = false;
  let updateBytes = 0;
  doc.on("update", (update: Uint8Array) => { updateBytes = update.byteLength; });
  const position = Math.floor(source.length / 2);
  return {
    doc,
    text,
    operation: () => {
      if (inserted) text.delete(position, 1);
      else text.insert(position, "x");
      inserted = !inserted;
      blackhole ^= text.length + updateBytes;
    },
  };
}

function jsonJoyEditCycle(source: string): { operation: () => void; model: Model<any> } {
  const model = Model.create(s.str(source), 65_537);
  model.api.flush();
  const text = model.api.str();
  let inserted = false;
  const position = Math.floor(source.length / 2);
  return {
    model,
    operation: () => {
      if (inserted) text.del(position, 1);
      else text.ins(position, "x");
      inserted = !inserted;
      const patch = model.api.flush();
      blackhole ^= text.length() + patch.ops.length;
    },
  };
}

function buildBashroomLag(lag: number) {
  const base = roomTextFromString("base");
  let current = base;
  let bytes = 4;
  const accepted: Array<{ updateToken: string; changes: ReturnType<typeof changeSetFromWire> }> = [];
  for (let index = 0; index < lag; index++) {
    const changes = changeSetFromWire([{ from: current.length, to: current.length, insert: "x" }], current.length);
    accepted.push({ updateToken: `accepted-${index}`, changes });
    const next = applyRoomTextChange(current, changes, bytes);
    current = next.doc;
    bytes = next.byteLength;
  }
  const incoming = changeSetFromWire([{ from: 0, to: 0, insert: "y" }], base.length);
  return { incoming, accepted, current, bytes };
}

function buildYjsLag(lag: number): Uint8Array[] {
  const doc = new Y.Doc();
  const text = doc.getText("text");
  text.insert(0, "base");
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  for (let index = 0; index < lag; index++) text.insert(text.length, "x");
  return updates;
}

function printTable(title: string, rows: Measurement[]): void {
  console.log(`\n${title}`);
  console.table(rows.map((row) => ({
    case: row.name,
    "ops/s": row.opsPerSecond.toLocaleString("en-US"),
    "median us": row.microsecondsPerOp,
    "p95 us": row.p95MicrosecondsPerOp,
  })));
}

console.log(JSON.stringify({
  benchmark: "Bashroom RoomText in-process comparison",
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: process.env.BENCH_CPU || "recorded by runner",
  note: "Each table compares one named phase only; persisted/network results are separate.",
}, null, 2));

const editRows: Measurement[] = [];
const materializeRows: Measurement[] = [];
const snapshotRows: Measurement[] = [];
const sizeRows: Array<Record<string, string | number>> = [];
for (const size of [10_000, 100_000, 999_000]) {
  const source = markdownFixture(size);
  const label = size === 999_000 ? "999KB" : `${size / 1_000}KB`;

  editRows.push(measureStateful(`Bashroom ${label} validated edit`, () => bashroomEditCycle(source)));
  editRows.push(measureStateful(`Yjs ${label} local edit`, () => yjsEditCycle(source).operation));
  editRows.push(measureStateful(`JSON Joy ${label} local edit`, () => jsonJoyEditCycle(source).operation));

  const bashroomDoc = roomTextFromString(source);
  const yjs = yjsEditCycle(source);
  const jsonJoy = jsonJoyEditCycle(source);
  materializeRows.push(measure(`Bashroom ${label} -> string`, () => {
    blackhole ^= bashroomDoc.toString().length;
  }));
  materializeRows.push(measure(`Yjs ${label} -> string`, () => {
    blackhole ^= yjs.text.toString().length;
  }));
  materializeRows.push(measure(`JSON Joy ${label} -> string`, () => {
    blackhole ^= String(jsonJoy.model.view()).length;
  }));

  snapshotRows.push(measure(`Bashroom ${label} UTF-8 snapshot`, () => {
    blackhole ^= encodeRoomText(bashroomDoc).byteLength;
  }, 100));
  snapshotRows.push(measure(`Yjs ${label} state update`, () => {
    blackhole ^= Y.encodeStateAsUpdate(yjs.doc).byteLength;
  }, 100));
  snapshotRows.push(measure(`JSON Joy ${label} binary model`, () => {
    blackhole ^= jsonJoy.model.toBinary().byteLength;
  }, 100));

  const bashUpdate = changeSetFromWire([{ from: 1, to: 1, insert: "x" }], bashroomDoc.length);
  let yUpdate = new Uint8Array();
  const tempY = new Y.Doc();
  const tempText = tempY.getText("text");
  tempText.insert(0, source);
  tempY.on("update", (update: Uint8Array) => { yUpdate = update; });
  tempText.insert(1, "x");
  const tempJoy = Model.create(s.str(source), 80_000 + size);
  tempJoy.api.flush();
  tempJoy.api.str().ins(1, "x");
  const joyPatch = tempJoy.api.flush();
  sizeRows.push({
    document: label,
    "plain UTF-8 snapshot": textEncoder.encode(source).byteLength,
    "Bashroom update JSON bytes": textEncoder.encode(JSON.stringify(bashUpdate.toJSON())).byteLength,
    "Yjs incremental bytes": yUpdate.byteLength,
    "JSON Joy patch bytes": joyPatch.toBinary().byteLength,
    "Yjs snapshot bytes": Y.encodeStateAsUpdate(yjs.doc).byteLength,
    "JSON Joy snapshot bytes": jsonJoy.model.toBinary().byteLength,
  });
}

printTable("A1. Hot local mutation (no SQLite/network)", editRows);
printTable("A2. Repeated string access (shows each engine's view caching)", materializeRows);
printTable("A3. Snapshot encoding", snapshotRows);
console.log("\nA4. Payload and snapshot sizes");
console.table(sizeRows);

const lagRows: Measurement[] = [];
for (const lag of [0, 8, 32, 128, 512]) {
  const bashroom = buildBashroomLag(lag);
  lagRows.push(measure(`Bashroom rebase+apply lag ${lag}`, () => {
    const rebased = rebaseRoomTextChange(bashroom.incoming, "incoming", bashroom.accepted);
    blackhole ^= applyRoomTextChange(bashroom.current, rebased, bashroom.bytes).doc.length;
  }));
  if (lag > 0) {
    const updates = buildYjsLag(lag);
    lagRows.push(measure(`Yjs merge ${lag} incremental updates`, () => {
      blackhole ^= Y.mergeUpdates(updates).byteLength;
    }));
  }
}
printTable("A5. Stale-work reconciliation (different algorithms; trend comparison)", lagRows);

const envelope = {
  protocol: 1,
  fileId: "01JROOMTEXTBENCHMARK",
  epoch: 1,
  baseRevision: 421,
  clientId: "browser-7f4ac",
  requestId: "request-422",
  changes: [
    { from: 127, to: 127, insert: "hello 🙂" },
    { from: 512, to: 520, insert: "replacement" },
  ],
};
const jsonString = JSON.stringify(envelope);
const nativeJsonBytes = textEncoder.encode(jsonString);
const jsonJoyJson = new JsonEncoder(new Writer());
const jsonJoyJsonDecoder = new JsonDecoder();
const cbor = new CborEncoder();
const cborDecoder = new CborDecoder();
const messagePack = new MsgPackEncoder();
const messagePackDecoder = new MsgPackDecoder();
const jsonJoyJsonBytes = jsonJoyJson.encode(envelope);
const cborBytes = cbor.encode(envelope);
const messagePackBytes = messagePack.encode(envelope);

const codecEncodeRows = [
  measure("JSON.stringify (string)", () => { blackhole ^= JSON.stringify(envelope).length; }),
  measure("JSON.stringify + TextEncoder", () => { blackhole ^= textEncoder.encode(JSON.stringify(envelope)).byteLength; }),
  measure("JSON Joy JSON encoder", () => { blackhole ^= jsonJoyJson.encode(envelope).byteLength; }),
  measure("JSON Joy CBOR encoder", () => { blackhole ^= cbor.encode(envelope).byteLength; }),
  measure("JSON Joy MessagePack encoder", () => { blackhole ^= messagePack.encode(envelope).byteLength; }),
];
const codecDecodeRows = [
  measure("JSON.parse (string)", () => { blackhole ^= (JSON.parse(jsonString) as typeof envelope).baseRevision; }),
  measure("TextDecoder + JSON.parse", () => { blackhole ^= (JSON.parse(textDecoder.decode(nativeJsonBytes)) as typeof envelope).baseRevision; }),
  measure("JSON Joy JSON decoder", () => { blackhole ^= (jsonJoyJsonDecoder.decode(jsonJoyJsonBytes) as typeof envelope).baseRevision; }),
  measure("JSON Joy CBOR decoder", () => { blackhole ^= (cborDecoder.decode(cborBytes) as typeof envelope).baseRevision; }),
  measure("JSON Joy MessagePack decoder", () => { blackhole ^= (messagePackDecoder.decode(messagePackBytes) as typeof envelope).baseRevision; }),
];
printTable("B1. Identical update-envelope encoding", codecEncodeRows);
printTable("B2. Identical update-envelope decoding", codecDecodeRows);
console.log("\nB3. Identical update-envelope encoded sizes");
console.table([
  { codec: "native JSON UTF-8", bytes: nativeJsonBytes.byteLength },
  { codec: "JSON Joy JSON", bytes: jsonJoyJsonBytes.byteLength },
  { codec: "JSON Joy CBOR", bytes: cborBytes.byteLength },
  { codec: "JSON Joy MessagePack", bytes: messagePackBytes.byteLength },
]);

if (blackhole === Number.MIN_SAFE_INTEGER) console.error("unreachable", blackhole);
