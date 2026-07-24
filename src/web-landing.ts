// Bashroom landing page — bashroom.sdan.io/
//
// Visual language mirrored from ~/Developer/vmux/homepage (cream surface,
// hairline borders, single orange accent, Inter + JetBrains Mono, uncarded
// spec rows, install-bar-as-CTA, click-to-copy command rows). Rebuilt in
// vanilla HTML/CSS to keep the worker single-file and to make it mobile-
// friendly out of the box — the vmux site uses fixed 640px widths, this one
// uses `max-width: 720px; width: 100%` with a wrapping diagram.
//
// Served from the worker at GET /.

export function webLandingHtml(cities: string[] = [], colo: string = ""): string {
  // Footer: left side is instrument-panel status (green dot + colo the request
  // was served from, per the dashboard dialect in design wiki). Right side is
  // viewer cities + human signature. Both are real data, no decoration.
  const used = cities.length > 0
    ? `viewed from ${cities.slice(0, 4).join(", ")}${cities.length > 4 ? `, +${cities.length - 4} more` : ""} · `
    : "";
  const footerLine = `${used}from <a href="https://github.com/sdan" target="_blank" rel="noreferrer">@sdan</a>`;
  const statusLine = colo
    ? `<span class="dot" aria-hidden="true"></span>all systems normal · served from ${colo}`
    : `<span class="dot" aria-hidden="true"></span>all systems normal`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bashroom — a filesystem for agents</title>
<meta name="description" content="Save notes, share files, and hand off work between running sessions." />

<!-- OpenGraph + Twitter card. Social scrapers (Twitter/X, iMessage, Slack,
     LinkedIn) do NOT render SVG and silently drop it, so og:image points at
     /og.png — a rasterized 1:1 copy of /og.svg (mark + wordmark + room tree
     + tagline). Re-render via "npm run og" if the SVG changes. -->
<meta property="og:type" content="website" />
<meta property="og:url" content="https://bashroom.sdan.io" />
<meta property="og:title" content="Bashroom — a filesystem for agents" />
<meta property="og:description" content="Save notes, share files, and hand off work between running sessions." />
<meta property="og:image" content="https://bashroom.sdan.io/og.png" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="bashroom — a filesystem for agents" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Bashroom — a filesystem for agents" />
<meta name="twitter:description" content="Save notes, share files, and hand off work between running sessions." />
<meta name="twitter:image" content="https://bashroom.sdan.io/og.png" />

<link rel="preconnect" href="https://pingpong.sdan.io" crossorigin />
<link rel="dns-prefetch" href="https://pingpong.sdan.io" />
<script defer src="https://pingpong.sdan.io/client.js" data-site="bashroom.sdan.io" data-presence="true"></script>
<script>
  // Theme init — runs before paint to avoid FOUC. Reads localStorage first;
  // falls back to OS preference if user has never toggled.
  (function() {
    try {
      var saved = localStorage.getItem("bashroom.theme");
      if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
    } catch (_) {}
  })();
</script>
<style>
  :root {
    --bg: #FFFFFF;
    --surface: #F7F7F5;
    --hover: #EFEEEC;
    --active: #E8E6F5;
    --ink: #37352F;
    --ink-muted: #6F6E69;
    --ink-faint: #A3A29C;
    --ink-faintest: #C4C3BE;
    --rule: #EBEAE6;
    --rule-strong: #DADAD5;
    --row-hover: #F7F7F5;
    --separator: #EBEAE6;
    --separator-strong: #DADAD5;
    --label: #A3A29C;
    --value: #6F6E69;
    --value-strong: #37352F;
    --accent: #4F3BD0;
    --accent-on: #FFFFFF;
    --accent-soft: #E8E6F5;
    --green: #1F8A65;
    --code-bg: #F7F7F5;
    --code-border: #EBEAE6;
    --code-text: #4F4B45;
    --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
  }
  /* Dark palette. Order matters: media query is the "OS-derived default";
     the [data-theme="dark"] / [data-theme="light"] attribute selectors at
     the same specificity come later in source order and win when the user
     has explicitly toggled. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #191919;
      --surface: #202020;
      --hover: #2A2A2A;
      --active: #2F2940;
      --ink: #E8E6E1;
      --ink-muted: #9B9A94;
      --ink-faint: #6F6F6A;
      --ink-faintest: #4A4A46;
      --rule: #2A2A2A;
      --rule-strong: #3A3A3A;
      --row-hover: #222222;
      --separator: #2A2A2A;
      --separator-strong: #303030;
      --label: #6F6F6A;
      --value: #9B9A94;
      --value-strong: #E8E6E1;
      --accent: #C8A8FF;
      --accent-on: #191919;
      --accent-soft: #2F2940;
      --green: #4ECDC4;
      --code-bg: #202020;
      --code-border: #2A2A2A;
      --code-text: #9B9A94;
    }
  }
  /* Explicit user override for dark mode regardless of OS. */
  :root[data-theme="dark"] {
    --bg: #191919;
    --surface: #202020;
    --hover: #2A2A2A;
    --active: #2F2940;
    --ink: #E8E6E1;
    --ink-muted: #9B9A94;
    --ink-faint: #6F6F6A;
    --ink-faintest: #4A4A46;
    --rule: #2A2A2A;
    --rule-strong: #3A3A3A;
    --row-hover: #222222;
    --separator: #2A2A2A;
    --separator-strong: #303030;
    --label: #6F6F6A;
    --value: #9B9A94;
    --value-strong: #E8E6E1;
    --accent: #C8A8FF;
    --accent-on: #191919;
    --accent-soft: #2F2940;
    --green: #4ECDC4;
    --code-bg: #202020;
    --code-border: #2A2A2A;
    --code-text: #9B9A94;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
  body { padding: 0 24px; }
  a { color: inherit; text-decoration: none; }
  /* Replace the harsh browser-default focus ring with a quiet accent ring,
     but only for keyboard focus (mouse clicks don't get it). */
  a:focus, button:focus { outline: none; }
  a:focus-visible, button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-soft); border-radius: 4px; }

  .shell { max-width: 720px; margin: 0 auto; padding: 32px 0 80px; }

  /* Top nav */
  .nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 64px; }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--ink); }
  .brand .mark { height: 22px; width: auto; flex-shrink: 0; color: var(--ink); display: inline-flex; align-items: center; }
  .brand .name { font-family: var(--sans); font-size: 17px; font-weight: 500; letter-spacing: -0.01em; }
  .nav-links { display: flex; align-items: center; gap: 24px; font-family: var(--sans); font-size: 14px; color: var(--ink-muted); }
  .nav-links a { transition: color 140ms ease; }
  .nav-links a:hover { color: var(--ink); }
  /* Icon link in nav (e.g. GitHub) — same visual register as the theme
     toggle button next to it. Inherits color via currentColor on the SVG. */
  .nav-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px;
    color: var(--ink-muted); border-radius: 6px;
    transition: color 140ms ease, background 140ms ease;
    position: relative;
  }
  /* Invisible 40x40 hit target — meets touch accessibility minimum without
     changing the visual 28x28 size. */
  .nav-icon::before {
    content: ""; position: absolute; inset: -6px; border-radius: 8px;
  }
  .nav-icon:hover { color: var(--ink); background: var(--hover); }
  .nav-icon svg { display: block; }

  .theme-toggle {
    background: transparent; border: 0; padding: 6px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--ink-muted); border-radius: 6px;
    transition: color 140ms ease, background 140ms ease, box-shadow 140ms ease;
    -webkit-appearance: none; appearance: none;
    line-height: 0; position: relative;
  }
  /* 40x40 hit target via ::before — visual stays 28x28. */
  .theme-toggle::before {
    content: ""; position: absolute; inset: -6px; border-radius: 8px;
  }
  .theme-toggle:hover { color: var(--ink); background: var(--hover); }
  .theme-toggle:focus { outline: none; }
  .theme-toggle:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
  .theme-toggle svg { width: 16px; height: 16px; display: block; transition: opacity 140ms ease, transform 220ms ease; }
  .theme-toggle .ic-moon, .theme-toggle .ic-sun { position: absolute; inset: 0; }
  .theme-toggle .ic-stack { position: relative; width: 16px; height: 16px; display: inline-block; }
  /* Show moon in light mode (click to go dark), sun in dark mode (click to go light). */
  .theme-toggle .ic-sun { opacity: 0; transform: rotate(-45deg) scale(.7); }
  :root[data-theme="dark"] .theme-toggle .ic-moon,
  :root:not([data-theme="light"]) .theme-toggle .ic-moon { /* default moon visible */ }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .theme-toggle .ic-moon { opacity: 0; transform: rotate(45deg) scale(.7); }
    :root:not([data-theme="light"]) .theme-toggle .ic-sun { opacity: 1; transform: rotate(0) scale(1); }
  }
  :root[data-theme="dark"] .theme-toggle .ic-moon { opacity: 0; transform: rotate(45deg) scale(.7); }
  :root[data-theme="dark"] .theme-toggle .ic-sun { opacity: 1; transform: rotate(0) scale(1); }
  :root[data-theme="light"] .theme-toggle .ic-moon { opacity: 1; transform: rotate(0) scale(1); }
  :root[data-theme="light"] .theme-toggle .ic-sun { opacity: 0; transform: rotate(-45deg) scale(.7); }

  /* Hero — single paragraph lede. Category claim first, then how it
     works in plain English. Reads as one thought, not a slogan + tagline. */
  .hero { margin-bottom: 40px; max-width: 640px; }
  .hero .lede { font-family: var(--sans); font-size: 20px; line-height: 1.45; margin: 0; color: var(--ink); font-weight: 400; letter-spacing: -0.01em; }
  .hero .lede code { font-family: var(--mono); font-size: 0.92em; color: var(--ink); background: var(--code-bg); padding: 1px 6px; border-radius: 3px; }

  /* FAQ — three plain-English questions, click to expand one-sentence
     answers. Cards-not-rows: each <details> is its own bordered tile
     with breathing room around the answer when open. Plus icon rotates
     to × on open. Same surface + border palette as the install command
     rows above so the bottom of the page reads as one coherent style. */
  .faq { display: flex; flex-direction: column; gap: 10px; margin-bottom: 0; }
  .q {
    background: var(--surface); border: 1px solid var(--rule);
    transition: background 140ms ease, border-color 140ms ease;
  }
  .q:hover { background: var(--row-hover); }
  .q[open] { background: var(--bg); border-color: var(--rule-strong); }
  .q summary {
    list-style: none; cursor: pointer; user-select: none;
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px;
    font-family: var(--sans); font-size: 14px; color: var(--ink);
    font-weight: 500; letter-spacing: -0.005em;
  }
  .q summary::-webkit-details-marker { display: none; }
  .q summary::after {
    content: "+";
    font-family: var(--mono); font-size: 18px; line-height: 1;
    color: var(--ink-faint); flex-shrink: 0; margin-left: 12px;
    transition: transform 200ms ease, color 140ms ease;
    transform-origin: center;
  }
  .q[open] summary::after { transform: rotate(45deg); color: var(--accent); }
  .q:hover summary::after { color: var(--ink); }
  .q .a {
    padding: 0 18px 16px;
    font-family: var(--sans); font-size: 13px; line-height: 1.6;
    color: var(--ink-muted); max-width: 580px;
  }
  .q .a p { margin: 0 0 10px; }
  .q .a p:last-child { margin-bottom: 0; }
  .q .a code { font-family: var(--mono); font-size: 12px; color: var(--ink); }
  .q .a em { font-style: italic; color: var(--ink); }
  .q .a a { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; text-decoration-color: var(--ink-faint); transition: text-decoration-color 140ms; }
  .q .a a:hover { text-decoration-color: var(--accent); }

  /* Diagram card — multiple agents → one shared tree */
  .diagram { background: var(--surface); border: 1px solid var(--rule); padding: 36px 28px; margin-bottom: 36px; }
  .diagram-row { display: flex; align-items: center; justify-content: center; gap: 18px; flex-wrap: wrap; }
  .agents-col { display: flex; flex-direction: column; gap: 10px; }
  .agent-row { display: flex; align-items: center; gap: 10px; }
  .pill { display: flex; align-items: center; justify-content: center; min-width: 96px; padding: 7px 14px; border: 1px solid var(--rule-strong); font-family: var(--mono); font-size: 11px; color: var(--ink); background: transparent; }
  .pill.you { border-color: var(--accent); color: var(--accent); }
  .arrow { color: var(--ink-faint); font-family: var(--mono); font-size: 14px; line-height: 1; }

  /* Pierre-style tree as the shared room surface */
  .room-tree { border: 1px solid var(--accent); min-width: 260px; max-width: 320px; width: 100%; }
  .tree-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 14px; border-bottom: 1px solid var(--rule); }
  .tree-head .room-name { font-family: var(--mono); font-size: 12px; color: var(--accent); }
  .tree-head .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 6px; vertical-align: 1px; }
  .tree-head .live { font-family: var(--sans); font-size: 10px; color: var(--green); }
  .tree-body { padding: 8px 4px 10px; font-family: var(--mono); font-size: 12px; color: var(--ink); }
  .tree-body ul { list-style: none; margin: 0; padding: 0; position: relative; }
  .tree-body ul ul { padding-left: 18px; }
  /* No indent guide on the landing diagram — only 2 nested files, the guide
     adds more noise than it removes. Reader at /web keeps its guide because
     it has real depth to communicate. */
  .tree-body li { padding: 2px 10px; display: flex; align-items: center; gap: 6px; }
  .tree-body .chev { width: 10px; color: var(--ink-faint); }
  .tree-body .ic { width: 14px; height: 14px; flex-shrink: 0; display: inline-flex; align-items: center; }
  .tree-body .ic.folder { color: #d8a23a; }
  .tree-body .ic.md { color: #1ca1c7; }
  .tree-body .lbl { color: var(--ink); }
  .tree-body .who { margin-left: auto; font-size: 10px; color: var(--ink-faint); }
  .diagram-caption { font-family: var(--sans); font-size: 11px; color: var(--ink-muted); margin-top: 22px; text-align: center; }

  /* Install bar — primary CTA */
  .install {
    display: flex; align-items: center; justify-content: space-between;
    background: var(--accent); color: var(--accent-on);
    padding: 0 22px; height: 52px; margin-bottom: 22px;
    cursor: pointer; user-select: none;
    transition: filter 140ms ease;
  }
  .install:hover { filter: brightness(1.05); }
  .install .cmd { font-family: var(--mono); font-size: 14px; color: var(--accent-on); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .install .lbl { font-family: var(--sans); font-size: 11px; color: color-mix(in srgb, var(--accent-on) 80%, transparent); flex-shrink: 0; margin-left: 12px; }

  /* Command rows */
  .commands { display: flex; flex-direction: column; gap: 10px; margin-bottom: 36px; }
  .cmd-row {
    display: flex; align-items: center; justify-content: space-between;
    background: var(--surface); border: 1px solid var(--rule);
    padding: 14px 18px; cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
    gap: 12px;
  }
  .cmd-row:hover { background: var(--row-hover); }
  .cmd-row.copied { background: var(--accent); border-color: var(--accent); color: var(--accent-on); }
  .cmd-row .cmd { font-family: var(--mono); font-size: 13px; color: currentColor; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .cmd-row .meta { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .cmd-row .desc { font-family: var(--sans); font-size: 11px; color: var(--ink-faint); }
  .cmd-row.copied .desc { color: color-mix(in srgb, var(--accent-on) 80%, transparent); }
  .cmd-row .ic-stack {
    position: relative; width: 14px; height: 14px; flex-shrink: 0; color: var(--ink-faint);
  }
  .cmd-row:hover .ic-stack { color: var(--ink); }
  .cmd-row.copied .ic-stack { color: var(--accent-on); }
  .cmd-row .ic-stack svg {
    position: absolute; inset: 0; width: 14px; height: 14px;
    transition: opacity 140ms cubic-bezier(.4,0,.2,1), transform 220ms cubic-bezier(.4,0,.2,1);
  }
  .cmd-row .ic-stack .ic-check { opacity: 0; transform: scale(.6); }
  .cmd-row.copied .ic-stack .ic-copy { opacity: 0; transform: scale(.6); }
  .cmd-row.copied .ic-stack .ic-check { opacity: 1; transform: scale(1); }
  @media (prefers-reduced-motion: reduce) {
    .cmd-row .ic-stack svg { transition: none; }
  }
  @media (max-width: 520px) {
    .cmd-row .desc { display: none; }
  }

  /* Section heads (specs / commands) */
  .section-label { font-family: var(--mono); font-size: 11px; letter-spacing: 0.05em; color: var(--label); padding-bottom: 12px; text-transform: lowercase; }

  /* Handoff walkthrough — two real artifacts, shown verbatim: the write one
     agent makes at the end of a session, and the read the next agent makes
     at the start of its own. Content-forward: the file IS the explanation,
     so the copy around it stays out of the way. Same surface/rule palette
     as the command rows so the page reads as one material. */
  .handoff { display: flex; flex-direction: column; gap: 10px; margin-bottom: 36px; }
  .ho-step { background: var(--surface); border: 1px solid var(--rule); padding: 14px 18px 16px; }
  .ho-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .ho-head .pill { min-width: 0; padding: 4px 10px; font-size: 10px; }
  .ho-when { font-family: var(--sans); font-size: 11px; color: var(--ink-faint); }
  .ho-code {
    margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.55;
    color: var(--code-text); white-space: pre-wrap; word-break: break-word;
  }
  .ho-code .hi { color: var(--ink); }
  /* The \n escapes are honest (an MCP write IS a JSON string) but they're
     plumbing — fade them so the eye reads the note's structure, and let the
     SAME tokens glow in both panels: the write and the read are one file. */
  .ho-code .esc { color: var(--ink-faint); }
  .ho-note { font-family: var(--sans); font-size: 12px; line-height: 1.6; color: var(--ink-muted); padding: 2px 2px 0; max-width: 580px; }

  /* Footer — instrument-panel split: status pill (left) and viewer
     attribution (right). Both are real data. On narrow screens they
     stack with status on top so the green dot stays first-read. */
  .foot {
    margin-top: 32px; font-family: var(--sans); font-size: 11px;
    color: var(--ink-faint); font-variant-numeric: tabular-nums;
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; flex-wrap: wrap;
  }
  .foot a { color: var(--label); transition: color 140ms ease; }
  .foot a:hover { color: var(--ink); }
  .foot .status { display: inline-flex; align-items: center; gap: 7px; }
  .foot .dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--green);
    display: inline-block; flex-shrink: 0;
  }

  @media (max-width: 520px) {
    body { padding: 0 18px; }
    .shell { padding: 24px 0 60px; }
    .nav { margin-bottom: 48px; }
    .nav-links { gap: 16px; font-size: 13px; }
    .hero h1 { font-size: 26px; }
    .hero p { font-size: 15px; }
    .diagram { padding: 28px 18px; }
    .diagram-row { flex-direction: column; gap: 12px; }
    .arrow { transform: rotate(90deg); }
    .room-card { min-width: 0; width: 100%; }
    .install { height: 48px; padding: 0 16px; }
    .install .cmd { font-size: 12px; }
  }
</style>
</head>
<body>
  <div class="shell">

    <div class="nav">
      <a class="brand" href="/">
        <svg class="mark" viewBox="0 0 46 20" aria-hidden="true">
          <!-- 6-05: six rounded squares, horizontal trail, opacity 0.12 → 1.0.
               currentColor so it adapts to theme. -->
          <g fill="currentColor">
            <rect x="0"  y="2" width="16" height="16" rx="4" opacity="0.12"/>
            <rect x="6"  y="2" width="16" height="16" rx="4" opacity="0.22"/>
            <rect x="12" y="2" width="16" height="16" rx="4" opacity="0.36"/>
            <rect x="18" y="2" width="16" height="16" rx="4" opacity="0.55"/>
            <rect x="24" y="2" width="16" height="16" rx="4" opacity="0.78"/>
            <rect x="30" y="2" width="16" height="16" rx="4" opacity="1"/>
          </g>
        </svg>
        <span class="name">bashroom</span>
      </a>
      <div class="nav-links">
        <a href="/web">reader</a>
        <a class="nav-icon" href="https://github.com/sdan/bashroom" target="_blank" rel="noreferrer" aria-label="GitHub repository">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </a>
        <button class="theme-toggle" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">
          <span class="ic-stack">
            <svg class="ic-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/></svg>
            <svg class="ic-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>
          </span>
        </button>
      </div>
    </div>

    <div class="hero">
      <p class="lede">
        Bashroom is a filesystem for agents — save notes, share files,
        and hand off work between running sessions.
      </p>
    </div>

    <div class="diagram">
      <div class="diagram-row">
        <div class="agents-col">
          <div class="agent-row"><div class="pill you">you</div><span class="arrow">→</span></div>
          <div class="agent-row"><div class="pill">claude</div><span class="arrow">→</span></div>
          <div class="agent-row"><div class="pill">codex</div><span class="arrow">→</span></div>
        </div>

        <div class="room-tree">
          <div class="tree-head">
            <span class="room-name">sdan/quickquack</span>
          </div>
          <div class="tree-body">
            <ul>
              <li>
                <span class="chev">▾</span>
                <span class="ic folder"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.2 1.2h4.8a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg></span>
                <span class="lbl">notes/</span>
              </li>
              <ul>
                <li>
                  <span class="chev" style="visibility:hidden">▸</span>
                  <span class="ic md"><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 2.5h9v9h-9z"/><path d="M4.5 9V5l1.5 2L7.5 5v4M10 5v4M8.5 7.5 10 9l1.5-1.5"/></svg></span>
                  <span class="lbl">2026-05-20.md</span>
                  <span class="who">claude</span>
                </li>
                <li>
                  <span class="chev" style="visibility:hidden">▸</span>
                  <span class="ic md"><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 2.5h9v9h-9z"/><path d="M4.5 9V5l1.5 2L7.5 5v4M10 5v4M8.5 7.5 10 9l1.5-1.5"/></svg></span>
                  <span class="lbl">2026-05-21.md</span>
                  <span class="who">codex</span>
                </li>
              </ul>
              <li>
                <span class="chev" style="visibility:hidden">▸</span>
                <span class="ic md"><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 2.5h9v9h-9z"/><path d="M4.5 9V5l1.5 2L7.5 5v4M10 5v4M8.5 7.5 10 9l1.5-1.5"/></svg></span>
                <span class="lbl">index.md</span>
                <span class="who">you</span>
              </li>
              <li>
                <span class="chev" style="visibility:hidden">▸</span>
                <span class="ic md"><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 2.5h9v9h-9z"/><path d="M4.5 9V5l1.5 2L7.5 5v4M10 5v4M8.5 7.5 10 9l1.5-1.5"/></svg></span>
                <span class="lbl">log.md</span>
                <span class="who">claude</span>
              </li>
              <li>
                <span class="chev" style="visibility:hidden">▸</span>
                <span class="ic md"><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 2.5h9v9h-9z"/><path d="M4.5 9V5l1.5 2L7.5 5v4M10 5v4M8.5 7.5 10 9l1.5-1.5"/></svg></span>
                <span class="lbl">README.md</span>
                <span class="who">you</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div class="diagram-caption">One folder. Every agent writes to it; you can open it from anywhere.</div>
    </div>

    <div class="install" id="install" title="Copy">
      <div class="cmd">npm install -g bashroom</div>
      <div class="lbl" id="install-lbl">copy</div>
    </div>

    <div class="commands">
      <div class="cmd-row" data-cmd="bashroom login">
        <div class="cmd">bashroom login</div>
        <div class="meta"><div class="desc">sign in with GitHub</div><span class="ic-stack"><svg class="ic-copy" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.4"/><path d="M10 4V2.5a.5.5 0 0 0-.5-.5H2.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H4"/></svg><svg class="ic-check" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7.5 6 10.5 11.5 4.5"/></svg></span></div>
      </div>
      <div class="cmd-row" data-cmd="claude mcp add bashroom -- bashroom mcp">
        <div class="cmd">claude mcp add bashroom -- bashroom mcp</div>
        <div class="meta"><div class="desc">wire it into Claude Code</div><span class="ic-stack"><svg class="ic-copy" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.4"/><path d="M10 4V2.5a.5.5 0 0 0-.5-.5H2.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H4"/></svg><svg class="ic-check" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7.5 6 10.5 11.5 4.5"/></svg></span></div>
      </div>
      <div class="cmd-row" data-cmd="codex mcp add bashroom -- bashroom mcp">
        <div class="cmd">codex mcp add bashroom -- bashroom mcp</div>
        <div class="meta"><div class="desc">wire it into Codex</div><span class="ic-stack"><svg class="ic-copy" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.4"/><path d="M10 4V2.5a.5.5 0 0 0-.5-.5H2.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H4"/></svg><svg class="ic-check" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7.5 6 10.5 11.5 4.5"/></svg></span></div>
      </div>
      <div class="cmd-row" data-cmd="npx skills add sdan/bashroom">
        <div class="cmd">npx skills add sdan/bashroom</div>
        <div class="meta"><div class="desc">install the skill into any agent</div><span class="ic-stack"><svg class="ic-copy" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.4"/><path d="M10 4V2.5a.5.5 0 0 0-.5-.5H2.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H4"/></svg><svg class="ic-check" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7.5 6 10.5 11.5 4.5"/></svg></span></div>
      </div>
    </div>

    <div class="section-label">a handoff, end to end</div>
    <div class="handoff">
      <div class="ho-step">
        <div class="ho-head"><div class="pill">claude</div><span class="ho-when">tuesday, end of session</span></div>
        <pre class="ho-code">bashroom_write({
  path: <span class="hi">"/rooms/quickquack/notes/2026-06-09.md"</span>,
  content: "<span class="hi">## state</span><span class="esc">\\n</span>OAuth refresh works, tests green.<span class="esc">\\n</span><span class="hi">## next</span><span class="esc">\\n</span>Wire the callback into /settings."
})</pre>
      </div>
      <div class="ho-step">
        <div class="ho-head"><div class="pill">codex</div><span class="ho-when">wednesday, fresh session</span></div>
        <pre class="ho-code">$ cat /rooms/quickquack/notes/2026-06-09.md
<span class="hi">## state</span>
OAuth refresh works, tests green.
<span class="hi">## next</span>
Wire the callback into /settings.</pre>
      </div>
      <div class="ho-note">That's the whole trick. The second agent reads the first one's file and starts where it stopped — different model, different machine, no scrollback paste.</div>
    </div>

    <div class="faq">
      <details class="q">
        <summary>How does it work?</summary>
        <div class="a"><p>Bashroom is organized around rooms: a room is a durable project workspace, like <code>/rooms/my-app</code>, where agents keep the files they need for handoff.</p><p>When an agent runs a command, Bashroom starts a fresh cloud shell and mounts its rooms read-only, so normal bash — <code>cat</code>, <code>rg</code>, <code>git</code> — can inspect the same files another session sees. Durable mutations use structured tools with explicit conflict protection.</p><p><code>bashroom_edit</code> changes one uniquely named Markdown span through the room sequencer, <code>bashroom_write</code> creates or replaces a file, and bounded tree/read/search/stat tools retrieve context without booting Linux.</p></div>
      </details>
      <details class="q">
        <summary>How is it secure?</summary>
        <div class="a">Each account gets its own ephemeral sandbox and storage prefix. Only that account's allowed rooms are mounted, read-only, at <code>/rooms</code>. Structured tools authorize the exact room and path before reaching RoomText or R2. The account token stays in the local <code>bashroom mcp</code> process, so the model can use Bashroom without seeing the credential.</div>
      </details>
      <details class="q">
        <summary>How do you use it?</summary>
        <div class="a">For anything you'd otherwise re-explain to a new chat. Keep a standing <code>index.md</code> per project and tell any agent — <em>"read <code>/rooms/&lt;project&gt;/index.md</code> first"</em> — Claude, Codex, and a long-running worker on another machine all see the same files. Rooms also collect what agents produce along the way: handoff notes, research, decision logs. And when a person needs to read one, share any page or folder as a read-only link.</div>
      </details>
      <details class="q">
        <summary>How long will it stick around?</summary>
        <div class="a">It's cheap to run — room state is compact, R2 keeps a byte-for-byte recovery copy, and shells are ephemeral. If pricing ever changes it would become a small fee, not a rug-pull: rooms remain plain files, and <code>bashroom export</code> pulls everything out in one command.</div>
      </details>
    </div>

    <div class="foot">
      <div class="status">${statusLine}</div>
      <div>${footerLine}</div>
    </div>

  </div>

<script>
  function flashCopy(el, labelEl, original) {
    el.classList.add("copied");
    if (labelEl) labelEl.textContent = "copied";
    setTimeout(() => {
      el.classList.remove("copied");
      if (labelEl) labelEl.textContent = original;
    }, 1100);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.top = "-9999px";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
    } catch (_) { return false; }
  }
  const install = document.getElementById("install");
  const installLbl = document.getElementById("install-lbl");
  install.addEventListener("click", async () => {
    const cmd = install.querySelector(".cmd").textContent.trim();
    const ok = await copyText(cmd);
    if (ok) flashCopy(install, installLbl, "copy");
  });
  document.querySelectorAll(".cmd-row").forEach(row => {
    row.addEventListener("click", async () => {
      const cmd = row.dataset.cmd || row.querySelector(".cmd").textContent.trim();
      const ok = await copyText(cmd);
      if (ok) flashCopy(row, null, "");
    });
  });

  // Theme toggle: cycles light ⇄ dark, persists to localStorage.
  // First click flips relative to whatever's currently rendered (which may be
  // the OS default if the user hasn't toggled yet).
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      let next;
      if (current === "light") next = "dark";
      else if (current === "dark") next = "light";
      else {
        // Following OS — flip to the opposite of what's rendered now.
        const osDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        next = osDark ? "light" : "dark";
      }
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("bashroom.theme", next); } catch (_) {}
    });
  }
</script>
</body>
</html>`;
}
