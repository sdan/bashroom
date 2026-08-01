import { describe, expect, it } from "vitest";
import {
  normalizeOfflineHttpUrl,
  WEB_OFFLINE_CLIENT_JS,
  WEB_OFFLINE_CACHE_NAME,
  WEB_OFFLINE_CRAWL_POLICY,
  WEB_OFFLINE_GENERATION,
  WEB_OFFLINE_MANIFEST,
  WEB_OFFLINE_READER_JS,
  WEB_OFFLINE_SERVICE_WORKER_JS,
  WEB_OFFLINE_TIMEOUTS,
} from "./web-offline";

function loadFastOfflineClient(options: {
  navigator?: Record<string, unknown>;
  fetch?: typeof fetch;
  indexedDB?: { open: () => Record<string, unknown> };
} = {}) {
  const fastTimeouts = Object.fromEntries(
    Object.keys(WEB_OFFLINE_TIMEOUTS).map((key) => [key, 5]),
  );
  const script = WEB_OFFLINE_CLIENT_JS.replace(
    `var TIMEOUTS = ${JSON.stringify(WEB_OFFLINE_TIMEOUTS)};`,
    `var TIMEOUTS = ${JSON.stringify(fastTimeouts)};`,
  );
  const windowObject: Record<string, unknown> = {};
  const navigatorObject = options.navigator || {};
  const run = new Function(
    "window", "navigator", "crypto", "TextEncoder", "fetch", "indexedDB",
    "MessageChannel", "AbortController", "setTimeout", "clearTimeout", script,
  );
  run(
    windowObject,
    navigatorObject,
    crypto,
    TextEncoder,
    options.fetch || globalThis.fetch,
    options.indexedDB || { open: () => ({}) },
    MessageChannel,
    AbortController,
    setTimeout,
    clearTimeout,
  );
  return windowObject.BashroomOffline as {
    prepare: (token: string, onProgress?: (progress: unknown) => void, options?: { signal?: AbortSignal }) => Promise<unknown>;
    readSnapshot: (token: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
  };
}

describe("offline archive URL validation", () => {
  it("accepts public HTTP URLs and removes fragments", () => {
    expect(normalizeOfflineHttpUrl("https://example.com/read?a=1#section")).toBe("https://example.com/read?a=1");
  });

  it.each([
    "file:///etc/passwd",
    "data:text/plain,nope",
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://10.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.2/admin",
    "https://user:secret@example.com/",
  ])("rejects non-public or credential-bearing URL %s", (url) => {
    expect(normalizeOfflineHttpUrl(url)).toBeNull();
  });
});

describe("offline browser resources", () => {
  it("emit syntactically valid classic scripts", () => {
    expect(() => new Function(WEB_OFFLINE_CLIENT_JS)).not.toThrow();
    expect(() => new Function(WEB_OFFLINE_READER_JS)).not.toThrow();
    expect(() => new Function(WEB_OFFLINE_SERVICE_WORKER_JS)).not.toThrow();
  });

  it("bounds recursive work while prioritizing a breadth-first archive", () => {
    expect(WEB_OFFLINE_CRAWL_POLICY).toMatchObject({ maxDepth: 2, maxPages: 500, pageConcurrency: 3 });
    expect(WEB_OFFLINE_CLIENT_JS).toContain("for (var depth = 0; depth <= CRAWL_POLICY.maxDepth");
    expect(WEB_OFFLINE_CLIENT_JS).toContain('childUrl.origin !== parentUrl.origin');
  });

  it("ships an installable manifest rooted at /web", () => {
    const manifest = JSON.parse(WEB_OFFLINE_MANIFEST);
    expect(manifest).toMatchObject({ start_url: "/web", display: "standalone" });
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512"]);
  });

  it("never caches authenticated API responses in the service worker", () => {
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('url.pathname.startsWith("/web/api/")');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).not.toContain("authorization: \"Bearer");
  });

  it("serves archived PDFs from IndexedDB through the service worker", () => {
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('url.pathname === "/web/offline/pdf"');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('"content-type": "application/pdf"');
  });

  it("bounds every preparation wait and propagates cancellation into workers", () => {
    expect(WEB_OFFLINE_TIMEOUTS.serviceWorkerReadyMs).toBeGreaterThan(0);
    expect(WEB_OFFLINE_TIMEOUTS.requestMs).toBeGreaterThan(0);
    expect(WEB_OFFLINE_TIMEOUTS.indexedDbMs).toBeGreaterThan(0);
    expect(WEB_OFFLINE_CLIENT_JS).toContain('"service_worker_ready_timeout"');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('throw codedError("request_timeout")');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('finish(reject, codedError("offline_db_timeout"))');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('checkStopped(signal)');
  });

  it("refreshes installed-app helpers instead of pinning the first cached copy", () => {
    expect(WEB_OFFLINE_GENERATION).toBe("2");
    expect(WEB_OFFLINE_CACHE_NAME).toBe("bashroom-shell-v2");
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('"/web-offline.js?v=2"');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('var refreshable = url.origin === self.location.origin');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('if (!fresh.ok) throw new Error("http_" + fresh.status)');
  });

  it("proves the active worker generation before stamping a receipt", () => {
    expect(WEB_OFFLINE_CLIENT_JS).toContain('cache_generation: CACHE_GENERATION');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('receipt.cache_generation !== CACHE_GENERATION');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('cache_generation: CACHE_GENERATION');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('event.data.cache_generation !== CACHE_GENERATION');
  });

  it("activates a bounded core while preserving the previous complete shell", () => {
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('var INSTALL_URLS = SHELL_URLS.slice(0, 4)');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('cacheGraph(INSTALL_URLS).then(function (receipt)');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('if (!receipt.ok) throw new Error("shell_install_failed")');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('var shellPreparation = null');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('if (receipt.ok) await deletePreviousShells()');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('matchPreviousShell(request)');
  });

  it("invalidates interrupted and legacy snapshots and serializes writers", () => {
    expect(WEB_OFFLINE_CLIENT_JS).toContain('receipt.cache_generation === CACHE_GENERATION');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('if (!current) receipt.invalidated = true');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('state: "running"');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('state: "complete"');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('mode: "exclusive", ifAvailable: true');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('mode: "shared", ifAvailable: true');
    expect(WEB_OFFLINE_CLIENT_JS).not.toContain('lockOptions.signal');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('error.snapshotInvalidated = true');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('current.run_id === value.run_id && current.state === "running"');
  });

  it("keeps request timeouts active through body and cache consumption", () => {
    expect(WEB_OFFLINE_CLIENT_JS).toContain('typeof consume === "function" ? await consume(response) : response');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('typeof consume === "function" ? await consume(response) : response');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('await cache.put(absolute, response.clone())');
  });

  it("falls back to a known-good shell on bad navigation responses", () => {
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('if (!response.ok || !contentType.includes("text/html"))');
    expect(WEB_OFFLINE_SERVICE_WORKER_JS).toContain('await matchPreviousShell("/web")');
  });

  it("preserves queued plane edits during a refresh", () => {
    expect(WEB_OFFLINE_CLIENT_JS).toContain('current.file.pending_offline');
    expect(WEB_OFFLINE_CLIENT_JS).toContain('if (store === "files" && rows[i].file && rows[i].file.pending_offline) continue');
  });

  it("caps server-requested retry delays", () => {
    expect(WEB_OFFLINE_TIMEOUTS.retryAfterMaxMs).toBe(15_000);
    expect(WEB_OFFLINE_CLIENT_JS).toContain('Math.min(retryAfter * 1000, TIMEOUTS.retryAfterMaxMs)');
  });
});

describe("offline preparation failure lifecycle", () => {
  it("rejects when service-worker readiness never settles", async () => {
    const offline = loadFastOfflineClient({
      navigator: {
        serviceWorker: { ready: new Promise(() => {}), register: async () => null, controller: null },
        storage: {},
      },
    });
    await expect(offline.prepare("br_user_test")).rejects.toMatchObject({ code: "service_worker_ready_timeout" });
  });

  it("honors a caller cancellation before starting work", async () => {
    const controller = new AbortController();
    controller.abort();
    const offline = loadFastOfflineClient();
    await expect(offline.prepare("br_user_test", undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      code: "preparation_stopped",
    });
  });

  it("uses a non-blocking Web Lock without the forbidden signal combination", async () => {
    let optionsSeen: Record<string, unknown> | null = null;
    const offline = loadFastOfflineClient({
      navigator: {
        locks: {
          request: async (_name: string, options: Record<string, unknown>, callback: (lock: null) => unknown) => {
            optionsSeen = options;
            if ("signal" in options && options.ifAvailable === true) throw new DOMException("unsupported", "NotSupportedError");
            return callback(null);
          },
        },
        storage: {},
      },
    });
    const controller = new AbortController();
    await expect(offline.prepare("br_user_test", undefined, { signal: controller.signal })).rejects.toMatchObject({
      code: "preparation_already_running",
    });
    expect(optionsSeen).toEqual({ mode: "exclusive", ifAvailable: true });
  });

  it("turns a hung API request into a bounded timeout", async () => {
    const activeWorker = {
      postMessage: (_message: unknown, ports: MessagePort[]) => ports[0].postMessage({ ok: true, cache_generation: WEB_OFFLINE_GENERATION }),
    };
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })) as typeof fetch;
    const offline = loadFastOfflineClient({
      navigator: {
        serviceWorker: { ready: Promise.resolve({ active: activeWorker }), register: async () => null, controller: null },
        storage: {},
      },
      fetch: hangingFetch,
    });
    await expect(offline.prepare("br_user_test")).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("turns a blocked IndexedDB open into a bounded timeout", async () => {
    const activeWorker = {
      postMessage: (_message: unknown, ports: MessagePort[]) => ports[0].postMessage({ ok: true, cache_generation: WEB_OFFLINE_GENERATION }),
    };
    const offline = loadFastOfflineClient({
      navigator: {
        serviceWorker: { ready: Promise.resolve({ active: activeWorker }), register: async () => null, controller: null },
        storage: {},
      },
      fetch: (async () => new Response(JSON.stringify({ ok: true, rooms: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      indexedDB: { open: () => ({}) },
    });
    await expect(offline.prepare("br_user_test")).rejects.toMatchObject({ code: "offline_db_timeout" });
  });
});
