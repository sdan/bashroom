// Browser-side offline support is served as two ordinary JavaScript resources:
// a window helper (IndexedDB snapshots/outbox/export) and a service worker
// (app-shell/CDN cache + offline linked-page reader). Keeping these out of the
// already-large inline web shell makes the security boundary reviewable and
// lets the service worker cache the offline implementation itself.

export const WEB_OFFLINE_DB_NAME = "bashroom-offline-v1";
export const WEB_OFFLINE_CACHE_PREFIX = "bashroom-shell-";
export const WEB_OFFLINE_CACHE_NAME = `${WEB_OFFLINE_CACHE_PREFIX}v1`;
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
  var CRAWL_POLICY = ${JSON.stringify(WEB_OFFLINE_CRAWL_POLICY)};

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        STORES.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "key" });
        });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("offline_db_open_failed")); };
    });
  }

  async function storeCall(storeName, mode, operation) {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, mode);
      var store = tx.objectStore(storeName);
      var request;
      try { request = operation(store); }
      catch (error) { db.close(); reject(error); return; }
      if (request) {
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error("offline_db_request_failed")); };
      } else {
        tx.oncomplete = function () { resolve(undefined); };
      }
      tx.onerror = function () { reject(tx.error || new Error("offline_db_transaction_failed")); };
      tx.onabort = function () { reject(tx.error || new Error("offline_db_transaction_aborted")); };
      tx.oncomplete = function () { db.close(); };
    });
  }

  function get(store, key) { return storeCall(store, "readonly", function (s) { return s.get(key); }); }
  function getAll(store) { return storeCall(store, "readonly", function (s) { return s.getAll(); }); }
  function put(store, value) { return storeCall(store, "readwrite", function (s) { return s.put(value); }); }
  function remove(store, key) { return storeCall(store, "readwrite", function (s) { return s.delete(key); }); }

  async function pruneScope(store, scope, keepKeys) {
    var rows = await getAll(store);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].scope === scope && !keepKeys.has(rows[i].key)) await remove(store, rows[i].key);
    }
  }

  async function scopeForToken(token) {
    var bytes = new TextEncoder().encode(String(token || ""));
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).slice(0, 16).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  function scopedKey(scope, room, path) { return scope + "\u0000" + room + "\u0000" + path; }
  function linkKey(scope, url) { return scope + "\u0000" + url; }
  function auth(token) { return { authorization: "Bearer " + token }; }

  async function jsonFetch(path, token, init) {
    var options = Object.assign({}, init || {});
    options.headers = Object.assign({}, auth(token), options.headers || {});
    var response = await fetch(path, options);
    var data = await response.json().catch(function () { return null; });
    if (!response.ok || !data || data.ok === false) {
      var error = new Error((data && data.error) || ("http_" + response.status));
      error.status = response.status;
      error.data = data;
      error.retryAfter = Number(response.headers.get("retry-after") || 0);
      throw error;
    }
    return data;
  }

  function report(callback, phase, done, total, detail) {
    if (typeof callback !== "function") return;
    try { callback({ phase: phase, done: done, total: total, detail: detail || "" }); } catch (_) {}
  }

  async function pool(items, concurrency, worker) {
    var next = 0;
    var results = new Array(items.length);
    async function run() {
      while (true) {
        var index = next++;
        if (index >= items.length) return;
        try { results[index] = await worker(items[index], index); }
        catch (error) { results[index] = { ok: false, error: String((error && error.message) || error) }; }
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(concurrency, Math.max(1, items.length)); i += 1) workers.push(run());
    await Promise.all(workers);
    return results;
  }

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  async function withRetry(operation) {
    var lastError;
    for (var attempt = 0; attempt < 4; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        lastError = error;
        var status = Number(error && error.status || 0);
        if (status && status !== 429 && status < 500) throw error;
        if (attempt === 3) break;
        var retryAfter = Number(error && error.retryAfter || 0);
        await wait(retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt) * 1250);
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

  function shellPrepare() {
    if (!("serviceWorker" in navigator)) return Promise.resolve({ ok: false, error: "service_worker_unsupported" });
    return navigator.serviceWorker.ready.then(function (registration) {
      var target = navigator.serviceWorker.controller || registration.active;
      if (!target) return { ok: false, error: "service_worker_not_active" };
      return new Promise(function (resolve) {
        var channel = new MessageChannel();
        var timer = setTimeout(function () { resolve({ ok: false, error: "shell_cache_timeout" }); }, 120000);
        channel.port1.onmessage = function (event) { clearTimeout(timer); resolve(event.data || { ok: false }); };
        target.postMessage({ type: "PREPARE_SHELL" }, [channel.port2]);
      });
    });
  }

  async function register() {
    if (!("serviceWorker" in navigator)) return null;
    try { return await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }); }
    catch (_) { return null; }
  }

  async function fetchPdf(token, url) {
    return withRetry(async function () {
      var response = await fetch("/web/api/offline/pdf", {
        method: "POST",
        headers: Object.assign({}, auth(token), { "content-type": "application/json" }),
        body: JSON.stringify({ url: url }),
      });
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
  }

  async function prepare(token, onProgress) {
    if (!token) throw new Error("token_required");
    var scope = await scopeForToken(token);
    var persistent = false;
    try {
      if (navigator.storage && navigator.storage.persist) persistent = await navigator.storage.persist();
    } catch (_) {}

    // The final workload is not knowable yet: room trees reveal the file
    // count, and rendered pages reveal deeper links. Report discovery honestly
    // instead of briefly claiming the whole operation is a misleading 0/1.
    report(onProgress, "planning", 0, 0, "Caching the app and finding your rooms");
    var shell = await shellPrepare();

    var roomsData = await jsonFetch("/web/api/rooms", token);
    var rooms = Array.isArray(roomsData.rooms) ? roomsData.rooms : [];
    var trees = {};
    report(onProgress, "rooms", 0, rooms.length, "Reading room indexes");
    for (var roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
      var room = String(rooms[roomIndex].room || "");
      if (!room) continue;
      var treeData = await jsonFetch("/web/api/tree?room=" + encodeURIComponent(room), token);
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
    var fileDone = 0;
    var fileErrors = [];
    var textFiles = [];
    report(onProgress, "files", 0, fileJobs.length, rooms.length + " rooms · " + fileJobs.length + " files");
    await pool(fileJobs, 4, async function (job) {
      try {
        var data = await jsonFetch("/web/api/file?room=" + encodeURIComponent(job.room) + "&path=" + encodeURIComponent(job.path), token);
        var file = data.file;
        if (file && file.is_binary) {
          var raw = await fetch("/web/api/raw?room=" + encodeURIComponent(job.room) + "&path=" + encodeURIComponent(job.path), { headers: auth(token) });
          if (!raw.ok) throw new Error("binary_http_" + raw.status);
          file.offline_blob = await raw.blob();
        } else if (file) {
          textFiles.push({ room: job.room, path: job.path, content: String(file.content || "") });
        }
        await put("files", { key: scopedKey(scope, job.room, job.path), scope: scope, room: job.room, path: job.path, file: file, cached_at: Date.now() });
        return { ok: true };
      } catch (error) {
        fileErrors.push({ room: job.room, path: job.path, error: String((error && error.message) || error) });
        return { ok: false };
      } finally {
        fileDone += 1;
        report(onProgress, "files", fileDone, fileJobs.length, job.room + "/" + job.path);
      }
    });
    await pruneScope("files", scope, new Set(fileJobs.map(function (job) { return scopedKey(scope, job.room, job.path); })));

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
          });
        });
        var outcomes = await Promise.allSettled([renderTask, fetchPdf(token, job.url)]);
        var rendered = outcomes[0].status === "fulfilled" ? outcomes[0].value : null;
        var pdf = outcomes[1].status === "fulfilled" ? outcomes[1].value : null;
        var renderError = outcomes[0].status === "rejected" ? outcomes[0].reason : null;
        var pdfError = outcomes[1].status === "rejected" ? outcomes[1].reason : null;
        if (renderError) linkErrors.push({ url: job.url, error: String(renderError && renderError.message || renderError) });
        if (pdfError) pdfErrors.push({ url: job.url, error: String(pdfError && pdfError.message || pdfError) });
        var previous = await get("links", linkKey(scope, job.url));
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
            markdownCount += 1;
            browserMsUsed += Number(rendered.browser_ms_used || 0);
          }
          if (pdf) {
            row.pdf_blob = pdf.blob;
            row.pdf_cached_at = Date.now();
            pdfCount += 1;
            browserMsUsed += Number(pdf.browserMs || 0);
          }
          await put("links", row);
        }
        var node = addNode(job.url, job.depth);
        if (node) {
          node.title = rendered ? String(rendered.title || "") : "";
          node.status = rendered && pdf ? "ready" : rendered ? "markdown_only" : pdf ? "pdf_only" : "failed";
        }
        linkDone += 1;
        report(onProgress, "links", linkDone, scheduled.size, job.url);
        return { job: job, rendered: rendered };
      });
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
    await pruneScope("links", scope, new Set(linkList.map(function (url) { return linkKey(scope, url); })));

    var storage = null;
    try { if (navigator.storage && navigator.storage.estimate) storage = await navigator.storage.estimate(); } catch (_) {}

    var receipt = {
      prepared_at: Date.now(), persistent: persistent, rooms: rooms.length,
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
    });
    return receipt;
  }

  async function readSnapshot(token) {
    if (!token) return null;
    var scope = await scopeForToken(token);
    var meta = await get("meta", "snapshot");
    if (!meta || meta.scope !== scope) return null;
    var records = (await getAll("files")).filter(function (row) { return row.scope === scope; });
    return { meta: meta, files: records };
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
var SHELL_URLS = [
  "/web",
  "/web-offline.js",
  "/web-offline-reader.js",
  "/manifest.webmanifest",
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
var STATIC_HOSTS = new Set(["cdn.jsdelivr.net", "esm.sh"]);

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
    + '<script src="/web-offline-reader.js"></script>';
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
      var response = await fetch(absolute, { redirect: "follow" });
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
    } catch (error) {
      errors.push({ url: absolute, error: String((error && error.message) || error) });
    }
  }
  return { ok: errors.length === 0, cached: cached, errors: errors };
}

self.addEventListener("install", function (event) {
  event.waitUntil(cacheGraph(["/web", "/web-offline.js", "/web-offline-reader.js", "/manifest.webmanifest"]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (name) { return name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME; }).map(function (name) { return caches.delete(name); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("message", function (event) {
  if (!event.data || event.data.type !== "PREPARE_SHELL") return;
  var port = event.ports && event.ports[0];
  event.waitUntil(cacheGraph(SHELL_URLS).then(function (receipt) {
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
    event.respondWith(fetch(request).then(async function (response) {
      if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
        var cache = await caches.open(CACHE_NAME);
        await cache.put("/web", response.clone());
      }
      return response;
    }).catch(async function () {
      var cache = await caches.open(CACHE_NAME);
      return (await cache.match("/web")) || new Response("Bashroom was not prepared for offline use.", { status: 503 });
    }));
    return;
  }
  if (url.origin === self.location.origin || STATIC_HOSTS.has(url.hostname)) {
    event.respondWith(caches.open(CACHE_NAME).then(async function (cache) {
      var cached = await cache.match(request, { ignoreVary: false });
      if (cached) return cached;
      var response = await fetch(request);
      if (response.ok || response.type === "opaque") await cache.put(request, response.clone());
      return response;
    }));
  }
});
`;
