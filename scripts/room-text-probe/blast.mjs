import assert from "node:assert/strict";

const base = process.argv[2] || "http://localhost:8792";
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
const retainedStats = await json(`/inspect?file=${checkpointFile}`);
assert.equal(retainedStats.snapshotRevision, 640);
assert.equal(retainedStats.historyFloor, 257);
assert.equal(retainedStats.updateCount, 384);
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
    retainedUpdates: retainedStats.updateCount,
    historyFloor: retainedStats.historyFloor,
    verdict: "cold replay, stale transform work, and log retention are bounded",
  },
  anchors: {
    mappedOnAccept: `[6,11) -> [9,14)`,
    replayReportsAnchors: false,
    resolvedFrozen: true,
    verdict: "comment anchors follow the canonical ChangeSet, not substrings",
  },
}, null, 2));
