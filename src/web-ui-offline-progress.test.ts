import { describe, expect, it } from "vitest";
import { webIndexHtml } from "./web-ui";
import { WEB_OFFLINE_CLIENT_JS } from "./web-offline";

describe("offline preparation progress", () => {
  const html = webIndexHtml();

  it("starts with an honest indeterminate discovery phase", () => {
    expect(WEB_OFFLINE_CLIENT_JS).toContain('report(onProgress, "planning", 0, 0');
    expect(WEB_OFFLINE_CLIENT_JS).not.toContain('report(onProgress, "shell", 0, 1');
    expect(html).toContain('planning: "Planning your offline library"');
    expect(html).toContain('phase !== "planning" && phase !== "links"');
  });

  it("keeps the action label stable and moves counts into a progress row", () => {
    expect(html).toContain('if (offlineBusy) return "Preparing…"');
    expect(html).toContain('id="offline-progress" hidden');
    expect(html).toContain('id="offline-progress-label"');
    expect(html).toContain('id="offline-progress-count"');
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
});
