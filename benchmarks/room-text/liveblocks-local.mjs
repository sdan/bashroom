import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { createClient } from "@liveblocks/client";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import WebSocket from "ws";

const port = process.env.LIVEBLOCKS_DEV_SERVER_PORT ?? "1153";
const baseUrl = process.env.LIVEBLOCKS_BASE_URL ?? `http://localhost:${port}`;
const roomId = `bench-${process.pid}-${Date.now()}`;

function makePeer() {
  const client = createClient({
    publicApiKey: "pk_localdev",
    baseUrl,
    throttle: 16,
    polyfills: { WebSocket },
  });
  const { room, leave } = client.enterRoom(roomId, { initialPresence: {} });
  const provider = getYjsProviderForRoom(room);
  return { leave, provider, doc: provider.getYDoc() };
}

function waitUntilSynced(provider, timeoutMs = 10_000) {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onSync = (synced) => {
      if (!synced) return;
      clearTimeout(timeout);
      provider.off("sync", onSync);
      resolve();
    };
    const timeout = setTimeout(() => {
      provider.off("sync", onSync);
      reject(new Error(`Yjs provider did not sync within ${timeoutMs}ms`));
    }, timeoutMs);
    provider.on("sync", onSync);
    if (provider.synced) onSync(true);
  });
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function waitForText(text, predicate, timeoutMs = 10_000) {
  if (predicate(text.toString())) return Promise.resolve(performance.now());
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (!predicate(text.toString())) return;
      clearTimeout(timeout);
      text.unobserve(onChange);
      resolve(performance.now());
    };
    const timeout = setTimeout(() => {
      text.unobserve(onChange);
      reject(new Error("observer did not receive the edit within 10 seconds"));
    }, timeoutMs);
    text.observe(onChange);
  });
}

const writer = makePeer();
const observer = makePeer();
try {
  await Promise.all([waitUntilSynced(writer.provider), waitUntilSynced(observer.provider)]);
  const writerText = writer.doc.getText("text");
  const observerText = observer.doc.getText("text");
  const visibilityLatencies = [];
  for (let index = 0; index < 30; index++) {
    const marker = `edit-${index}-${randomUUID()};`;
    const observed = waitForText(observerText, (value) => value.includes(marker));
    const startedAt = performance.now();
    writerText.insert(writerText.length, marker);
    visibilityLatencies.push((await observed) - startedAt);
  }

  const burstCount = 50;
  const burstPrefix = `burst-${randomUUID()}-`;
  const finalBurstMarker = `${burstPrefix}${burstCount - 1};`;
  const burstObserved = waitForText(observerText, (value) => value.includes(finalBurstMarker));
  const burstStarted = performance.now();
  for (let index = 0; index < burstCount; index++) {
    writerText.insert(writerText.length, `${burstPrefix}${index};`);
  }
  const burstElapsed = (await burstObserved) - burstStarted;

  const reconnectStarted = performance.now();
  const reconnect = makePeer();
  await waitUntilSynced(reconnect.provider);
  const reconnectMs = performance.now() - reconnectStarted;
  const reconnectConverged = reconnect.doc.getText("text").toString() === writerText.toString();
  console.log(JSON.stringify({
    system: "liveblocks-local-yjs",
    server: "liveblocks dev 1.6.2",
    client: "@liveblocks/client 3.22.0",
    throttleMs: 16,
    writerToObserver: {
      samples: visibilityLatencies.length,
      p50Ms: Number(percentile(visibilityLatencies, 0.5).toFixed(3)),
      p95Ms: Number(percentile(visibilityLatencies, 0.95).toFixed(3)),
      p99Ms: Number(percentile(visibilityLatencies, 0.99).toFixed(3)),
    },
    burst: {
      edits: burstCount,
      observerVisibilityMs: Number(burstElapsed.toFixed(3)),
      editsPerSecondAtObserver: Math.round(burstCount * 1_000 / burstElapsed),
    },
    reconnect: {
      milliseconds: Number(reconnectMs.toFixed(3)),
      converged: reconnectConverged,
    },
    bytesInserted: Buffer.byteLength(writerText.toString()),
    converged: writerText.toString() === observerText.toString(),
    caveat: "Remote visibility, not a per-edit durable acknowledgement.",
  }, null, 2));
  reconnect.provider.destroy();
  reconnect.doc.destroy();
  reconnect.leave();
} finally {
  writer.provider.destroy();
  observer.provider.destroy();
  writer.doc.destroy();
  observer.doc.destroy();
  writer.leave();
  observer.leave();
}
