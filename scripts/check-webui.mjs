// Extract the embedded SPA <script> from web-ui.ts and emit it as plain JS
// for `node --check`. CRITICAL: the HTML is produced by evaluating the
// source region AS A TEMPLATE LITERAL (new Function), which processes every
// escape sequence exactly like TypeScript/the browser will — a raw backtick,
// a bad escape, or a \n-broken regex fails HERE instead of in production.
// (The naive regex-unescape version of this script passed two real outages.)
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(process.argv[2], "utf8");
const marker = "const WEB_INDEX_HTML = `";
const start = src.indexOf(marker);
if (start === -1) { console.error("WEB_INDEX_HTML not found"); process.exit(1); }
const bodyStart = start + marker.length;
const end = src.lastIndexOf("`;");
const raw = src.slice(bodyStart, end);

let html;
try {
  html = new Function("return `" + raw + "`;")();
} catch (e) {
  console.error("TEMPLATE EVAL FAILED — the browser would receive broken output:");
  console.error("  " + (e && e.message));
  process.exit(1);
}

const m = html.match(/<script>\s*\(\(\) => \{[\s\S]*?\}\)\(\);\s*<\/script>/);
if (!m) { console.error("main script block not found in evaluated HTML"); process.exit(1); }
const js = m[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
writeFileSync(process.argv[3], js);
console.log("extracted", js.length, "chars (faithful template evaluation)");
