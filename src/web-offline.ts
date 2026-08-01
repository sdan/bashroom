// Browser-side offline support is served as two ordinary JavaScript resources:
// a window helper (IndexedDB snapshots/outbox/export) and a service worker
// (app-shell/CDN cache + offline linked-page reader). Keeping these out of the
// already-large inline web shell makes the security boundary reviewable and
// lets the service worker cache the offline implementation itself.

export const WEB_OFFLINE_DB_NAME = "bashroom-offline-v1";
export const WEB_OFFLINE_CACHE_PREFIX = "bashroom-shell-";
// Bump the cache generation whenever the shell/offline helper contract changes.
// Installed PWAs may otherwise keep an old cache-first helper indefinitely.
export const WEB_OFFLINE_GENERATION = "2";
export const WEB_OFFLINE_CACHE_NAME = `${WEB_OFFLINE_CACHE_PREFIX}v${WEB_OFFLINE_GENERATION}`;
export const WEB_OFFLINE_TIMEOUTS = Object.freeze({
  storageMs: 5_000,
  serviceWorkerReadyMs: 15_000,
  shellCacheMs: 60_000,
  requestMs: 45_000,
  indexedDbMs: 15_000,
  retryAfterMaxMs: 15_000,
});
export const WEB_OFFLINE_CRAWL_POLICY = Object.freeze({
  // Direct Bashroom links are never dropped. The page cap only limits links
  // discovered after those seeds, so a large reading list remains complete.
  maxDepth: 2,
  maxPages: 500,
  pageConcurrency: 3,
  maxPdfBytes: 30_000_000,
  maxGraphNodes: 5_000,
  maxGraphEdges: 20_000,
});

export const WEB_OFFLINE_MANIFEST = JSON.stringify({
  name: "Bashroom",
  short_name: "Bashroom",
  description: "Durable shared Markdown, available offline.",
  start_url: "/web",
  scope: "/",
  id: "/web",
  display: "standalone",
  categories: ["books", "productivity"],
  background_color: "#ffffff",
  theme_color: "#37352f",
  icons: [
    { src: "/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

// Runs only inside the script-free offline reader response assembled by the
// service worker. Marked provides readable structure, DOMPurify is the final
// boundary, and every web link is routed back through the offline archive.
export const WEB_OFFLINE_READER_JS = String.raw`
(function () {
  "use strict";
  var source = document.getElementById("offline-source");
  var content = document.getElementById("offline-content");
  if (!source || !content || !window.marked || !window.DOMPurify) return;
  var baseUrl = source.getAttribute("data-url") || location.href;
  var markdown = source.textContent || "";
  var rendered = window.marked.parse(markdown, { gfm: true, breaks: false });
  content.innerHTML = window.DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "img", "video", "audio"],
    FORBID_ATTR: ["style", "srcset"],
  });
  content.querySelectorAll("a[href]").forEach(function (anchor) {
    var raw = anchor.getAttribute("href") || "";
    if (raw.charAt(0) === "#") return;
    try {
      var target = new URL(raw, baseUrl);
      if (target.protocol !== "http:" && target.protocol !== "https:") return;
      target.hash = "";
      anchor.href = "/web/offline?url=" + encodeURIComponent(target.toString());
      anchor.rel = "noreferrer";
    } catch (_) {}
  });
})();
`;

export function normalizeOfflineHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) return null;
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return null;
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    if (
      octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    ) return null;
  }
  // Fragments do not change the fetched document and would duplicate one
  // article under many cache keys.
  url.hash = "";
  return url.toString();
}

export const WEB_OFFLINE_CLIENT_JS = String.raw`
(function () {
  "use strict";
  var DB_NAME = "${WEB_OFFLINE_DB_NAME}";
  var DB_VERSION = 1;
  var STORES = ["meta", "files", "links", "outbox"];
  var CACHE_GENERATION = "${WEB_OFFLINE_GENERATION}";
  var CRAWL_POLICY = ${JSON.stringify(WEB_OFFLINE_CRAWL_POLICY)};
  var TIMEOUTS = ${JSON.stringify(WEB_OFFLINE_TIMEOUTS)};

  function codedError(code) {
    var error = new Error(code);
    error.code = code;
    return error;
  }

  function stoppedError() {
    var error = codedError("preparation_stopped");
    error.name = "AbortError";
    return error;
  }

  function isStopped(error, signal) {
    return Boolean((signal && signal.aborted) || (error && (error.name === "AbortError" || error.code === "preparation_stopped")));
  }

  function checkStopped(signal) {
    if (signal && signal.aborted) throw stoppedError();
  }

  function withDeadline(promise, timeoutMs, code, signal) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      function cleanup() {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }
      function onAbort() { finish(reject, stoppedError()); }
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timer = setTimeout(function () { finish(reject, codedError(code)); }, timeoutMs);
      Promise.resolve(promise).then(function (value) { finish(resolve, value); }, function (error) { finish(reject, error); });
    });
  }

  // Keep the timeout alive until the response body has been consumed. A fetch
  // resolving only means the headers arrived; JSON, Blob, and Cache writes can
  // still stall after that point.
  async function timedFetch(input, init, signal, consume) {
    checkStopped(signal);
    var controller = new AbortController();
    var timedOut = false;
    var options = Object.assign({}, init || {}, { signal: controller.signal });
    function onAbort() { controller.abort(); }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, TIMEOUTS.requestMs);
    try {
      var response = await fetch(input, options);
      return typeof consume === "function" ? await consume(response) : response;
    } catch (error) {
      if (signal && signal.aborted) throw stoppedError();
      if (timedOut) throw codedError("request_timeout");
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  function openDb(signal) {
    return new Promise(function (resolve, reject) {
      checkStopped(signal);
      var settled = false;
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      var timer = setTimeout(function () { finish(reject, codedError("offline_db_timeout")); }, TIMEOUTS.indexedDbMs);
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      function finish(callback, value) {
        if (settled) {
          if (callback === resolve && value && value.close) value.close();
          return;
        }
        settled = true;
        cleanup();
        callback(value);
      }
      function onAbort() { finish(reject, stoppedError()); }
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        STORES.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "key" });
        });
      };
      request.onblocked = function () { finish(reject, codedError("offline_db_blocked")); };
      request.onsuccess = function () { finish(resolve, request.result); };
      request.onerror = function () { finish(reject, request.error || codedError("offline_db_open_failed")); };
    });
  }

  async function storeCall(storeName, mode, operation, signal) {
    var db = await openDb(signal);
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { db.close(); reject(stoppedError()); return; }
      var settled = false;
      var result;
      var tx = db.transaction(storeName, mode);
      var store = tx.objectStore(storeName);
      var request;
      var timer = setTimeout(function () {
        try { tx.abort(); } catch (_) {}
        finish(reject, codedError("offline_db_timeout"));
      }, TIMEOUTS.indexedDbMs);
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        db.close();
      }
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }
      function onAbort() {
        try { tx.abort(); } catch (_) {}
        finish(reject, stoppedError());
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try { request = operation(store); }
      catch (error) { finish(reject, error); return; }
      if (request) {
        request.onsuccess = function () { result = request.result; };
        request.onerror = function () { finish(reject, request.error || codedError("offline_db_request_failed")); };
      }
      tx.onerror = function () { finish(reject, tx.error || codedError("offline_db_transaction_failed")); };
      tx.onabort = function () {
        finish(reject, (signal && signal.aborted) ? stoppedError() : (tx.error || codedError("offline_db_transaction_aborted")));
      };
      tx.oncomplete = function () { finish(resolve, result); };
    });
  }

  function get(store, key, signal) { return storeCall(store, "readonly", function (s) { return s.get(key); }, signal); }
  function getAll(store, signal) { return storeCall(store, "readonly", function (s) { return s.getAll(); }, signal); }
  function put(store, value, signal) { return storeCall(store, "readwrite", function (s) { return s.put(value); }, signal); }
  function remove(store, key, signal) { return storeCall(store, "readwrite", function (s) { return s.delete(key); }, signal); }

  function putSnapshotFile(value, signal) {
    return storeCall("files", "readwrite", function (store) {
      var request = store.get(value.key);
      request.onsuccess = function () {
        var current = request.result;
        // Check and write inside one transaction so a queued plane edit cannot
        // slip between a separate read and write.
        if (!(current && current.file && current.file.pending_offline)) store.put(value);
      };
    }, signal);
  }

  function markPreparationFailed(value) {
    return storeCall("meta", "readwrite", function (store) {
      var request = store.get("preparation");
      request.onsuccess = function () {
        var current = request.result;
        // A late failure from run A must never overwrite run B's running or
        // complete marker after A releases the browser-wide writer lock.
        if (current && current.run_id === value.run_id && current.state === "running") store.put(value);
      };
    });
  }

  async function pruneScope(store, scope, keepKeys, signal) {
    var rows = await getAll(store, signal);
    for (var i = 0; i < rows.length; i += 1) {
      checkStopped(signal);
      if (rows[i].scope !== scope || keepKeys.has(rows[i].key)) continue;
      if (store === "files" && rows[i].file && rows[i].file.pending_offline) continue;
      await remove(store, rows[i].key, signal);
    }
  }

  async function scopeForToken(token) {
    var bytes = new TextEncoder().encode(String(token || ""));
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).slice(0, 16).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  function preparationLockName(scope) { return "bashroom-offline-prepare-" + scope; }
  function scopedKey(scope, room, path) { return scope + "\u0000" + room + "\u0000" + path; }
  function linkKey(scope, url) { return scope + "\u0000" + url; }
  function auth(token) { return { authorization: "Bearer " + token }; }

  async function jsonFetch(path, token, init, signal) {
    var options = Object.assign({}, init || {});
    options.headers = Object.assign({}, auth(token), options.headers || {});
    return timedFetch(path, options, signal, async function (response) {
      var data = await response.json().catch(function () { return null; });
      if (!response.ok || !data || data.ok === false) {
        var error = new Error((data && data.error) || ("http_" + response.status));
        error.status = response.status;
        error.data = data;
        error.retryAfter = Number(response.headers.get("retry-after") || 0);
        throw error;
      }
      return data;
    });
  }

  function report(callback, phase, done, total, detail) {
    if (typeof callback !== "function") return;
    try { callback({ phase: phase, done: done, total: total, detail: detail || "" }); } catch (_) {}
  }

  async function pool(items, concurrency, worker, signal) {
    var next = 0;
    var results = new Array(items.length);
    async function run() {
      while (true) {
        checkStopped(signal);
        var index = next++;
        if (index >= items.length) return;
        try { results[index] = await worker(items[index], index); }
        catch (error) {
          if (isStopped(error, signal)) throw stoppedError();
          results[index] = { ok: false, error: String((error && error.message) || error) };
        }
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(concurrency, Math.max(1, items.length)); i += 1) workers.push(run());
    await Promise.all(workers);
    return results;
  }

  function wait(ms, signal) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { cleanup(); resolve(); }, ms);
      function cleanup() { if (signal) signal.removeEventListener("abort", onAbort); }
      function onAbort() { clearTimeout(timer); cleanup(); reject(stoppedError()); }
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async function withRetry(operation, signal) {
    var lastError;
    for (var attempt = 0; attempt < 4; attempt += 1) {
      checkStopped(signal);
      try { return await operation(); }
      catch (error) {
        if (isStopped(error, signal) || (error && (error.code === "request_timeout" || error.code === "response_timeout"))) throw error;
        lastError = error;
        var status = Number(error && error.status || 0);
        if (status && status !== 429 && status < 500) throw error;
        if (attempt === 3) break;
        var retryAfter = Number(error && error.retryAfter || 0);
        var retryDelay = retryAfter > 0 ? Math.min(retryAfter * 1000, TIMEOUTS.retryAfterMaxMs) : Math.pow(2, attempt) * 1250;
        await wait(retryDelay, signal);
      }
    }
    throw lastError;
  }

  function canonicalWebUrl(raw, baseUrl) {
    try {
      var url = new URL(String(raw || ""), baseUrl || location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (url.username || url.password) return null;
      if (url.origin === location.origin) return null;
      // Images, media, bundles, and archives are document dependencies rather
      // than reading nodes. PDF stays eligible because it is itself a page.
      if (/\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|m4a|m4v|mov|mp3|mp4|ogg|otf|png|svg|tar|tgz|ttf|wav|webm|webp|woff2?|zip)$/i.test(url.pathname)) return null;
      url.hash = "";
      Array.from(url.searchParams.keys()).forEach(function (key) {
        var lower = key.toLowerCase();
        if (lower.indexOf("utm_") === 0 || lower === "fbclid" || lower === "gclid" || lower === "mc_cid" || lower === "mc_eid") {
          url.searchParams.delete(key);
        }
      });
      return url.toString();
    } catch (_) { return null; }
  }

  function externalLinks(markdown, baseUrl) {
    var found = new Set();
    var source = String(markdown || "");
    var patterns = [
      /\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/gi,
      /<(https?:\/\/[^>\s]+)>/gi,
      /\b(https?:\/\/[^\s<>"']+)/gi,
    ];
    patterns.forEach(function (pattern, patternIndex) {
      var match;
      while ((match = pattern.exec(source))) {
        if (patternIndex === 0 && match.index > 0 && source.charAt(match.index - 1) === "!") continue;
        var candidate = String(match[1] || "").replace(/[),.;!?\]]+$/, "");
        var normalized = canonicalWebUrl(candidate, baseUrl);
        if (normalized) found.add(normalized);
      }
    });
    return Array.from(found);
  }

  async function shellPrepare(signal) {
    if (!("serviceWorker" in navigator)) return Promise.resolve({ ok: false, error: "service_worker_unsupported" });
    var registration;
    try {
      registration = await withDeadline(
        navigator.serviceWorker.ready,
        TIMEOUTS.serviceWorkerReadyMs,
        "service_worker_ready_timeout",
        signal
      );
    } catch (error) {
      if (isStopped(error, signal)) throw error;
      return { ok: false, error: String((error && error.code) || (error && error.message) || error) };
    }
    try {
      var target = registration.active || navigator.serviceWorker.controller;
      if (!target) return { ok: false, error: "service_worker_not_active" };
      return await new Promise(function (resolve, reject) {
        var channel = new MessageChannel();
        var settled = false;
        var timer = setTimeout(function () { finish(resolve, { ok: false, error: "shell_cache_timeout" }); }, TIMEOUTS.shellCacheMs);
        function cleanup() {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          try { channel.port1.close(); } catch (_) {}
        }
        function finish(callback, value) {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        }
        function onAbort() { finish(reject, stoppedError()); }
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener("abort", onAbort, { once: true });
        }
        channel.port1.onmessage = function (event) {
          var receipt = event.data || { ok: false };
          if (receipt.cache_generation !== CACHE_GENERATION) {
            finish(resolve, { ok: false, error: "shell_generation_mismatch", cache_generation: receipt.cache_generation || "" });
            return;
          }
          finish(resolve, receipt);
        };
        target.postMessage({ type: "PREPARE_SHELL", cache_generation: CACHE_GENERATION }, [channel.port2]);
      });
    } catch (error) {
      if (isStopped(error, signal)) throw error;
      return { ok: false, error: String((error && error.code) || (error && error.message) || error) };
    }
  }

  async function register() {
    if (!("serviceWorker" in navigator)) return null;
    try { return await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }); }
    catch (_) { return null; }
  }

  async function fetchPdf(token, url, signal) {
    return withRetry(async function () {
      return timedFetch("/web/api/offline/pdf", {
        method: "POST",
        headers: Object.assign({}, auth(token), { "content-type": "application/json" }),
        body: JSON.stringify({ url: url }),
      }, signal, async function (response) {
        if (!response.ok) {
          var data = await response.json().catch(function () { return null; });
          var error = new Error(data && data.error || ("pdf_http_" + response.status));
          error.status = response.status;
          error.retryAfter = Number(response.headers.get("retry-after") || 0);
          throw error;
        }
        var declared = Number(response.headers.get("content-length") || 0);
        if (declared > CRAWL_POLICY.maxPdfBytes) {
          var declaredError = new Error("pdf_too_large");
          declaredError.status = 413;
          throw declaredError;
        }
        var blob = await response.blob();
        if (blob.size > CRAWL_POLICY.maxPdfBytes) {
          var sizeError = new Error("pdf_too_large");
          sizeError.status = 413;
          throw sizeError;
        }
        return { blob: blob, browserMs: Number(response.headers.get("x-browser-ms-used") || 0) };
      });
    }, signal);
  }

  async function prepareRun(token, onProgress, options) {
    var signal = options && options.signal;
    var scope = String(options && options.scope || "");
    var runId = String(options && options.runId || "");
    checkStopped(signal);
    var persistent = false;
    try {
      if (navigator.storage && navigator.storage.persist) {
        persistent = await withDeadline(navigator.storage.persist(), TIMEOUTS.storageMs, "storage_persist_timeout", signal);
      }
    } catch (error) { if (isStopped(error, signal)) throw error; }

    // The final workload is not knowable yet: room trees reveal the file
    // count, and rendered pages reveal deeper links. Report discovery honestly
    // instead of briefly claiming the whole operation is a misleading 0/1.
    report(onProgress, "planning", 0, 0, "Caching the app and finding your rooms");
    var shell = await shellPrepare(signal);
    if (!shell || shell.ok !== true) throw codedError(String((shell && shell.error) || "shell_cache_failed"));

    var roomsData = await jsonFetch("/web/api/rooms", token, undefined, signal);
    var rooms = Array.isArray(roomsData.rooms) ? roomsData.rooms : [];
    var trees = {};
    report(onProgress, "rooms", 0, rooms.length, "Reading room indexes");
    for (var roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
      checkStopped(signal);
      var room = String(rooms[roomIndex].room || "");
      if (!room) continue;
      var treeData = await jsonFetch("/web/api/tree?room=" + encodeURIComponent(room), token, undefined, signal);
      trees[room] = Array.isArray(treeData.files) ? treeData.files : [];
      report(onProgress, "rooms", roomIndex + 1, rooms.length, room);
    }

    var fileJobs = [];
    Object.keys(trees).forEach(function (room) {
      trees[room].forEach(function (metadata) {
        var path = String((metadata && metadata.path) || "");
        if (path && !path.endsWith("/")) fileJobs.push({ room: room, path: path, metadata: metadata });
      });
    });
    await put("meta", {
      key: "preparation", scope: scope, run_id: runId,
      cache_generation: CACHE_GENERATION, state: "running",
      started_at: Number(options && options.startedAt || 0),
    }, signal);
    if (options && options.lifecycle) options.lifecycle.started = true;
    var fileDone = 0;
    var fileErrors = [];
    var textFiles = [];
    report(onProgress, "files", 0, fileJobs.length, rooms.length + " rooms · " + fileJobs.length + " files");
    await pool(fileJobs, 4, async function (job) {
      try {
        var data = await jsonFetch("/web/api/file?room=" + encodeURIComponent(job.room) + "&path=" + encodeURIComponent(job.path), token, undefined, signal);
        var key = scopedKey(scope, job.room, job.path);
        var previousFile = await get("files", key, signal);
        // An unsynced plane edit is the user's newest truth. Refreshing the
        // server snapshot must never overwrite that local overlay.
        var file = previousFile && previousFile.file && previousFile.file.pending_offline
          ? previousFile.file
          : data.file;
        if (file && file.is_binary) {
          file.offline_blob = await timedFetch("/web/api/raw?room=" + encodeURIComponent(job.room) + "&path=" + encodeURIComponent(job.path), { headers: auth(token) }, signal, async function (raw) {
            if (!raw.ok) throw new Error("binary_http_" + raw.status);
            return raw.blob();
          });
        } else if (file) {
          textFiles.push({ room: job.room, path: job.path, content: String(file.content || "") });
        }
        await putSnapshotFile({ key: key, scope: scope, room: job.room, path: job.path, file: file, cached_at: Date.now() }, signal);
        return { ok: true };
      } catch (error) {
        if (isStopped(error, signal)) throw error;
        fileErrors.push({ room: job.room, path: job.path, error: String((error && error.message) || error) });
        return { ok: false };
      } finally {
        fileDone += 1;
        report(onProgress, "files", fileDone, fileJobs.length, job.room + "/" + job.path);
      }
    }, signal);
    await pruneScope("files", scope, new Set(fileJobs.map(function (job) { return scopedKey(scope, job.room, job.path); })), signal);

    // Build a provenance graph instead of a flat URL bag. Files are roots;
    // each rendered page contributes child edges. Breadth-first levels ensure
    // every direct reading-list entry finishes before deeper site navigation.
    var seedLinks = new Set();
    var graphNodes = new Map();
    var graphEdges = [];
    var graphEdgeKeys = new Set();
    var graphTruncated = false;
    function addNode(url, depth) {
      var existing = graphNodes.get(url);
      if (existing) {
        existing.depth = Math.min(existing.depth, depth);
        return existing;
      }
      if (graphNodes.size >= CRAWL_POLICY.maxGraphNodes) { graphTruncated = true; return null; }
      var node = { url: url, depth: depth, status: "discovered" };
      graphNodes.set(url, node);
      return node;
    }
    function addEdge(from, to, kind) {
      var key = from + "\u0000" + to;
      if (graphEdgeKeys.has(key)) return;
      if (graphEdges.length >= CRAWL_POLICY.maxGraphEdges) { graphTruncated = true; return; }
      graphEdgeKeys.add(key);
      graphEdges.push({ from: from, to: to, kind: kind });
    }
    textFiles.forEach(function (file) {
      externalLinks(file.content).forEach(function (url) {
        seedLinks.add(url);
        addNode(url, 0);
        addEdge("file:" + file.room + "/" + file.path, url, "file");
      });
    });
    var seedList = Array.from(seedLinks);
    var pageBudget = Math.max(CRAWL_POLICY.maxPages, seedList.length);
    var scheduled = new Set(seedList);
    var frontier = seedList.map(function (url) { return { url: url, depth: 0 }; });
    var linkDone = 0;
    var linkErrors = [];
    var pdfErrors = [];
    var markdownCount = 0;
    var pdfCount = 0;
    var browserMsUsed = 0;
    report(onProgress, "links", 0, scheduled.size, "Building the offline reading graph");
    for (var depth = 0; depth <= CRAWL_POLICY.maxDepth && frontier.length; depth += 1) {
      var level = frontier;
      frontier = [];
      var levelResults = await pool(level, CRAWL_POLICY.pageConcurrency, async function (job) {
        var renderTask = withRetry(function () {
          return jsonFetch("/web/api/offline/render", token, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: job.url }),
          }, signal);
        }, signal);
        var outcomes = await Promise.allSettled([renderTask, fetchPdf(token, job.url, signal)]);
        checkStopped(signal);
        var rendered = outcomes[0].status === "fulfilled" ? outcomes[0].value : null;
        var pdf = outcomes[1].status === "fulfilled" ? outcomes[1].value : null;
        var renderError = outcomes[0].status === "rejected" ? outcomes[0].reason : null;
        var pdfError = outcomes[1].status === "rejected" ? outcomes[1].reason : null;
        if (renderError) linkErrors.push({ url: job.url, error: String(renderError && renderError.message || renderError) });
        if (pdfError) pdfErrors.push({ url: job.url, error: String(pdfError && pdfError.message || pdfError) });
        var previous = await get("links", linkKey(scope, job.url), signal);
        if (rendered || pdf || previous) {
          var row = Object.assign({}, previous || {}, {
            key: linkKey(scope, job.url), scope: scope, url: job.url, depth: job.depth,
            cached_at: Date.now(), status: rendered && pdf ? "ready" : rendered ? "markdown_only" : pdf ? "pdf_only" : "stale",
          });
          if (rendered) {
            row.markdown = String(rendered.markdown || "");
            row.title = String(rendered.title || "");
            row.truncated = Boolean(rendered.truncated);
            row.markdown_cached_at = Date.now();
          }
          if (pdf) {
            row.pdf_blob = pdf.blob;
            row.pdf_cached_at = Date.now();
          }
          await put("links", row, signal);
          if (rendered) {
            markdownCount += 1;
            browserMsUsed += Number(rendered.browser_ms_used || 0);
          }
          if (pdf) {
            pdfCount += 1;
            browserMsUsed += Number(pdf.browserMs || 0);
          }
        }
        var node = addNode(job.url, job.depth);
        if (node) {
          node.title = rendered ? String(rendered.title || "") : "";
          node.status = rendered && pdf ? "ready" : rendered ? "markdown_only" : pdf ? "pdf_only" : "failed";
        }
        linkDone += 1;
        report(onProgress, "links", linkDone, scheduled.size, job.url);
        return { job: job, rendered: rendered };
      }, signal);
      if (depth >= CRAWL_POLICY.maxDepth) continue;
      levelResults.forEach(function (result) {
        if (!result || result.ok === false || !result.rendered) return;
        externalLinks(result.rendered.markdown, result.job.url).forEach(function (child) {
          addNode(child, result.job.depth + 1);
          addEdge(result.job.url, child, "page");
          var childUrl;
          var parentUrl;
          try { childUrl = new URL(child); parentUrl = new URL(result.job.url); } catch (_) { return; }
          if (childUrl.origin !== parentUrl.origin || scheduled.has(child)) return;
          if (scheduled.size >= pageBudget) { graphTruncated = true; return; }
          scheduled.add(child);
          frontier.push({ url: child, depth: result.job.depth + 1 });
        });
      });
    }
    var linkList = Array.from(scheduled);
    await pruneScope("links", scope, new Set(linkList.map(function (url) { return linkKey(scope, url); })), signal);

    var storage = null;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        storage = await withDeadline(navigator.storage.estimate(), TIMEOUTS.storageMs, "storage_estimate_timeout", signal);
      }
    } catch (error) { if (isStopped(error, signal)) throw error; }

    var receipt = {
      prepared_at: Date.now(), persistent: persistent, rooms: rooms.length,
      cache_generation: CACHE_GENERATION, run_id: runId,
      files: fileJobs.length - fileErrors.length, file_errors: fileErrors,
      links: markdownCount, link_errors: linkErrors, pdfs: pdfCount, pdf_errors: pdfErrors,
      crawl: {
        seeds: seedList.length, scheduled: scheduled.size, depth: CRAWL_POLICY.maxDepth,
        page_limit: pageBudget, truncated: graphTruncated,
        nodes: graphNodes.size, edges: graphEdges.length,
      },
      browser_ms_used: browserMsUsed,
      storage: storage ? { usage: Number(storage.usage || 0), quota: Number(storage.quota || 0) } : null,
      shell: shell,
    };
    await put("meta", {
      key: "snapshot", scope: scope, rooms: rooms, handle: String(roomsData.handle || ""),
      trees: trees, receipt: receipt, prepared_at: receipt.prepared_at,
      graph: { nodes: Array.from(graphNodes.values()), edges: graphEdges, policy: CRAWL_POLICY, truncated: graphTruncated },
    }, signal);
    await put("meta", {
      key: "preparation", scope: scope, run_id: runId,
      cache_generation: CACHE_GENERATION, state: "complete",
      started_at: Number(options && options.startedAt || 0), completed_at: receipt.prepared_at,
    }, signal);
    return receipt;
  }

  async function prepareOwned(token, onProgress, options) {
    var signal = options && options.signal;
    var scope = String(options && options.scope || "");
    var runId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    var startedAt = Date.now();
    var lifecycle = { started: false };
    try {
      return await prepareRun(token, onProgress, {
        signal: signal, scope: scope, runId: runId, startedAt: startedAt, lifecycle: lifecycle,
      });
    } catch (error) {
      // Do not reuse the caller's aborted signal: the failure marker is what
      // makes a reload show Retry instead of trusting the previous receipt.
      if (lifecycle.started) markPreparationFailed({
          key: "preparation", scope: scope, run_id: runId,
          cache_generation: CACHE_GENERATION, state: "failed",
          started_at: startedAt, failed_at: Date.now(),
          error: String((error && (error.code || error.message)) || error),
      }).catch(function () {});
      if (lifecycle.started && error && typeof error === "object") error.snapshotInvalidated = true;
      throw error;
    }
  }

  async function prepare(token, onProgress, options) {
    if (!token) throw new Error("token_required");
    var signal = options && options.signal;
    checkStopped(signal);
    var scope = await scopeForToken(token);
    if (navigator.locks && typeof navigator.locks.request === "function") {
      // Web Locks forbids combining ifAvailable with signal. This request is
      // non-blocking; the signal is still enforced by every operation inside.
      var lockOptions = { mode: "exclusive", ifAvailable: true };
      return navigator.locks.request(preparationLockName(scope), lockOptions, function (lock) {
        if (!lock) throw codedError("preparation_already_running");
        return prepareOwned(token, onProgress, { signal: signal, scope: scope });
      });
    }
    return prepareOwned(token, onProgress, { signal: signal, scope: scope });
  }

  async function readSnapshotForScope(scope, signal) {
    var meta = await get("meta", "snapshot", signal);
    if (!meta || meta.scope !== scope) return null;
    var preparation = await get("meta", "preparation", signal);
    var receipt = Object.assign({}, meta.receipt || {});
    var current = receipt.cache_generation === CACHE_GENERATION &&
      preparation && preparation.scope === scope && preparation.state === "complete" &&
      preparation.cache_generation === CACHE_GENERATION && preparation.run_id === receipt.run_id;
    if (!current) receipt.invalidated = true;
    meta = Object.assign({}, meta, { receipt: receipt });
    var records = (await getAll("files", signal)).filter(function (row) { return row.scope === scope; });
    return { meta: meta, files: records, preparation: preparation || null };
  }

  async function readSnapshot(token, options) {
    if (!token) return null;
    var signal = options && options.signal;
    checkStopped(signal);
    var scope = await scopeForToken(token);
    if (navigator.locks && typeof navigator.locks.request === "function") {
      var lockOptions = { mode: "shared", ifAvailable: true };
      return navigator.locks.request(preparationLockName(scope), lockOptions, function (lock) {
        if (!lock) throw codedError("preparation_already_running");
        return readSnapshotForScope(scope, signal);
      });
    }
    return readSnapshotForScope(scope, signal);
  }

  async function readFile(token, room, path) {
    if (!token) return null;
    var scope = await scopeForToken(token);
    var row = await get("files", scopedKey(scope, room, path));
    return row && row.file ? row.file : null;
  }

  async function putFile(token, room, path, file) {
    if (!token || !file) return;
    var scope = await scopeForToken(token);
    var meta = await get("meta", "snapshot");
    if (!meta || meta.scope !== scope) return;
    await put("files", { key: scopedKey(scope, room, path), scope: scope, room: room, path: path, file: file, cached_at: Date.now() });
  }

  async function queueEdit(token, edit) {
    var scope = await scopeForToken(token);
    var key = scopedKey(scope, edit.room, edit.path);
    var existing = await get("files", key);
    var file = Object.assign({}, existing && existing.file ? existing.file : {}, {
      room: edit.room, path: edit.path, content: edit.content,
      etag: edit.base_etag, pending_offline: true, updated_at: new Date().toISOString(),
      size_bytes: new TextEncoder().encode(edit.content).byteLength, is_binary: false,
    });
    await put("files", { key: key, scope: scope, room: edit.room, path: edit.path, file: file, cached_at: Date.now() });
    await put("outbox", {
      key: key, scope: scope, room: edit.room, path: edit.path, content: edit.content,
      base_etag: edit.base_etag || "", queued_at: Date.now(),
    });
    return file;
  }

  async function syncOutbox(token) {
    if (!token || !navigator.onLine) return { synced: [], conflicts: [], failed: [] };
    var scope = await scopeForToken(token);
    var rows = (await getAll("outbox")).filter(function (row) { return row.scope === scope; }).sort(function (a, b) { return a.queued_at - b.queued_at; });
    var result = { synced: [], conflicts: [], failed: [] };
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      try {
        var response = await fetch("/web/api/file", {
          method: "PUT",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ room: row.room, path: row.path, content: row.content, base_etag: row.base_etag || undefined }),
        });
        var data = await response.json().catch(function () { return null; });
        if (response.status === 412) { result.conflicts.push({ row: row, file: data && data.file }); continue; }
        if (!response.ok || !data || data.ok === false || !data.file) throw new Error((data && data.error) || ("http_" + response.status));
        data.file.pending_offline = false;
        await put("files", { key: row.key, scope: scope, room: row.room, path: row.path, file: data.file, cached_at: Date.now() });
        await remove("outbox", row.key);
        result.synced.push({ row: row, file: data.file });
      } catch (error) {
        result.failed.push({ row: row, error: String((error && error.message) || error) });
      }
    }
    return result;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch];
    });
  }

  async function exportHtml(token) {
    var snapshot = await readSnapshot(token);
    if (!snapshot) throw new Error("offline_snapshot_missing");
    if (snapshot.meta.receipt && snapshot.meta.receipt.invalidated) throw new Error("offline_snapshot_incomplete");
    var scope = snapshot.meta.scope;
    var links = (await getAll("links")).filter(function (row) { return row.scope === scope; });
    var textFiles = snapshot.files.filter(function (row) { return row.file && !row.file.is_binary; });
    var toc = textFiles.map(function (row, index) {
      return '<li><a href="#file-' + index + '">' + escapeHtml(row.room + "/" + row.path) + '</a></li>';
    }).join("");
    var bodies = textFiles.map(function (row, index) {
      return '<section id="file-' + index + '"><h2>' + escapeHtml(row.room + "/" + row.path) + '</h2><pre>' + escapeHtml(row.file.content || "") + '</pre></section>';
    }).join("");
    var linked = links.map(function (row, index) {
      return '<section id="link-' + index + '"><h2>' + escapeHtml(row.title || row.url) + '</h2><p><a href="' + escapeHtml(row.url) + '">' + escapeHtml(row.url) + '</a></p><pre>' + escapeHtml(row.markdown || "") + '</pre></section>';
    }).join("");
    var html = '<!doctype html><meta charset="utf-8"><title>Bashroom offline export</title>'
      + '<style>body{max-width:900px;margin:40px auto;padding:0 24px;font:16px/1.55 system-ui;color:#24221f}a{color:#4f3bd0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.55 ui-monospace,monospace;border-top:1px solid #ddd;padding-top:16px}section{break-before:page;margin:56px 0}h1,h2{line-height:1.2}@media print{body{margin:0}section{break-before:page}}</style>'
      + '<h1>Bashroom offline export</h1><p>Prepared ' + escapeHtml(new Date(snapshot.meta.prepared_at).toLocaleString()) + '</p><h2>Files</h2><ol>' + toc + '</ol>' + bodies
      + (linked ? '<h1>Linked pages</h1>' + linked : '');
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var href = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "bashroom-offline-" + new Date().toISOString().slice(0, 10) + ".html";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
  }

  async function purge(token) {
    if (!token) return;
    var scope = await scopeForToken(token);
    for (var i = 0; i < STORES.length; i += 1) {
      var rows = await getAll(STORES[i]);
      for (var j = 0; j < rows.length; j += 1) {
        if (rows[j].scope === scope) await remove(STORES[i], rows[j].key);
      }
    }
  }

  window.BashroomOffline = {
    register: register, prepare: prepare, readSnapshot: readSnapshot,
    readFile: readFile, putFile: putFile, queueEdit: queueEdit,
    syncOutbox: syncOutbox, exportHtml: exportHtml, purge: purge,
    externalLinks: externalLinks,
  };
  void register();
})();
`;

export const WEB_OFFLINE_SERVICE_WORKER_JS = String.raw`
"use strict";
var DB_NAME = "${WEB_OFFLINE_DB_NAME}";
var DB_VERSION = 1;
var CACHE_NAME = "${WEB_OFFLINE_CACHE_NAME}";
var CACHE_PREFIX = "${WEB_OFFLINE_CACHE_PREFIX}";
var CACHE_GENERATION = "${WEB_OFFLINE_GENERATION}";
var REQUEST_TIMEOUT_MS = ${WEB_OFFLINE_TIMEOUTS.requestMs};
var SHELL_URLS = [
  "/web",
  "/web-offline.js?v=${WEB_OFFLINE_GENERATION}",
  "/web-offline-reader.js?v=${WEB_OFFLINE_GENERATION}",
  "/manifest.webmanifest?v=${WEB_OFFLINE_GENERATION}",
  "/app-icon-192.png",
  "/app-icon-512.png",
  "https://cdn.jsdelivr.net/npm/marked@13.0.2/marked.min.js",
  "https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js",
  "https://cdn.jsdelivr.net/npm/@atomic-editor/editor@0.4.3/dist/styles/inline-preview.css",
  "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs",
  "https://esm.sh/react@18.3.1",
  "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1",
  "https://esm.sh/@atomic-editor/editor@0.4.3?deps=react@18.3.1,react-dom@18.3.1,@codemirror/view@6.39.1",
  "https://esm.sh/@codemirror/view@6.39.1",
  "https://esm.sh/@codemirror/language@6?deps=@codemirror/view@6.39.1",
  "https://esm.sh/@lezer/highlight@1"
];
var INSTALL_URLS = SHELL_URLS.slice(0, 4);
var STATIC_HOSTS = new Set(["cdn.jsdelivr.net", "esm.sh"]);
var shellPreparation = null;

async function timedNetworkFetch(input, init, consume) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var response = await fetch(input, Object.assign({}, init || {}, { signal: controller.signal }));
    return typeof consume === "function" ? await consume(response) : response;
  } finally {
    clearTimeout(timer);
  }
}

function openDb() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function () {
      var db = request.result;
      ["meta", "files", "links", "outbox"].forEach(function (name) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "key" });
      });
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

async function allLinks() {
  var db = await openDb();
  return new Promise(function (resolve) {
    var request = db.transaction("links", "readonly").objectStore("links").getAll();
    request.onsuccess = function () { db.close(); resolve(request.result || []); };
    request.onerror = function () { db.close(); resolve([]); };
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch];
  });
}

async function offlineLinkResponse(requestUrl) {
  var target = new URL(requestUrl).searchParams.get("url") || "";
  var rows = await allLinks();
  var matches = rows.filter(function (row) { return row.url === target; }).sort(function (a, b) { return b.cached_at - a.cached_at; });
  if (!matches.length) {
    try { return await fetch(requestUrl); }
    catch (_) {
      return new Response("This linked page was not included in the offline snapshot.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
  var row = matches[0];
  var html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml(row.title || row.url) + '</title>'
    + '<style>body{max-width:820px;margin:48px auto;padding:0 24px;background:#fff;color:#2c2a26;font:16px/1.65 system-ui}a{color:#4f3bd0;text-underline-offset:3px}h1,h2,h3{line-height:1.25}pre,code{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f7f5;padding:16px}blockquote{border-left:3px solid #d9d6cf;margin-left:0;padding-left:18px;color:#5f5b54}.meta{display:flex;gap:14px;flex-wrap:wrap;color:#777;font-size:13px;margin-bottom:36px}.pill{border:1px solid #d9d6cf;border-radius:999px;padding:3px 10px;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#191919;color:#e8e6e1}pre{background:#242424}.pill{border-color:#4a4844}}</style>'
    + '<h1>' + escapeHtml(row.title || row.url) + '</h1><p class="meta"><span>Offline copy</span><a href="' + escapeHtml(row.url) + '">Original</a>'
    + (row.pdf_blob ? '<a class="pill" href="/web/offline/pdf?url=' + encodeURIComponent(row.url) + '">Open PDF</a>' : '')
    + '</p><pre id="offline-source" data-url="' + escapeHtml(row.url) + '" hidden>' + escapeHtml(row.markdown || "") + '</pre><main id="offline-content"></main>'
    + '<script src="https://cdn.jsdelivr.net/npm/marked@13.0.2/marked.min.js"></script>'
    + '<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"></script>'
    + '<script src="/web-offline-reader.js?v=${WEB_OFFLINE_GENERATION}"></script>';
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff"
    }
  });
}

async function offlinePdfResponse(requestUrl) {
  var target = new URL(requestUrl).searchParams.get("url") || "";
  var rows = await allLinks();
  var matches = rows.filter(function (row) { return row.url === target && row.pdf_blob; }).sort(function (a, b) { return b.pdf_cached_at - a.pdf_cached_at; });
  if (!matches.length) {
    return new Response("This page has no offline PDF.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  var row = matches[0];
  var safeName = String(row.title || new URL(row.url).hostname || "page").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page";
  return new Response(row.pdf_blob, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": 'inline; filename="' + safeName + '.pdf"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function moduleSpecifiers(source, base) {
  var urls = [];
  var patterns = [
    /\b(?:import|export)\s*(?:[^"'();]*?from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  patterns.forEach(function (pattern) {
    var match;
    while ((match = pattern.exec(source))) {
      try {
        var url = new URL(match[1], base);
        if (url.protocol === "https:" && STATIC_HOSTS.has(url.hostname)) urls.push(url.toString());
      } catch (_) {}
    }
  });
  return urls;
}

async function cacheGraph(seedUrls) {
  var cache = await caches.open(CACHE_NAME);
  var queue = seedUrls.slice();
  var seen = new Set();
  var cached = 0;
  var errors = [];
  while (queue.length) {
    var raw = queue.shift();
    var absolute = new URL(raw, self.location.origin).toString();
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    try {
      await timedNetworkFetch(absolute, { redirect: "follow" }, async function (response) {
        if (!response.ok && response.type !== "opaque") throw new Error("http_" + response.status);
        await cache.put(absolute, response.clone());
        if (response.url && response.url !== absolute) await cache.put(response.url, response.clone());
        cached += 1;
        var contentType = response.headers.get("content-type") || "";
        if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
          var source = await response.clone().text();
          moduleSpecifiers(source, response.url || absolute).forEach(function (url) {
            if (!seen.has(url)) queue.push(url);
          });
        }
      });
    } catch (error) {
      errors.push({ url: absolute, error: String((error && error.message) || error) });
    }
  }
  return { ok: errors.length === 0, cached: cached, errors: errors, cache_generation: CACHE_GENERATION };
}

function prepareShellGraph() {
  // A stopped client may close its MessagePort while the worker is still
  // caching public shell assets. Share that bounded work with the next retry
  // instead of starting duplicate background downloads.
  if (!shellPreparation) {
    shellPreparation = cacheGraph(SHELL_URLS).finally(function () { shellPreparation = null; });
  }
  return shellPreparation;
}

async function deletePreviousShells() {
  var names = await caches.keys();
  await Promise.all(names.filter(function (name) {
    return name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME;
  }).map(function (name) { return caches.delete(name); }));
}

async function matchPreviousShell(request) {
  var names = await caches.keys();
  var previous = names.filter(function (name) {
    return name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME;
  }).reverse();
  for (var i = 0; i < previous.length; i += 1) {
    var match = await (await caches.open(previous[i])).match(request, { ignoreVary: false });
    if (match) return match;
  }
  return null;
}

self.addEventListener("install", function (event) {
  event.waitUntil(cacheGraph(INSTALL_URLS).then(function (receipt) {
    if (!receipt.ok) throw new Error("shell_install_failed");
    return self.skipWaiting();
  }));
});

self.addEventListener("activate", function (event) {
  // Keep the last complete shell as fallback until PREPARE_SHELL proves the
  // entire current dependency graph. Activation itself stays fast.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", function (event) {
  if (!event.data || event.data.type !== "PREPARE_SHELL") return;
  var port = event.ports && event.ports[0];
  if (event.data.cache_generation !== CACHE_GENERATION) {
    if (port) port.postMessage({ ok: false, error: "shell_generation_mismatch", cache_generation: CACHE_GENERATION });
    return;
  }
  event.waitUntil(prepareShellGraph().then(async function (receipt) {
    if (receipt.ok) await deletePreviousShells();
    if (port) port.postMessage(receipt);
  }).catch(function (error) {
    if (port) port.postMessage({ ok: false, error: String((error && error.message) || error) });
  }));
});

function isAppNavigation(url) {
  var excluded = ["/s/", "/auth/", "/oauth/", "/account/", "/sandbox/", "/mcp", "/bash", "/device", "/help", "/llms.txt", "/skill.md", "/og."];
  return !excluded.some(function (prefix) { return url.pathname.startsWith(prefix); });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/web/api/")) return;
  if (url.origin === self.location.origin && url.pathname === "/web/offline/pdf") {
    event.respondWith(offlinePdfResponse(request.url));
    return;
  }
  if (url.origin === self.location.origin && url.pathname === "/web/offline") {
    event.respondWith(offlineLinkResponse(request.url));
    return;
  }
  if (request.mode === "navigate" && url.origin === self.location.origin && isAppNavigation(url)) {
    event.respondWith(timedNetworkFetch(request, undefined, async function (response) {
      var contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("text/html")) throw new Error("navigation_http_" + response.status);
      var cache = await caches.open(CACHE_NAME);
      await cache.put("/web", response.clone());
      return response;
    }).catch(async function () {
      var cache = await caches.open(CACHE_NAME);
      return (await cache.match("/web")) || (await matchPreviousShell("/web")) || new Response("Bashroom was not prepared for offline use.", { status: 503 });
    }));
    return;
  }
  if (url.origin === self.location.origin || STATIC_HOSTS.has(url.hostname)) {
    event.respondWith(caches.open(CACHE_NAME).then(async function (cache) {
      // The installed app must not pin unversioned Bashroom helpers forever.
      // Refresh these from the origin when online and retain Cache Storage only
      // as the offline fallback. Pinned third-party modules stay cache-first.
      var refreshable = url.origin === self.location.origin && (
        url.pathname === "/web-offline.js" ||
        url.pathname === "/web-offline-reader.js" ||
        url.pathname === "/manifest.webmanifest"
      );
      if (refreshable) {
        try {
          return await timedNetworkFetch(request, undefined, async function (fresh) {
            if (!fresh.ok) throw new Error("http_" + fresh.status);
            await cache.put(request, fresh.clone());
            return fresh;
          });
        } catch (_) {
          var fallback = await cache.match(request, { ignoreVary: false });
          if (!fallback) fallback = await matchPreviousShell(request);
          if (fallback) return fallback;
          throw _;
        }
      }
      var cached = await cache.match(request, { ignoreVary: false });
      if (!cached) cached = await matchPreviousShell(request);
      if (cached) return cached;
      return timedNetworkFetch(request, undefined, async function (response) {
        if (response.ok || response.type === "opaque") await cache.put(request, response.clone());
        return response;
      });
    }));
  }
});
`;
