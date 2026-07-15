// Experiment 2: chunk-aligned dirty-spine hashing (feeds the room digest
// index design). Hypothesis: caching per-node content hashes keyed by the
// rope's immutable node identity (WeakMap) makes per-revision document
// hashing cost O(dirty spine) instead of O(document).
//
// Decision rule (pre-registered): adopt if incremental is <=15% of the
// full-rehash cost at median across traces AND the incrementally maintained
// root hash equals a from-scratch hash of the final content (which also
// proves the combine is structure-independent).
//
// Hash: polynomial rolling hash, combine(h1, h2, len2) = h1*B^len2 + h2
// (mod p) — associative over content, so subtree hashes merge in O(1) and
// the result is independent of tree shape. p < 2^26 keeps every product
// below 2^52 (exact in doubles). Production would use two moduli or a real
// mergeable hash; one modulus is fine for a cost-structure benchmark.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import type { Text } from "@codemirror/state";
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

function loadTrace(name: string): SequentialTrace {
  const filename = join(editingTracesRoot, "sequential_traces", `${name}.json.gz`);
  return JSON.parse(gunzipSync(readFileSync(filename)).toString("utf8")) as SequentialTrace;
}

// ── polynomial content hash ──
const P = 67_108_859; // largest prime < 2^26
const B = 131;

function polyHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * B + value.charCodeAt(index)) % P;
  }
  return hash;
}

const powCache = new Map<number, number>();
function powB(exponent: number): number {
  const cached = powCache.get(exponent);
  if (cached !== undefined) return cached;
  let result = 1;
  let base = B % P;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining & 1) result = (result * base) % P;
    base = (base * base) % P;
    remaining >>>= 1;
  }
  powCache.set(exponent, result);
  return result;
}

function combine(left: number, right: number, rightLength: number): number {
  return (left * powB(rightLength) + right) % P;
}

const SEPARATOR_HASH = polyHash("\n");

// ── incremental: per-node cache keyed by object identity ──
type NodeInfo = { hash: number; length: number };
let nodeCache = new WeakMap<Text, NodeInfo>();
let leavesHashed = 0;

function hashOfNode(node: Text): NodeInfo {
  const cached = nodeCache.get(node);
  if (cached) return cached;
  let info: NodeInfo;
  const children = (node as unknown as { children: readonly Text[] | null }).children;
  if (children) {
    let hash = 0;
    let length = 0;
    for (let index = 0; index < children.length; index++) {
      const child = hashOfNode(children[index]);
      if (index > 0) {
        hash = combine(hash, SEPARATOR_HASH, 1);
        length += 1;
      }
      hash = combine(hash, child.hash, child.length);
      length += child.length;
    }
    info = { hash, length };
  } else {
    leavesHashed++;
    const content = node.sliceString(0, node.length);
    info = { hash: polyHash(content), length: content.length };
  }
  nodeCache.set(node, info);
  return info;
}

// ── replay with per-revision hashing under each strategy ──
function run(trace: SequentialTrace, strategy: "full" | "incremental") {
  nodeCache = new WeakMap();
  leavesHashed = 0;
  let doc = roomTextFromString(trace.startContent);
  let byteLength = roomTextByteLength(doc);
  let revisions = 0;
  let lastHash = 0;
  const started = performance.now();

  for (const transaction of trace.txns) {
    let combined: ReturnType<typeof changeSetFromWire> | undefined;
    let workingLength = doc.length;
    for (const [position, remove, insert] of transaction.patches) {
      const next = changeSetFromWire([{ from: position, to: position + remove, insert }], workingLength);
      combined = combined ? combined.compose(next) : next;
      workingLength = next.newLength;
    }
    if (!combined) continue;
    const applied = applyRoomTextChange(doc, combined, byteLength);
    doc = applied.doc;
    byteLength = applied.byteLength;
    revisions++;
    lastHash = strategy === "full" ? polyHash(doc.toString()) : hashOfNode(doc).hash;
  }

  const elapsed = performance.now() - started;
  return { elapsed, revisions, lastHash, leavesHashed, finalContent: doc.toString() };
}

const rows: Array<Record<string, string | number>> = [];
for (const name of traceNames) {
  const trace = loadTrace(name);
  const full = run(trace, "full");
  const incremental = run(trace, "incremental");

  // Correctness gate: incremental root must equal a from-scratch hash of
  // the final content — proving cache reuse AND structure-independence.
  assert.equal(incremental.lastHash, polyHash(incremental.finalContent), `${name}: root hash mismatch`);
  assert.equal(incremental.finalContent, trace.endContent, `${name}: content mismatch`);

  rows.push({
    trace: name,
    revisions: full.revisions,
    "full ms": Number(full.elapsed.toFixed(1)),
    "incr ms": Number(incremental.elapsed.toFixed(1)),
    "incr/full": `${((incremental.elapsed / full.elapsed) * 100).toFixed(1)}%`,
    "leaves hashed": incremental.leavesHashed,
  });
}
console.table(rows);
console.log("gate: all incremental roots equal from-scratch content hashes; finals byte-exact");
