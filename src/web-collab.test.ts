import { describe, expect, it } from "vitest";
import { webCollaborativeShareHtml } from "./web-collab";

describe("webCollaborativeShareHtml", () => {
  it("keeps authenticated document bytes behind the shared API", () => {
    const html = webCollaborativeShareHtml({ slug: "abc12345", role: "comment", nonce: "nonce" });
    expect(html).toContain("/web/api/shared?slug=");
    expect(html).toContain('["bashroom","tok." + state.token]');
    expect(html).toContain("Sign in to collaborate");
    expect(html).not.toContain("users/");
  });

  it("renders Mermaid only through strict mode", () => {
    const html = webCollaborativeShareHtml({ slug: "abc12345", role: "edit", nonce: "nonce" });
    expect(html).toContain('securityLevel:"strict"');
    expect(html).toContain("mermaid@11.16.0");
    expect(html).toContain("ascii-diagram");
  });

  it("streams and renders actor-labelled caret positions", () => {
    const html = webCollaborativeShareHtml({ slug: "abc12345", role: "edit", nonce: "nonce" });
    expect(html).toContain('caret:input.selectionStart || 0');
    expect(html).toContain('source.onkeyup = streamDraft');
    expect(html).toContain('renderLiveDraft(message.content || "",message.caret,message.actor || "Someone")');
    expect(html).toContain('className = "remote-caret"');
    expect(html).toContain('className = "remote-caret-label"');
  });

  it("escapes the embedded slug before the inline script boundary", () => {
    const html = webCollaborativeShareHtml({ slug: "</script><script>alert(1)", role: "edit", nonce: "nonce" });
    expect(html).not.toContain('var slug = "</script>');
    expect(html).toContain("\\u003c/script>");
  });
});
