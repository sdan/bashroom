import { describe, expect, it } from "vitest";
import { webIndexHtml } from "./web-ui";
import { WEB_OFFLINE_CLIENT_JS, WEB_OFFLINE_GENERATION } from "./web-offline";

describe("offline preparation progress", () => {
  const html = webIndexHtml();

  it("starts with an honest indeterminate discovery phase", () => {
    expect(WEB_OFFLINE_CLIENT_JS).toContain('report(onProgress, "planning", 0, 0');
    expect(WEB_OFFLINE_CLIENT_JS).not.toContain('report(onProgress, "shell", 0, 1');
    expect(html).toContain('planning: "Planning your offline library"');
    expect(html).toContain('phase !== "planning" && phase !== "links"');
  });

  it("keeps progress visible and turns the busy action into an escape hatch", () => {
    expect(html).toContain('if (offlineBusy) return "Stop"');
    expect(html).toContain('if (offlineBusy) stopOfflinePreparation()');
    expect(html).toContain('offlineController.abort()');
    expect(html).toContain('id="offline-progress" hidden');
    expect(html).toContain('id="offline-progress-label"');
    expect(html).toContain('id="offline-progress-count"');
  });

  it("keeps recovery instructions visible and routes stale workers to reload", () => {
    expect(html).toContain('id="offline-notice" role="status" hidden');
    expect(html).toContain('"Last copy ready · "');
    expect(html).toContain('if (offlineFailureRequiresReload()) return "Reload app"');
    expect(html).toContain('if (offlineFailureRequiresReload()) location.reload()');
    expect(html).toContain('if (offlineFailureCode === "service_worker_unsupported") return "Offline unavailable"');
  });

  it("only paints a ready receipt when the shell and every room file succeeded", () => {
    expect(html).toContain('receipt.invalidated === true');
    expect(html).toContain('receipt.cache_generation !== OFFLINE_GENERATION');
    expect(html).toContain('receipt.shell.ok !== true');
    expect(html).toContain('!Array.isArray(receipt.file_errors)');
    expect(html).toContain('receipt.file_errors.length === 0');
    expect(html).toContain('!offlineBusy && !offlineFailure && offlineReceiptIsReady(offlineReceipt) ? " ready" : ""');
  });

  it("separates room readiness from a fully complete linked archive", () => {
    expect(html).toContain('return offlineReceiptIsComplete(offlineReceipt) ? "Offline ready" : "Rooms ready"');
    expect(html).toContain('links.length === 0 && pdfs.length === 0');
  });

  it("forces the installed app past an older cache-first helper", () => {
    expect(html).toContain(`<script src="/web-offline.js?v=${WEB_OFFLINE_GENERATION}"></script>`);
    expect(html).toContain(`<link rel="manifest" href="/manifest.webmanifest?v=${WEB_OFFLINE_GENERATION}" />`);
    expect(html).toContain(`const OFFLINE_GENERATION = "${WEB_OFFLINE_GENERATION}"`);
  });

  it("exposes accessible determinate and indeterminate progress", () => {
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('progress.classList.toggle("indeterminate", !view.determinate)');
    expect(html).toContain('progressTrack.setAttribute("aria-valuenow", String(view.done))');
    expect(html).toContain('progressTrack.removeAttribute("aria-valuenow")');
  });

  it("uses tabular counts and motion-safe progress animation", () => {
    expect(html).toContain("font-variant-numeric: tabular-nums");
    expect(html).toContain("@keyframes offline-progress-slide");
    expect(html).toContain("animation: none");
  });

  it("cancels post-prepare hydration and rejects stale signed-out data", () => {
    expect(html).toContain('offline.readSnapshot(capturedToken, { signal })');
    expect(html).toContain('state.token !== capturedToken');
    expect(html).toContain('hydrateOfflineSnapshot(preparationToken, controller.signal)');
  });
});
