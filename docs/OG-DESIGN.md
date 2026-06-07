# Fleet OG Design System

How every sdan-fleet site builds its social-share image (the `og:image` that
unfurls in Twitter/X, iMessage, Slack, Discord). One author, several sites —
this doc is the shared playbook so a new site's OG lands in the family without
re-deriving it each time.

Sites covered: **bashroom**, **pingpong**, **bountylist**, **yecombinator**,
**quack**. Each section below is "what's the same" (the invariants you must
keep) then "what's different" (the per-site choices you're free to make).

---

## The one rule that defines the fleet

**One iconic object, dead-center, that IS the product.** Not a logo on a
gradient, not a feature list — the actual product surface, rendered big and
centered:

| Site | Centered hero object |
|------|----------------------|
| bashroom | the room file-tree (`sdan/quickquack` with files attributed to agents) |
| pingpong | the live cobe globe (real screenshot, arcs + presence markers) |
| bountylist | the fruit illustration, bleeding off the corner |
| yecombinator | the actual tweet text, set large |
| quack | a real iPhone running the real feed |

If you can't name the single object before you start, you're not ready to build
the OG. pingpong's comment says it outright: *"Place it dead-center… the single
object, like bashroom's tree."*

A corollary: **prefer real product pixels over a redraw.** pingpong screenshots
its actual globe; yecombinator shows the literal tweet; quack composites real
captured feed cards. bashroom *redraws* its tree in SVG because the tree is
cheap to redraw faithfully — but the bias is toward genuine pixels. A redraw is
acceptable only when it's indistinguishable from the real surface.

---

## The composition grammar (hard invariants)

Every fleet OG honors these. They're the visual signature — break them and it
stops looking like a sibling.

1. **1200×630**, rendered at 2× (2400×1260) for retina, declared 1200×630 in
   the meta tags.
2. **Brand lockup top-left** — mark + wordmark, small, at ~`(80, 70)`.
3. **Tagline bottom-right, on a diagonal to the brand.** This BL/BR diagonal is
   the most recognizable fleet tell. bashroom's comment: *"diagonal pair to the
   top-left brand."* pingpong: *"the signature bashroom diagonal."*
4. **Flat, quiet metadata type** — one weight, generous letter-spacing, muted
   ink. The default register is `26px / weight 400 / muted`. (quack runs heavier
   — see below — because it's a consumer product, not a quiet tool.)
5. **The hero is centered and dominant.** Side elements recede; nothing competes
   with the one object.

---

## The palette (soft — per-site, NOT shared)

This is the most-misunderstood part. The fleet does **not** share a palette —
it shares the *grammar above*. Coherence has never meant "same hex codes."

| Site | Background | Ink / accent |
|------|-----------|--------------|
| bashroom | warm wash `#F7F7F5` | warm ink `#37352F`, muted `#6F6E69`, indigo `#4F3BD0` |
| pingpong | warm wash `#F7F7F5` | same warm ink + green `#2EA043` (live-state accent) |
| bountylist | white `#ffffff` | black + blue `#0a4dff` |
| yecombinator | off-white `#fafafa` | `#252321` + rust `#b4493c` |
| quack | **black `#000`** | white + TikTok red `#fe2c55` / cyan `#25f4ee` |

bashroom + pingpong share the warm wash because they're both quiet
analytics/tooling products — and pingpong's code calls it "the shared fleet
palette," which is only true *between those two*. bountylist, yecombinator, and
quack each picked their own. **The palette must serve the product's category,
and it must match the app the user opens.** quack is a black-UI TikTok-style
feed; a warm-wash card would be a lie about the product (and you can't composite
real black-bg feed screenshots onto cream without an ugly seam). Pick the
palette from the running app, not from the fleet.

---

## The two render lineages (soft — pick by stack)

The fleet splits cleanly into static and dynamic OGs. Both produce the same
1200×630 output; choose by whether the OG is one fixed image or one-per-item.

### Static — `rsvg-convert` (bashroom, pingpong, quack)

One SVG string → one PNG asset, generated at build time, committed to the repo
and served as a static asset. Pattern:

```text
ogSvg() / gen-og.mjs           # builds the SVG string (the single source)
  -> rsvg-convert -w 2400 -h 1260
  -> public/og.png             # committed; served by the Worker's ASSETS
```

- bashroom: `src/og.ts` exports `ogSvg()`; `scripts/render-og.ts` rasterizes it.
  Isolated so the PNG never drifts from `/og.svg` — both come from one function.
- pingpong: `og/blend-og.mjs` composites a real globe screenshot into the SVG,
  then `rsvg-convert`. `og/capture-globe.mjs` (Playwright) refreshes the
  screenshot.
- quack: `scripts/capture-cards.mjs` (Playwright captures real feed cards) →
  `scripts/gen-og.mjs` composites + `rsvg-convert`.

Requires `rsvg-convert` on PATH (`brew install librsvg`). Use this lineage when
there's **one** OG (the homepage card).

### Dynamic — Satori / next-og (bountylist, yecombinator)

JSX-ish tree → SVG (Satori) → PNG (resvg-wasm or next/og), rendered
**per-request at the edge** so each item (tweet, listing) gets its own card.

- bountylist: `satori` + `@resvg/resvg-wasm` in the Worker; `renderListingOg`
  per job, `renderHomeOg` for the homepage. Fonts loaded from ASSETS, memoized.
- yecombinator: `next/og` `ImageResponse`, `runtime = "edge"`, switches layout
  on query params (`?id=` tweet, `?q=` search, default home).

Use this lineage when the OG is **per-item** (deep links need their own card).
Caveat (yecombinator's comment): every multi-child container needs
`display: flex` or next/og silently emits an empty PNG.

---

## Gotchas the fleet has already hit

- **Fonts.** `rsvg-convert` uses **system** fonts, not the ones you name in CSS.
  If the font isn't installed, it silently falls back (quack shipped *Verdana*
  instead of Inter until Inter was installed on the build machine). Either
  install the font on the build box (and add an `fc-match` guard that fails the
  build if it's missing) or embed it as base64 `@font-face`. Satori/next-og take
  fonts explicitly, so they don't have this trap — but you must pass every
  weight you use.
- **Absolute `og:image` URL.** Several scrapers (older Facebook, some
  Slack/LinkedIn bots) don't resolve relative URLs. Use
  `https://<site>/og.png`, not `/og.png`. Same for `twitter:image`. Don't leave
  a duplicate relative tag — the later one wins.
- **Square-crop safe area.** Some platforms crop to 1:1, keeping only the center
  ~630px-wide column. Anything critical near the left/right edge (the brand
  lockup, the tagline) vanishes in that crop. Keep at least the wordmark inside
  the central safe zone, or accept the 1.91:1-only contract knowingly.
- **Thumbnail legibility.** The card is seen at ~500px wide for <2s. Text baked
  into a screenshot (a real card's caption/byline) becomes unreadable mush at
  that size — keep it as texture, put the load-bearing words in real SVG text at
  a size that survives downscale.
- **Declare `og:image:width`/`height`** (1200×630) so scrapers size the card
  before the image loads and don't drop it.

---

## Adding an OG to a new fleet site — checklist

1. Name the **one centered object** that is the product. Get real pixels of it
   if you can (Playwright screenshot of the live surface).
2. Pick the **palette from the running app**, not the fleet. Match what the user
   opens.
3. Lay out the **grammar**: brand top-left, hero centered, tagline bottom-right
   on the diagonal, flat quiet type.
4. Choose the **lineage**: one OG → static `rsvg-convert`; per-item → Satori /
   next-og.
5. Run the **gotcha checklist**: font installed/embedded, absolute `og:image`
   URL, `width`/`height` declared, square-safe area, thumbnail-legible text.
6. View it at real thumbnail size before shipping. If the hero doesn't survive a
   2-second blind glance, simplify until it does.

---

## Worked example — quack (2026-06)

quack's OG is the newest and exercised the whole playbook, so it's the reference
implementation for the static lineage:

- **Hero:** a real iPhone 15 Pro (magicui frame SVG), dead-center, showing a
  genuine captured feed card — flanked by two dimmed/desaturated "candidate"
  feeds scored `0.42` / `0.71`, with the bright center marked `PROMOTED ↑`. This
  shows quack's "self-improving feed" *physically* (the recsys ranking
  candidates and promoting the best) instead of only stating it.
- **Palette:** black + TikTok red/cyan — quack's own app brand, a deliberate
  break from the warm-wash siblings (see the palette section). An earlier
  iteration wrongly copied pingpong's wash; it was wrong because the OG must
  match the black-UI app.
- **Brand:** the real `<LogoMark/>` path (red duck-bubble) copied verbatim from
  the app + "QuickQuack" in real Inter. Tagline "A self-improving feed."
  bottom-right.
- **Pipeline:** `scripts/capture-cards.mjs` → `scripts/gen-og.mjs` →
  `public/og.png`. Hit every gotcha above (the Verdana font fallback, the
  relative-URL bug, the square-crop loss) — all fixed before ship.

The design was pressure-tested by a panel of adversarial reviewers (fleet
purist, cold first-time viewer, minimalist, ship-it PM, QA auditor). Two durable
lessons came out of it:

1. **Trust the cold-viewer read over the informed one.** Reviewers who read the
   generator's intent "saw" the meaning; the one who judged the image blind (like
   a real Twitter viewer) is the verdict that ships. Subtle metaphors that need a
   legend (faint arrows, dim duplicate phones) don't transmit at thumbnail size —
   make the signal legible (explicit score numbers) or cut it.
2. **The OG is a poster, not a system diagram.** The temptation is to *explain*
   the product on the canvas. Resist it; show one thing big, let the words carry
   the claim.
