import assert from "node:assert/strict";
import { ChangeSet, Text } from "@codemirror/state";

const base = process.argv[2] || "http://localhost:8798";
const fileId = `probe-${Date.now()}`;
const room = `room-${Date.now()}`;
const concurrency = 50;

async function json(path, init) {
  const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}room=${room}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function post(path, body) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return json(path, init);
}

const created = await post("/create", { fileId, path: "notes/probe.md", content: "" });
assert.equal(created.ok, true);

// Every request deliberately starts at revision zero. The DO must serialize
// and rebase all fifty rather than losing or overwriting concurrent inserts.
const concurrent = await Promise.all(Array.from({ length: concurrency }, (_, index) => post("/push", {
  protocol: 1,
  fileId,
  epoch: 1,
  baseRevision: 0,
  clientId: `client-${index}`,
  requestId: "insert-1",
  changes: [{ from: 0, to: 0, insert: String.fromCharCode(65 + (index % 26)) }],
})));
assert.ok(concurrent.every((result) => result.ok));
const revisions = concurrent.map((result) => result.revision).sort((a, b) => a - b);
assert.deepEqual(revisions, Array.from({ length: concurrency }, (_, index) => index + 1));

const afterConcurrent = await json(`/open?file=${fileId}`);
assert.equal(afterConcurrent.ok, true);
assert.equal(afterConcurrent.revision, concurrency);
assert.equal(afterConcurrent.content.length, concurrency);

// Fifty redeliveries of one logical mutation must produce one update and one
// byte. A real client may retry when the commit succeeded but its response died.
const dedupeRequest = {
  protocol: 1,
  fileId,
  epoch: 1,
  baseRevision: concurrency,
  clientId: "retrying-client",
  requestId: "one-logical-request",
  changes: [{ from: concurrency, to: concurrency, insert: "!" }],
};
const retries = await Promise.all(Array.from({ length: concurrency }, () => post("/push", dedupeRequest)));
assert.ok(retries.every((result) => result.ok));
assert.equal(new Set(retries.map((result) => JSON.stringify(result))).size, 1);

const beforeEviction = await json(`/open?file=${fileId}`);
assert.equal(beforeEviction.revision, concurrency + 1);
assert.equal(beforeEviction.content.length, concurrency + 1);
await post(`/evict?file=${fileId}`);
const afterEviction = await json(`/open?file=${fileId}`);
assert.deepEqual(afterEviction, beforeEviction);

await post(`/checkpoint?file=${fileId}`);
await post(`/evict?file=${fileId}`);
const afterCheckpoint = await json(`/open?file=${fileId}`);
assert.deepEqual(afterCheckpoint, beforeEviction);

const pulled = await json(`/pull?file=${fileId}&epoch=1&after=0`);
assert.equal(pulled.ok, true);
assert.equal(pulled.updates.length, concurrency + 1);

const stats = await json(`/inspect?file=${fileId}`);
assert.deepEqual({
  revision: stats.revision,
  snapshotRevision: stats.snapshotRevision,
  updateCount: stats.updateCount,
  byteLength: stats.byteLength,
}, {
  revision: concurrency + 1,
  snapshotRevision: concurrency + 1,
  updateCount: concurrency + 1,
  byteLength: concurrency + 1,
});

// Regression for the SQLite 2 MB per-row limit: JSON escaping expands each
// U+0001 to six bytes. The idempotency row must not duplicate the full response.
const escapedFile = `${fileId}-escaped`;
assert.equal((await post("/create", { fileId: escapedFile, path: "notes/escaped.md", content: "" })).ok, true);
const escapedPaste = "\u0001".repeat(262_144);
const escapedRequest = {
  protocol: 1,
  fileId: escapedFile,
  epoch: 1,
  baseRevision: 0,
  clientId: "escaped-client",
  requestId: "max-escaped-paste",
  changes: [{ from: 0, to: 0, insert: escapedPaste }],
};
const escapedAccepted = await post("/push", escapedRequest);
assert.equal(escapedAccepted.ok, true);
assert.deepEqual(await post("/push", escapedRequest), escapedAccepted);
assert.equal((await json(`/open?file=${escapedFile}`)).byteLength, 262_144);

// Automatic snapshots bound hibernation recovery, and clients outside the
// bounded transformation window receive an explicit reset rather than an
// unbounded rebase.
const checkpointFile = `${fileId}-checkpoint`;
assert.equal((await post("/create", { fileId: checkpointFile, path: "notes/checkpoint.md", content: "" })).ok, true);
for (let revision = 0; revision < 257; revision++) {
  const accepted = await post("/push", {
    protocol: 1,
    fileId: checkpointFile,
    epoch: 1,
    baseRevision: revision,
    clientId: "checkpoint-client",
    requestId: `append-${revision}`,
    changes: [{ from: revision, to: revision, insert: "x" }],
  });
  assert.equal(accepted.ok, true);
}
const checkpointStats = await json(`/inspect?file=${checkpointFile}`);
assert.equal(checkpointStats.snapshotRevision, 256);
assert.equal(checkpointStats.recoveryTailBytes > 0, true);
const tooStale = await post("/push", {
  protocol: 1,
  fileId: checkpointFile,
  epoch: 1,
  baseRevision: 0,
  clientId: "stale-client",
  requestId: "too-stale",
  changes: [{ from: 0, to: 0, insert: "y" }],
});
assert.equal(tooStale.error, "RESET_REQUIRED");
for (let revision = 257; revision < 640; revision++) {
  const accepted = await post("/push", {
    protocol: 1,
    fileId: checkpointFile,
    epoch: 1,
    baseRevision: revision,
    clientId: "checkpoint-client",
    requestId: `append-${revision}`,
    changes: [{ from: revision, to: revision, insert: "x" }],
  });
  assert.equal(accepted.ok, true);
}
// The floor closes the sync window but no longer deletes the rows below it:
// they are cold history awaiting the flush janitor.
const retainedStats = await json(`/inspect?file=${checkpointFile}`);
assert.equal(retainedStats.snapshotRevision, 640);
assert.equal(retainedStats.historyFloor, 257);
assert.equal(retainedStats.updateCount, 640);
assert.equal(retainedStats.belowFloorUpdates, 256);
await post(`/evict?file=${checkpointFile}`);
const recoveredCheckpoint = await json(`/open?file=${checkpointFile}`);
assert.equal(recoveredCheckpoint.content, "x".repeat(640));

// Server-mapped comment anchors: a push may carry open-anchor offsets; the
// accept result returns them mapped through the exact canonical ChangeSet,
// and DocumentCollab.remapCommentAnchors persists them for open comments.
const anchorFile = `${fileId}-anchors`;
assert.equal(
  (await post("/create", { fileId: anchorFile, path: "notes/anchors.md", content: "hello world notes" })).ok,
  true,
);
const added = await post("/comments/add", {
  authorUserId: "user-a",
  author: "usera",
  anchorStart: 6,
  anchorEnd: 11,
  quote: "world",
  body: "anchor probe",
  documentEtag: "etag-1",
});
assert.equal(added.ok, true);
const commentId = added.comment.id;

const anchoredRequest = {
  protocol: 1,
  fileId: anchorFile,
  epoch: 1,
  baseRevision: 0,
  clientId: "anchor-client",
  requestId: "insert-before-anchor",
  changes: [{ from: 0, to: 0, insert: ">> " }],
  anchors: [{ id: commentId, start: 6, end: 11 }],
};
const anchoredPush = await post("/push", anchoredRequest);
assert.equal(anchoredPush.ok, true);
assert.deepEqual(anchoredPush.anchors, [{ id: commentId, start: 9, end: 14 }]);

// An idempotent replay returns the same revision but never re-reports
// anchors: the first accept already carried the mapping, and mapping an
// already rewritten anchor through the same update would double-shift it.
const anchoredReplay = await post("/push", anchoredRequest);
assert.equal(anchoredReplay.ok, true);
assert.equal(anchoredReplay.revision, anchoredPush.revision);
assert.equal(anchoredReplay.anchors, undefined);

const remapped = await post("/comments/remap", { anchors: anchoredPush.anchors.map((anchor) => ({
  id: anchor.id,
  anchor_start: anchor.start,
  anchor_end: anchor.end,
})) });
assert.deepEqual(remapped, { ok: true, updated: 1 });
const openComments = await json("/comments/list");
assert.equal(openComments[0].anchor_start, 9);
assert.equal(openComments[0].anchor_end, 14);

// Resolved comments freeze their offsets: the remap RPC skips them.
const resolvedComment = await post("/comments/resolve", {
  id: commentId,
  actorUserId: "user-a",
  actor: "usera",
  canResolveAny: true,
});
assert.equal(resolvedComment.ok, true);
const remapAfterResolve = await post("/comments/remap", {
  anchors: [{ id: commentId, anchor_start: 0, anchor_end: 1 }],
});
assert.deepEqual(remapAfterResolve, { ok: true, updated: 0 });
const frozenComments = await json("/comments/list");
assert.equal(frozenComments[0].anchor_start, 9);
assert.equal(frozenComments[0].anchor_end, 14);

// A 640-byte document sits under the SOFT threshold: history keeps
// per-revision granularity instead of composing runs.
const softCompact = await post(`/compact?file=${checkpointFile}`);
assert.deepEqual(
  { mode: softCompact.mode, composedRows: softCompact.composedRows, belowFloorUpdates: softCompact.belowFloorUpdates },
  { mode: "soft", composedRows: 0, belowFloorUpdates: 256 },
);
assert.equal((await json(`/inspect?file=${checkpointFile}`)).updateCount, 640);

// History janitor: HARD compaction below the floor, R2 version export with
// an etag-CAS HEAD flip, and crash-safe floor advance. The document must be
// >= 8 KB so compaction is not SOFT-skipped, and 768 appends put 384 rows
// (> 256) below the floor at the sixth automatic checkpoint.
const janitorFile = `${fileId}-janitor`;
const seed = "seed\n".repeat(1800);
assert.equal((await post("/create", { fileId: janitorFile, path: "notes/janitor.md", content: seed })).ok, true);
for (let index = 0; index < 768; index++) {
  const accepted = await post("/push", {
    protocol: 1,
    fileId: janitorFile,
    epoch: 1,
    baseRevision: index,
    clientId: `janitor-writer-${Math.floor(index / 8) % 2}`,
    requestId: `append-${index}`,
    changes: [{ from: seed.length + index, to: seed.length + index, insert: "x" }],
  });
  assert.equal(accepted.ok, true);
}
const janitorStats = await json(`/inspect?file=${janitorFile}`);
assert.deepEqual(
  {
    revision: janitorStats.revision,
    snapshotRevision: janitorStats.snapshotRevision,
    historyFloor: janitorStats.historyFloor,
    updateCount: janitorStats.updateCount,
    belowFloorUpdates: janitorStats.belowFloorUpdates,
  },
  { revision: 768, snapshotRevision: 768, historyFloor: 385, updateCount: 768, belowFloorUpdates: 384 },
);

// Compaction rewrites ONLY strictly-below-floor rows: 48 same-client runs of
// eight collapse to 48 composed rows while every live-window row survives
// byte-identically (the rebaseUpdates clientID confirmation invariant).
const exportBefore = await json(`/export?file=${janitorFile}`);
const compacted = await post(`/compact?file=${janitorFile}`);
assert.deepEqual(
  { mode: compacted.mode, composedRows: compacted.composedRows, belowFloorUpdates: compacted.belowFloorUpdates },
  { mode: "compacted", composedRows: 48, belowFloorUpdates: 48 },
);
const exportAfter = await json(`/export?file=${janitorFile}`);
const entriesBefore = JSON.parse(exportBefore.composed_changes_json);
const entriesAfter = JSON.parse(exportAfter.composed_changes_json);
assert.deepEqual(
  entriesAfter.filter((entry) => entry.revision >= 385),
  entriesBefore.filter((entry) => entry.revision >= 385),
);
assert.equal(entriesAfter.filter((entry) => entry.revision < 385).length, 48);
assert.equal(exportAfter.snapshot_base64, exportBefore.snapshot_base64);
assert.equal((await json(`/open?file=${janitorFile}`)).content, seed + "x".repeat(768));

// Composed history still replays byte-exactly from the created document.
{
  let doc = Text.of(seed.split("\n"));
  for (const entry of entriesAfter) doc = ChangeSet.fromJSON(entry.changes).apply(doc);
  assert.equal(doc.toString(), Buffer.from(exportAfter.snapshot_base64, "base64").toString("utf8"));
}

// Re-running the compactor composes nothing further and re-exports
// byte-identical artifacts — the property that makes alarm re-fires safe.
const compactAgain = await post(`/compact?file=${janitorFile}`);
assert.deepEqual(
  { mode: compactAgain.mode, composedRows: compactAgain.composedRows },
  { mode: "idle", composedRows: 0 },
);
assert.deepEqual(await json(`/export?file=${janitorFile}`), exportAfter);

// A lagging-but-in-window client still rebases over the untouched live rows.
const lagging = await post("/push", {
  protocol: 1,
  fileId: janitorFile,
  epoch: 1,
  baseRevision: 760,
  clientId: "janitor-lagger",
  requestId: "lag-1",
  changes: [{ from: seed.length + 760, to: seed.length + 760, insert: "L" }],
});
assert.equal(lagging.ok, true);
assert.equal(lagging.revision, 769);
const beforeFlush = await json(`/open?file=${janitorFile}`);
assert.equal(beforeFlush.content.length, seed.length + 769);

// Real alarm wiring: schedule, then wait for the janitor to flush.
const historyPrefix = `rooms/${room}/.history/${janitorFile}`;
const artifactKey = `${historyPrefix}/1@768`;
const headKey = `${historyPrefix}/HEAD`;
await post(`/janitor/schedule?file=${janitorFile}`);
let r2AfterFlush;
for (let attempt = 0; attempt < 150; attempt++) {
  r2AfterFlush = (await json("/janitor/r2")).objects;
  if (r2AfterFlush[headKey]) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(r2AfterFlush[headKey], "alarm janitor did not publish HEAD");
assert.ok(r2AfterFlush[artifactKey], "alarm janitor did not PUT the version artifact");
const headManifest = JSON.parse(Buffer.from(r2AfterFlush[headKey].base64, "base64").toString("utf8"));
assert.deepEqual(headManifest, {
  protocol: 1,
  fileId: janitorFile,
  path: "notes/janitor.md",
  epoch: 1,
  revision: 768,
  byteLength: seed.length + 768,
  artifact: "1@768",
});
const flushedStats = await json(`/inspect?file=${janitorFile}`);
assert.deepEqual(
  { historyFloor: flushedStats.historyFloor, updateCount: flushedStats.updateCount, belowFloorUpdates: flushedStats.belowFloorUpdates },
  { historyFloor: 768, updateCount: 2, belowFloorUpdates: 0 },
);
// Floor advance keeps cold replay byte-exact.
await post(`/evict?file=${janitorFile}`);
assert.deepEqual(await json(`/open?file=${janitorFile}`), beforeFlush);

// Alarm re-fire: the create-only artifact PUT and the content-equal HEAD
// manifest make the whole pass a no-op — same artifact bytes, single
// visible HEAD, floor unmoved.
const refire = await post(`/janitor/fire?file=${janitorFile}`);
assert.deepEqual(
  {
    ok: refire.ok,
    artifactWritten: refire.artifactWritten,
    headFlip: refire.headFlip,
    historyFloor: refire.advanced.historyFloor,
    prunedUpdates: refire.advanced.prunedUpdates,
  },
  { ok: true, artifactWritten: false, headFlip: "already-visible", historyFloor: 768, prunedUpdates: 0 },
);
const r2AfterRefire = (await json("/janitor/r2")).objects;
assert.equal(r2AfterRefire[artifactKey].base64, r2AfterFlush[artifactKey].base64);
assert.equal(r2AfterRefire[headKey].etag, r2AfterFlush[headKey].etag);

// Crash between artifact PUT and HEAD flip: the artifact is orphaned, HEAD
// and the floor stay put, and the next fire completes the flush.
for (let index = 0; index < 3; index++) {
  const accepted = await post("/push", {
    protocol: 1,
    fileId: janitorFile,
    epoch: 1,
    baseRevision: 769 + index,
    clientId: "janitor-writer-0",
    requestId: `crash-append-${index}`,
    changes: [{ from: seed.length + 769 + index, to: seed.length + 769 + index, insert: "y" }],
  });
  assert.equal(accepted.ok, true);
}
await post(`/checkpoint?file=${janitorFile}`);
const beforeCrash = await json(`/open?file=${janitorFile}`);
const crashArtifactKey = `${historyPrefix}/1@772`;
const crashed = await post(`/janitor/fire?file=${janitorFile}&crash=before-head-flip`);
assert.deepEqual({ ok: crashed.ok, crashed: crashed.crashed }, { ok: false, crashed: true });
const r2AfterCrash = (await json("/janitor/r2")).objects;
assert.ok(r2AfterCrash[crashArtifactKey], "artifact must be durable before the flip");
assert.equal(r2AfterCrash[headKey].etag, r2AfterFlush[headKey].etag);
assert.equal((await json(`/inspect?file=${janitorFile}`)).historyFloor, 768);

const recovery = await post(`/janitor/fire?file=${janitorFile}`);
assert.deepEqual(
  {
    ok: recovery.ok,
    revision: recovery.revision,
    artifactWritten: recovery.artifactWritten,
    headFlip: recovery.headFlip,
    historyFloor: recovery.advanced.historyFloor,
    prunedUpdates: recovery.advanced.prunedUpdates,
  },
  { ok: true, revision: 772, artifactWritten: false, headFlip: "flipped", historyFloor: 772, prunedUpdates: 4 },
);
const r2AfterRecovery = (await json("/janitor/r2")).objects;
assert.equal(r2AfterRecovery[crashArtifactKey].base64, r2AfterCrash[crashArtifactKey].base64);
assert.equal(JSON.parse(Buffer.from(r2AfterRecovery[headKey].base64, "base64").toString("utf8")).artifact, "1@772");
const recoveredStats = await json(`/inspect?file=${janitorFile}`);
assert.deepEqual(
  { historyFloor: recoveredStats.historyFloor, updateCount: recoveredStats.updateCount, belowFloorUpdates: recoveredStats.belowFloorUpdates },
  { historyFloor: 772, updateCount: 1, belowFloorUpdates: 0 },
);
await post(`/evict?file=${janitorFile}`);
assert.deepEqual(await json(`/open?file=${janitorFile}`), beforeCrash);

// Consecutive artifacts chain byte-exactly: replaying 1@772's entries above
// 768 on top of 1@768's snapshot reproduces 1@772's snapshot.
{
  const artifact768 = JSON.parse(Buffer.from(r2AfterRecovery[artifactKey].base64, "base64").toString("utf8"));
  const artifact772 = JSON.parse(Buffer.from(r2AfterRecovery[crashArtifactKey].base64, "base64").toString("utf8"));
  let doc = Text.of(Buffer.from(artifact768.snapshot_base64, "base64").toString("utf8").split("\n"));
  for (const entry of JSON.parse(artifact772.composed_changes_json)) {
    if (entry.revision <= artifact768.revision) continue;
    doc = ChangeSet.fromJSON(entry.changes).apply(doc);
  }
  assert.equal(doc.toString(), Buffer.from(artifact772.snapshot_base64, "base64").toString("utf8"));
}

// Floor advance guard rails: past the snapshot is refused, behind the floor
// is an idempotent no-op.
assert.equal((await post(`/advance?file=${janitorFile}&revision=773`)).error, "INVALID_REQUEST");
const staleAdvance = await post(`/advance?file=${janitorFile}&revision=100`);
assert.deepEqual(
  { ok: staleAdvance.ok, historyFloor: staleAdvance.historyFloor, prunedUpdates: staleAdvance.prunedUpdates },
  { ok: true, historyFloor: 772, prunedUpdates: 0 },
);

// Size-gated digest index. A >32KB document takes the dirty-spine
// incremental path: creating it hashes every leaf once, and a one-character
// edit must NOT rehash the whole document (the WeakMap node cache).
const bigFile = `${fileId}-digest-big`;
const bigContent = Array.from({ length: 2_000 }, (_, line) => `line ${line} ${"x".repeat(40)}`).join("\n");
const leavesBeforeCreate = (await json("/digest/stats")).hashedLeaves;
assert.equal((await post("/create", { fileId: bigFile, path: "notes/digest-big.md", content: bigContent })).ok, true);
const leavesOnCreate = (await json("/digest/stats")).hashedLeaves - leavesBeforeCreate;
assert.ok(leavesOnCreate > 16, `creating a ~100KB doc should hash every leaf, saw ${leavesOnCreate}`);
const leavesBeforeEdit = (await json("/digest/stats")).hashedLeaves;
const bigEdit = {
  protocol: 1,
  fileId: bigFile,
  epoch: 1,
  baseRevision: 0,
  clientId: "digest-client",
  requestId: "big-edit-1",
  changes: [{ from: 10, to: 10, insert: "!" }],
};
assert.equal((await post("/push", bigEdit)).ok, true);
const leavesOnEdit = (await json("/digest/stats")).hashedLeaves - leavesBeforeEdit;
assert.ok(leavesOnEdit > 0, "an edit must rehash its dirty leaf");
assert.ok(
  leavesOnEdit * 8 < leavesOnCreate,
  `edit rehashed ${leavesOnEdit} of ${leavesOnCreate} leaves; dirty spine should be a small fraction`,
);

// Gate: the incrementally maintained digest equals a from-scratch hash of
// the current content after edits.
const bigVerify = await json(`/digest/verify?file=${bigFile}`);
assert.equal(bigVerify.match, true, `digest ${bigVerify.contentHash} != from-scratch ${bigVerify.fromScratch}`);
assert.equal(bigVerify.revision, 1);

// The room root changes iff any file's content changed: an idempotent
// replay and a checkpoint leave it alone; a fresh accept moves it.
const rootBefore = (await json("/digest/room")).rootHash;
assert.equal((await post("/push", bigEdit)).ok, true);
await post(`/checkpoint?file=${bigFile}`);
assert.equal((await json("/digest/room")).rootHash, rootBefore);
assert.equal((await post("/push", { ...bigEdit, requestId: "big-edit-2", baseRevision: 1 })).ok, true);
const rootAfterEdit = (await json("/digest/room")).rootHash;
assert.notEqual(rootAfterEdit, rootBefore);

// diffDigest returns exactly the changed files: one edited, one created,
// every other file in the room untouched.
const smallFile = `${fileId}-digest-small`;
assert.equal((await post("/create", { fileId: smallFile, path: "notes/digest-small.md", content: "small\n" })).ok, true);
const diff = await json(`/digest/diff?root=${rootBefore}`);
assert.equal(diff.baseKnown, true);
assert.deepEqual(diff.changed.map((file) => file.path), ["notes/digest-big.md"]);
assert.deepEqual(diff.added.map((file) => file.path), ["notes/digest-small.md"]);
assert.deepEqual(diff.removed, []);
const diffCurrent = await json(`/digest/diff?root=${diff.rootHash}`);
assert.deepEqual(
  { baseKnown: diffCurrent.baseKnown, changed: diffCurrent.changed, added: diffCurrent.added },
  { baseKnown: true, changed: [], added: [] },
);

// An unknown root diffs against the empty room: full listing, flagged.
const roomNow = await json("/digest/room");
const diffUnknown = await json("/digest/diff?root=ffffffffffffff-0");
assert.equal(diffUnknown.baseKnown, false);
assert.equal(diffUnknown.changed.length, 0);
assert.equal(diffUnknown.added.length, roomNow.fileCount);

// Gate on the small path too: a <32KB doc hashes whole content, and its
// maintained row still matches from-scratch after an edit.
assert.equal((await post("/push", {
  protocol: 1,
  fileId: smallFile,
  epoch: 1,
  baseRevision: 0,
  clientId: "digest-client",
  requestId: "small-edit-1",
  changes: [{ from: 0, to: 0, insert: "# heading\n" }],
})).ok, true);
const smallVerify = await json(`/digest/verify?file=${smallFile}`);
assert.equal(smallVerify.match, true);
assert.equal(smallVerify.byteLength, "# heading\nsmall\n".length);

// Structure independence: the same >32KB content built as one tree versus
// grown by chunked appends must produce identical digests.
const shapeA = `${fileId}-digest-shape-a`;
const shapeB = `${fileId}-digest-shape-b`;
assert.equal((await post("/create", { fileId: shapeA, path: "notes/digest-shape-a.md", content: bigContent })).ok, true);
assert.equal((await post("/create", { fileId: shapeB, path: "notes/digest-shape-b.md", content: "" })).ok, true);
let grownLength = 0;
let grownRevision = 0;
for (let offset = 0; offset < bigContent.length; offset += 16_000) {
  const chunk = bigContent.slice(offset, offset + 16_000);
  const appended = await post("/push", {
    protocol: 1,
    fileId: shapeB,
    epoch: 1,
    baseRevision: grownRevision,
    clientId: "digest-grower",
    requestId: `grow-${offset}`,
    changes: [{ from: grownLength, to: grownLength, insert: chunk }],
  });
  assert.equal(appended.ok, true);
  grownLength += chunk.length;
  grownRevision = appended.revision;
}
const digestShapeA = await json(`/digest?file=${shapeA}`);
const digestShapeB = await json(`/digest?file=${shapeB}`);
assert.equal(digestShapeA.contentHash, digestShapeB.contentHash);
assert.equal(digestShapeA.byteLength, digestShapeB.byteLength);

console.log(JSON.stringify({
  concurrent: {
    requests: concurrency,
    revisions: `${revisions[0]}..${revisions.at(-1)}`,
    finalBytes: afterConcurrent.byteLength,
    verdict: "all stale updates rebased and committed",
  },
  idempotency: {
    redeliveries: concurrency,
    durableUpdates: 1,
    verdict: "one stored result returned identically",
  },
  recovery: {
    coldTailReplay: "exact",
    checkpointReplay: "exact",
    verdict: "cache is disposable",
  },
  rowLimit: {
    escapedInsertBytes: 262_144,
    identicalRetry: "exact",
    verdict: "request pointer avoids duplicated payload row",
  },
  bounds: {
    automaticCheckpointRevision: retainedStats.snapshotRevision,
    staleWindowUpdates: 256,
    liveWindowUpdates: retainedStats.updateCount - retainedStats.belowFloorUpdates,
    coldHistoryUpdates: retainedStats.belowFloorUpdates,
    historyFloor: retainedStats.historyFloor,
    verdict: "cold replay and stale transform work are bounded; below-floor rows await the flush janitor",
  },
  janitor: {
    composedRuns: compacted.composedRows,
    liveWindowRows: "byte-identical across compaction",
    alarmFlush: { artifact: "1@768", headFlip: "etag CAS" },
    refire: "no-op: create-only artifact PUT, content-equal HEAD",
    crashBetweenPutAndFlip: "artifact orphaned, HEAD unmoved, next fire completed",
    coldReplayAfterFloorAdvance: "byte-exact, artifacts chain 1@768 -> 1@772",
    verdict: "history compaction and version flush are idempotent and crash-safe",
  },
  anchors: {
    mappedOnAccept: `[6,11) -> [9,14)`,
    replayReportsAnchors: false,
    resolvedFrozen: true,
    verdict: "comment anchors follow the canonical ChangeSet, not substrings",
  },
  digest: {
    leavesOnCreate,
    leavesOnEdit,
    fromScratchMatch: { big: bigVerify.match, small: smallVerify.match },
    rootMovedOnlyOnContentChange: true,
    diffAgainstOldRoot: { changed: 1, added: 1, removed: 0 },
    structureIndependent: digestShapeA.contentHash === digestShapeB.contentHash,
    verdict: "size-gated digest index: O(dirty spine) hashing, O(changed) catch-up",
  },
}, null, 2));
