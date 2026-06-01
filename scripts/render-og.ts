// Rasterize the OG card: ogSvg() -> assets/og.png (1200×630).
//
// Run via `npm run og` whenever src/og.ts changes. Social scrapers (Twitter/X,
// iMessage, Slack, LinkedIn) reject SVG for og:image, so the worker serves this
// PNG and we keep it in sync from the single source of truth in src/og.ts.
//
// Requires `rsvg-convert` on PATH (brew install librsvg). Node 23 strips the
// TS types natively, so no build step — `node scripts/render-og.ts`.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ogSvg } from "../src/og.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "assets", "og.png");

const res = spawnSync("rsvg-convert", ["-w", "1200", "-h", "630"], {
  input: ogSvg(),
  maxBuffer: 16 * 1024 * 1024,
});

if (res.error) {
  console.error("render-og: rsvg-convert not found — `brew install librsvg`");
  process.exit(1);
}
if (res.status !== 0) {
  console.error("render-og: rsvg-convert failed:", res.stderr?.toString());
  process.exit(res.status ?? 1);
}

writeFileSync(out, res.stdout);
console.log(`render-og: wrote ${out} (${res.stdout.length} bytes, 1200×630)`);
