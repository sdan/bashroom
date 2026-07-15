// Bashroom device-flow OAuth pages.
//
// /device?code=XXXX-XXXX  — confirm-the-code page; clicking "Sign in" sends
//                            the user to /auth/github with the code in the URL.
// (post-callback)         — webDeviceResultHtml() renders the success/failure
//                            terminal page the user lands on after GitHub.
//
// Visual language mirrors web-landing.ts (cream surface, hairline borders,
// orange CTA, Inter + JetBrains Mono). Single inline HTML, no build.

function shellHead(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Bashroom</title>
<link rel="preconnect" href="https://pingpong.sdan.io" crossorigin />
<link rel="dns-prefetch" href="https://pingpong.sdan.io" />
<script defer src="https://pingpong.sdan.io/client.js" data-site="bashroom.sdan.io" data-presence="true"></script>
<script>
  (function() {
    try {
      var saved = localStorage.getItem("bashroom.theme");
      if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
    } catch (_) {}
  })();
</script>
<style>
  :root {
    --bg: #FFFFFF; --surface: #F7F7F5; --rule: #EBEAE6; --rule-strong: #DADAD5;
    --ink: #37352F; --ink-muted: #6F6E69; --ink-faint: #A3A29C;
    --accent: #4F3BD0; --accent-on: #FFFFFF; --green: #1F8A65;
    --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #191919; --surface: #202020; --rule: #2A2A2A; --rule-strong: #3A3A3A;
      --ink: #E8E6E1; --ink-muted: #9B9A94; --ink-faint: #6F6F6A;
      --accent: #C8A8FF; --accent-on: #191919;
    }
  }
  :root[data-theme="dark"] {
    --bg: #191919; --surface: #202020; --rule: #2A2A2A; --rule-strong: #3A3A3A;
    --ink: #E8E6E1; --ink-muted: #9B9A94; --ink-faint: #6F6F6A;
    --accent: #C8A8FF; --accent-on: #191919;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
  body { padding: 0 24px; }
  a { color: inherit; text-decoration: none; }
  .shell { max-width: 520px; margin: 0 auto; padding: 80px 0 60px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; color: var(--ink); }
  .brand .mark { height: 22px; width: auto; flex-shrink: 0; color: var(--ink); display: inline-flex; align-items: center; }
  .brand .name { font-size: 16px; font-weight: 500; letter-spacing: -0.01em; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 10px; color: var(--ink); }
  p { font-size: 14px; line-height: 1.55; color: var(--ink-muted); margin: 0 0 18px; }
  .code-card { background: var(--surface); border: 1px solid var(--rule-strong); padding: 28px 24px; margin: 24px 0 18px; text-align: center; }
  .code-label { font-family: var(--sans); font-size: 11px; color: var(--ink-muted); letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 14px; }
  .code-value { font-family: var(--mono); font-size: 28px; font-weight: 500; letter-spacing: 0.08em; color: var(--ink); }
  .check { font-size: 13px; color: var(--ink-muted); margin: 18px 0 22px; }
  .btn { display: inline-flex; align-items: center; gap: 10px; background: var(--accent); color: var(--accent-on); padding: 11px 18px; font-family: var(--sans); font-size: 14px; font-weight: 500; border: 0; cursor: pointer; transition: filter 140ms ease; text-decoration: none; }
  .btn:hover { filter: brightness(1.05); }
  .btn svg { width: 16px; height: 16px; }
  .btn.full { display: flex; width: 100%; justify-content: center; }
  .muted { color: var(--ink-faint); font-size: 12px; }
  .ok { color: var(--green); font-weight: 500; }
  .err { color: var(--accent); font-weight: 500; }
  .terminal {
    background: var(--surface); border: 1px solid var(--rule); padding: 16px 18px;
    font-family: var(--mono); font-size: 12px; line-height: 1.5; color: var(--ink-muted);
    white-space: pre-wrap; margin: 16px 0 24px; border-radius: 4px;
  }
</style>
</head>
<body>
  <div class="shell">
    <a class="brand" href="/">
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
      <span class="name">bashroom</span>
    </a>`;
}

const SHELL_FOOT = `  </div>
</body>
</html>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function webDeviceHtml(code: string): string {
  const safeCode = escapeHtml(code);
  if (!safeCode) {
    return `${shellHead("Device sign-in")}
    <h1>Open this page from your CLI.</h1>
    <p>Run <code style="font-family:var(--mono);background:var(--surface);padding:2px 6px;border:1px solid var(--rule);border-radius:3px">bashroom login</code> in your terminal — it'll print a URL with a code.</p>
${SHELL_FOOT}`;
  }
  return `${shellHead("Confirm device code")}
    <h1>Confirm device code</h1>
    <p>Make sure this code matches what's shown in your terminal. If it doesn't, close this page.</p>

    <div class="code-card">
      <div class="code-label">Your code</div>
      <div class="code-value">${safeCode}</div>
    </div>

    <p class="check">Matches your terminal? Continue with GitHub to finish signing in.</p>

    <a class="btn full" href="/auth/github?code=${encodeURIComponent(code)}">
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.36c-2.22.48-2.69-1.07-2.69-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.88 2.34.67.07-.52.28-.88.51-1.08-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0z"/></svg>
      Continue with GitHub
    </a>

    <p class="muted" style="margin-top:18px">Bashroom only reads your public GitHub profile (id and username). No repo access, no email.</p>
${SHELL_FOOT}`;
}

export function webDeviceResultHtml(result: { ok: boolean; message: string }): string {
  const cls = result.ok ? "ok" : "err";
  const title = result.ok ? "Signed in" : "Sign-in failed";
  return `${shellHead(title)}
    <h1>${result.ok ? "You're signed in." : "Couldn't sign in."}</h1>
    <p class="${cls}">${escapeHtml(result.message)}</p>
    ${result.ok ? '<div class="terminal">Return to your terminal — bashroom should pick up your token within a few seconds.</div>' : ''}
    <p class="muted">${result.ok ? '' : 'Try running <code style="font-family:var(--mono);background:var(--surface);padding:2px 6px;border:1px solid var(--rule);border-radius:3px">bashroom login</code> again.'}</p>
${SHELL_FOOT}`;
}
