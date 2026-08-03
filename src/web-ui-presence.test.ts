import { describe, expect, it } from "vitest";
import { ANON_ANIMALS } from "./presence-identities";
import { webIndexHtml } from "./web-ui";

describe("Roomling anonymous presence", () => {
  const html = webIndexHtml();

  it("covers every anonymous identity dealt by RoomHub", () => {
    expect(ANON_ANIMALS.length).toBeGreaterThan(0);
    for (const animal of ANON_ANIMALS) {
      expect(html).toContain(`${animal}: ["#`);
      expect(html).toContain(`${animal}: '<path`);
    }
  });

  it("turns the stable animal name into a local paper-stamp avatar", () => {
    expect(html).toContain("function faceStyle(name, anon)");
    expect(html).toContain("--roomling-bg:");
    expect(html).toContain("--roomling-ink:");
    expect(html).toContain('class="roomling-wash"');
    expect(html).toContain("fill: #fff7e8");
    expect(html).toContain("border-radius: 7px");
    expect(html).toContain("Object.hasOwn(ROOMLING_PALETTES, key)");
    expect(html).toContain("Object.hasOwn(ANIMAL_FACES, key)");
  });

  it("preserves circular GitHub photos for signed-in people", () => {
    expect(html).toContain('if (!anon) return "background:" + actorColor(name)');
    expect(html).toContain('src="https://github.com/');
    expect(html).toContain("width: 24px; height: 24px; border-radius: 50%");
    expect(html).toContain(".presence .p-face.p-anon, .actor-panel .p-face.p-anon");
  });

  it("uses the same identity in the roster and actor panel", () => {
    expect(html).toContain("faceStyle(v.name, v.anon)");
    expect(html).toContain("faceStyle(actor, anon)");
    expect(html).toContain('v.name + (v.anon ? ", anonymous viewer" : "")');
    expect(html).toContain("\" aria-hidden=\"true\">' + faceInnerHtml(actor, anon)");
    expect(html).toContain('aria-haspopup="dialog" aria-expanded="false"');
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
