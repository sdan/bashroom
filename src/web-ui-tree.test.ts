import { describe, expect, it } from "vitest";
import { webIndexHtml } from "./web-ui";

describe("Pierre-quality room tree", () => {
  const html = webIndexHtml();

  it("escapes path-derived text and attributes before inserting tree HTML", () => {
    expect(html).toContain("const safeRoom = escHtml(room)");
    expect(html).toContain("const safePath = escHtml(n.path)");
    expect(html).toContain("const safeName = escHtml(n.name)");
    expect(html).toContain("escHtml(state.activePath)");
    expect(html).not.toContain('data-file="${n.path}"');
    expect(html).not.toContain('data-dir="${n.path}"');
  });

  it("uses real disclosure and navigation controls", () => {
    expect(html).toContain('class="room-head" type="button"');
    expect(html).toContain('class="row folder-row" type="button"');
    expect(html).toContain('class="row file-row ${active}" type="button"');
    expect(html).toContain('aria-expanded="${open ? "true" : "false"}"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('class="row-share" type="button"');
  });

  it("supports fast keyboard traversal and focus recovery", () => {
    for (const key of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(html).toContain(`event.key === "${key}"`);
    }
    expect(html).toContain("focusedSidebarKey");
    expect(html).toContain("focus({ preventScroll: true })");
  });

  it("turns the rail into a full-width phone navigation surface", () => {
    expect(html).toContain("@media (max-width: 720px)");
    expect(html).toContain('id="mobile-tree-toggle"');
    expect(html).toContain('id="mobile-tree-close"');
    expect(html).toContain('document.body.classList.toggle("tree-open"');
    expect(html).toContain('aside.toggleAttribute("inert", mobile && !open)');
    expect(html).toContain("!profileSurface && !share && (mobileTreeOpen || !state.activePath)");
    expect(html).toContain("mobileTreeShouldBeOpen() && state.activePath");
    expect(html).toContain("mobileTreeOpen = Boolean(mobileTreeMedia.matches)");
    expect(html).toContain("state.activePath || (activeFile && !activeFileIsErr)");
    expect(html).toContain('share ? "" : `<button class="mobile-tree-toggle"');
    expect(html).toContain(".result-folder, .tree-retry { min-height: 40px");
  });

  it("keeps the tree quiet and exposes recoverable failures", () => {
    expect(html).not.toContain("--md:");
    expect(html).not.toContain("ICON.md");
    expect(html).toContain('data-retry-room="');
    expect(html).toContain("label.scrollWidth > label.clientWidth");
  });

  it("scrolls long room trees without pushing account controls off-screen", () => {
    expect(html).toContain("#sections { flex: 1 1 auto; min-height: 0; overflow-y: auto");
    expect(html).toContain(".footer { flex-shrink: 0;");
    expect(html).toContain("aside {\n    position: fixed;");
    expect(html).toContain("overflow: hidden;");
  });
});
