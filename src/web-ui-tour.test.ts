import { describe, expect, it } from "vitest";
import { webIndexHtml } from "./web-ui";

describe("offline feature guide", () => {
  const html = webIndexHtml();

  it("teaches each new plane-mode capability", () => {
    expect(html).toContain('id: "offline-sync"');
    expect(html).toContain('id: "offline-search"');
    expect(html).toContain('id: "offline-install"');
    expect(html).toContain('id: "offline-export"');
  });

  it("is dismissible and can be replayed", () => {
    expect(html).toContain('aria-label="Dismiss tutorial"');
    expect(html).toContain("TOUR_STEPS.forEach");
    expect(html).toContain("localStorage.removeItem(TOUR_KEY)");
    expect(html).toContain('id="tour-replay"');
  });

  it("never appears in capability-share mode", () => {
    expect(html).toContain("if (!state.token || share || profileSurface) { hideFeatureTour(); return; }");
  });
});
