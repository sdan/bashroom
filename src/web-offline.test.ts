import { describe, expect, it } from "vitest";
import {
  normalizeOfflineHttpUrl,
  WEB_OFFLINE_CLIENT_JS,
  WEB_OFFLINE_CRAWL_POLICY,
  WEB_OFFLINE_MANIFEST,
  WEB_OFFLINE_READER_JS,
  WEB_OFFLINE_SERVICE_WORKER_JS,
} from "./web-offline";

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
});
