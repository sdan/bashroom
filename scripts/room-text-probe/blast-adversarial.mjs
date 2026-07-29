import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
const config = path.join(root, "scripts", "room-text-probe", "wrangler.jsonc");

// Group-commit lane port isolation (assigned range 8850-8859): fixed ports
// instead of ephemeral ones so concurrent lab lanes never collide.
let nextFixedPort = Number(process.env.ROOM_TEXT_ADVERSARIAL_PORT ?? 8855);
async function freePort() {
  return nextFixedPort++;
}

async function waitForReady(child, base, output, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler exited with ${child.exitCode}:\n${output.value}`);
    }
    try {
      await fetch(base);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`wrangler did not become ready:\n${output.value}`);
}

async function startServer() {
  const [port, inspectorPort] = await Promise.all([freePort(), freePort()]);
  const persistence = await mkdtemp(path.join(os.tmpdir(), "bashroom-room-text-adversarial-"));
  const output = { value: "" };
  const child = spawn(wrangler, [
    "dev",
    "-c", config,
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
    output.value = (output.value + chunk.toString()).slice(-30_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(child, base, output);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(persistence, { recursive: true, force: true });
    throw error;
  }
  return {
    base,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await rm(persistence, { recursive: true, force: true });
    },
  };
}

const runtime = process.argv[2] ? null : await startServer();
const base = process.argv[2] ?? runtime.base;
const room = `adversarial-${Date.now()}-${process.pid}`;

async function request(route, init, expectedStatus = 200) {
  const url = new URL(route, base);
  url.searchParams.set("room", room);
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(
    response.status,
    expectedStatus,
    `${route}: expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`,
  );
  return body;
}

function post(route, body, expectedStatus = 200) {
  return request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, expectedStatus);
}

async function postAnyStatus(route, body) {
  const url = new URL(route, base);
  url.searchParams.set("room", room);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function get(route) {
  return request(route);
}

async function state(fileId) {
  const result = await get(`/fault/state?file=${encodeURIComponent(fileId)}`);
  assert.equal(result.ok, true);
  return result.state;
}

async function arm(kind) {
  const result = await post("/fault/arm", { kind });
  assert.deepEqual(result, { ok: true, kind });
}

async function disarm() {
  assert.deepEqual(await post("/fault/disarm"), { ok: true });
}

function pushInput(fileId, baseRevision, clientId, requestId, changes) {
  return { protocol: 1, fileId, epoch: 1, baseRevision, clientId, requestId, changes };
}

async function waitFor(check, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function manifestAt(objects, key) {
  const object = objects[key];
  return object
    ? JSON.parse(Buffer.from(object.base64, "base64").toString("utf8"))
    : undefined;
}

const results = [];
function pass(name, evidence) {
  results.push({ status: "PASS", name, evidence });
  console.log(`PASS ${name}`);
}
function reproduced(name, evidence) {
  results.push({ status: "REPRODUCED GAP", name, evidence });
  console.log(`REPRODUCED GAP ${name}`);
}

try {
  // CREATE writes file + durable head + digest/root in one transaction. Abort
  // at its final digest-log write and prove that no prefix survived.
  const createRollbackFile = "rollback-create";
  const beforeCreateFault = await state(createRollbackFile);
  await arm("abort-digest-log-insert");
  const failedCreate = await postAnyStatus("/create", {
    fileId: createRollbackFile,
    path: "adversarial/rollback-create.md",
    content: "create transaction\n",
  });
  if (failedCreate.status === 500) {
    assert.equal(failedCreate.body.error, "UNCAUGHT");
  } else {
    assert.deepEqual(
      { status: failedCreate.status, ok: failedCreate.body.ok, error: failedCreate.body.error },
      { status: 200, ok: false, error: "ALREADY_EXISTS" },
    );
    reproduced("create masks a non-uniqueness SQLite abort as ALREADY_EXISTS", {
      status: failedCreate.status,
      error: failedCreate.body.error,
    });
  }
  await disarm();
  assert.deepEqual(await state(createRollbackFile), beforeCreateFault);
  const createdAfterRollback = await post("/create", {
    fileId: createRollbackFile,
    path: "adversarial/rollback-create.md",
    content: "create transaction\n",
  });
  assert.equal(createdAfterRollback.ok, true);
  pass("create transaction rolls back every durable row", { retryRevision: createdAfterRollback.revision });

  // Abort exactly when the separate durable head would move. The canonical
  // update, file metadata, and commit were already attempted and must all roll
  // back with it.
  const headRollbackFile = "rollback-head";
  const headSeed = "head transaction";
  assert.equal((await post("/create", {
    fileId: headRollbackFile,
    path: "adversarial/rollback-head.md",
    content: headSeed,
  })).ok, true);
  const headRequest = pushInput(
    headRollbackFile,
    0,
    "rollback-client",
    "head-update",
    [{ from: headSeed.length, to: headSeed.length, insert: "!" }],
  );
  const beforeHeadFault = await state(headRollbackFile);
  await arm("abort-head-update");
  assert.equal((await post("/push", headRequest, 500)).error, "UNCAUGHT");
  await disarm();
  assert.deepEqual(await state(headRollbackFile), beforeHeadFault);
  await post(`/evict?file=${headRollbackFile}`);
  assert.equal((await get(`/open?file=${headRollbackFile}`)).content, headSeed);
  const acceptedHead = await post("/push", headRequest);
  assert.equal(acceptedHead.revision, 1);
  assert.deepEqual(await post("/push", headRequest), acceptedHead);
  pass("head-write abort rolls back file, log, request, commit, and digest", { revision: acceptedHead.revision });

  // Abort after the head and request have been written, at the final digest
  // log insert. This is the strongest late-transaction rollback point.
  const lateSeed = `${headSeed}!`;
  const lateRequest = pushInput(
    headRollbackFile,
    1,
    "rollback-client",
    "late-digest",
    [{ from: lateSeed.length, to: lateSeed.length, insert: "?" }],
  );
  const beforeLateFault = await state(headRollbackFile);
  await arm("abort-digest-log-insert");
  assert.equal((await post("/push", lateRequest, 500)).error, "UNCAUGHT");
  await disarm();
  assert.deepEqual(await state(headRollbackFile), beforeLateFault);
  await post(`/evict?file=${headRollbackFile}`);
  assert.equal((await get(`/open?file=${headRollbackFile}`)).content, lateSeed);
  assert.equal((await post("/push", lateRequest)).revision, 2);
  pass("late digest abort rolls back an already-written current head", { revisionAfterRetry: 2 });

  // Reproduce the known integrity gap: valid same-size bytes satisfy the head
  // metadata checks even though they disagree with the committed digest.
  const corruptHeadFile = "corrupt-head";
  const corruptSeed = "Alpha durable head\n";
  assert.equal((await post("/create", {
    fileId: corruptHeadFile,
    path: "adversarial/corrupt-head.md",
    content: corruptSeed,
  })).ok, true);
  const corrupted = await post("/fault/corrupt", {
    kind: "flip-head-byte-same-length",
    fileId: corruptHeadFile,
  });
  assert.equal(corrupted.ok, true);
  const corruptOpen = await get(`/open?file=${corruptHeadFile}`);
  const corruptVerify = await get(`/digest/verify?file=${corruptHeadFile}`);
  if (!corruptOpen.ok && corruptOpen.error === "STORAGE_CORRUPT") {
    pass("same-length head corruption fails closed", { error: corruptOpen.error });
  } else {
    assert.equal(corruptOpen.ok, true);
    assert.equal(corruptOpen.byteLength, Buffer.byteLength(corruptSeed));
    assert.notEqual(corruptOpen.content, corruptSeed);
    assert.equal(corruptVerify.match, false);
    reproduced("same-length head corruption opens without digest validation", {
      revision: corruptOpen.revision,
      byteLength: corruptOpen.byteLength,
    });
  }

  // The current BLOB remains readable if a live update row disappears, but
  // every operation that needs that transformation must fail closed.
  const missingUpdateFile = "missing-update";
  assert.equal((await post("/create", {
    fileId: missingUpdateFile,
    path: "adversarial/missing-update.md",
    content: "M",
  })).ok, true);
  assert.equal((await post("/push", pushInput(
    missingUpdateFile, 0, "missing-client", "one", [{ from: 1, to: 1, insert: "1" }],
  ))).revision, 1);
  assert.equal((await post("/push", pushInput(
    missingUpdateFile, 1, "missing-client", "two", [{ from: 2, to: 2, insert: "2" }],
  ))).revision, 2);
  assert.equal((await post("/fault/corrupt", {
    kind: "delete-latest-update",
    fileId: missingUpdateFile,
  })).ok, true);
  const headWithoutUpdate = await get(`/open?file=${missingUpdateFile}`);
  assert.deepEqual(
    { ok: headWithoutUpdate.ok, revision: headWithoutUpdate.revision, content: headWithoutUpdate.content },
    { ok: true, revision: 2, content: "M12" },
  );
  const brokenPull = await get(`/pull?file=${missingUpdateFile}&epoch=1&after=1`);
  assert.deepEqual({ ok: brokenPull.ok, error: brokenPull.error }, { ok: false, error: "STORAGE_CORRUPT" });
  const brokenRebase = await post("/push", pushInput(
    missingUpdateFile, 1, "missing-client", "after-gap", [{ from: 2, to: 2, insert: "x" }],
  ));
  assert.deepEqual(
    { ok: brokenRebase.ok, error: brokenRebase.error },
    { ok: false, error: "STORAGE_CORRUPT" },
  );
  assert.equal((await get(`/open?file=${missingUpdateFile}`)).content, "M12");
  pass("missing live update fails pull and rebase closed while head stays readable", { headRevision: 2 });

  // Churn twice the 32-file cache capacity. Every reopen must reconstruct from
  // the separate durable BLOB, not from a checkpoint tail.
  const lruFiles = [];
  for (let index = 0; index < 64; index++) {
    const fileId = `lru-${index}`;
    const content = `file-${index}\n`;
    lruFiles.push({ fileId, content: `${content}x` });
    assert.equal((await post("/create", {
      fileId,
      path: `adversarial/lru/${index}.md`,
      content,
    })).ok, true);
    assert.equal((await post("/push", pushInput(
      fileId,
      0,
      "lru-client",
      `edit-${index}`,
      [{ from: content.length, to: content.length, insert: "x" }],
    ))).revision, 1);
  }
  for (const expected of [...lruFiles].reverse()) {
    const opened = await get(`/open?file=${expected.fileId}`);
    assert.deepEqual(
      { ok: opened.ok, revision: opened.revision, content: opened.content },
      { ok: true, revision: 1, content: expected.content },
    );
    assert.equal((await get(`/digest/verify?file=${expected.fileId}`)).match, true);
  }
  const lruInspect = await get(`/inspect?file=${lruFiles[0].fileId}`);
  assert.equal(lruInspect.cacheEntries, 32);
  pass("64-file LRU churn reloads every durable head exactly", { files: 64, cacheEntries: 32 });

  // Request IDs are room-global today. Reusing one on another file must fail
  // explicitly rather than dedupe to the wrong document.
  const tokenA = "token-file-a";
  const tokenB = "token-file-b";
  assert.equal((await post("/create", {
    fileId: tokenA,
    path: "adversarial/token-a.md",
    content: "a",
  })).ok, true);
  assert.equal((await post("/create", {
    fileId: tokenB,
    path: "adversarial/token-b.md",
    content: "b",
  })).ok, true);
  const sharedA = pushInput(tokenA, 0, "shared-client", "shared-request", [{ from: 1, to: 1, insert: "A" }]);
  const sharedB = pushInput(tokenB, 0, "shared-client", "shared-request", [{ from: 1, to: 1, insert: "B" }]);
  const acceptedA = await post("/push", sharedA);
  assert.equal(acceptedA.revision, 1);
  const rejectedB = await post("/push", sharedB);
  assert.deepEqual(
    { ok: rejectedB.ok, error: rejectedB.error },
    { ok: false, error: "IDEMPOTENCY_MISMATCH" },
  );
  assert.deepEqual(await post("/push", sharedA), acceptedA);
  assert.deepEqual(
    { content: (await get(`/open?file=${tokenA}`)).content, other: (await get(`/open?file=${tokenB}`)).content },
    { content: "aA", other: "b" },
  );
  assert.equal((await state(tokenB)).updates.length, 0);
  pass("cross-file token reuse fails explicitly without mutating either wrong file", {
    error: rejectedB.error,
  });

  // A single durable alarm target is lossy for a room with multiple dirty
  // files. Delay the alarm so B deterministically overwrites A before it fires.
  const targetA = "janitor-target-a";
  const targetB = "janitor-target-b";
  assert.equal((await post("/create", {
    fileId: targetA,
    path: "adversarial/janitor-target-a.md",
    content: "A",
  })).ok, true);
  assert.equal((await post("/create", {
    fileId: targetB,
    path: "adversarial/janitor-target-b.md",
    content: "B",
  })).ok, true);
  await post(`/janitor/schedule?file=${targetA}&delay=500`);
  await post(`/janitor/schedule?file=${targetB}&delay=500`);
  const targetPrefix = `rooms/${room}/.history`;
  const targetObjects = await waitFor(async () => {
    const objects = (await get("/janitor/r2")).objects;
    return objects[`${targetPrefix}/${targetB}/HEAD`] ? objects : undefined;
  }, "second janitor target never flushed");
  assert.equal(targetObjects[`${targetPrefix}/${targetA}/HEAD`], undefined);
  assert.ok(targetObjects[`${targetPrefix}/${targetB}/HEAD`]);
  reproduced("scalar janitor target drops an earlier dirty file", {
    missing: targetA,
    flushed: targetB,
  });

  // Emulate real R2 latency by yielding after the older artifact PUT. While
  // that request is suspended, commit and publish a newer checkpoint. The
  // monotonic publication guard must make the resumed older request skip
  // ("stale-skip") instead of CASing HEAD backward over the newer publish.
  const orderingFile = "janitor-head-order";
  assert.equal((await post("/create", {
    fileId: orderingFile,
    path: "adversarial/janitor-head-order.md",
    content: "a",
  })).ok, true);
  assert.equal((await post("/push", pushInput(
    orderingFile, 0, "janitor-client", "revision-1", [{ from: 1, to: 1, insert: "b" }],
  ))).revision, 1);
  assert.equal((await post(`/checkpoint?file=${orderingFile}`)).revision, 1);
  assert.deepEqual(await post("/janitor/gate/arm"), { ok: true, state: "armed" });
  const olderFire = post(`/janitor/fire?file=${orderingFile}`);
  await waitFor(async () => (await get("/janitor/gate")).state === "paused", "older janitor never paused");

  assert.equal((await post("/push", pushInput(
    orderingFile, 1, "janitor-client", "revision-2", [{ from: 2, to: 2, insert: "c" }],
  ))).revision, 2);
  assert.equal((await post(`/checkpoint?file=${orderingFile}`)).revision, 2);
  const newerFire = await post(`/janitor/fire?file=${orderingFile}`);
  assert.equal(newerFire.revision, 2);
  const orderingHeadKey = `${targetPrefix}/${orderingFile}/HEAD`;
  const beforeReleaseObjects = (await get("/janitor/r2")).objects;
  assert.equal(manifestAt(beforeReleaseObjects, orderingHeadKey).revision, 2);

  assert.deepEqual(await post("/janitor/gate/release"), { ok: true, state: "released" });
  const olderResult = await olderFire;
  assert.deepEqual(
    { ok: olderResult.ok, revision: olderResult.revision, headFlip: olderResult.headFlip },
    { ok: true, revision: 1, headFlip: "stale-skip" },
  );
  const afterReleaseObjects = (await get("/janitor/r2")).objects;
  const afterRelease = manifestAt(afterReleaseObjects, orderingHeadKey);
  assert.equal(afterRelease.revision, 2);
  assert.deepEqual(
    { revision: (await get(`/open?file=${orderingFile}`)).revision, content: (await get(`/open?file=${orderingFile}`)).content },
    { revision: 2, content: "abc" },
  );
  pass("older async janitor stale-skips instead of CASing R2 HEAD backward", {
    beforeRelease: 2,
    afterRelease: afterRelease.revision,
    olderFire: olderResult.headFlip,
    sqliteHead: 2,
  });

  console.log(JSON.stringify({
    probe: "RoomText B-only adversarial durability",
    passed: results.filter((result) => result.status === "PASS").length,
    reproducedGaps: results.filter((result) => result.status === "REPRODUCED GAP").length,
    results,
  }, null, 2));
} finally {
  try {
    await disarm();
  } catch {
    // The server may already be gone after an unexpected failure.
  }
  await runtime?.stop();
}
