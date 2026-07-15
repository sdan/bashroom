// Bashroom web UI — a logged-in read view over /rooms.
//
// Two regions: a fixed-position sidebar pinned to the viewport left edge, and
// the page body offset to clear it. No flex, no grid, no media queries —
// absolute positioning is the only sizing model that doesn't fight nested
// scroll containers across browsers. Single inline HTML, vanilla JS, marked
// from CDN. No build step.
//
// Auth: bearer token in localStorage (key `bashroom.token`). Endpoints:
//   GET /web/api/rooms?active=X   -> { rooms: [...], tree?: [{ path, updated_at, size_bytes }] }
//   GET /web/api/tree?room=X      -> { files: [{ path, updated_at, size_bytes }] }
//   GET /web/api/file?room=X&path=Y -> { file: { path, content, updated_at, size_bytes } }

// The SPA shell is fully static — no server-side interpolation — so it's
// built once at module load instead of re-materialized on every request
// (deep-link page loads are the hot path). `webIndexHtml()` just hands back
// the cached string.
const WEB_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<!-- Dark-OS users must never see a white pre-CSS canvas while the head's
     CDN resources resolve — declare both schemes before any CSS parses. -->
<meta name="color-scheme" content="light dark" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bashroom</title>
<link rel="preconnect" href="https://pingpong.sdan.io" crossorigin />
<link rel="dns-prefetch" href="https://pingpong.sdan.io" />
<script defer src="https://pingpong.sdan.io/client.js" data-site="bashroom.sdan.io" data-presence="true"></script>
<script>
  (function() {
    try {
      var saved = localStorage.getItem("bashroom.theme");
      if (saved === "light" || saved === "dark") {
        document.documentElement.setAttribute("data-theme", saved);
        // Pin the UA canvas to the explicit choice — a saved light theme on
        // a dark OS must not flash dark (and vice versa).
        document.documentElement.style.colorScheme = saved;
      }
    } catch (_) {}
  })();
</script>
<link rel="preconnect" href="https://cdn.jsdelivr.net" />
<!-- Preconnected sockets are partitioned by credentials mode: the bare hint
     warms the classic-script/stylesheet socket, the crossorigin one warms
     the anonymous socket module fetches use (mermaid's dynamic import). -->
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
<link rel="preconnect" href="https://esm.sh" crossorigin />
<!-- marked/dompurify load at the END of <body> (still classic scripts, so
     order is preserved and they run before the app script) — in <head> they
     were parser-blocking and nothing painted until jsdelivr responded. -->
<!-- Atomic Editor (CodeMirror 6 live-preview: type on the rendered view,
     markers hidden except on the active line). The JS is lazy-imported (CDN
     ESM) on first edit; the buffer IS the markdown — no parse/serialize step
     — so saves are byte-identical to what you'd type in a textarea.
     modulepreload starts those downloads DURING boot instead of at first
     mount — the editor is the app's primary surface, so this is never
     wasted; mounting drops from network-bound to cache-hit. -->
<link rel="modulepreload" href="https://esm.sh/react@18.3.1" />
<link rel="modulepreload" href="https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1" />
<link rel="modulepreload" href="https://esm.sh/@atomic-editor/editor@0.4.3?deps=react@18.3.1,react-dom@18.3.1,@codemirror/view@6.39.1" />
<link rel="modulepreload" href="https://esm.sh/@codemirror/view@6.39.1" />
<!-- Editor CSS loads non-render-blocking (preload, swapped to stylesheet on
     load). loadCm() awaits the swap so the editor can never mount unstyled;
     the shell paints without waiting on this fetch. -->
<link id="atomic-css" rel="preload" as="style" href="https://cdn.jsdelivr.net/npm/@atomic-editor/editor@0.4.3/dist/styles/inline-preview.css" onload="this.onload=null;this.rel='stylesheet'" />
<style>
  :root {
    --bg: #ffffff;
    --side: #f7f7f5;
    --hover: #efeeec;
    --active: #e8e6f5;
    --ink: #37352f;
    --ink-dim: #6f6e69;
    --ink-faint: #a3a29c;
    --rule: #ebeae6;
    --guide: #e3e2dd;
    --link: #4f3bd0;
    --folder: #d8a23a;
    --md: #1ca1c7;
    --mono: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, Arial, sans-serif;
    --side-w: 260px;
    /* Actor identity — "color means who". Chrome stays ink-and-paper
       monochrome; these pastels appear ONLY where provenance does:
       presence pills, joined-toasts, provenance flashes. */
    --actor-you: #6f9a78;
    --actor-claude: #cf8a74;
    --actor-codex: #7fa7cf;
    --actor-guest: #c2a06b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #191919;
      --side: #202020;
      --hover: #2a2a2a;
      --active: #2f2940;
      --ink: #e8e6e1;
      --ink-dim: #9b9a94;
      --ink-faint: #5c5b56;
      --rule: #2a2a2a;
      --guide: #303030;
      --link: #c8a8ff;
      --folder: #ffd452;
      --md: #08c0ef;
      --actor-you: #8fc09a;
      --actor-claude: #e8a68f;
      --actor-codex: #9cc0e8;
      --actor-guest: #d9bc85;
    }
  }
  :root[data-theme="dark"] {
    --bg: #191919;
    --side: #202020;
    --hover: #2a2a2a;
    --active: #2f2940;
    --ink: #e8e6e1;
    --ink-dim: #9b9a94;
    --ink-faint: #5c5b56;
    --rule: #2a2a2a;
    --guide: #303030;
    --link: #c8a8ff;
    --folder: #ffd452;
    --md: #08c0ef;
    --actor-you: #8fc09a;
    --actor-claude: #e8a68f;
    --actor-codex: #9cc0e8;
    --actor-guest: #d9bc85;
  }
  * { box-sizing: border-box; }

  /* Body owns the scroll; sidebar is pulled out of flow. */
  html { height: 100%; }
  body {
    margin: 0;
    padding: 0;
    padding-left: var(--side-w);
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }

  /* Sidebar: fixed to the left edge, its own scroll container. The whole
     rail is navigation, so double-clicking a room head must toggle it, not
     select the "Loading…" text beside it — user-select off for everything
     except the search input. */
  aside {
    position: fixed;
    inset: 0 auto 0 0;        /* top:0 right:auto bottom:0 left:0 */
    width: var(--side-w);
    background: var(--side);
    border-right: 1px solid var(--rule);
    overflow-y: auto;
    padding: 10px 0 0;
    display: flex;
    flex-direction: column;
    user-select: none;
    -webkit-user-select: none;
  }
  aside .search-box input { user-select: text; -webkit-user-select: text; }

  /* Capability mode — /s/<slug> edit links serve this same SPA with an
     injected grant. One document: no sidebar to browse, no Share control to
     mint further capabilities. Everything else (editor, presence, bar) is
     identical to the app, which is the point. */
  :root.share-mode body { padding-left: 0; }
  :root.share-mode aside { display: none; }
  :root.share-mode .share-wrap { display: none; }

  /* Main: lives in the normal flow next to the padded body. Top padding is
     breathing room under the sticky doc bar, not page chrome. */
  main { padding: 40px 64px 160px; }
  .page { max-width: 820px; margin: 0 auto; }

  /* Brand row */
  /* Brand matches the landing page (logo 22px, name 17px/500/-0.01em).
     Same visual identity across the product surface. */
  .brand { color: var(--ink); padding: 6px 14px 14px; display: flex; align-items: center; gap: 10px; }
  .brand .mark { height: 22px; width: auto; color: var(--ink); display: inline-flex; align-items: center; flex-shrink: 0; }
  .brand .brand-name { flex: 1; font-family: var(--sans); font-size: 17px; font-weight: 500; letter-spacing: -0.01em; }
  .brand .brand-repo { color: var(--ink-faint); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 28px; height: 28px; border-radius: 6px; transition: color 140ms ease, background 140ms ease; position: relative; }
  .brand .brand-repo::before { content: ""; position: absolute; inset: -6px; border-radius: 8px; }
  .brand .brand-repo:hover { color: var(--ink); background: var(--hover); }
  .brand .brand-repo svg { width: 16px; height: 16px; display: block; }
  .brand .theme-toggle {
    background: transparent; border: 0; padding: 0; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--ink-faint); width: 28px; height: 28px; border-radius: 6px;
    transition: color 140ms ease, background 140ms ease;
    -webkit-appearance: none; appearance: none; position: relative;
  }
  .brand .theme-toggle::before { content: ""; position: absolute; inset: -6px; border-radius: 8px; }
  .brand .theme-toggle:hover { color: var(--ink); background: var(--hover); }
  .brand .theme-toggle svg { width: 16px; height: 16px; display: block; }
  .brand .theme-toggle .ic-sun { display: none; }
  :root[data-theme="dark"] .brand .theme-toggle .ic-moon,
  :root:not([data-theme="light"]) .brand .theme-toggle .ic-moon {
    /* moon shown by default (light mode) */
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .brand .theme-toggle .ic-moon { display: none; }
    :root:not([data-theme="light"]) .brand .theme-toggle .ic-sun { display: inline; }
  }
  :root[data-theme="dark"] .brand .theme-toggle .ic-moon { display: none; }
  :root[data-theme="dark"] .brand .theme-toggle .ic-sun { display: inline; }
  :root[data-theme="light"] .brand .theme-toggle .ic-moon { display: inline; }
  :root[data-theme="light"] .brand .theme-toggle .ic-sun { display: none; }

  /* Room sections */
  .section { padding: 2px 6px; }
  .room-head { display: flex; align-items: center; gap: 2px; padding: 4px 6px; cursor: pointer; border-radius: 4px; color: var(--ink-dim); }
  .room-head:hover { background: var(--hover); color: var(--ink); }
  .room-head .chev { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-faint); transition: transform 120ms ease; flex-shrink: 0; }
  .room-head .chev.open { transform: rotate(90deg); }
  .room-head .name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }

  /* Tree */
  .tree { list-style: none; margin: 0; padding: 0 0 4px; }
  .tree li { position: relative; }
  .tree ul { list-style: none; margin: 0; padding-left: 18px; position: relative; }
  .tree ul::before { content: ""; position: absolute; left: 7px; top: 0; bottom: 0; border-left: 1px solid var(--guide); }
  .tree .row {
    display: flex; align-items: center; gap: 4px;
    padding: 3px 6px; margin: 0 6px;
    cursor: pointer; color: var(--ink-dim);
    border-radius: 4px; user-select: none;
    min-height: 26px;
  }
  .tree .row:hover { background: var(--hover); color: var(--ink); }
  .tree .row.active { background: var(--active); color: var(--link); }
  .tree .row.active .icon { color: var(--link); }
  .tree .chev { width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-faint); transition: transform 120ms ease; }
  .tree .chev.open { transform: rotate(90deg); }
  .tree .chev.hidden { visibility: hidden; }
  .tree .icon { width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-faint); }
  .tree .icon.folder { color: var(--folder); }
  .tree .icon.md { color: var(--md); }
  .tree .label { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Footer — 10px vertical matches the brand row's top spacing for visual symmetry. */
  .footer { margin-top: auto; padding: 10px 14px; font-size: 13px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--rule); }
  .footer .handle { color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .footer .logout { cursor: pointer; color: var(--ink-faint); flex-shrink: 0; }
  .footer .logout:hover { color: var(--link); }

  /* Document chrome — one bar bolted to the top of the content pane, three
     zones with distinct materials: breadcrumb (sans, the document's name),
     telemetry (flat mono readout — presence, viewers, save state), actions
     (one segmented hairline-ringed control). Single row ALWAYS: breadcrumb
     ellipsizes and telemetry collapses under a fade mask before anything
     wraps or shifts. Sticky; blur keeps scrolled text legible beneath. */
  .doc-header {
    position: sticky; top: 0; z-index: 30;
    display: flex; align-items: center; flex-wrap: nowrap; gap: 12px;
    min-height: 52px; padding: 8px 20px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  /* Seamless at rest, instrument on scroll: where scroll-driven animations
     exist, the bottom rule and a faint drop materialize over the first 64px
     of scroll — the bar reads as part of the page until content actually
     slides under it. Elsewhere the static rule stays. */
  @supports (animation-timeline: scroll()) {
    .doc-header {
      border-bottom-color: transparent;
      animation: doc-bar-elevate linear both;
      animation-timeline: scroll();
      animation-range: 0 64px;
    }
    @keyframes doc-bar-elevate {
      to { border-bottom-color: var(--rule); box-shadow: 0 8px 24px -18px rgba(0,0,0,.35); }
    }
  }
  /* Breadcrumb in the app's own sans at UI size. The current file is the
     emphasis; the room is context. Ellipsizes under pressure — the bar
     NEVER wraps to a second row; the telemetry lane collapses first. */
  .doc-location {
    flex: 0 1 auto; min-width: 60px; display: flex; align-items: baseline; gap: 6px;
    font-size: 13px; line-height: 1.4; letter-spacing: -0.01em;
    white-space: nowrap; overflow: hidden;
  }
  .doc-location .doc-room { color: var(--ink-dim); flex-shrink: 0; }
  .doc-location .doc-separator { color: var(--ink-faint); flex-shrink: 0; }
  .doc-location .doc-path { color: var(--ink); font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
  /* Telemetry lane — a flat mono readout, right-aligned against the actions.
     This is the collapsible piece: under pressure it clips from the left
     beneath a fade mask (oldest presence goes first, the counters survive),
     so the filename and the actions never move. The 16px padding is the
     fade runway — content only enters it while being clipped. */
  .doc-activity {
    display: flex; align-items: center; justify-content: flex-end;
    margin-left: auto; min-width: 0; flex: 0 4 auto; overflow: hidden;
    gap: 10px; padding-left: 16px;
    font-family: var(--mono); font-size: 11px; color: var(--ink-faint);
    white-space: nowrap;
    mask-image: linear-gradient(to right, transparent, #000 16px);
    -webkit-mask-image: linear-gradient(to right, transparent, #000 16px);
  }
  /* Hairline between telemetry and actions — only when telemetry has
     something to say (no stray divider on a quiet solo document). */
  .doc-activity:has(.p-pill, .p-viewers, .doc-save-state:not(:empty)) {
    border-right: 1px solid var(--rule); padding-right: 14px;
  }
  /* Middot before the save state so "3 viewing" and "saved" — two unrelated
     live counters — stop reading as one phrase. */
  .doc-save-state:not(:empty)::before { content: "· "; color: var(--ink-faint); }
  /* Actions fused into one segmented control — a single hairline-ringed
     instrument instead of three words floating in space. Segments share
     internal rules; hover fills a segment; the ring is the only box in
     the bar, so it reads as THE control. */
  .doc-actions { display: flex; align-items: stretch; flex-shrink: 0; border-radius: 8px; box-shadow: 0 0 0 1px var(--rule); }
  .doc-actions > * + * { border-left: 1px solid var(--rule); }
  .share-wrap { display: flex; }
  .doc-action {
    min-height: 30px; border: 0; border-radius: 0; padding: 0 11px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    background: transparent; color: var(--ink-dim); cursor: pointer;
    font: 500 12.5px/1 var(--sans); user-select: none; -webkit-appearance: none; appearance: none;
    transition-property: color, background-color;
    transition-duration: 150ms; transition-timing-function: ease-out;
    position: relative;
  }
  /* Invisible tap-target extension (same pattern as .brand-repo::before):
     each segment stays a quiet 30px visually but accepts clicks across
     ~46px vertically — most of the 52px bar. Vertical-only, so adjacent
     segments' targets never overlap. */
  .doc-action::before { content: ""; position: absolute; inset: -8px 0; }
  .doc-actions > :first-child, .doc-actions > :first-child .doc-action { border-radius: 8px 0 0 8px; }
  .doc-actions > :last-child, .doc-actions > :last-child .doc-action { border-radius: 0 8px 8px 0; }
  .doc-actions > :only-child, .doc-actions > :only-child .doc-action { border-radius: 8px; }
  .doc-action:hover { color: var(--ink); background: var(--hover); }
  .doc-action:active { color: var(--ink); background: var(--active); }
  .doc-action:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; z-index: 1; }
  .doc-action.copied { color: var(--link); background: var(--active); }
  .doc-action.failed { color: #d4493b; }
  .doc-action .icon-stack { position: relative; width: 14px; height: 14px; display: inline-block; flex-shrink: 0; }
  .doc-action .icon-stack svg {
    position: absolute; inset: 0; width: 14px; height: 14px;
    transition-property: opacity, scale, filter; transition-duration: 220ms;
    transition-timing-function: cubic-bezier(.2,0,0,1);
  }
  .doc-action .icon-stack .ic-check,
  .doc-action .icon-stack .ic-fail { opacity: 0; scale: .25; filter: blur(4px); }
  .doc-action.copied .icon-stack .ic-copy,
  .doc-action.failed .icon-stack .ic-copy { opacity: 0; scale: .25; filter: blur(4px); }
  .doc-action.copied .icon-stack .ic-check,
  .doc-action.failed .icon-stack .ic-fail { opacity: 1; scale: 1; filter: blur(0); }
  .doc-action .label-stack { position: relative; display: inline-block; min-width: 44px; height: 1.1em; overflow: hidden; }
  .doc-action .label-stack span {
    position: absolute; left: 0; top: 0; white-space: nowrap;
    transition-property: opacity, transform; transition-duration: 180ms;
    transition-timing-function: cubic-bezier(.2,0,0,1);
  }
  .doc-action .lb-copied, .doc-action .lb-failed { opacity: 0; transform: translateY(6px); }
  .doc-action.copied .lb-copy, .doc-action.failed .lb-copy { opacity: 0; transform: translateY(-6px); }
  .doc-action.copied .lb-copied, .doc-action.failed .lb-failed { opacity: 1; transform: translateY(0); }
  .doc-action .share-lbl { min-width: 5ch; }
  /* Same reservation as Copy/Share: "Preview"⇄"Edit" must not change the
     segmented control's width under the cursor. */
  #preview-btn > span { display: inline-block; min-width: 7ch; text-align: center; }
  .share-wrap { position: relative; }
  .share-menu {
    position: absolute; top: calc(100% + 8px); right: 0; z-index: 50;
    width: 268px; padding: 4px; border-radius: 10px;
    background: var(--bg);
    box-shadow: 0 0 0 1px rgba(0,0,0,.07), 0 8px 28px rgba(0,0,0,.12);
  }
  .share-menu[hidden] { display: none; }
  .share-option {
    width: 100%; min-height: 48px; padding: 7px 10px; border: 0; border-radius: 6px;
    display: grid; grid-template-columns: 26px 1fr; column-gap: 8px; align-items: center;
    color: var(--ink); background: transparent; cursor: pointer; text-align: left;
    transition-property: background-color, scale; transition-duration: 140ms; transition-timing-function: ease-out;
  }
  .share-option:hover { background: var(--hover); }
  .share-option:active { scale: .96; }
  .share-option:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
  .share-option .share-role-icon { grid-row: 1 / 3; color: var(--ink-dim); font-size: 15px; text-align: center; }
  .share-option strong { align-self: end; font-size: 12.5px; font-weight: 600; }
  .share-option small { align-self: start; color: var(--ink-faint); font-size: 10.5px; line-height: 1.3; text-wrap: pretty; }
  :root[data-theme="dark"] .share-menu { box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 10px 30px rgba(0,0,0,.28); }
  .doc-save-state { white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) {
    .doc-action, .doc-action .icon-stack svg, .doc-action .label-stack span { transition: none; }
  }

  /* Editor — swaps in for the rendered article. Mono + the code-block
     metrics so flipping between read and edit doesn't feel like a
     different page. */
  .editor { width: 100%; min-height: 65vh; resize: vertical; font-family: var(--mono); font-size: 13px; line-height: 1.55; color: var(--ink); background: var(--side); border: 1px solid var(--rule); border-radius: 6px; padding: 14px 16px; }
  .editor:focus { outline: none; border-color: var(--link); }
  /* Atomic Editor (CM6 live-preview). Mounts into #cm-mount; the textarea
     stays in the DOM as the draft buffer + fallback, hidden (.cm-active) once
     the editor loads. Atomic themes itself via --atomic-editor-* variables —
     we map them onto the reader palette so edit mode reads as the same
     surface as the rendered article, in both light and dark. */
  .editor.cm-active { display: none; }
  #cm-mount { border: 1px solid var(--rule); border-radius: 6px; overflow: hidden; }
  #cm-mount:focus-within { border-color: var(--link); }
  /* The bordered mount only appears once CodeMirror populates it — empty
     (fallback textarea mode, or mid-mount) it painted a stray rounded
     hairline above the textarea. */
  #cm-mount:not(.inline):empty { display: none; }
  /* Modeless surface: the document IS the editor, so no box around it — it
     sits on the page like the rendered article did. */
  #cm-mount.inline, #cm-mount.inline:focus-within { border: 0; border-radius: 0; overflow: visible; }
  /* While the editor mount is empty (esm.sh import in flight, or a full
     render detached the live editor) the rendered article placeholder next
     to it holds the document's content and height — no blank pane, no page
     collapse, no scroll clamp. CSS hides it the instant CodeMirror
     populates the mount. */
  #cm-mount.inline:not(:empty) ~ #cm-ph { display: none; }
  /* Hanging heading/quote markers (Obsidian-style): Atomic reveals "## " as
     the active line's first span, which used to push the text right and back
     on every caret move — the single most visible jank in the editor. The
     marker collapses to a zero-advance inline-block whose glyphs overflow
     leftward (rtl) into the column gutter, so the text never moves; the
     negative margin cancels the revealed trailing space, which stays in flow
     as a bare text node. Targets .tok-processingInstruction (classHighlighter,
     wired in loadCm) — only real HeaderMark/QuoteMark spans carry it, so
     setext content spans and lazy-continuation quote lines never match, and
     marker-only lines ("##" on a blank line) keep their height. Scoped to the
     overflow-visible inline surface; the bordered fallback clips its gutter,
     so there the markers stay in flow and shrink instead (see below). */
  #cm-mount .cm-line { position: relative; }
  #cm-mount.inline .cm-activeLine[class*="cm-atomic-h"] > .tok-processingInstruction:first-child {
    display: inline-block; width: 0; direction: rtl; white-space: pre;
    margin-right: -0.27em; /* space width in the -apple-system stack ~0.25-0.28em */
    color: var(--ink-dim);
  }
  /* Blockquote counterpart: the hung ">" fits inside the quote rail's 14px
     padding, so this one is safe on the bordered surface too. */
  #cm-mount .cm-activeLine.cm-atomic-blockquote > .tok-processingInstruction:first-child {
    display: inline-block; width: 0; direction: rtl; white-space: pre;
    margin-right: -0.25em;
  }
  /* aria-live announces autosaves from the quiet document activity lane. */
  #cm-mount .atomic-cm-editor {
    --atomic-editor-bg: var(--bg);
    --atomic-editor-bg-surface: var(--side);
    --atomic-editor-bg-panel: var(--side);
    --atomic-editor-fg: var(--ink);
    --atomic-editor-fg-muted: var(--ink-dim);
    --atomic-editor-fg-faint: var(--ink-faint);
    --atomic-editor-border: var(--rule);
    --atomic-editor-accent: var(--link);
    --atomic-editor-accent-soft: var(--active);
    --atomic-editor-link: var(--link);
    --atomic-editor-link-hover: var(--link);
    --atomic-editor-code-bg: var(--hover);
    --atomic-editor-code-rail: var(--rule);
    --atomic-editor-selection-bg: var(--active);
    --atomic-editor-font: var(--sans);
    --atomic-editor-font-mono: var(--mono);
    --atomic-editor-body-size: 16px;
    --atomic-editor-body-leading: 1.6;
    /* .page already caps the column at 820px like the article did — don't
       double-constrain inside the editor. */
    --atomic-editor-measure: none;
    min-height: 65vh;
  }
  #cm-mount .cm-editor { min-height: 65vh; }
  #cm-mount .cm-focused { outline: none; }
  #cm-mount .cm-content { padding-inline: 0; }
  /* Equal floors on both surfaces: Atomic's theme gives .cm-content a 40vh
     trailing pad; the article had neither floor nor pad, so Preview⇄Edit
     jumped the page height ~half a viewport. 20vh on both, same 65vh floor.
     (id+class+class out-specifies Atomic's injected theme pair.) */
  #cm-mount.inline .cm-content { padding-bottom: 20vh; }
  .page > article { min-height: 65vh; padding-bottom: 20vh; }
  /* ── Reader-parity type scale ──
     Match the article CSS the reader used before modeless editing, so the
     editing surface and the old rendered view are indistinguishable:
     h1 2.25em/600, h2 1.5em/600, h3 1.15em/600, all lh 1.3 ls -0.01em. */
  #cm-mount .cm-line.cm-atomic-h1, #cm-mount .cm-line.cm-atomic-h1 * { font-size: 2.25em; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
  #cm-mount .cm-line.cm-atomic-h2, #cm-mount .cm-line.cm-atomic-h2 * { font-size: 1.5em; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
  #cm-mount .cm-line.cm-atomic-h3, #cm-mount .cm-line.cm-atomic-h3 * { font-size: 1.15em; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
  #cm-mount .cm-line.cm-atomic-h1 *, #cm-mount .cm-line.cm-atomic-h2 *, #cm-mount .cm-line.cm-atomic-h3 * { font-size: 1em; }
  /* Vertical rhythm: the article gives headings margin-top 1.6em; the
     editor's only gap above one is the blank source line (25.6px).
     Compensate with padding — CM6's heightmap measures padding, not margin. */
  #cm-mount .cm-line.cm-atomic-h2 { padding-top: 0.53em; padding-bottom: 0; } /* (1.6em*24px − 25.6px)/24px */
  #cm-mount .cm-line.cm-atomic-h3 { padding-top: 0.21em; padding-bottom: 0; } /* (1.6em*18.4px − 25.6px)/18.4px */
  /* The article styles h4 like the rest of the scale; Atomic's h4-h6 fall to
     its defaults (line-height 1.6, h6 uppercase). Extend the parity. */
  #cm-mount .cm-line.cm-atomic-h4, #cm-mount .cm-line.cm-atomic-h5, #cm-mount .cm-line.cm-atomic-h6 {
    font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; text-transform: none; color: var(--ink);
  }
  /* Inline code: article was 0.85em ink-on-hover-gray, radius 3. The inner
     highlight span would otherwise tint it accent-purple. */
  #cm-mount .cm-atomic-inline-code,
  #cm-mount .cm-atomic-inline-code * { font-size: 0.85em; color: var(--ink); }
  #cm-mount .cm-atomic-inline-code { background: var(--hover); border-radius: 3px; padding: 2px 6px; }
  #cm-mount .cm-atomic-inline-code * { font-size: 1em; }
  /* Inside headings the (1,2,0) descendant reset above would win over the
     (1,1,0) inline-code rule and blow the chip up to heading size — restate
     it at (1,3,0) like the article's 0.85em. */
  #cm-mount .cm-line.cm-atomic-h1 .cm-atomic-inline-code,
  #cm-mount .cm-line.cm-atomic-h2 .cm-atomic-inline-code,
  #cm-mount .cm-line.cm-atomic-h3 .cm-atomic-inline-code { font-size: 0.85em; }
  /* Fenced code: article pre was 13px/1.55 plain ink on --side. */
  #cm-mount .cm-line.cm-atomic-fenced-code,
  #cm-mount .cm-line.cm-atomic-fenced-code * { color: var(--ink); }
  #cm-mount .cm-line.cm-atomic-fenced-code { font-size: 13px; line-height: 1.55; background: var(--side); box-shadow: inset 2px 0 0 var(--rule); padding-left: 16px; padding-right: 16px; }
  /* Tables: article was 14px, content-width (not stretched), 600-weight
     headers on --side. */
  #cm-mount .cm-atomic-table-cell-source, #cm-mount .cm-atomic-table-cell-preview { font-size: 14px; line-height: 1.6; }
  #cm-mount .cm-atomic-table table { min-width: 0; }
  #cm-mount .cm-atomic-table thead .cm-atomic-table-cell-source,
  #cm-mount .cm-atomic-table th .cm-atomic-table-cell-source,
  #cm-mount .cm-atomic-table th { font-weight: 600; background: var(--side); }
  /* Match the article's cell metrics (6px/10px) and block gap (0.8em) so a
     table keeps its height and position on surface swap. Padding, not
     margin — CM6's heightmap excludes margin and mis-routes clicks. */
  #cm-mount .cm-atomic-table th, #cm-mount .cm-atomic-table td { padding: 6px 10px; }
  #cm-mount .cm-atomic-table { padding: 0.8em 0; }
  /* Blockquote: article used a 3px ink rail with dimmed text. */
  #cm-mount .cm-line.cm-atomic-blockquote { border-left: 3px solid var(--ink); padding-left: 14px; color: var(--ink-dim); }
  /* Revealed syntax on the ACTIVE line (the Obsidian-style caret reveal —
     the markers must stay text-editable, so they can't be hidden, but they
     can whisper): faint ink. No font-weight override — Atomic matches each
     mark's weight to its span ("**" at 700) precisely so the marks don't
     change width mid-typing. .cm-atomic-mark only ever exists inside table
     cells; prose markers carry .tok-processingInstruction (classHighlighter). */
  #cm-mount .tok-processingInstruction,
  #cm-mount .cm-atomic-em-mark,
  #cm-mount .cm-atomic-strong-mark,
  #cm-mount .cm-atomic-strike-mark { color: var(--ink-faint); opacity: 0.55; }
  /* Bordered fallback: markers stay in flow, so heading hashes shrink to a
     whisper instead of shouting at heading size. Kept off the inline surface
     — there the hang rule owns them, and a shrunken em would mis-size its
     space-cancelling negative margin. */
  #cm-mount:not(.inline) .cm-line.cm-atomic-h1 .tok-processingInstruction,
  #cm-mount:not(.inline) .cm-line.cm-atomic-h2 .tok-processingInstruction,
  #cm-mount:not(.inline) .cm-line.cm-atomic-h3 .tok-processingInstruction,
  #cm-mount:not(.inline) .cm-line.cm-atomic-h4 .tok-processingInstruction,
  #cm-mount:not(.inline) .cm-line.cm-atomic-h5 .tok-processingInstruction,
  #cm-mount:not(.inline) .cm-line.cm-atomic-h6 .tok-processingInstruction { font-size: 0.55em; font-weight: 400; }
  .edit-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .edit-actions button { font-family: var(--sans); font-size: 13px; font-weight: 500; padding: 7px 14px; border: 1px solid var(--rule); background: var(--side); color: var(--ink); border-radius: 6px; cursor: pointer; }
  .edit-actions button:hover { background: var(--hover); }
  .edit-actions button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .edit-actions .edit-error { font-size: 12px; color: #d4493b; }
  .edit-actions .hint { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); margin-left: auto; }

  /* Share affordance on tree rows — hidden until hover so the tree stays
     quiet. Click copies a public link to that directory (the room head
     variant shares the room root). visibility (not display) so the icon's
     18px box is ALWAYS in the layout — the icon is taller than the text
     line, and popping it in on hover used to grow the row ~1px and shift
     every row below it. Hover must never change layout. */
  .tree .row .row-share, .room-head .row-share { display: inline-flex; visibility: hidden; margin-left: auto; width: 18px; height: 18px; align-items: center; justify-content: center; color: var(--ink-faint); border-radius: 4px; flex-shrink: 0; }
  .tree .row:hover .row-share, .room-head:hover .row-share { visibility: visible; }
  .row-share:hover { color: var(--link); background: var(--active); }
  .row-share.copied { color: var(--link); }
  /* Reserve the widest label's width so Share→copied→Share never shifts. */
  .share-lbl { display: inline-block; min-width: 6ch; }
  .row-share svg { width: 12px; height: 12px; }

  article { font-size: 16px; line-height: 1.6; color: var(--ink); }
  article h1, article h2, article h3, article h4 { font-weight: 600; line-height: 1.3; margin-top: 1.6em; margin-bottom: 0.4em; letter-spacing: -0.01em; text-wrap: balance; }
  article h1 { font-size: 2.25em; margin-top: 0; margin-bottom: 0.4em; }
  article h2 { font-size: 1.5em; }
  article h3 { font-size: 1.15em; }
  article p { margin: 0 0 0.6em; text-wrap: pretty; }
  article a { color: var(--link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
  article code { font-family: var(--mono); font-size: 0.85em; background: var(--hover); padding: 2px 6px; border-radius: 3px; color: var(--ink); }
  /* Code blocks mirror the EDITOR's geometry (borderless strip, 2px inset
     rail, ~20px vertical space from the hidden fence lines) — the editor
     can't shed its fence-line height, so the article meets it. */
  article pre { font-family: var(--mono); font-size: 13px; line-height: 1.55; background: var(--side); border: 0; box-shadow: inset 2px 0 0 var(--rule); padding: 20px 16px; overflow-x: auto; border-radius: 0; }
  article pre code { background: transparent; padding: 0; font-size: 13px; }
  article pre.ascii-diagram { tab-size: 4; line-height: 1.35; white-space: pre; }
  article pre.diagram-mermaid { padding: 18px; text-align: center; background: var(--bg); box-shadow: none; }
  article pre.diagram-mermaid svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
  article blockquote { border-left: 3px solid var(--ink); margin: 1em 0; padding: 0 0 0 14px; color: var(--ink-dim); }
  article hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
  /* List columns follow the EDITOR (its per-line padding is an inline style
     we can't beat): first-line text at 2em, +0.6em per nested level — so
     list lines don't slide sideways on Preview⇄Edit. */
  article ul, article ol { padding-left: 2em; margin: 0 0 0.6em; }
  article :is(ul, ol) :is(ul, ol) { padding-left: 0.6em; }
  article li { margin: 0.15em 0; }
  article table { border-collapse: collapse; font-size: 14px; margin: 0.8em 0; }
  article th, article td { border: 1px solid var(--rule); padding: 6px 10px; text-align: left; }
  article th { background: var(--side); font-weight: 600; }
  article img { max-width: 100%; outline: 1px solid rgba(0,0,0,.1); outline-offset: -1px; }
  :root[data-theme="dark"] article img { outline-color: rgba(255,255,255,.1); }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) article img { outline-color: rgba(255,255,255,.1); }
  }

  /* ── Presence (who's here / who wrote recently) ──
     Flat mono readout in the bar's telemetry lane — no chips, no boxes;
     the ONLY color is the actor dot, which pulses while its actor's last
     write is fresh (<90s). Boxing this made ambient telemetry louder than
     the actions, which is backwards. */
  .doc-activity .presence { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
  .presence .p-pill {
    display: inline-flex; align-items: center; gap: 5px;
    color: var(--ink-dim);
    white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  /* Anonymous share-link viewers (dealt an animal by the hub) read dimmer
     than named handles — ambient audience, not actors. */
  .presence .p-anon { color: var(--ink-faint); }
  /* Live roster as a Notion-style avatar stack: signed-in handles are
     GitHub logins, so github.com/<handle>.png is a real profile photo for
     free; animals get their initial on the actor color. Overlap + a bg
     ring makes N viewers read as one object instead of a list. */
  .presence .p-stack { display: inline-flex; align-items: center; }
  .presence .p-face {
    position: relative; overflow: hidden; flex-shrink: 0;
    width: 22px; height: 22px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font: 600 10px/1 var(--sans); color: #fff;
    box-shadow: 0 0 0 2px var(--bg);
  }
  .presence .p-face + .p-face { margin-left: -7px; }
  .presence .p-face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .presence .p-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .presence .p-kind { display: inline-flex; color: var(--ink-faint); flex-shrink: 0; }
  .presence .p-kind svg { width: 9px; height: 9px; display: block; }
  .presence .p-dot.live { animation: presence-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
  @keyframes presence-pulse { 50% { opacity: 0.35; } }
  .presence .p-viewers { white-space: nowrap; font-variant-numeric: tabular-nums; }

  /* Live follow view — the document morphing under a collaborator's hands.
     A sticky name flag floats top-right in the writer's color; the block
     they're changing carries a colored rail. */
  .live-view { position: relative; }
  .live-flag {
    position: sticky; top: 12px; float: right; z-index: 5;
    font-family: var(--mono); font-size: 10.5px;
    padding: 3px 9px; border: 1px solid; border-radius: 999px;
    background: var(--bg);
  }
  .live-article .live-edit {
    box-shadow: inset 3px 0 0 var(--live-color);
    padding-left: 10px;
    border-radius: 2px;
  }
  /* Remote caret: zero layout width, so presence never reflows the document
     or changes the rendered-text offsets used by inline comments. */
  .remote-caret {
    position: relative; display: inline-block; width: 0; height: 1.15em;
    vertical-align: -0.18em; pointer-events: none; z-index: 8;
  }
  .remote-caret::before {
    content: ""; position: absolute; left: -1px; top: 0; bottom: 0;
    width: 2px; border-radius: 2px; background: var(--remote-color);
    animation: remote-caret-blink 1.05s steps(1, end) infinite;
  }
  .remote-caret-label {
    position: absolute; left: -2px; bottom: calc(100% + 2px);
    max-width: 140px; padding: 2px 5px; border-radius: 4px 4px 4px 1px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #191919; background: var(--remote-color);
    font: 600 9.5px/1.25 var(--sans); letter-spacing: 0;
    box-shadow: 0 1px 3px rgba(0,0,0,.18);
  }
  @keyframes remote-caret-blink { 0%, 44%, 100% { opacity: 1; } 45%, 78% { opacity: .18; } }

  /* Joined-toast — fade-and-rise, bottom center, auto-dismiss. Lives on
     <body>, outside #app, so full rerenders can't kill it mid-flight. */
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translate(-50%, 8px);
    background: var(--ink); color: var(--bg);
    font-family: var(--sans); font-size: 12.5px;
    padding: 8px 14px; border-radius: 8px;
    display: flex; align-items: center; gap: 8px;
    opacity: 0; pointer-events: none; z-index: 50;
    transition: opacity 180ms ease, transform 220ms cubic-bezier(0.25, 1, 0.5, 1);
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast .t-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  @media (prefers-reduced-motion: reduce) {
    .toast { transition: none; }
    .presence .p-dot.live { animation: none; }
    .remote-caret::before { animation: none; }
  }

  /* Styled tooltips (data-tip) — replaces native title bubbles, which read
     as OS chrome inside an otherwise designed surface. Right-anchored so the
     right-aligned controls never overflow the viewport; 400ms intent delay
     like every desktop app. */
  [data-tip] { position: relative; }
  [data-tip]::after {
    content: attr(data-tip);
    position: absolute; top: calc(100% + 6px); right: 0;
    background: var(--ink); color: var(--bg);
    font: 500 11px/1 var(--sans);
    padding: 5px 8px; border-radius: 4px; white-space: nowrap;
    opacity: 0; transform: translateY(-2px); pointer-events: none;
    transition: opacity 120ms ease 400ms, transform 120ms ease 400ms;
    z-index: 10;
  }
  [data-tip]:hover::after, [data-tip]:focus-visible::after { opacity: 1; transform: translateY(0); }
  @media (prefers-reduced-motion: reduce) {
    [data-tip]::after { transition-duration: 0ms; }
  }

  .empty { font-size: 14px; color: var(--ink-dim); padding: 10px 14px; }
  .empty code { font-family: var(--mono); font-size: 12px; background: var(--hover); padding: 2px 6px; border-radius: 3px; color: var(--link); }

  /* Cross-room search — quiet input pinned under the brand; results replace
     the room sections while a query is active. */
  .search-box { padding: 0 14px 10px; flex-shrink: 0; }
  .search-box input {
    width: 100%; font-family: var(--sans); font-size: 13px;
    padding: 6px 10px; border: 1px solid var(--rule); background: var(--bg);
    color: var(--ink); border-radius: 6px; outline: none;
    transition: border-color 140ms ease;
  }
  .search-box input:focus { border-color: var(--link); }
  .search-box input::placeholder { color: var(--ink-faint); }
  .search-room { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); padding: 10px 14px 2px; }
  .result { padding: 5px 8px; margin: 0 6px; border-radius: 4px; cursor: pointer; }
  .result:hover { background: var(--hover); }
  .result-path { font-size: 12.5px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .result-line { color: var(--ink-faint); }
  .result-preview { font-family: var(--mono); font-size: 11px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .result-preview b { color: var(--link); font-weight: 600; }
  .result-folder {
    font-family: var(--mono); font-size: 11px; color: var(--ink-faint);
    padding: 6px 8px 1px; margin: 0 6px; cursor: pointer; border-radius: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .result-folder:hover { color: var(--link); background: var(--hover); }
  .result.nested { margin-left: 18px; }

  /* Login */
  .login { padding: 24px; max-width: 460px; margin: 72px auto; }
  .login h1 { font-weight: 600; font-size: 24px; letter-spacing: -0.01em; margin: 0 0 8px; }
  .login p { color: var(--ink-dim); line-height: 1.55; margin: 0 0 18px; font-size: 14px; }
  .login input { width: 100%; font-family: var(--mono); font-size: 13px; padding: 10px 12px; border: 1px solid var(--rule); background: var(--side); color: var(--ink); border-radius: 6px; }
  .login button { margin-top: 12px; font-size: 13px; font-weight: 500; padding: 9px 18px; border: 0; background: var(--ink); color: var(--bg); border-radius: 6px; cursor: pointer; }
  .login code { font-family: var(--mono); font-size: 12px; background: var(--hover); padding: 2px 6px; border-radius: 3px; color: var(--link); }
  .login .steps { display: flex; flex-direction: column; gap: 10px; margin: 0 0 22px; }
  .login .step { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--side); border: 1px solid var(--rule); border-radius: 6px; cursor: pointer; transition: background 140ms ease; }
  .login .step:hover { background: var(--hover); }
  .login .step .n { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); flex-shrink: 0; width: 14px; }
  .login .step .cmd { font-family: var(--mono); font-size: 12px; color: var(--ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .login .step .copy { font-size: 11px; color: var(--ink-faint); flex-shrink: 0; }
  .login .step.copied { background: var(--active); }
  .login .step.copied .copy { color: var(--link); }
  .login .divider { display: flex; align-items: center; gap: 10px; margin: 18px 0 14px; }
  .login .divider::before, .login .divider::after { content: ""; flex: 1; border-top: 1px solid var(--rule); }
  .login .divider span { font-size: 11px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.05em; }
  .login-error { font-size: 12px; color: #c33; background: var(--side); border: 1px solid var(--rule); border-left: 3px solid #c33; padding: 8px 10px; margin: 0 0 10px; border-radius: 4px; line-height: 1.45; }

  /* Login view doesn't need the sidebar gutter. */
  body.login-view { padding-left: 0; }
</style>
</head>
<body>
  <div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/marked@13.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"></script>
<script>
(() => {
  const TOKEN_KEY = "bashroom.token";
  const STATE_KEY = "bashroom.state";
  const OPEN_KEY = "bashroom.opened";
  const ROOM_OPEN_KEY = "bashroom.rooms-opened";
  const app = document.getElementById("app");
  const requestedReturn = new URLSearchParams(location.search).get("return") || "";
  // Only collaboration links on this origin may round-trip through login.
  // This keeps the token-paste page from becoming an open redirect.
  const RETURN_TO = requestedReturn.startsWith("/s/") && !requestedReturn.startsWith("//") ? requestedReturn : "";

  const ICON = {
    chev: '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 2 8 6 4 10"/></svg>',
    folder: '<svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.2 1.2h4.8a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>',
    md: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 2.5h9v9h-9z"/><path d="M4.5 9V5l1.5 2L7.5 5v4M10 5v4M8.5 7.5 10 9l1.5-1.5"/></svg>',
    file: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3 1.5h5l3 3V12a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/><path d="M8 1.5v3h3"/></svg>',
    copy: '<svg class="ic-copy" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.4"/><path d="M10 4V2.5a.5.5 0 0 0-.5-.5H2.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H4"/></svg>',
    check: '<svg class="ic-check" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7.5 6 10.5 11.5 4.5"/></svg>',
    cross: '<svg class="ic-fail" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>',
    pencil: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5l2 2L5 11l-2.5.5L3 9z"/></svg>',
    share: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8.5l3-3"/><path d="M6.5 4l1.5-1.5a2.12 2.12 0 0 1 3 3L9.5 7"/><path d="M7.5 10l-1.5 1.5a2.12 2.12 0 0 1-3-3L4.5 7"/></svg>',
    agent: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l3 3-3 3"/><path d="M7.5 10.5H11"/></svg>',
    person: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="4.5" r="2.3"/><path d="M2.8 12c0-2.3 1.9-3.8 4.2-3.8s4.2 1.5 4.2 3.8"/></svg>',
  };

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    rooms: [],
    activeRoom: "",
    activePath: "",
    opened: new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")),
    roomsOpened: new Set(JSON.parse(localStorage.getItem(ROOM_OPEN_KEY) || "[]")),
    ...JSON.parse(localStorage.getItem(STATE_KEY) || "{}"),
  };
  state.opened = state.opened instanceof Set ? state.opened : new Set(state.opened || []);
  state.roomsOpened = state.roomsOpened instanceof Set ? state.roomsOpened : new Set(state.roomsOpened || []);

  // Capability mode: /s/<slug> edit links serve this SAME SPA with a grant
  // injected by the worker (window.BASHROOM_SHARE = {slug, room, path, role}).
  // One document, no sidebar, slug-authorized API calls — the app surface IS
  // the share surface, so there is no second editor to maintain.
  const share = (window.BASHROOM_SHARE && window.BASHROOM_SHARE.slug) ? window.BASHROOM_SHARE : null;
  if (share) {
    state.activeRoom = String(share.room || "");
    state.activePath = String(share.path || "");
    document.documentElement.classList.add("share-mode");
  }

  // trees holds lightweight R2 metadata for expanded rooms; files holds only
  // bodies the user actually opened (in-memory only — bodies are too big and
  // too mutable for localStorage). Both are stale-while-revalidate: cached
  // data paints instantly, a background fetch refreshes it.
  const trees = new Map(); // room -> file metadata[] | { __error }
  const files = new Map(); // room + NUL + path -> file | { __error }
  const treeInflight = new Set(); // room -> in-flight tree fetch dedup
  const fileInflight = new Set(); // room + NUL + path -> in-flight file fetch dedup
  // First /web/api/rooms round-trip on an empty cache: the sidebar shows
  // "Loading rooms…" instead of the (wrong) "No rooms." empty state — and
  // the shell paints at all instead of a blank page until the fetch lands.
  let roomsLoading = false;

  // ── Aggressive directory caching (stale-while-revalidate) ──
  // Directory listings change rarely, so the rooms list and every fetched
  // tree persist to localStorage. Boot and room-expand paint from cache with
  // zero network wait — "Loading…" only appears for a room this device has
  // never seen — while a background fetch revalidates; the anchored
  // sections-only repaint makes the refresh invisible.
  const TREES_KEY = "bashroom.trees-cache";
  const ROOMS_KEY = "bashroom.rooms-cache";
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // drop caches abandoned for a week

  function readCache(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      if (!raw || typeof raw !== "object" || (Date.now() - (raw.at || 0)) > CACHE_TTL_MS) return null;
      return raw;
    } catch (_) { return null; }
  }
  function persistTreeCache() {
    try {
      const rooms = {};
      for (const [room, tree] of trees) if (Array.isArray(tree)) rooms[room] = tree;
      localStorage.setItem(TREES_KEY, JSON.stringify({ at: Date.now(), rooms }));
    } catch (_) {} // quota/corruption — the cache is best-effort
  }
  function persistRoomsCache() {
    try { localStorage.setItem(ROOMS_KEY, JSON.stringify({ at: Date.now(), rooms: state.rooms, handle: state.handle })); }
    catch (_) {}
  }
  function hydrateFromCache() {
    const roomsCache = readCache(ROOMS_KEY);
    if (roomsCache && Array.isArray(roomsCache.rooms)) {
      state.rooms = roomsCache.rooms;
      state.handle = roomsCache.handle || "";
    }
    const treeCache = readCache(TREES_KEY);
    if (treeCache && treeCache.rooms && typeof treeCache.rooms === "object") {
      for (const [room, filesMeta] of Object.entries(treeCache.rooms)) {
        if (Array.isArray(filesMeta)) trees.set(room, filesMeta);
      }
    }
  }

  function persist() {
    if (share) return; // a capability visit must not hijack the app's boot state
    localStorage.setItem(STATE_KEY, JSON.stringify({ activeRoom: state.activeRoom, activePath: state.activePath }));
    localStorage.setItem(OPEN_KEY, JSON.stringify([...state.opened]));
    localStorage.setItem(ROOM_OPEN_KEY, JSON.stringify([...state.roomsOpened]));
  }

  // Accept either a raw token or a pasted snippet (e.g. a line from
  // cat ~/.bashroom/config.json like '"token": "br_user_..."'). Pull
  // the first br_user_ token out and ignore surrounding quotes/commas.
  function extractToken(raw) {
    if (!raw) return "";
    const match = String(raw).match(/br_user_[A-Za-z0-9_-]+/);
    return match ? match[0] : raw.trim();
  }

  async function api(path) {
    const res = await fetch(path, { headers: { authorization: "Bearer " + state.token } });
    if (res.status === 401) {
      state.token = "";
      state.loginError = "Token rejected by server. Run 'bashroom login' to mint a fresh one, then paste it again.";
      localStorage.removeItem(TOKEN_KEY);
      // The presence socket was authorized at upgrade and never re-checked —
      // tear it down with the token, or it survives the login screen and the
      // NEXT account's session could adopt the old account's room hub.
      disconnectPresence();
      render();
      throw new Error("unauthorized");
    }
    return res.json();
  }

  async function loadRooms() {
    // One request returns the rooms list + active room's metadata tree (if any).
    const params = state.activeRoom ? "?active=" + encodeURIComponent(state.activeRoom) : "";
    const data = await api("/web/api/rooms" + params);
    state.rooms = data.rooms || [];
    state.handle = data.handle || "";
    // If the URL named a room the user isn't a member of, drop the stale
    // selection so we fall back to the first room rather than a dead view.
    if (state.activeRoom && !state.rooms.some(r => r.room === state.activeRoom)) {
      state.activeRoom = ""; state.activePath = "";
    }
    // Prune rooms that no longer exist (deleted/renamed) from the remembered-
    // open sets — otherwise every boot fires a doomed tree fetch per ghost
    // room and the localStorage entries never die.
    const knownRooms = new Set(state.rooms.map(r => r.room));
    for (const room of [...state.roomsOpened]) if (!knownRooms.has(room)) state.roomsOpened.delete(room);
    for (const key of [...state.opened]) {
      const colon = key.indexOf(":");
      if (colon === -1 || !knownRooms.has(key.slice(0, colon))) state.opened.delete(key);
    }
    for (const room of [...trees.keys()]) if (!knownRooms.has(room)) trees.delete(room);
    persistRoomsCache();
    if (!state.activeRoom && state.rooms.length) state.activeRoom = state.rooms[0].room;
    if (state.activeRoom) state.roomsOpened.add(state.activeRoom);

    // Eager metadata tree bundled with /rooms response.
    if (data.active && Array.isArray(data.tree)) {
      const treeFiles = data.tree.slice().sort((a, b) => a.path.localeCompare(b.path));
      trees.set(data.active, treeFiles);
      persistTreeCache();
      if (!state.activePath) {
        const preferred = treeFiles.find(f => f.path === "index.md") || treeFiles.find(f => f.path === "README.md") || treeFiles[0];
        if (preferred) state.activePath = preferred.path;
      }
    }

    persist();
    // Reflect the settled selection in the address bar without adding a history
    // entry — covers bare /web (auto-picked room) and stale-room fallback.
    syncUrl(true);
    ensureActiveFile();
    connectPresence(state.activeRoom);
    roomsLoading = false;
    render(); // paint everything we have so far

    // Revalidate every other expanded room (cached trees paint immediately;
    // the fetch refreshes them silently). The active room came bundled fresh.
    for (const room of state.roomsOpened) {
      if (room !== state.activeRoom && !treeInflight.has(room)) void fetchTree(room);
    }
  }

  async function fetchTree(room) {
    if (treeInflight.has(room)) return;
    treeInflight.add(room);
    const hadTree = Array.isArray(trees.get(room));
    let pickedDefault = false;
    try {
      const data = await api("/web/api/tree?room=" + encodeURIComponent(room));
      if (!data || data.ok === false) throw new Error(data?.error || "tree_failed");
      const treeFiles = (data.files || []).sort((a, b) => a.path.localeCompare(b.path));
      trees.set(room, treeFiles);
      persistTreeCache();
      if (room === state.activeRoom && !state.activePath) {
        const preferred = treeFiles.find(f => f.path === "index.md") || treeFiles.find(f => f.path === "README.md") || treeFiles[0];
        if (preferred) { state.activePath = preferred.path; pickedDefault = true; }
      }
      if (room === state.activeRoom) ensureActiveFile();
    } catch (e) {
      // A failed REVALIDATION keeps serving the cached tree — stale beats an
      // error row. Only surface the error when there's nothing to show.
      if (!Array.isArray(trees.get(room))) trees.set(room, { __error: String(e?.message || e) });
    } finally {
      treeInflight.delete(room);
      persist();
      // Tree data only affects the sidebar unless THIS fetch changed what the
      // main pane shows: the active room's first tree (Loading → content) or
      // a default file it picked. Pure revalidations (sizes/dates/new files —
      // including the one presence schedules after every collaborator write)
      // must not full-render: that tears down and remounts the open editor.
      if (room === state.activeRoom && (!hadTree || pickedDefault)) render();
      else renderSidebar();
    }
  }

  async function fetchFile(room, path) {
    const key = fileKey(room, path);
    if (fileInflight.has(key)) return;
    fileInflight.add(key);
    let unchanged = false;
    try {
      const data = await api("/web/api/file?room=" + encodeURIComponent(room) + "&path=" + encodeURIComponent(path) + (share ? "&slug=" + encodeURIComponent(share.slug) : ""));
      if (!data || data.ok === false || !data.file) throw new Error(data?.error || "file_failed");
      // SWR no-op detection: same etag as the copy already painted means the
      // revalidation changed nothing visible.
      const prev = files.get(key);
      unchanged = Boolean(prev && !isErrorRecord(prev) && prev.etag === data.file.etag);
      files.set(key, data.file);
    } catch (e) {
      files.set(key, { __error: String(e?.message || e) });
    } finally {
      fileInflight.delete(key);
      // Off-screen fetch: only caches + sidebar metadata changed — a full
      // render() would tear down the live editor for nothing.
      if (key !== fileKey(state.activeRoom, state.activePath)) { renderSidebar(); return; }
      // Byte-identical revalidation of the doc the inline editor already
      // holds: skip the repaint — render() would destroy + remount CodeMirror
      // a few hundred ms after first paint, dropping focus and caret.
      if (unchanged && inlineKey === key) return;
      render();
    }
  }

  function fileKey(room, path) {
    return room + "\\0" + path;
  }

  // Edit-mode state lives outside the persisted state object on purpose:
  // it's transient (never saved to localStorage) and a draft must survive
  // the full innerHTML re-renders that background fetches trigger.
  let editing = false;
  // Modeless editor remains the default; Preview is an explicit rendered
  // surface for Mermaid and other rich blocks. Keyed by file so navigating
  // never carries preview mode into a different document.
  let previewKey = "";
  let editDraft = "";
  let editError = "";
  let editFocusPending = false;
  // Etag of the version the edit started from. Sent as base_etag on save so
  // the server's conditional put rejects the write (412) if another agent or
  // session saved in between — lost updates become explicit conflicts.
  let editBaseEtag = "";

  // Atomic Editor — CodeMirror 6 live-preview (type on the rendered view;
  // syntax markers hide except on the active line). Lazy-loaded (CDN ESM) on
  // first edit so non-editing visits never pay for it. The CM6 buffer IS the
  // markdown — no parse/serialize round-trip — so content can never drift; on
  // every change we mirror the buffer into editDraft, which is what saveFile()
  // ships. If the import fails, we fall back to the plain textarea.
  //
  // Atomic is a React component; React is pinned via ?deps so the component
  // and our createRoot share one React instance (mismatched copies = broken
  // hooks). That's the only React in the app, confined to the edit pane.
  let cmMod = null;          // resolved { React, createRoot, AtomicCodeMirrorEditor, EditorView, highlightExt }
  let cmRoot = null;         // live React root, if mounted
  let cmLoadFailed = false;
  let cmMounting = false;    // an async mount is in flight (prevents double-mount)
  const cmHandle = { current: null }; // Atomic's imperative handle (focus, getMarkdown)
  // Reading position to restore once the ASYNC editor mount settles — the
  // rAF restore at render time lands before the editor has real height, so
  // mountCm re-applies it after its commit. -1 = nothing pending; cleared on
  // navigation so a stale position can't leak into a different document.
  let pendingScrollY = -1;

  // The editor stylesheet is a non-blocking preload (see <head>); the editor
  // must never mount unstyled, so mounting awaits the preload→stylesheet
  // swap. Error resolves too — a dead CDN already fails the JS import — and
  // a timeout keeps a slow CSS fetch from wedging the editor forever.
  function atomicCssReady() {
    return new Promise((resolve) => {
      const link = document.getElementById("atomic-css");
      if (!link || (link.rel === "stylesheet" && link.sheet)) return resolve();
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }

  async function loadCm() {
    if (cmMod) return cmMod;
    // @codemirror/view is pinned: esm.sh resolves ^6.0.0 to the newest
    // publish, and a broken CDN build of that one sub-dep (500) silently
    // killed the entire editor in prod (2026-07: 6.43.5 was the culprit).
    // The ?deps pin propagates through the whole CodeMirror graph.
    const [react, reactDomClient, atomic, codemirrorView, language, lezerHighlight] = await Promise.all([
      import("https://esm.sh/react@18.3.1"),
      import("https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1"),
      import("https://esm.sh/@atomic-editor/editor@0.4.3?deps=react@18.3.1,react-dom@18.3.1,@codemirror/view@6.39.1"),
      import("https://esm.sh/@codemirror/view@6.39.1"),
      import("https://esm.sh/@codemirror/language@6?deps=@codemirror/view@6.39.1"),
      import("https://esm.sh/@lezer/highlight@1"),
    ]);
    await atomicCssReady();
    cmMod = {
      React: react.default || react,
      createRoot: reactDomClient.createRoot,
      AtomicCodeMirrorEditor: atomic.AtomicCodeMirrorEditor,
      EditorView: codemirrorView.EditorView,
      // classHighlighter tags revealed syntax with stable tok-* classes —
      // Atomic's own markers only exist inside table cells, so the CSS that
      // shrinks/hangs "## " and "> " targets .tok-processingInstruction.
      // Built ONCE: the array's identity must be stable across cmRoot
      // re-renders or the extensions prop would churn the editor config.
      highlightExt: [language.syntaxHighlighting(lezerHighlight.classHighlighter)],
    };
    return cmMod;
  }

  // The editor element, built from CURRENT draft state. Shared by mountCm
  // (initial mount) and the presence path (re-render of the live root).
  // documentId keys the editor's identity — switching files, or adopting
  // fresh remote content via cmDocSalt, swaps the editor subtree in ONE
  // React commit: no empty-DOM gap, no scroll collapse, no app-wide render.
  let cmDocSalt = "";
  function cmElement() {
    const { React, AtomicCodeMirrorEditor } = cmMod;
    const docId = fileKey(state.activeRoom, state.activePath) + (cmDocSalt ? "@" + cmDocSalt : "");
    return React.createElement(AtomicCodeMirrorEditor, {
      // The React "key" prop GUARANTEES a remount when identity changes (a
      // prop change alone doesn't make Atomic reload its buffer). The swap
      // commits atomically — old editor stays until the new one is ready.
      key: docId,
      documentId: docId,
      markdownSource: editDraft,
      // Atomic spreads consumer extensions last, so they compose on top.
      extensions: cmMod.highlightExt,
      onMarkdownChange: (markdown) => {
        editDraft = markdown;
        if (inlineKey) { scheduleAutosave(); streamDraft(); }
      },
      editorHandleRef: cmHandle,
      // Internal room links open via the SPA router; external in a new tab.
      onLinkClick: (url) => {
        if (isInternalLink(url)) followInternalLink(url);
        else window.open(url, "_blank", "noopener,noreferrer");
      },
    });
  }

  // Tear down any live editor. Called on cancel/save and before re-mounting.
  function destroyCm() {
    if (cmRoot) {
      try { cmRoot.unmount(); } catch (_) {}
      cmRoot = null;
    }
    cmHandle.current = null;
  }

  // Mount Atomic into #cm-mount with the current draft. On any change, mirror
  // the buffer into editDraft. Hides the textarea on success; on failure
  // leaves the textarea as the editor.
  async function mountCm() {
    if (cmMounting) return;
    const mount = document.getElementById("cm-mount");
    if (!mount) return;
    if (cmLoadFailed) { mount.style.display = "none"; return; }
    cmMounting = true;
    try {
      const { createRoot } = await loadCm();
      // Race guard: a re-render replaced the mount node, or the user switched
      // files while the CDN import ran. Re-read the live nodes.
      const liveMount = document.getElementById("cm-mount");
      if ((!editing && !inlineKey) || !liveMount) return;
      const root = createRoot(liveMount);
      root.render(cmElement());
      cmRoot = root;
      const liveTa = document.getElementById("editor");
      if (liveTa) liveTa.classList.add("cm-active");  // hide the fallback textarea
      if (pendingScrollY >= 0) {
        const y = pendingScrollY;
        pendingScrollY = -1;
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
      if (editFocusPending) {
        editFocusPending = false;
        // The imperative handle attaches after React's first commit.
        setTimeout(() => { if (cmHandle.current) cmHandle.current.focus(); }, 50);
      }
    } catch (e) {
      // CDN/parse failure → fall back: explicit-edit textarea flow (and the
      // rendered article view) take over on the next render.
      cmLoadFailed = true;
      inlineKey = "";
      const m = document.getElementById("cm-mount");
      const t = document.getElementById("editor");
      if (m) m.style.display = "none";
      if (t) { t.classList.remove("cm-active"); if (editFocusPending) { editFocusPending = false; t.focus(); } }
      render(); // repaint into fallback mode
    } finally {
      cmMounting = false;
    }
  }

  // ─── Modeless autosave ───
  // In inline mode the editor is the document: edits autosave after a quiet
  // beat (or on ⌘S / file-switch / tab-close). lastSaved tracks the content
  // the server has; editDraft !== lastSaved means dirty. Every save carries
  // base_etag, so a concurrent save by another session surfaces as a 412
  // conflict bar instead of a silent clobber.
  let inlineKey = "";        // fileKey the inline editor is currently bound to
  let lastSaved = "";
  let saveTimer = 0;
  let saveState = "";        // "" | "dirty" | "saving" | "saved" | "conflict" | "error"
  let conflictTheirs = null; // server's file from a 412, awaiting user choice

  function setSaveState(s) {
    saveState = s;
    const el = document.getElementById("save-state");
    if (el) {
      el.textContent =
        s === "dirty" ? "edited…"
        : s === "saving" ? "saving…"
        : s === "saved" ? "saved"
        : s === "conflict" ? "conflict"
        : s === "error" ? "save failed — ⌘S to retry"
        : "";
    }
  }

  function scheduleAutosave() {
    if (editDraft === lastSaved || saveState === "conflict") return;
    setSaveState("dirty");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void autosave(); }, 1500);
  }

  function flushAutosave() {
    clearTimeout(saveTimer);
    if (inlineKey && editDraft !== lastSaved && saveState !== "conflict") void autosave();
  }

  async function autosave() {
    if (!inlineKey || editDraft === lastSaved || saveState === "conflict") return;
    // Snapshot everything — the user may keep typing or switch files while
    // the request is in flight.
    const room = state.activeRoom, path = state.activePath, content = editDraft, base = editBaseEtag;
    setSaveState("saving");
    try {
      const res = await fetch("/web/api/file", {
        method: "PUT",
        headers: { authorization: "Bearer " + state.token, "content-type": "application/json" },
        body: JSON.stringify({ room, path, content, base_etag: base || undefined, slug: share ? share.slug : undefined }),
      });
      const data = await res.json();
      if (res.status === 412 && data && data.file) {
        conflictTheirs = data.file;
        setSaveState("conflict");
        render(); // shows the conflict bar; draft is preserved
        return;
      }
      if (!data || data.ok === false || !data.file) throw new Error((data && data.error) || "save failed");
      files.set(fileKey(room, path), data.file);
      editBaseEtag = data.file.etag || "";
      lastSaved = content;
      // Typed more while saving? Stay dirty and go again.
      if (editDraft !== content) { setSaveState("dirty"); scheduleAutosave(); }
      else setSaveState("saved");
    } catch (e) {
      setSaveState("error");
    }
  }

  function startEdit(file) {
    editing = true;
    editDraft = file.content;
    editBaseEtag = file.etag || "";
    editError = "";
    editFocusPending = true;
    render();
  }

  function cancelEdit() {
    editing = false;
    editError = "";
    void destroyCm();
    render();
  }

  async function saveFile() {
    const room = state.activeRoom, path = state.activePath;
    try {
      const res = await fetch("/web/api/file", {
        method: "PUT",
        headers: { authorization: "Bearer " + state.token, "content-type": "application/json" },
        body: JSON.stringify({ room, path, content: editDraft, base_etag: editBaseEtag || undefined, slug: share ? share.slug : undefined }),
      });
      const data = await res.json();
      if (res.status === 412 && data && data.file) {
        // Someone saved since we started editing. Keep the draft, rebase the
        // etag onto the server's current version, and tell the user — a
        // second Save is an informed overwrite, Cancel shows their version.
        files.set(fileKey(room, path), data.file);
        editBaseEtag = data.file.etag || "";
        editError = "Changed underneath you — another session saved this file first. Save again to overwrite their version, or Cancel to review it.";
        render();
        return;
      }
      if (!data || data.ok === false || !data.file) throw new Error((data && data.error) || "save failed");
      files.set(fileKey(room, path), data.file);
      editing = false;
      editError = "";
      destroyCm();
      // Refresh sidebar metadata (size/updated) for the saved file.
      void fetchTree(room);
    } catch (e) {
      editError = "Couldn't save: " + String((e && e.message) || e);
    }
    render();
  }

  // Mint (or fetch the existing) public link for a page or directory and
  // put it on the clipboard. Server enforces that only room admins can
  // share, so a plain member's click comes back as "failed".
  async function shareTarget(room, path, el, role = "view") {
    try {
      const res = await fetch("/web/api/share", {
        method: "POST",
        headers: { authorization: "Bearer " + state.token, "content-type": "application/json" },
        body: JSON.stringify({ room, path: path || "", role }),
      });
      const data = await res.json();
      if (!data || data.ok === false || !data.url) throw new Error((data && data.error) || "share failed");
      const ok = await copyText(data.url);
      // Short fixed-width labels — "link copied" was wider than "Share" and
      // shifted the whole control row on every flash (layout-shift law).
      flashShare(el, ok ? "copied" : "failed");
    } catch (_) {
      flashShare(el, "failed");
    }
  }

  function flashShare(el, text) {
    if (!el) return;
    const lbl = el.querySelector(".share-lbl");
    if (lbl) {
      const orig = lbl.textContent;
      lbl.textContent = text;
      setTimeout(() => { lbl.textContent = orig; }, 1400);
    }
    el.classList.remove("copied", "failed");
    el.classList.add(text === "failed" ? "failed" : "copied");
    setTimeout(() => el.classList.remove("copied", "failed"), 1400);
  }

  function isErrorRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) && "__error" in value;
  }

  // Rewrite + intercept links inside a rendered Markdown article. marked
  // turns [notes/x.md](notes/x.md) into a relative <a> the browser would
  // resolve to a dead route; internal links get the canonical deep link +
  // SPA navigation, external links open in a new tab. Shared by render()
  // and the presence in-place article patch.
  function wireArticleLinks(article) {
    if (!article) return;
    article.querySelectorAll("a[href]").forEach(a => {
      const raw = a.getAttribute("href") || "";
      if (isInternalLink(raw)) {
        const clean = raw.split("#")[0].split("?")[0];
        const resolved = resolveRelativePath(state.activePath, clean);
        if (resolved !== null) {
          // Canonical URL so the status bar / copy-link / new-tab are correct.
          const room = encodeURIComponent(state.activeRoom);
          const enc = resolved.replace(/\\/+$/, "").split("/").map(encodeURIComponent).join("/");
          a.setAttribute("href", "/" + room + (enc ? "/" + enc : "") + (resolved.endsWith("/") ? "/" : ""));
        }
        a.onclick = (e) => {
          // Honor modifier-clicks (new tab / new window) and middle-click —
          // let the browser do a real navigation in those cases.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          followInternalLink(raw);
        };
      } else {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noreferrer");
      }
    });
  }

  // Rich Markdown is an allowlist layered AFTER sanitization. Fenced
  // Mermaid blocks become strict-mode SVG; ASCII-like blocks keep exact
  // spacing. Unknown languages stay ordinary code instead of executing.
  let mermaidPromise = null;
  async function enhanceRichDocument(article) {
    if (!article) return;
    const mermaidNodes = [];
    article.querySelectorAll("pre > code").forEach(code => {
      let language = "";
      code.classList.forEach(name => { if (name.startsWith("language-")) language = name.slice(9).toLowerCase(); });
      const pre = code.parentElement;
      if (!pre) return;
      if (language === "mermaid") {
        pre.className = "diagram-mermaid";
        pre.textContent = code.textContent || "";
        mermaidNodes.push(pre);
      } else if (["ascii", "text", "plaintext", "diagram", "art"].includes(language)) {
        pre.classList.add("ascii-diagram");
      }
    });
    if (!mermaidNodes.length) return;
    try {
      if (!mermaidPromise) {
        mermaidPromise = import("https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs").then(mod => {
          const mermaid = mod.default;
          const explicit = document.documentElement.getAttribute("data-theme");
          const dark = explicit === "dark" || (explicit !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
          return mermaid;
        });
      }
      const mermaid = await mermaidPromise;
      await mermaid.run({ nodes: mermaidNodes, suppressErrors: true });
    } catch (_) {
      mermaidNodes.forEach(node => node.classList.add("ascii-diagram"));
    }
  }

  function renderMarkdownInto(article, source) {
    if (!article) return false;
    try {
      article.innerHTML = DOMPurify.sanitize(marked.parse(source || ""));
      wireArticleLinks(article);
      void enhanceRichDocument(article);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Convert a CodeMirror Markdown-source offset into an approximate visible
  // text offset. Parsing the full document with a private-use sentinel keeps
  // surrounding Markdown context (lists/emphasis/headings) intact. The
  // prefix parse is only a fallback for positions hidden inside link URLs or
  // other non-visible syntax.
  function renderedCaretOffset(source, rawCaret) {
    const content = String(source || "");
    const caret = Math.max(0, Math.min(Number(rawCaret) || 0, content.length));
    let marker = String.fromCharCode(0xe000, 0xe001, 0xe002);
    while (content.includes(marker)) marker += String.fromCharCode(0xe003);
    const probe = document.createElement("div");
    try {
      const markedSource = content.slice(0, caret) + marker + content.slice(caret);
      probe.innerHTML = DOMPurify.sanitize(marked.parse(markedSource));
      const visible = probe.textContent || "";
      const found = visible.indexOf(marker);
      if (found !== -1) return found;
      probe.innerHTML = DOMPurify.sanitize(marked.parse(content.slice(0, caret)));
      return (probe.textContent || "").length;
    } catch (_) {
      return 0;
    }
  }

  function placeRemoteCaret(article, source, caret, actor, color) {
    if (!article) return null;
    article.querySelectorAll(".remote-caret").forEach(node => node.remove());
    let remaining = renderedCaretOffset(source, caret);
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let node = null, target = null, localOffset = 0, last = null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest("svg,.remote-caret,script,style")) continue;
      last = node;
      if (remaining <= node.data.length) { target = node; localOffset = remaining; break; }
      remaining -= node.data.length;
    }
    if (!target && last) { target = last; localOffset = last.data.length; }

    const cursor = document.createElement("span");
    cursor.className = "remote-caret";
    cursor.style.setProperty("--remote-color", color);
    cursor.setAttribute("role", "img");
    cursor.setAttribute("aria-label", String(actor || "Someone") + " cursor");
    const label = document.createElement("span");
    label.className = "remote-caret-label";
    label.textContent = String(actor || "Someone");
    cursor.appendChild(label);
    if (target) {
      const range = document.createRange();
      range.setStart(target, Math.max(0, Math.min(localOffset, target.data.length)));
      range.collapse(true);
      range.insertNode(cursor);
    } else {
      article.appendChild(cursor);
    }
    cursor.scrollIntoView({ block: "nearest", inline: "nearest" });
    return cursor;
  }

  function ensureActiveFile() {
    if (!state.activeRoom || !state.activePath) return;
    const key = fileKey(state.activeRoom, state.activePath);
    // SWR: a cached body paints immediately, but every navigation still
    // revalidates — the inline editor adopts the fresh copy only when the
    // local draft is clean, so typing is never interrupted.
    if (!fileInflight.has(key)) void fetchFile(state.activeRoom, state.activePath);
  }

  function selectFile(room, path) {
    // A CDN hiccup during one mount must not downgrade the whole session to
    // the read-only fallback — give the live editor another try on every
    // navigation. (A dead CDN just fails fast into the fallback again.)
    if (cmLoadFailed) { cmLoadFailed = false; cmMod = null; }
    pendingScrollY = -1; // navigations start at the top — drop any pending restore
    // Leaving a dirty inline doc: push the pending save before rebinding.
    if (inlineKey && (room !== state.activeRoom || path !== state.activePath)) flushAutosave();
    if (editing && (room !== state.activeRoom || path !== state.activePath)) { editing = false; editError = ""; void destroyCm(); }
    state.activeRoom = room; state.activePath = path;
    revealActiveFile(); // expand room + ancestor folders so the row is visible
    persist();
    syncUrl(false); // push a history entry so back/forward walks file history
    // A tree may not be loaded yet (e.g. clicking a cross-room link or a
    // deep link into a not-yet-fetched room). Ensure it's fetched.
    if (room && !trees.has(room) && !treeInflight.has(room)) void fetchTree(room);
    if (room && path) ensureActiveFile();
    connectPresence(room);
    render();
  }
  function toggleDir(room, dir) {
    const key = room + ":" + dir;
    const opening = !state.opened.has(key);
    if (opening) state.opened.add(key); else state.opened.delete(key);
    persist();
    // In-place patch so the toggle animates. Fall back to a full render when
    // the row or tree data isn't in the DOM (error states, programmatic use).
    const aside = app.querySelector("aside");
    const row = aside && findAnchorRow(aside, ["dir", room, dir]);
    const li = row && row.closest("li");
    if (!li) { nextAnchorKey = ["dir", room, dir]; render(); return; }
    const chev = row.querySelector(".chev");
    if (opening) {
      const html = subtreeHtmlFor(room, dir);
      if (html === null) { nextAnchorKey = ["dir", room, dir]; render(); return; }
      li.querySelectorAll(":scope > ul").forEach(u => u.remove()); // interrupted-close leftovers
      if (chev) chev.classList.add("open");
      li.insertAdjacentHTML("beforeend", "<ul>" + html + "</ul>");
      wireSidebar(); // new rows need handlers; reassignment is idempotent
      animateOpen(li.querySelector(":scope > ul"));
    } else {
      if (chev) chev.classList.remove("open");
      const ul = li.querySelector(":scope > ul");
      if (ul) animateClose(ul, () => ul.remove());
    }
  }

  // Expand the tree so the active file is actually visible + highlighted.
  // A sidebar click can only reach files whose folder is already open, so its
  // ancestors are implicitly expanded. But a deep link / back-forward / cross-
  // folder content-link sets activePath directly, leaving parent folders
  // collapsed — the .active row never renders. This expands the active room and
  // every ancestor directory of activePath ("notes/x/y.md" → "notes", "notes/x").
  function revealActiveFile() {
    if (!state.activeRoom) return;
    state.roomsOpened.add(state.activeRoom);
    if (!state.activePath) return;
    const parts = state.activePath.split("/").slice(0, -1); // drop the filename
    let dir = "";
    for (const p of parts) {
      dir = dir ? dir + "/" + p : p;
      state.opened.add(state.activeRoom + ":" + dir);
    }
  }
  function toggleRoom(room) {
    const opening = !state.roomsOpened.has(room);
    const aside = app.querySelector("aside");
    const head = aside && findAnchorRow(aside, ["room", room]);
    const section = head && head.closest(".section");
    const chev = head && head.querySelector(".chev");
    if (!opening) {
      // Collapse keeps the cached tree — re-expand paints it instantly and
      // revalidates in the background (stale-while-revalidate).
      state.roomsOpened.delete(room);
      persist();
      if (!section) { nextAnchorKey = ["room", room]; render(); return; }
      if (chev) chev.classList.remove("open");
      const ul = section.querySelector(":scope > ul.tree");
      if (ul) animateClose(ul, () => ul.remove());
      return;
    }
    state.roomsOpened.add(room);
    // Always revalidate on expand (deduped). A cached tree paints instantly;
    // only a never-seen room shows Loading until the fetch resolves.
    if (!treeInflight.has(room)) void fetchTree(room);
    persist();
    if (!section) { nextAnchorKey = ["room", room]; render(); return; }
    if (chev) chev.classList.add("open");
    section.querySelectorAll(":scope > ul.tree").forEach(u => u.remove());
    section.insertAdjacentHTML("beforeend", '<ul class="tree">' + roomTreeInnerHtml(room) + '</ul>');
    wireSidebar();
    animateOpen(section.querySelector(":scope > ul.tree"));
  }
  // ── URL ⇆ state (deep links) ─────────────────────────────────────────────
  // The address bar is the source of truth for which room/file is open.
  // Canonical shape: /<room>/<path>, e.g. /bashroom/notes/handoff-template.md.
  // The Worker serves this same SPA for any non-reserved path (see index.ts
  // catch-all), then we hydrate state from location.pathname on boot.

  // Build the canonical URL path for the current selection. encodeURI (not
  // encodeURIComponent) so "/" segment separators survive but spaces/specials
  // in names are escaped.
  function urlForState() {
    if (!state.activeRoom) return "/web";
    const room = encodeURIComponent(state.activeRoom);
    if (!state.activePath) return "/" + room;
    const path = state.activePath.split("/").map(encodeURIComponent).join("/");
    return "/" + room + "/" + path;
  }

  // Parse location.pathname back into { room, path }. Returns null for the
  // bare /web entry point (no room selected) so boot falls back to defaults.
  function stateFromUrl() {
    const raw = decodeURIComponent(location.pathname).replace(/^\\/+/, "");
    if (!raw || raw === "web" || raw === "web/") return null;
    const slash = raw.indexOf("/");
    if (slash === -1) return { room: raw, path: "" };
    return { room: raw.slice(0, slash), path: raw.slice(slash + 1) };
  }

  // Push the current selection into the address bar. replace=true swaps the
  // current history entry instead of adding one — used on boot/auto-correct so
  // the back button doesn't trap the user on a URL we redirected them away from.
  function syncUrl(replace) {
    if (share) return; // capability URLs are /s/<slug> — never rewrite them
    const next = urlForState();
    if (next === location.pathname) return;
    if (replace) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }

  // A link is "internal" if it points at another file/folder in the same room
  // rather than off-site. Anything with a scheme (http:, mailto:), a
  // protocol-relative (//host) URL, or a bare "#anchor" is NOT internal.
  function isInternalLink(href) {
    if (!href) return false;
    if (href.startsWith("#")) return false;            // in-page anchor; leave to browser
    if (href.startsWith("//")) return false;           // protocol-relative → external
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false; // has a scheme (http:, mailto:, etc.)
    return true;
  }

  // Resolve a room-relative markdown href against the active file, then drive
  // the SPA via selectFile (which updates the URL). Directory targets (trailing
  // slash) just expand the folder in the tree since there's no file to render.
  function followInternalLink(href) {
    const clean = href.split("#")[0].split("?")[0]; // file cache is keyed by plain path
    if (!clean) return;
    const isDir = clean.endsWith("/");
    const resolved = resolveRelativePath(state.activePath, clean);
    if (resolved === null) return; // escaped the room root — ignore
    if (isDir) {
      if (!state.roomsOpened.has(state.activeRoom)) toggleRoom(state.activeRoom);
      const dir = resolved.replace(/\\/+$/, "");
      if (dir && !state.opened.has(state.activeRoom + ":" + dir)) toggleDir(state.activeRoom, dir);
      else render();
    } else {
      selectFile(state.activeRoom, resolved);
    }
  }

  // Resolve a relative link target against the directory of the current file,
  // mirroring how a filesystem / browser resolves relative paths.
  //
  //   resolveRelativePath("notes/x.md", "y.md")         → "notes/y.md"
  //   resolveRelativePath("notes/x.md", "../README.md") → "README.md"
  //   resolveRelativePath("index.md",  "notes/")        → "notes/"
  //   resolveRelativePath("index.md",  "log/2026.md")   → "log/2026.md"
  //
  // Return the cleaned room-relative path (string), preserving a trailing
  // slash for directory targets. Return null if the path escapes the room
  // root (e.g. too many "../"), so the caller can ignore it.
  //
  function resolveRelativePath(currentPath, target) {
    if (!target) return null;
    const trailingSlash = target.endsWith("/");
    // Leading "/" → room-absolute: resolve from the room root, not the
    // current file's directory. (Agents sometimes write /AGENTS.md.)
    let stack;
    if (target.startsWith("/")) {
      stack = [];
      target = target.replace(/^\\/+/, "");
    } else {
      // Start from the current file's *directory* (drop the filename).
      stack = (currentPath || "").split("/").slice(0, -1).filter(Boolean);
    }
    for (const seg of target.split("/")) {
      if (seg === "" || seg === ".") continue;       // "." / empty / "./" → no-op (current dir)
      if (seg === "..") {
        if (stack.length === 0) return null;          // climbed above the room root → ignore
        stack.pop();
        continue;
      }
      stack.push(seg);
    }
    const out = stack.join("/");
    return trailingSlash ? out + "/" : out;
  }

  function logout() {
    disconnectPresence();
    [TOKEN_KEY, STATE_KEY, OPEN_KEY, ROOM_OPEN_KEY, TREES_KEY, ROOMS_KEY].forEach(k => localStorage.removeItem(k));
    state.token = ""; state.rooms = []; state.handle = "";
    state.activeRoom = ""; state.activePath = "";
    state.opened = new Set(); state.roomsOpened = new Set();
    trees.clear(); files.clear(); treeInflight.clear(); fileInflight.clear();
    history.replaceState(null, "", "/web"); // drop the deep link on sign-out
    render();
  }

  // ── Cross-room search ──
  // A query of >= 2 chars swaps the sidebar's room sections for result rows
  // (grouped by room) until the query is cleared with Esc or the input's ✕.
  // The input lives OUTSIDE #sections, so background sidebar repaints never
  // steal focus mid-typing; full renders restore value + focus explicitly.
  let searchQuery = "";
  let searchResults = null;   // null = request in flight / not run; [] = no matches
  let searchError = "";
  let searchSeq = 0;          // stale-response guard
  let searchTimer = 0;

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Escape, then bold the first case-insensitive occurrence of the query.
  function highlightMatch(line, q) {
    const idx = line.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escHtml(line);
    return escHtml(line.slice(0, idx)) + "<b>" + escHtml(line.slice(idx, idx + q.length)) + "</b>" + escHtml(line.slice(idx + q.length));
  }

  function setSearchQuery(q) {
    searchQuery = q;
    clearTimeout(searchTimer);
    if (q.trim().length < 2) {
      searchResults = null; searchError = "";
      renderSidebar();
      return;
    }
    searchResults = null; searchError = "";
    // Filename matching reads the cached trees — warm any room we've never
    // opened so its filenames join the results as trees arrive (each arrival
    // repaints the results via renderSidebar).
    for (const r of state.rooms) {
      if (!trees.has(r.room) && !treeInflight.has(r.room)) void fetchTree(r.room);
    }
    searchTimer = setTimeout(() => { void runSearch(q.trim()); }, 250);
    renderSidebar(); // filename hits paint NOW; content results stream in after
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    try {
      const data = await api("/web/api/search?q=" + encodeURIComponent(q));
      if (seq !== searchSeq || searchQuery.trim() !== q) return; // stale response
      if (!data || data.ok === false) throw new Error((data && data.error) || "search failed");
      searchResults = data.results || [];
      searchError = "";
    } catch (e) {
      if (seq !== searchSeq) return;
      searchResults = [];
      searchError = String((e && e.message) || e);
    }
    renderSidebar();
  }

  // Filename hits — instant, straight from the cached trees. The Cursor
  // pattern: files paint in milliseconds, content matches stream in after.
  function searchFileMatches(q) {
    const needle = q.toLowerCase();
    const hits = [];
    for (const r of state.rooms) {
      const tree = trees.get(r.room);
      if (!Array.isArray(tree)) continue;
      for (const f of tree) {
        if (f.path.toLowerCase().indexOf(needle) !== -1) {
          hits.push({ room: r.room, path: f.path });
          if (hits.length >= 12) return hits;
        }
      }
    }
    return hits;
  }

  function searchResultsHtml() {
    const q = searchQuery.trim();
    let html = "";
    const fileHits = searchFileMatches(q);
    if (fileHits.length) {
      html += '<div class="search-room">files</div>';
      for (const h of fileHits) {
        html += '<div class="result" data-room="' + escHtml(h.room) + '" data-file="' + escHtml(h.path) + '">'
          + '<div class="result-path">' + highlightMatch(h.path, q) + '<span class="result-line"> · ' + escHtml(h.room) + '</span></div>'
          + '</div>';
      }
    }
    if (searchError) return html + '<div class="empty">Search failed: ' + escHtml(searchError) + '</div>';
    if (searchResults === null) return html + '<div class="empty">Searching content…</div>';
    if (!searchResults.length && !fileHits.length) return '<div class="empty">No matches for <code>' + escHtml(q) + '</code>.</div>';
    // Content hits, nested: room header → folder line (click reveals the
    // folder in the sidebar) → file rows with basename:line + preview.
    let lastRoom = "", lastDir = null;
    for (const r of searchResults) {
      if (r.room !== lastRoom) { html += '<div class="search-room">' + escHtml(r.room) + '</div>'; lastRoom = r.room; lastDir = null; }
      const slash = r.path.lastIndexOf("/");
      const dir = slash === -1 ? "" : r.path.slice(0, slash);
      const base = slash === -1 ? r.path : r.path.slice(slash + 1);
      if (dir !== lastDir) {
        lastDir = dir;
        if (dir) html += '<div class="result-folder" data-room="' + escHtml(r.room) + '" data-reveal-dir="' + escHtml(dir) + '">' + escHtml(dir) + '/</div>';
      }
      html += '<div class="result' + (dir ? " nested" : "") + '" data-room="' + escHtml(r.room) + '" data-file="' + escHtml(r.path) + '">'
        + '<div class="result-path">' + escHtml(base) + '<span class="result-line">:' + r.line + '</span></div>'
        + '<div class="result-preview">' + highlightMatch(r.preview, q) + '</div>'
        + '</div>';
    }
    return html;
  }

  // Clear the query + results without repainting (callers render).
  function clearSearchQuery() {
    searchQuery = "";
    searchResults = null;
    searchError = "";
    clearTimeout(searchTimer);
    const si = document.getElementById("room-search");
    if (si) si.value = "";
  }

  // ── Presence ──
  // One WebSocket to the ACTIVE room's hub. Auth rides the WS subprotocol
  // ("tok.<token>") because browser WebSockets can't set headers. The hub's
  // hello frame seeds recent activity so pills paint immediately; live
  // "write" events refresh the open document (the editor adopts fresh
  // content only when the local draft is clean — same CAS-backed logic as
  // always) and flash provenance in the writer's color.
  let presenceWs = null;
  let presenceRoom = "";
  let presenceSeq = 0;          // invalidates reconnect timers from stale rooms
  let presenceBackoff = 1000;
  let presencePing = 0;
  let presenceViewers = 0;
  let presenceRoster = [];      // live connections: [{ name, anon }] — animals for share-link viewers
  let presenceTreeTimer = 0;
  let presenceFileTimer = 0;
  let presenceFilePendingSince = 0;
  let provenanceTimer = 0;
  let toastTimer = 0;
  const presenceActors = new Map(); // actor -> { ts, path } (active room only)
  const seenActors = new Set();     // joined-toast fires once per actor per session

  function actorColor(actor) {
    const a = String(actor || "").toLowerCase();
    if (a === String(state.handle || "").toLowerCase() || a === "you") return "var(--actor-you)";
    if (a.indexOf("claude") !== -1) return "var(--actor-claude)";
    if (a.indexOf("codex") !== -1) return "var(--actor-codex)";
    return "var(--actor-guest)";
  }

  // Person or coding agent? Events carry source: "web" is a human at the
  // reader; mcp/shell are agents. History rows without a source fall back
  // to identity (your handle = human, anything else = agent).
  function actorGlyph(actor, source) {
    if (source === "web") return ICON.person;
    if (source === "mcp" || source === "shell") return ICON.agent;
    return actor === String(state.handle || "") ? ICON.person : ICON.agent;
  }

  function timeAgo(ts) {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  // Presence-driven refresh of the OPEN file. Deliberately NOT fetchFile():
  // that path ends in a full render(), which tears down and remounts the
  // whole editor — focus, cursor, and reading-scroll casualties on a trigger
  // the user doesn't control. This adopts in place instead: update the
  // caches, then either re-render the live editor root with a salted
  // documentId (one React commit, no empty-DOM gap) or patch the fallback
  // <article> body directly.
  async function presenceRefreshActiveFile() {
    const room = state.activeRoom, path = state.activePath;
    if (!room || !path) return;
    const key = fileKey(room, path);
    if (fileInflight.has(key)) return;
    fileInflight.add(key);
    try {
      const data = await api("/web/api/file?room=" + encodeURIComponent(room) + "&path=" + encodeURIComponent(path) + (share ? "&slug=" + encodeURIComponent(share.slug) : ""));
      if (!data || data.ok === false || !data.file) return;
      files.set(key, data.file);
      if (room !== state.activeRoom || path !== state.activePath) return; // navigated away — cache only
      if (inlineKey === key) {
        // Live editor bound to this file: adopt ONLY when the local draft is
        // clean; a dirty draft resolves through the CAS conflict flow instead.
        if (editDraft === lastSaved && data.file.content !== lastSaved && saveState !== "conflict") {
          editDraft = data.file.content;
          lastSaved = data.file.content;
          editBaseEtag = data.file.etag || "";
          cmDocSalt = data.file.etag || String(Date.now());
          if (previewKey === key) {
            renderMarkdownInto(app.querySelector("article"), data.file.content);
          } else if (cmRoot && cmMod) {
            // The salted key remounts the editor in one React commit — but a
            // remount still resets selection and initial height. Bracket the
            // adopt with position capture/restore so a collaborator's save
            // doesn't yank the reader's scroll or caret.
            const y = window.scrollY;
            const caret = currentDraftCaret();
            cmRoot.render(cmElement());
            requestAnimationFrame(() => {
              window.scrollTo(0, y);
              const dom = document.querySelector("#cm-mount .cm-editor");
              const view = dom && cmMod.EditorView.findFromDOM(dom);
              if (view) view.dispatch({ selection: { anchor: Math.min(caret, view.state.doc.length) } });
            });
          } else { destroyCm(); void mountCm(); }
        }
      } else {
        const article = app.querySelector("article");
        if (article && !data.file.is_binary) {
          renderMarkdownInto(article, data.file.content);
        }
      }
    } catch (_) { /* refresh is best-effort */ }
    finally { fileInflight.delete(key); }
  }

  // ── Live-edit streaming (out) ──
  // While the local draft changes, throttle-stream the buffer to the room
  // hub so collaborators can follow along. Saves still carry the truth —
  // frames are ephemeral and size-capped (big files just sync on save).
  let draftStreamTimer = 0;
  let draftStreamLast = 0;

  function currentDraftCaret() {
    const editorDom = document.querySelector("#cm-mount .cm-editor");
    if (editorDom && cmMod?.EditorView) {
      try {
        const view = cmMod.EditorView.findFromDOM(editorDom);
        if (view) return view.state.selection.main.head;
      } catch (_) { /* Atomic may be between React commits; use fallback. */ }
    }
    const textarea = document.getElementById("editor");
    return textarea && Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : 0;
  }

  function streamDraftFrame() {
    if (!presenceWs || presenceWs.readyState !== 1 || (!inlineKey && !editing)) return;
    if (editDraft.length > 262144) return;
    try {
      presenceWs.send(JSON.stringify({ type: "draft", path: state.activePath, caret: currentDraftCaret(), content: editDraft }));
    } catch (_) { /* socket mid-close */ }
  }

  function streamDraft() {
    const now = Date.now();
    if (now - draftStreamLast >= 300) {
      draftStreamLast = now;
      streamDraftFrame();
    } else {
      clearTimeout(draftStreamTimer);
      draftStreamTimer = setTimeout(() => { draftStreamLast = Date.now(); streamDraftFrame(); }, 300 - (now - draftStreamLast));
    }
  }

  // ── Live-edit following (in) ──
  // When a collaborator (human or agent stream) is typing the file we have
  // open and OUR draft is clean, the pane switches to a live rendered view
  // of their buffer — the document morphs as they type, with their source
  // caret mapped into the rendered Markdown and the first changed block
  // flagged in their color. When frames stop (~3s) we adopt the final saved
  // state and return to the editor. If WE are dirty too we never follow; a
  // one-time toast sets conflict expectations instead.
  let followActor = "";
  let followTimer = 0;
  let followPrevContent = "";
  let followWarned = "";

  function handleDraftFrame(msg) {
    if (msg.path !== state.activePath || presenceRoom !== state.activeRoom) return;
    presenceActors.set(msg.actor, { ts: Date.now(), path: msg.path, editing: true, source: "web" });
    renderPresence();
    if ((inlineKey || editing) && editDraft !== lastSaved) {
      if (followWarned !== msg.actor) {
        followWarned = msg.actor;
        showToast(msg.actor + " is editing this file too — expect a conflict check on save", actorColor(msg.actor));
      }
      return;
    }
    enterFollow(msg.actor, msg.content, msg.caret);
  }

  function enterFollow(actor, content, caret) {
    followActor = actor;
    clearTimeout(followTimer);
    followTimer = setTimeout(exitFollow, 3000);
    const mount = document.getElementById("cm-mount");
    let live = document.getElementById("live-view");
    if (!live) {
      if (!mount || !mount.parentNode) return;
      live = document.createElement("div");
      live.id = "live-view";
      live.className = "live-view";
      live.innerHTML = '<div class="live-flag"></div><article class="live-article"></article>';
      mount.parentNode.insertBefore(live, mount.nextSibling);
    }
    if (mount) mount.style.display = "none";
    const flag = live.querySelector(".live-flag");
    flag.textContent = actor + " · editing…";
    flag.style.borderColor = actorColor(actor);
    flag.style.color = actorColor(actor);
    const article = live.querySelector(".live-article");
    if (!renderMarkdownInto(article, content)) return;
    placeRemoteCaret(article, content, caret, actor, actorColor(actor));
    // Land the reader's eye on the first changed block since the last frame.
    // Block→element mapping remains approximate (lists collapse); the
    // source-offset caret above is the precise collaboration signal.
    const prevBlocks = followPrevContent.split(/\\n\\n+/);
    const nextBlocks = content.split(/\\n\\n+/);
    let changed = -1;
    for (let i = 0; i < nextBlocks.length; i++) {
      if (nextBlocks[i] !== prevBlocks[i]) { changed = i; break; }
    }
    followPrevContent = content;
    if (changed >= 0 && article.children.length) {
      const el = article.children[Math.min(changed, article.children.length - 1)];
      el.classList.add("live-edit");
      el.style.setProperty("--live-color", actorColor(actor));
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function exitFollow() {
    if (!followActor) return;
    const doneActor = followActor;
    followActor = "";
    followPrevContent = "";
    clearTimeout(followTimer);
    const live = document.getElementById("live-view");
    if (live) live.remove();
    const mount = document.getElementById("cm-mount");
    if (mount) mount.style.display = "";
    const entry = presenceActors.get(doneActor);
    if (entry) { entry.editing = false; presenceActors.set(doneActor, entry); }
    renderPresence();
    void presenceRefreshActiveFile(); // adopt their final saved state
  }

  function connectPresence(room) {
    if (!room || !state.token) { disconnectPresence(); return; }
    if (presenceRoom === room && presenceWs && presenceWs.readyState <= 1) return;
    disconnectPresence();
    presenceRoom = room;
    const seq = ++presenceSeq;
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    let ws;
    try {
      ws = new WebSocket(
        scheme + location.host + "/web/api/presence?" + (share
          ? "slug=" + encodeURIComponent(share.slug)
          : "room=" + encodeURIComponent(room)),
        ["bashroom.v1", "tok." + state.token],
      );
    } catch (_) { return; } // invalid subprotocol chars — presence stays off
    presenceWs = ws;
    ws.onopen = () => {
      if (seq !== presenceSeq) return;
      presenceBackoff = 1000;
      clearInterval(presencePing);
      // App-level keepalive; the hub answers via auto-response without waking.
      presencePing = setInterval(() => { try { ws.send("ping"); } catch (_) {} }, 45000);
    };
    ws.onmessage = (e) => {
      if (seq !== presenceSeq) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.type === "hello") {
        presenceActors.clear();
        for (const ev of (msg.recent || []).slice().reverse()) {
          presenceActors.set(ev.actor, { ts: ev.ts, path: ev.path, source: ev.source || "" });
          seenActors.add(ev.actor); // history never toasts
        }
        presenceViewers = msg.viewers || 0;
        presenceRoster = Array.isArray(msg.roster) ? msg.roster : [];
      } else if (msg.type === "write") {
        presenceActors.set(msg.actor, { ts: msg.ts, path: msg.path, source: msg.source || "" });
        // Self-echo dedupe by ETAG, not identity: if this tab already holds
        // the exact version the event announces, there's nothing to fetch.
        // Identity comparison was wrong twice over — it hid agent writes
        // whenever the room's registered actor equals the handle, and it hid
        // the same account's saves from other devices.
        const known = msg.path ? files.get(fileKey(presenceRoom, msg.path)) : null;
        const alreadyCurrent = !!(msg.etag && known && !isErrorRecord(known) && known.etag === msg.etag);
        if (!seenActors.has(msg.actor) && msg.actor !== String(state.handle || "")) {
          showToast(msg.actor + " joined " + presenceRoom, actorColor(msg.actor));
        }
        seenActors.add(msg.actor);
        if (!alreadyCurrent && msg.path && presenceRoom === state.activeRoom && msg.path === state.activePath) {
          // Debounce-with-max-wait: a burst (agent rewriting the open file
          // 20x) coalesces to one refetch when it pauses, but a steady
          // stream still refreshes at least every ~2s.
          const now = Date.now();
          if (!presenceFilePendingSince) presenceFilePendingSince = now;
          clearTimeout(presenceFileTimer);
          if (now - presenceFilePendingSince > 2000) {
            presenceFilePendingSince = 0;
            void presenceRefreshActiveFile();
          } else {
            presenceFileTimer = setTimeout(() => { presenceFilePendingSince = 0; void presenceRefreshActiveFile(); }, 350);
          }
          flashProvenance(msg.actor);
        }
        if (!alreadyCurrent) {
          // Metadata refresh (sizes/dates/new files), debounced across bursts.
          clearTimeout(presenceTreeTimer);
          const room = presenceRoom;
          presenceTreeTimer = setTimeout(() => { if (!treeInflight.has(room)) void fetchTree(room); }, 2000);
        }
      } else if (msg.type === "draft") {
        handleDraftFrame(msg);
        return; // handleDraftFrame paints its own presence updates
      } else if (msg.type === "viewers") {
        presenceViewers = msg.viewers || 0;
        presenceRoster = Array.isArray(msg.roster) ? msg.roster : presenceRoster;
      }
      renderPresence();
    };
    ws.onclose = () => {
      if (seq !== presenceSeq) return;
      clearInterval(presencePing);
      presenceWs = null;
      // Reconnect with capped backoff while this room is still the active one.
      setTimeout(() => {
        if (seq === presenceSeq && presenceRoom === state.activeRoom) {
          presenceRoom = "";
          connectPresence(state.activeRoom);
        }
      }, presenceBackoff);
      presenceBackoff = Math.min(presenceBackoff * 2, 30000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function disconnectPresence() {
    presenceSeq += 1;
    clearInterval(presencePing);
    clearTimeout(draftStreamTimer);
    clearTimeout(followTimer);
    followActor = "";
    followPrevContent = "";
    followWarned = "";
    if (presenceWs) { try { presenceWs.close(); } catch (_) {} }
    presenceWs = null;
    presenceRoom = "";
    presenceActors.clear();
    presenceViewers = 0;
    presenceRoster = [];
  }

  // Patch ONLY the presence row — never a full render for a presence tick.
  // Two kinds of presence share the lane: writers (recent activity, verb +
  // timestamp) and the live roster (who is connected RIGHT NOW — signed-in
  // handles plus the animals dealt to anonymous share-link viewers).
  function renderPresence() {
    const el = document.getElementById("presence-row");
    if (!el) return;
    const cutoff = Date.now() - 30 * 60 * 1000;
    const items = [...presenceActors.entries()]
      .filter((entry) => entry[1].ts >= cutoff)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, 3);
    let html = "";
    const shown = new Set();
    for (const entry of items) {
      const actor = entry[0];
      shown.add(actor);
      const live = Date.now() - entry[1].ts < 90 * 1000;
      // Blunt literal copy: "codex wrote 2m ago" — the bare timestamp made
      // the pill read as a mystery viewer instead of the last writer. The
      // tooltip spells out the whole story, including what the glyph means.
      const verb = entry[1].editing ? "editing…" : "wrote " + timeAgo(entry[1].ts);
      const via = entry[1].source === "shell" ? "the shell (an agent)" : entry[1].source === "mcp" ? "MCP (an agent)" : "the web editor";
      const story = entry[1].editing
        ? actor + " is editing this room right now"
        : actor + " last wrote " + timeAgo(entry[1].ts) + " via " + via;
      html += '<span class="p-pill" title="' + escHtml(story) + '">'
        + '<span class="p-dot' + (live ? " live" : "") + '" style="background:' + actorColor(actor) + '"></span>'
        + '<span class="p-kind">' + actorGlyph(actor, entry[1].source) + '</span>'
        + escHtml(actor) + " " + verb
        + "</span>";
    }
    // Roster: connections that aren't already shown as writers (and aren't
    // this tab), as a Notion-style avatar stack. Handles are GitHub logins,
    // so github.com/<handle>.png is their real profile photo; a broken load
    // removes the img and the actor-colored initial underneath shows through.
    // Animals never get an img — they have no profile by definition.
    const self = String(state.handle || "");
    const roster = presenceRoster.filter((v) => v && v.name && v.name !== self && !shown.has(v.name)).slice(0, 5);
    if (roster.length) {
      let stack = '<span class="p-stack">';
      let depth = 20; // earlier faces stack ON TOP (Notion order) — otherwise the next circle clips this one's initial
      for (const v of roster) {
        stack += '<span class="p-face' + (v.anon ? " p-anon" : "") + '" title="' + escHtml(v.name) + '" style="background:' + actorColor(v.name) + ';z-index:' + (depth -= 1) + '">'
          + escHtml(String(v.name).slice(0, 1).toUpperCase())
          + (v.anon ? "" : '<img src="https://github.com/' + encodeURIComponent(v.name) + '.png?size=44" alt="" loading="lazy" onerror="this.remove()" />')
          + "</span>";
      }
      stack += "</span>";
      html += stack;
    }
    if (presenceViewers > 1) html += '<span class="p-viewers">' + presenceViewers + " viewing</span>";
    // Identical markup must not touch the DOM — rewriting it restarts the
    // live-dot pulse mid-cycle and re-decodes roster avatars. The memo lives
    // ON the element (not module state) so a full render's fresh
    // #presence-row always paints.
    if (el._lastHtml === html) return;
    el._lastHtml = html;
    el.innerHTML = html;
  }

  function showToast(text, color) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      t.innerHTML = '<span class="t-dot"></span><span class="t-text"></span>';
      document.body.appendChild(t); // body-level: survives #app innerHTML wipes
    }
    t.querySelector(".t-dot").style.background = color || "var(--actor-guest)";
    t.querySelector(".t-text").textContent = text;
    t.classList.remove("show");
    void t.offsetWidth; // restart the rise transition
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
  }

  // "updated by codex" in the writer's color, in the save-state slot —
  // never fighting a real autosave state (dirty/saving/conflict own it).
  // Held as STATE (actor + deadline), not a one-shot DOM write: the refetch
  // this flash accompanies triggers a full render that rebuilds the slot,
  // so render() re-applies the flash until the deadline passes.
  let provenanceActor = "";
  let provenanceUntil = 0;

  function paintProvenance() {
    if (provenanceUntil <= Date.now()) return;
    if (saveState && saveState !== "saved") return;
    const el = document.getElementById("save-state");
    if (!el) return;
    el.textContent = "updated by " + provenanceActor;
    el.style.color = actorColor(provenanceActor);
  }

  function flashProvenance(actor) {
    provenanceActor = actor;
    provenanceUntil = Date.now() + 3000;
    paintProvenance();
    clearTimeout(provenanceTimer);
    provenanceTimer = setTimeout(() => {
      provenanceUntil = 0;
      const el = document.getElementById("save-state");
      if (el && el.textContent.indexOf("updated by ") === 0) { el.textContent = ""; el.style.color = ""; }
    }, 3000);
  }

  // Sundial-style zero-install join: the prompt travels through the AGENT.
  function agentPromptFor(room) {
    return "In bashroom (a durable shared filesystem for agents), read /rooms/" + room
      + "/index.md and continue the work described there. Write your session notes and handoffs into /rooms/"
      + room + "/. If the bashroom tools aren't connected yet, run: claude mcp add bashroom -- bashroom mcp"
      + " (or: codex mcp add bashroom -- bashroom mcp), then use the bashroom tool to run: cat /rooms/"
      + room + "/index.md";
  }

  // ── Tree open/close animation ──
  // Accordion/Collapse on the subtree plus the chevron's Rotate. Folder and
  // room toggles patch the DOM in place instead of re-rendering the app, so
  // the chevron's CSS transition actually plays, the subtree height-animates
  // over its real measured height (WAAPI), and sidebar scroll is untouched.
  // Kept fast and subtle (140-160ms ease-out) because toggles are
  // high-frequency; disabled under prefers-reduced-motion.
  const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  function animateOpen(ul) {
    if (!ul || reducedMotion.matches || !ul.animate) return;
    ul.style.overflow = "hidden";
    const anim = ul.animate(
      [{ height: "0px", opacity: 0.4 }, { height: ul.scrollHeight + "px", opacity: 1 }],
      { duration: 160, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
    );
    anim.onfinish = anim.oncancel = () => { ul.style.overflow = ""; };
  }
  function animateClose(ul, done) {
    if (!ul || reducedMotion.matches || !ul.animate) { if (ul) done(); return; }
    ul.style.overflow = "hidden";
    const anim = ul.animate(
      [{ height: ul.getBoundingClientRect().height + "px", opacity: 1 }, { height: "0px", opacity: 0.4 }],
      { duration: 140, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    );
    anim.onfinish = anim.oncancel = done;
  }

  // HTML for the children of one directory node — used by the in-place open.
  function subtreeHtmlFor(room, dirPath) {
    const tree = trees.get(room);
    if (!Array.isArray(tree)) return null;
    let nodes = buildTree(tree);
    for (const seg of dirPath.split("/")) {
      const hit = nodes.find(n => n.kind === "dir" && n.name === seg);
      if (!hit) return null;
      nodes = hit.kids;
    }
    return renderTree(room, nodes);
  }

  // ── Sidebar scroll anchoring ──
  // Rerenders rebuild the sidebar DOM wholesale, and restoring the raw
  // scrollTop is wrong the moment content changes size ABOVE the rows the
  // user is looking at — a deep-link boot fans out one tree fetch per
  // remembered-open room, and each arrival used to shove the active file a
  // few hundred px off-screen. Anchor semantics instead: pick a reference
  // row before the swap (the row the user just clicked, else the active
  // file's row, else the topmost visible row) and keep it at the same
  // viewport offset after the swap.
  let nextAnchorKey = null; // set by toggleDir/toggleRoom: pin the clicked row

  function rowAnchorKey(el) {
    if (el.dataset.roomToggle !== undefined) return ["room", el.dataset.roomToggle];
    if (el.dataset.dir !== undefined) return ["dir", el.dataset.room, el.dataset.dir];
    return ["file", el.dataset.room, el.dataset.file];
  }
  function findAnchorRow(aside, key) {
    const esc = (s) => CSS.escape(String(s == null ? "" : s));
    if (key[0] === "room") return aside.querySelector('[data-room-toggle="' + esc(key[1]) + '"]');
    const attr = key[0] === "dir" ? "data-dir" : "data-file";
    return aside.querySelector('.row[data-room="' + esc(key[1]) + '"][' + attr + '="' + esc(key[2]) + '"]');
  }
  function sidebarAnchor(aside) {
    if (!aside) { nextAnchorKey = null; return null; }
    const asideTop = aside.getBoundingClientRect().top;
    const offsetOf = (el) => el.getBoundingClientRect().top - asideTop;
    const isVisible = (el) => { const o = offsetOf(el); return o >= 0 && o < aside.clientHeight; };
    // 1. The row the user just clicked (folder/room toggle) must stay put.
    if (nextAnchorKey) {
      const el = findAnchorRow(aside, nextAnchorKey);
      nextAnchorKey = null;
      if (el && isVisible(el)) return { key: rowAnchorKey(el), offset: offsetOf(el) };
    }
    // 2. Else the active file's row, if it's on screen.
    const active = aside.querySelector(".row.active");
    if (active && isVisible(active)) return { key: rowAnchorKey(active), offset: offsetOf(active) };
    // 3. Else the topmost visible row.
    for (const el of aside.querySelectorAll("[data-room-toggle], .row[data-dir], .row[data-file]")) {
      if (isVisible(el)) return { key: rowAnchorKey(el), offset: offsetOf(el) };
    }
    return null;
  }
  function applySidebarAnchor(aside, anchor, scrollTop) {
    aside.scrollTop = scrollTop;
    if (!anchor) return;
    const el = findAnchorRow(aside, anchor.key);
    if (!el) return; // anchor row gone (room collapsed) — raw restore is the best we have
    const drift = (el.getBoundingClientRect().top - aside.getBoundingClientRect().top) - anchor.offset;
    if (drift) aside.scrollTop += drift;
  }

  function buildTree(files) {
    const root = { children: new Map() };
    for (const f of files) {
      const parts = f.path.split("/");
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const isLeaf = i === parts.length - 1;
        const name = parts[i];
        const path = parts.slice(0, i + 1).join("/");
        if (!cur.children.has(name)) cur.children.set(name, { name, path, kind: isLeaf ? "file" : "dir", children: new Map() });
        cur = cur.children.get(name);
      }
    }
    const sort = (node) => {
      const list = [...node.children.values()];
      list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
      node.kids = list;
      list.forEach(sort);
    };
    sort(root);
    return root.kids;
  }

  function roomTreeInnerHtml(room) {
    const roomTree = trees.get(room);
    if (Array.isArray(roomTree)) return renderTree(room, buildTree(roomTree));
    if (isErrorRecord(roomTree)) return '<li class="empty">Couldn\\'t load. <span class="retry-link">Click room to retry.</span></li>';
    return '<li class="empty">Loading…</li>';
  }

  function sidebarSectionsHtml() {
    // An active search takes over the sections region until cleared.
    if (searchQuery.trim().length >= 2) return searchResultsHtml();
    return state.rooms.length
      ? state.rooms.map(r => {
          const open = state.roomsOpened.has(r.room);
          const treeHtml = open ? roomTreeInnerHtml(r.room) : "";
          return \`<div class="section">
            <div class="room-head" data-room-toggle="\${r.room}">
              <span class="chev \${open ? 'open' : ''}">\${ICON.chev}</span>
              <span class="name">\${r.room}</span>
              <span class="row-share" aria-label="Copy agent prompt — paste into any agent to point it at this room" role="button" data-room="\${r.room}" data-agent-prompt="1">\${ICON.agent}</span>
              <span class="row-share" aria-label="Copy public link to this room" role="button" data-room="\${r.room}" data-share-dir="">\${ICON.share}</span>
            </div>
            \${open ? '<ul class="tree">' + treeHtml + '</ul>' : ''}
          </div>\`;
        }).join("")
      : roomsLoading ? '<div class="empty">Loading rooms…</div>'
      : '<div class="empty">No rooms. Use <code>bashroom room create</code>.</div>';
  }

  function wireSidebar() {
    app.querySelectorAll("[data-room-toggle]").forEach(b => b.onclick = () => toggleRoom(b.dataset.roomToggle));
    app.querySelectorAll(".row[data-file]").forEach(r => r.onclick = () => selectFile(r.dataset.room, r.dataset.file));
    app.querySelectorAll(".row[data-dir]").forEach(r => r.onclick = () => toggleDir(r.dataset.room, r.dataset.dir));
    // Clicking a result leaves search mode: the tree comes back with the
    // file's ancestor folders expanded (selectFile → revealActiveFile) so
    // you land IN the folder, not on a dead-end results list.
    app.querySelectorAll(".result[data-file]").forEach(r => r.onclick = () => {
      const room = r.dataset.room, file = r.dataset.file;
      clearSearchQuery();
      selectFile(room, file);
    });
    // Folder lines in results reveal that folder in the sidebar directly.
    app.querySelectorAll(".result-folder[data-reveal-dir]").forEach(el => {
      el.onclick = () => {
        const room = el.dataset.room, dir = el.dataset.revealDir;
        clearSearchQuery();
        state.roomsOpened.add(room);
        let acc = "";
        for (const seg of dir.split("/")) { acc = acc ? acc + "/" + seg : seg; state.opened.add(room + ":" + acc); }
        if (!treeInflight.has(room)) void fetchTree(room);
        persist();
        render();
        const aside = app.querySelector("aside");
        const row = aside && findAnchorRow(aside, ["dir", room, dir]);
        if (row) row.scrollIntoView({ block: "center" });
      };
    });
    // Hover share icons on directory rows + room heads. stopPropagation so
    // the click doesn't also toggle the folder open/closed.
    app.querySelectorAll("[data-share-dir]").forEach(el => {
      el.onclick = (e) => { e.stopPropagation(); void shareTarget(el.dataset.room, el.dataset.shareDir || "", el); };
    });
    // Copy-agent-prompt on room heads: the zero-install way to point a fresh
    // agent at this room (the prompt carries its own MCP setup line).
    app.querySelectorAll("[data-agent-prompt]").forEach(el => {
      el.onclick = async (e) => {
        e.stopPropagation();
        const ok = await copyText(agentPromptFor(el.dataset.room));
        if (ok) flashShare(el, "copied");
      };
    });
  }

  // Repaint ONLY the sidebar's room sections. Background tree fetches used to
  // trigger a full render() — which wipes app.innerHTML and therefore also
  // destroys + remounts the inline editor and rendered article — once per
  // remembered-open room at boot. The tree data only affects the sidebar, so
  // swap just that region; the <aside> element survives, and anchoring keeps
  // the user's rows fixed while content above them grows.
  function renderSidebar() {
    const aside = app.querySelector("aside");
    const sectionsEl = aside && aside.querySelector("#sections");
    if (!sectionsEl) { render(); return; } // no sidebar painted yet — full paint
    const anchor = sidebarAnchor(aside);
    const scroll = aside.scrollTop;
    sectionsEl.innerHTML = sidebarSectionsHtml();
    wireSidebar();
    applySidebarAnchor(aside, anchor, scroll);
  }

  function fileIcon(name) {
    if (name.endsWith(".md")) return '<span class="icon md">' + ICON.md + '</span>';
    return '<span class="icon">' + ICON.file + '</span>';
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  }

  function renderTree(room, nodes) {
    if (!nodes.length) return '<li class="empty">Empty room.</li>';
    return nodes.map(n => {
      if (n.kind === "dir") {
        const open = state.opened.has(room + ":" + n.path);
        return \`<li>
          <div class="row" data-room="\${room}" data-dir="\${n.path}">
            <span class="chev \${open ? 'open' : ''}">\${ICON.chev}</span>
            <span class="icon folder">\${ICON.folder}</span>
            <span class="label">\${n.name}</span>
            <span class="row-share" aria-label="Copy public link to this folder" role="button" data-room="\${room}" data-share-dir="\${n.path}">\${ICON.share}</span>
          </div>
          \${open ? '<ul>' + renderTree(room, n.kids) + '</ul>' : ''}
        </li>\`;
      }
      const active = (room === state.activeRoom && n.path === state.activePath) ? "active" : "";
      return \`<li>
        <div class="row \${active}" data-room="\${room}" data-file="\${n.path}">
          <span class="chev hidden">\${ICON.chev}</span>
          \${fileIcon(n.name)}
          <span class="label">\${n.name}</span>
        </div>
      </li>\`;
    }).join("");
  }

  function renderLogin() {
    document.body.classList.add("login-view");
    app.innerHTML = \`
      <div class="login">
        <h1>Bashroom</h1>
        <p>The web reader needs a token from the CLI. Install once, then paste your token below.</p>
        <div class="steps">
          <div class="step" data-cmd="npm install -g bashroom"><span class="n">1</span><span class="cmd">npm install -g bashroom</span><span class="copy">copy</span></div>
          <div class="step" data-cmd="bashroom login"><span class="n">2</span><span class="cmd">bashroom login</span><span class="copy">copy</span></div>
          <div class="step" data-cmd="bashroom token"><span class="n">3</span><span class="cmd">bashroom token</span><span class="copy">copy</span></div>
        </div>
        <div class="divider"><span>then paste your token</span></div>
        \${state.loginError ? \`<div class="login-error">\${state.loginError}</div>\` : ''}
        <input id="tok" type="password" placeholder="br_user_…" autocomplete="off" spellcheck="false" />
        <button id="go">Open</button>
      </div>
    \`;
    document.getElementById("go").onclick = () => {
      const raw = document.getElementById("tok").value;
      const v = extractToken(raw);
      if (!v) {
        state.loginError = "No bashroom token found in that paste. Expected something starting with br_user_…";
        render();
        return;
      }
      state.loginError = "";
      localStorage.setItem(TOKEN_KEY, v);
      state.token = v;
      // login-view stays on <body> until the app shell actually paints
      // (render() removes it) — dropping it here shoved the still-visible
      // form 260px right into the sidebar gutter.
      if (RETURN_TO) { location.replace(RETURN_TO); return; }
      const go = document.getElementById("go");
      go.disabled = true;
      go.textContent = "Opening…";
      roomsLoading = true;
      loadRooms().catch(() => { roomsLoading = false; render(); });
    };
    document.getElementById("tok").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("go").click(); });
    document.querySelectorAll(".login .step").forEach((el) => {
      el.addEventListener("click", async () => {
        const cmd = el.getAttribute("data-cmd") || "";
        const ok = await copyText(cmd);
        if (!ok) return;
        el.classList.add("copied");
        const lbl = el.querySelector(".copy");
        if (lbl) lbl.textContent = "copied";
        setTimeout(() => {
          el.classList.remove("copied");
          if (lbl) lbl.textContent = "copy";
        }, 1100);
      });
    });
  }

  function render() {
    if (!state.token) return renderLogin();
    document.body.classList.remove("login-view");

    // Preserve sidebar scroll across full rerenders. app.innerHTML wipes the
    // DOM, so the new <aside> would otherwise reset to scrollTop=0 — the
    // "click a file, sidebar jumps to top" bug. null (not 0) when there's no
    // sidebar yet: scrollTop 0 is a real position, and treating it as "no
    // prior scroll" made every render at the top recenter the active row.
    const prevAside = app.querySelector("aside");
    const sidebarScroll = prevAside ? prevAside.scrollTop : null;
    const anchor = sidebarAnchor(prevAside);
    // The innerHTML wipe would silently blur + blank the search input; carry
    // its focus across the swap (the value re-paints from searchQuery).
    const ae = document.activeElement;
    const searchFocused = Boolean(ae && ae.id === "room-search");
    // ...and the caret with it — restoring focus at value.length relocated a
    // mid-word caret to the end under background renders.
    const searchSel = searchFocused ? [ae.selectionStart, ae.selectionEnd] : null;
    // Focus inside the editor is likewise wiped — flag it so mountCm (or the
    // fallback textarea path) refocuses after the remount instead of letting
    // the user's next keystrokes dead-end on <body>.
    if (ae && ae.closest && ae.closest("#cm-mount, #editor")) editFocusPending = true;
    // Body owns the document scroll, and the wipe momentarily shortens the
    // page (the browser clamps scrollY). Remember the position; restored
    // below ONLY when re-rendering the same document — navigations start at
    // the top.
    const prevDocKey = render._docKey;
    const docScrollY = window.scrollY;

    const tree = trees.get(state.activeRoom);
    const activeKey = state.activeRoom && state.activePath ? fileKey(state.activeRoom, state.activePath) : "";
    const activeFile = activeKey ? files.get(activeKey) : null;
    const treeIsErr = isErrorRecord(tree);
    const activeFileIsErr = isErrorRecord(activeFile);
    const activeFileLoading = state.activeRoom && state.activePath && !activeFile && fileInflight.has(activeKey);
    // Modeless editing stays primary. Preview is a per-document opt-in used
    // for renderers (Mermaid today, more allowlisted blocks later).
    const inlineMode = Boolean(activeFile && !activeFileIsErr && !activeFile.is_binary && !cmLoadFailed);
    const previewing = Boolean(inlineMode && previewKey === activeKey);
    let md = "";
    if (activeFile && !activeFileIsErr && !activeFile.is_binary) {
      // Room markdown is multi-writer input (other members, other agents) and
      // marked passes raw HTML through — sanitize before innerHTML so a
      // hostile file can't run script next to the localStorage token.
      const renderSource = inlineKey === activeKey ? editDraft : activeFile.content;
      try { md = DOMPurify.sanitize(marked.parse(renderSource)); }
      catch (e) { md = '<pre>marked error: ' + String(e) + '</pre>'; }
    }
    // File-dependent controls only exist once the body has arrived; the
    // header SHELL renders as soon as a document is addressed, so the 52px
    // sticky bar doesn't pop in after the fetch and shove the content down.
    const docPath = activeFile && !activeFileIsErr ? activeFile.path : state.activePath;
    const docActionsHtml = activeFile && !activeFileIsErr
      ? \`<div class="doc-actions">
              \${activeFile.is_binary ? "" : \`<button class="doc-action" id="copy-md" data-tip="Copy Markdown source" type="button">
                <span class="icon-stack">\${ICON.copy}\${ICON.check}\${ICON.cross}</span>
                <span class="label-stack">
                  <span class="lb-copy">Copy</span>
                  <span class="lb-copied">Copied</span>
                  <span class="lb-failed">Failed</span>
                </span>
              </button>\`}
              \${inlineMode ? \`<button class="doc-action" id="preview-btn" data-tip="\${previewing ? "Return to editing" : "Render diagrams and Markdown"}" type="button">
                <span>\${previewing ? "Edit" : "Preview"}</span>
              </button>\` : ""}
              \${activeFile.is_binary || editing || inlineMode ? "" : \`<button class="doc-action" id="edit-btn" data-tip="Edit this file" type="button">
                <span class="icon-stack">\${ICON.pencil}</span><span>Edit</span>
              </button>\`}
              <div class="share-wrap">
                <button class="doc-action" id="share-btn" data-tip="Create a role-based link" type="button" aria-haspopup="menu" aria-expanded="false">
                  <span class="icon-stack">\${ICON.share}</span><span class="share-lbl">Share</span>
                </button>
                <div class="share-menu" id="share-menu" role="menu" hidden>
                  <button class="share-option" type="button" role="menuitem" data-share-role="view"><span class="share-role-icon">◉</span><strong>View link</strong><small>Anyone with the link can read</small></button>
                  <button class="share-option" type="button" role="menuitem" data-share-role="comment"><span class="share-role-icon">✦</span><strong>Comment link</strong><small>Sign-in required · inline comments</small></button>
                  <button class="share-option" type="button" role="menuitem" data-share-role="edit"><span class="share-role-icon">✎</span><strong>Edit link</strong><small>Sign-in required · edit and comment</small></button>
                </div>
              </div>
          </div>\`
      : "";
    const documentHeader = (activeFile && !activeFileIsErr) || activeFileLoading
      ? \`<header class="doc-header">
          <div class="doc-location" title="\${escHtml(state.activeRoom + "/" + docPath)}">
            <span class="doc-room">\${escHtml(state.activeRoom)}</span>
            <span class="doc-separator" aria-hidden="true">/</span>
            <span class="doc-path">\${escHtml(docPath)}</span>
          </div>
          <div class="doc-activity">
            <span class="presence" id="presence-row"></span>
            \${inlineMode ? '<span class="doc-save-state" id="save-state" aria-live="polite"></span>' : ""}
          </div>
          \${docActionsHtml}
        </header>\`
      : "";
    const emptyMsg = !state.activeRoom ? "Pick a room."
      : treeIsErr ? "Couldn't load <code>" + state.activeRoom + "</code>. Click the room in the sidebar to retry."
      : !tree ? "Loading <code>" + state.activeRoom + "</code>…"
      : !state.activePath ? "Pick a file."
      : activeFileIsErr ? "Couldn't load <code>" + state.activePath + "</code>."
      : activeFileLoading ? "Loading <code>" + state.activePath + "</code>…"
      : "File <code>" + state.activePath + "</code> not in <code>" + state.activeRoom + "</code>.";
    // Fallback (cmLoadFailed) explicit-edit flow: textarea + Save/Cancel.
    const editorHtml = '<div id="cm-mount"></div>'
      + '<textarea class="editor" id="editor" spellcheck="false"></textarea>'
      + '<div class="edit-actions">'
      + '<button class="primary" id="save-btn" type="button">Save</button>'
      + '<button id="cancel-btn" type="button">Cancel</button>'
      + (editError ? '<span class="edit-error"></span>' : '')
      + '<span class="hint">⌘⏎ save · esc cancel</span>'
      + '</div>';
    // Modeless surface: the editor is the document. Conflict bar appears only
    // when an autosave hit a 412 (someone else saved first).
    const conflictBar = saveState === "conflict"
      ? '<div class="edit-actions"><span class="edit-error">Changed underneath you — another session saved this file first.</span>'
        + '<button id="overwrite-btn" type="button">Overwrite theirs</button>'
        + '<button class="primary" id="reload-btn" type="button">Load theirs</button></div>'
      : "";
    // The placeholder article paints the already-rendered draft while the
    // async editor mount runs (and across remount gaps); it sits OUTSIDE
    // #cm-mount so the childElementCount remount check stays untouched.
    const inlineHtml = '<div id="cm-mount" class="inline"></div>'
      + '<article id="cm-ph">' + md + '</article>' + conflictBar;
    // The doc bar renders OUTSIDE .page (full pane width, sticky at top:0);
    // body is only what flows in the 820px article column.
    const body = activeFile && !activeFileIsErr
      ? (activeFile.is_binary
          ? '<div class="empty">Binary file. Use the Bashroom shell to inspect it.</div>'
          : inlineMode ? (previewing ? '<article>' + md + '</article>' : inlineHtml)
          : (editing ? editorHtml : '<article>' + md + '</article>'))
      : '<div class="empty">' + emptyMsg + '</div>';

    app.innerHTML = \`
      <aside>
        <div class="brand">
          <svg class="mark" viewBox="0 0 46 20" aria-hidden="true">
            <g fill="currentColor">
              <rect x="0"  y="2" width="16" height="16" rx="4" opacity="0.12"/>
              <rect x="6"  y="2" width="16" height="16" rx="4" opacity="0.22"/>
              <rect x="12" y="2" width="16" height="16" rx="4" opacity="0.36"/>
              <rect x="18" y="2" width="16" height="16" rx="4" opacity="0.55"/>
              <rect x="24" y="2" width="16" height="16" rx="4" opacity="0.78"/>
              <rect x="30" y="2" width="16" height="16" rx="4" opacity="1"/>
            </g>
          </svg>
          <span class="brand-name">bashroom</span>
          <a class="brand-repo" href="https://github.com/sdan/bashroom" target="_blank" rel="noreferrer" aria-label="sdan/bashroom on GitHub" data-tip="sdan/bashroom on GitHub">
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.36c-2.22.48-2.69-1.07-2.69-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.88 2.34.67.07-.52.28-.88.51-1.08-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0z"/></svg>
          </a>
          <button class="theme-toggle" id="theme-toggle" data-tip="Toggle theme" aria-label="Toggle theme" type="button">
            <svg class="ic-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/></svg>
            <svg class="ic-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>
          </button>
        </div>
        <div class="search-box"><input id="room-search" type="search" placeholder="Search all rooms  ⌘K" autocomplete="off" spellcheck="false" /></div>
        <div id="sections">\${sidebarSectionsHtml()}</div>
        <div class="footer">
          <span class="handle">\${state.handle ? '@' + state.handle : ''}</span>
          <span class="logout" id="logout">Sign out</span>
        </div>
      </aside>
      \${documentHeader}
      <main>
        <div class="page">
          \${body}
        </div>
      </main>
    \`;
    // Same document re-rendered (background fetch, presence, toggle): put the
    // reader back where they were. The rAF restore works because the inline
    // placeholder/article preserves page height across the wipe; the pending
    // value covers the async editor mount settling after that.
    render._docKey = activeKey;
    if (prevDocKey && prevDocKey === activeKey && docScrollY) {
      if (inlineMode && !previewing) pendingScrollY = docScrollY;
      requestAnimationFrame(() => window.scrollTo(0, docScrollY));
    }
    wireSidebar();

    // Rewrite + intercept links inside rendered Markdown. marked turns
    // [notes/x.md](notes/x.md) into <a href="notes/x.md"> — a relative URL the
    // browser resolves to bashroom.sdan.io/notes/x.md (no such route → dead).
    // For internal links we (1) rewrite href to the canonical deep link so
    // hover/copy/cmd-click/open-in-new-tab all work, and (2) capture plain
    // left-clicks for in-app navigation (no full reload). External links open
    // in a new tab.
    const renderedArticle = app.querySelector("article");
    wireArticleLinks(renderedArticle);
    void enhanceRichDocument(renderedArticle);

    // Restore the sidebar scroll we captured before the innerHTML wipe —
    // anchored to a row identity (see sidebarAnchor) so async tree loads
    // that insert content above it can't shift what the user is looking at.
    const newAside = app.querySelector("aside");
    if (newAside) {
      if (sidebarScroll === null) {
        // First paint (fresh deep link): bring the active file into view so a
        // file deep in a long tree isn't below the fold.
        const activeRow = newAside.querySelector(".row.active");
        if (activeRow) activeRow.scrollIntoView({ block: "center" });
      } else {
        applySidebarAnchor(newAside, anchor, sidebarScroll);
      }
    }
    const lo = document.getElementById("logout"); if (lo) lo.onclick = logout;
    // Search input: value lives in searchQuery (never baked into the HTML),
    // so background re-renders can't eat keystrokes. Esc clears and blurs.
    const si = document.getElementById("room-search");
    if (si) {
      si.value = searchQuery;
      si.oninput = () => setSearchQuery(si.value);
      si.onkeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); si.value = ""; setSearchQuery(""); si.blur(); }
      };
      if (searchFocused) {
        si.focus();
        si.setSelectionRange(
          searchSel && searchSel[0] != null ? searchSel[0] : si.value.length,
          searchSel && searchSel[1] != null ? searchSel[1] : si.value.length,
        );
      }
    }
    // Theme toggle — mirrors the landing's pattern: cycle light/dark, persist
    // to localStorage("bashroom.theme") so both pages stay in sync if you
    // bounce between them in the same browser session.
    const themeBtn = document.getElementById("theme-toggle");
    if (themeBtn) {
      themeBtn.onclick = () => {
        const current = document.documentElement.getAttribute("data-theme");
        let next;
        if (current === "light") next = "dark";
        else if (current === "dark") next = "light";
        else {
          const osDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
          next = osDark ? "light" : "dark";
        }
        document.documentElement.setAttribute("data-theme", next);
        try { localStorage.setItem("bashroom.theme", next); } catch (_) {}
        // Mermaid bakes palette values into its SVG. Rebuild a visible
        // preview so diagrams switch theme with the rest of the reader.
        mermaidPromise = null;
        if (previewing) {
          // The repaint destroys the very button being clicked — keep the
          // keyboard user's focus and the reading position.
          const y = window.scrollY;
          const hadFocus = document.activeElement === themeBtn;
          render();
          if (hadFocus) document.getElementById("theme-toggle")?.focus();
          window.scrollTo(0, y);
        }
      };
    }
    // ─── Inline (modeless) editor wiring ───
    if (inlineMode) {
      const key = fileKey(state.activeRoom, state.activePath);
      if (inlineKey !== key) {
        // Crossing files: flush any pending save for the old file happened in
        // selectFile/popstate; bind the editor to the new one.
        inlineKey = key;
        cmDocSalt = "";
        destroyCm();
        editDraft = activeFile.content;
        editBaseEtag = activeFile.etag || "";
        lastSaved = activeFile.content;
        saveState = "";
        conflictTheirs = null;
      } else if (editDraft === lastSaved && activeFile.content !== lastSaved && saveState !== "conflict") {
        // We're clean but the server copy moved (another agent/session saved)
        // — adopt theirs. Never adopt over local unsaved edits; those resolve
        // through the CAS conflict flow at save time instead.
        destroyCm();
        editDraft = activeFile.content;
        editBaseEtag = activeFile.etag || "";
        lastSaved = activeFile.content;
      }
      const mountEl = document.getElementById("cm-mount");
      if (mountEl) {
        if (mountEl.childElementCount === 0) { destroyCm(); void mountCm(); }
        // ⌘S forces an immediate save (autosave covers the rest).
        mountEl.onkeydown = (e) => {
          if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); flushAutosave(); }
        };
        // CodeMirror changes selection without changing Markdown. Stream
        // those moves too so collaborators see clicks and arrow-key carets.
        mountEl.onkeyup = streamDraft;
        mountEl.onpointerup = streamDraft;
        mountEl.onfocusin = streamDraft;
      }
      setSaveState(saveState); // paint current state into the fresh DOM
      paintProvenance();       // re-apply an in-flight provenance flash
      const ob = document.getElementById("overwrite-btn");
      if (ob) ob.onclick = () => {
        // Informed overwrite: rebase onto their etag and push our draft.
        if (conflictTheirs) editBaseEtag = conflictTheirs.etag || "";
        conflictTheirs = null;
        saveState = "dirty";
        void autosave();
        render();
      };
      const rb = document.getElementById("reload-btn");
      if (rb) rb.onclick = () => {
        // Take theirs: drop our draft, rebind to the server copy.
        if (conflictTheirs) files.set(inlineKey, conflictTheirs);
        conflictTheirs = null;
        saveState = "";
        inlineKey = ""; // force a clean rebind on render
        destroyCm();
        render();
      };
    } else if (inlineKey) {
      // Left inline mode (binary file, error view, or no file): unbind.
      inlineKey = "";
      destroyCm();
    }
    // Editor wiring. The textarea's value is set from the draft var (not
    // baked into the HTML) so re-renders triggered by background fetches
    // can't lose keystrokes; editError text goes in via textContent for the
    // same reason HTML-escaping would otherwise matter.
    const ed = document.getElementById("editor");
    if (ed) {
      // The textarea is the draft buffer + fallback. CodeMirror (if it mounts)
      // hides it and becomes the live editor, mirroring into editDraft. The
      // textarea's own handlers stay wired so the fallback path works too.
      ed.value = editDraft;
      ed.oninput = () => { editDraft = ed.value; streamDraft(); };
      ed.onkeyup = streamDraft;
      ed.onpointerup = streamDraft;
      ed.onfocus = streamDraft;
      ed.onkeydown = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void saveFile(); }
        if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
      };
      // ⌘⏎ / esc should also work while focus is inside the CodeMirror surface.
      const mount = document.getElementById("cm-mount");
      if (mount) {
        mount.onkeydown = (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void saveFile(); }
          if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
        };
      }
      // render() wipes app.innerHTML, so a background re-render detaches any
      // live editor DOM. Detect an empty mount and (re)build from the current
      // editDraft — the draft is preserved across renders, so no keystrokes
      // are lost. The cmMounting flag inside mountCm handles the in-flight-
      // import case.
      const mountEl = document.getElementById("cm-mount");
      if (!cmLoadFailed && mountEl && mountEl.childElementCount === 0) {
        destroyCm(); // drop any root pointing at detached DOM
        void mountCm();
      } else if (cmLoadFailed && editFocusPending) { editFocusPending = false; ed.focus(); }
      const errEl = app.querySelector(".edit-error");
      if (errEl) errEl.textContent = editError;
      const sv = document.getElementById("save-btn");
      if (sv) sv.onclick = () => void saveFile();
      const cn = document.getElementById("cancel-btn");
      if (cn) cn.onclick = cancelEdit;
    }
    const eb = document.getElementById("edit-btn");
    if (eb && activeFile && !activeFileIsErr && !activeFile.is_binary) {
      eb.onclick = () => startEdit(activeFile);
    }
    const previewBtn = document.getElementById("preview-btn");
    if (previewBtn && activeKey) {
      previewBtn.onclick = () => {
        // Keep the reader's place and focus across the surface swap — the
        // wipe momentarily shortens the document and the browser clamps
        // scrollY; returning to Edit also refocuses the fresh editor.
        const y = window.scrollY;
        flushAutosave();
        destroyCm();
        previewKey = previewing ? "" : activeKey;
        if (previewing) editFocusPending = true;
        render(); // same-doc render() sets pendingScrollY for the async mount
        requestAnimationFrame(() => window.scrollTo(0, y));
      };
    }
    const sb = document.getElementById("share-btn");
    const shareMenu = document.getElementById("share-menu");
    if (sb && shareMenu && state.activeRoom && state.activePath) {
      const closeMenu = () => { shareMenu.hidden = true; sb.setAttribute("aria-expanded", "false"); };
      sb.onclick = (event) => {
        event.stopPropagation();
        shareMenu.hidden = !shareMenu.hidden;
        sb.setAttribute("aria-expanded", shareMenu.hidden ? "false" : "true");
        if (!shareMenu.hidden) shareMenu.querySelector(".share-option")?.focus();
      };
      shareMenu.querySelectorAll("[data-share-role]").forEach(option => {
        option.onclick = (event) => {
          event.stopPropagation();
          const role = option.getAttribute("data-share-role") || "view";
          // Hiding the focused menuitem drops focus to <body> — hand it back
          // to the trigger (which flashes copied/failed) like Escape does.
          closeMenu();
          sb.focus();
          void shareTarget(state.activeRoom, state.activePath, sb, role);
        };
      });
      shareMenu.onkeydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeMenu(); sb.focus(); }
      };
      // Tabbing out of the menu closes it — otherwise it lingers open with
      // aria-expanded stale.
      shareMenu.onfocusout = (event) => {
        if (!shareMenu.contains(event.relatedTarget) && event.relatedTarget !== sb) closeMenu();
      };
      document.onclick = closeMenu;
    }
    renderPresence(); // the innerHTML wipe recreated #presence-row — repaint it
    const cp = document.getElementById("copy-md");
    if (cp && activeFile && !activeFileIsErr && !activeFile.is_binary) {
      let resetTimer = 0;
      const trigger = async () => {
        // In inline mode the editor's draft is the live document — copy that,
        // not the last-fetched server copy.
        const ok = await copyText(inlineKey ? editDraft : activeFile.content);
        cp.classList.remove("copied", "failed");
        // Force a reflow so re-triggering the same class restarts the transition.
        void cp.offsetWidth;
        cp.classList.add(ok ? "copied" : "failed");
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => cp.classList.remove("copied", "failed"), 1500);
      };
      cp.onclick = trigger;
    }
  }

  // Two-tier copy: modern clipboard API first, fall back to the legacy
  // execCommand path for non-secure contexts and older browsers.
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  // URL wins over persisted state on boot: a deep link / refresh / shared link
  // should open exactly what's in the address bar, not the last-viewed file.
  // Capability mode is the exception — /s/<slug> is not a room/path URL; the
  // injected grant already fixed the document.
  const fromUrl = share ? null : stateFromUrl();
  if (fromUrl) {
    state.activeRoom = fromUrl.room;
    state.activePath = fromUrl.path;
    revealActiveFile(); // expand room + ancestor folders for the deep-linked file
  }

  // Back/forward: re-hydrate from the URL and repaint. The target room's
  // tree/file data may not be loaded (deep nav across rooms) — fetch on demand.
  // Don't lose a dirty inline doc to navigation or tab-close. pagehide uses
  // keepalive so the PUT survives the page going away; conflicts on that last
  // write are still CAS-checked server-side (a 412 there just means the other
  // writer won — nothing is clobbered).
  window.addEventListener("pagehide", () => {
    clearTimeout(saveTimer);
    if (inlineKey && editDraft !== lastSaved && saveState !== "conflict") {
      try {
        void fetch("/web/api/file", {
          method: "PUT",
          keepalive: true,
          headers: { authorization: "Bearer " + state.token, "content-type": "application/json" },
          body: JSON.stringify({ room: state.activeRoom, path: state.activePath, content: editDraft, base_etag: editBaseEtag || undefined, slug: share ? share.slug : undefined }),
        });
      } catch (_) {}
    }
  });

  // ⌘K / Ctrl-K focuses the cross-room search from anywhere in the app.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      const si = document.getElementById("room-search");
      if (si) { e.preventDefault(); si.focus(); si.select(); }
    }
  });

  window.addEventListener("popstate", () => {
    flushAutosave();
    pendingScrollY = -1; // back/forward is a navigation — no stale restore
    const s = stateFromUrl();
    state.activeRoom = s ? s.room : "";
    state.activePath = s ? s.path : "";
    if (state.activeRoom) {
      revealActiveFile(); // keep the tree in sync with back/forward navigation
      if (!trees.has(state.activeRoom) && !treeInflight.has(state.activeRoom)) void fetchTree(state.activeRoom);
      ensureActiveFile();
    }
    connectPresence(state.activeRoom);
    persist();
    render();
  });

  // Boot: paint the whole shell from cache immediately (rooms list + trees +
  // the deep-linked file's fetch kicked off), then loadRooms revalidates.
  // A revoked token still lands on login — api()'s 401 handler clears it.
  if (share) {
    // Capability boot: one document, no rooms list, no cache hydration.
    // The worker inlines small documents into the grant — seed the file
    // cache from it so first paint needs no API round-trip (background
    // revalidation still runs). Editing needs a signed-in identity, so no
    // token still lands on login.
    if (share.file && share.file.path) files.set(fileKey(state.activeRoom, state.activePath), share.file);
    if (state.token) { ensureActiveFile(); connectPresence(state.activeRoom); }
    render();
  } else if (state.token && RETURN_TO) {
    location.replace(RETURN_TO);
  } else if (state.token) {
    hydrateFromCache();
    if (state.rooms.length) { ensureActiveFile(); connectPresence(state.activeRoom); }
    // Paint the shell unconditionally — a first visit (nothing cached) used
    // to stare at a blank white #app for the whole rooms round-trip.
    roomsLoading = !state.rooms.length;
    render();
    loadRooms().catch(() => { roomsLoading = false; render(); });
  } else {
    render();
  }
  // Warm the editor graph at boot: modulepreload only fetches esm.sh's
  // ~200-byte redirect shims, not the real React/CodeMirror payload — the
  // heavy fetches otherwise start at first mount. Swallowed catch: a CDN
  // blip here must not reject unhandled; mountCm handles its own failure.
  if (state.token || share) setTimeout(() => { loadCm().catch(() => {}); }, 0);
  // Relative times in presence pills drift; refresh them on a slow tick.
  setInterval(renderPresence, 60000);
})();
</script>
</body>
</html>`;

export function webIndexHtml(share?: { slug: string; room: string; path: string; role: string; file?: unknown }): string {
  if (!share) return WEB_INDEX_HTML;
  // Capability bootstrap for /s/<slug> edit links: the SPA reads
  // window.BASHROOM_SHARE at boot and runs in single-document share mode.
  // JSON.stringify + < escaping keeps a hostile path from closing the
  // script tag early. (Plain concatenation, not a template literal — the
  // webcheck extractor treats the file's last backtick-semicolon as the
  // WEB_INDEX_HTML terminator.) Anchored on the #app div, NOT on "<body>":
  // that string also appears inside a CSS comment in the <style> block,
  // where an injected script would land as inert stylesheet text.
  const boot = "<script>window.BASHROOM_SHARE = "
    + JSON.stringify(share).replace(/</g, "\\u003c")
    + ";</script>";
  return WEB_INDEX_HTML.replace('<div id="app">', boot + '<div id="app">');
}
