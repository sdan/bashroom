// OG / social-preview image markup. Isolated in its own module (no Worker
// runtime deps) so scripts/render-og.ts can import ogSvg() directly and
// rasterize the exact same markup the worker serves — the PNG never drifts
// from /og.svg because both come from this one function.
export function ogSvg(): string {
  // 1200x630 OG image. Tagline top-right, brand bottom-left, room tree
  // centered. The tree IS the product mental model — top-level room with
  // files attributed to agents. Composition mirrors the landing footer
  // (brand bottom-left) so social previews and the site share signature.
  const fontStack = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const monoStack = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#F7F7F5"/>

  <!-- Brand block, top-left. Same mark/wordmark proportions as the
       site nav (gap ≈ 45% of mark height): mark height 42px, gap 19px,
       last square ends at x=122, wordmark starts at x=141. -->
  <g transform="translate(80, 80)">
    <g fill="#37352F">
      <rect x="0"   y="0" width="42" height="42" rx="10" opacity="0.12"/>
      <rect x="16"  y="0" width="42" height="42" rx="10" opacity="0.22"/>
      <rect x="32"  y="0" width="42" height="42" rx="10" opacity="0.36"/>
      <rect x="48"  y="0" width="42" height="42" rx="10" opacity="0.55"/>
      <rect x="64"  y="0" width="42" height="42" rx="10" opacity="0.78"/>
      <rect x="80"  y="0" width="42" height="42" rx="10" opacity="1"/>
    </g>
    <text x="141" y="32" font-family="${fontStack}" font-size="36" font-weight="500" fill="#37352F" letter-spacing="-0.5">bashroom</text>
  </g>

  <!-- Room tree, centered. Mirrors the landing diagram. -->
  <g transform="translate(380, 200)">
    <rect x="0" y="0" width="440" height="260" fill="none" stroke="#4F3BD0" stroke-width="2"/>
    <line x1="0" y1="48" x2="440" y2="48" stroke="#EBEAE6" stroke-width="1"/>
    <text x="22" y="32" font-family="${monoStack}" font-size="20" fill="#4F3BD0">sdan/quickquack</text>
    <g font-family="${monoStack}" font-size="18" fill="#37352F">
      <text x="22" y="86" fill="#A3A29C">▾</text>
      <rect x="44" y="74" width="20" height="16" fill="#D8A23A" rx="2"/>
      <path d="M 46 78 L 50 78 L 52 80 L 62 80 L 62 88 L 46 88 Z" fill="#D8A23A"/>
      <text x="72" y="88" fill="#37352F">notes/</text>
      <rect x="74" y="106" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="100" y="120" fill="#37352F">2026-05-20.md</text>
      <text x="418" y="120" text-anchor="end" fill="#A3A29C" font-size="14">claude</text>
      <rect x="74" y="136" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="100" y="150" fill="#37352F">2026-05-21.md</text>
      <text x="418" y="150" text-anchor="end" fill="#A3A29C" font-size="14">codex</text>
      <rect x="44" y="166" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="72" y="180" fill="#37352F">index.md</text>
      <text x="418" y="180" text-anchor="end" fill="#A3A29C" font-size="14">you</text>
      <rect x="44" y="196" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="72" y="210" fill="#37352F">log.md</text>
      <text x="418" y="210" text-anchor="end" fill="#A3A29C" font-size="14">claude</text>
      <rect x="44" y="226" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="72" y="240" fill="#37352F">README.md</text>
      <text x="418" y="240" text-anchor="end" fill="#A3A29C" font-size="14">you</text>
    </g>
  </g>

  <!-- Tagline, bottom-right — diagonal pair to the top-left brand. -->
  <text x="1120" y="555" text-anchor="end" font-family="${fontStack}" font-size="26" font-weight="400" fill="#6F6E69">a filesystem for agents</text>
</svg>`;
}
