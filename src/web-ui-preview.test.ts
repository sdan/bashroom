import { describe, expect, it } from "vitest";
import { webIndexHtml } from "./web-ui";

describe("addressable Markdown preview", () => {
  const html = webIndexHtml();

  it("uses a real link without changing the segmented-control styling", () => {
    expect(html).toContain('<a class="doc-action" id="preview-link" href="${escHtml(urlWithPreviewMode(!previewing))}"');
    expect(html).not.toContain('button class="doc-action" id="preview-btn"');
    expect(html).toContain("font: 500 12.5px/1 var(--sans); text-decoration: none");
    expect(html).toContain("#preview-link > span");
  });

  it("maps preview to a URL while keeping edit mode canonical", () => {
    expect(html).toContain('new URLSearchParams(location.search).get("view") === "preview"');
    expect(html).toContain('url.searchParams.set("view", "preview")');
    expect(html).toContain('url.searchParams.delete("view")');
    expect(html).toContain('base + "?view=preview" : base');
    expect(html).toContain('next === location.pathname + location.search');
  });

  it("restores the view on boot and browser history navigation", () => {
    expect(html).toContain("(fromUrl || share) && state.activeRoom && state.activePath && previewModeFromUrl()");
    expect(html).toContain("previewKey = previewModeFromUrl() && state.activeRoom && state.activePath");
    expect(html).toContain('history.pushState(null, "", nextUrl)');
  });

  it("keeps navigation and modified clicks native and capability-safe", () => {
    expect(html).toContain("if (changingFile) previewKey = \"\"");
    expect(html).toContain("event.metaKey || event.ctrlKey || event.shiftKey || event.altKey");
    expect(html).toContain("const url = new URL(location.href)");
    expect(html).toContain("if (share) return; // capability URLs are /s/<slug>");
    expect(html).toContain('document.getElementById("preview-link")?.focus()');
  });
});
