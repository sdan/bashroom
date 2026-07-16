import { ChangeSet, type ChangeDesc, type Text } from "@codemirror/state";
import type { ShareRole } from "./document-collab";

// ─── Selective undo ────────────────────────────────────────────────────────
// Local history for the collaborative editor. Invariants (Figma rule:
// undo-copy-redo must not change the document):
//   - the stacks hold inverses of this client's OWN changesets only;
//   - remote updates (receiveUpdates) NEVER enter history — they only remap
//     stored inverses, so an undo target survives concurrent edits;
//   - undo()/redo() return a brand-new forward changeset the caller submits
//     through the normal push pipeline — never a revision rollback.

export type CollabHistoryTransaction = {
  changes: ChangeSet;
  /** Document the changes apply to (state before this transaction). */
  docBefore: Text;
  /** True when the changes arrived from the authority (receiveUpdates). */
  remote?: boolean;
  /**
   * Wrapper-supplied CodeMirror-style flag. Origin wins over flags: a remote
   * transaction is never recorded even when a dispatch wrapper forces this
   * to true, and an own transaction with false remaps without recording.
   */
  addToHistory?: boolean;
  /**
   * Set on transactions this history itself emitted via undo()/redo(). The
   * stacks were already rotated for that op; recording or remapping it again
   * would corrupt them.
   */
  fromHistory?: boolean;
};

const MAX_HISTORY_DEPTH = 200;

export class SelectiveUndoHistory {
  private undone: ChangeSet[] = []; // inverses of own edits, oldest first
  private redone: ChangeSet[] = []; // inverses of undos, oldest first

  get undoDepth(): number {
    return this.undone.length;
  }

  get redoDepth(): number {
    return this.redone.length;
  }

  /** Single dispatch funnel: every applied transaction must pass through. */
  applyTransaction(tr: CollabHistoryTransaction): void {
    if (tr.fromHistory || tr.changes.empty) return;
    if (tr.remote || tr.addToHistory === false) {
      this.undone = mapBranch(this.undone, tr.changes.desc);
      this.redone = mapBranch(this.redone, tr.changes.desc);
      return;
    }
    this.undone.push(tr.changes.invert(tr.docBefore));
    if (this.undone.length > MAX_HISTORY_DEPTH) this.undone.shift();
    this.redone = []; // a fresh own edit invalidates redo; remote edits do not
  }

  /**
   * Pop the newest own inverse as a forward op against `doc` (the current
   * document). The caller dispatches it with { fromHistory: true } and pushes
   * it to the authority exactly like typing — a new revision, not a rollback.
   */
  undo(doc: Text): ChangeSet | null {
    return rotate(this.undone, this.redone, doc);
  }

  redo(doc: Text): ChangeSet | null {
    return rotate(this.redone, this.undone, doc);
  }
}

function rotate(from: ChangeSet[], to: ChangeSet[], doc: Text): ChangeSet | null {
  const changes = from.pop();
  if (!changes) return null;
  if (changes.length !== doc.length) {
    // A remote update reached the document without passing applyTransaction.
    throw new Error("selective undo history is out of sync with the document");
  }
  to.push(changes.invert(doc));
  return changes;
}

/**
 * Remap a stack of own inverses over one remote changeset. The newest entry
 * applies to the current document; each older entry applies to the document
 * its successors produce. Cascade the remote change down the stack, mapping
 * consistently in both directions (remote ordered before the inverse), and
 * drop inverses the remote edit fully absorbed — an empty mapped inverse is
 * an identity op, so deeper entries still line up.
 */
function mapBranch(branch: readonly ChangeSet[], remote: ChangeDesc): ChangeSet[] {
  const result: ChangeSet[] = [];
  let mapping = remote;
  for (let index = branch.length - 1; index >= 0; index--) {
    const inverse = branch[index];
    const mapped = inverse.map(mapping);
    mapping = mapping.mapDesc(inverse, true);
    if (!mapped.empty) result.push(mapped);
  }
  return result.reverse();
}

type CollaborativeShareHtmlOptions = {
  slug: string;
  role: Exclude<ShareRole, "view">;
  nonce: string;
};

// Authenticated collaboration shell for Comment / Edit links. The document
// body is deliberately absent from this HTML: the browser must prove a valid
// Bashroom identity before /web/api/shared returns owner-scoped R2 content.
export function webCollaborativeShareHtml({ slug, role, nonce }: CollaborativeShareHtmlOptions): string {
  const safeSlug = JSON.stringify(slug).replace(/</g, "\\u003c");
  const safeRole = JSON.stringify(role);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Shared document — Bashroom</title>
<meta name="robots" content="noindex" />
<link rel="preconnect" href="https://cdn.jsdelivr.net" />
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@13.0.2/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"></script>
<style>
  :root { --bg:#fff; --paper:#fff; --side:#f7f7f5; --hover:#efeeec; --active:#e8e6f5; --ink:#37352f; --dim:#6f6e69; --faint:#a3a29c; --rule:#ebeae6; --link:#4f3bd0; --comment:#f2b84b; --danger:#c93f34; --mono:ui-monospace,"SF Mono","Menlo","Consolas",monospace; --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Helvetica,Arial,sans-serif; --shadow:0 0 0 1px rgba(0,0,0,.06),0 1px 2px -1px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.06); }
  @media (prefers-color-scheme:dark) { :root { --bg:#191919; --paper:#191919; --side:#202020; --hover:#2a2a2a; --active:#2f2940; --ink:#e8e6e1; --dim:#9b9a94; --faint:#696862; --rule:#30302e; --link:#c8a8ff; --comment:#d8a23a; --danger:#ef7368; --shadow:0 0 0 1px rgba(255,255,255,.09); } }
  * { box-sizing:border-box; }
  html { -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 var(--sans); }
  button, textarea { font:inherit; }
  button { min-height:40px; border:0; border-radius:7px; padding:0 13px; color:var(--ink); background:var(--side); box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 10%,transparent); cursor:pointer; transition-property:background-color,box-shadow,scale; transition-duration:150ms; transition-timing-function:ease-out; }
  button:hover { background:var(--hover); box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 16%,transparent); }
  button:active { scale:.96; }
  button:focus-visible, textarea:focus-visible { outline:2px solid var(--link); outline-offset:2px; }
  button.primary { background:var(--ink); color:var(--bg); box-shadow:none; }
  button.quiet { background:transparent; box-shadow:none; color:var(--dim); }
  button.danger { color:var(--danger); }
  button[disabled] { opacity:.45; cursor:default; scale:1; }
  .topbar { position:sticky; top:0; z-index:20; min-height:56px; padding:8px 18px; display:flex; align-items:center; gap:12px; background:color-mix(in srgb,var(--bg) 90%,transparent); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); border-bottom:1px solid var(--rule); }
  .location { min-width:0; flex:1; }
  .path { font:600 12px/1.3 var(--mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .identity { margin-top:3px; color:var(--faint); font-size:11px; }
  .role { flex:none; padding:4px 9px; border-radius:999px; color:var(--link); background:var(--active); font:600 10px/1 var(--mono); text-transform:uppercase; letter-spacing:.06em; }
  .toolbar { display:flex; align-items:center; gap:7px; }
  .layout { width:min(1240px,100%); margin:0 auto; padding:34px 24px 120px; display:grid; grid-template-columns:minmax(0,820px) 300px; align-items:start; gap:38px; }
  .document { min-width:0; }
  article { font-size:16px; line-height:1.65; }
  article h1, article h2, article h3, article h4 { font-weight:600; line-height:1.3; margin-top:1.6em; margin-bottom:.4em; letter-spacing:-.01em; text-wrap:balance; }
  article h1 { margin-top:0; font-size:2.25em; } article h2 { font-size:1.5em; } article h3 { font-size:1.15em; }
  article p, article li, article blockquote { text-wrap:pretty; }
  article a { color:var(--link); text-decoration-thickness:1px; text-underline-offset:3px; }
  article code { font-family:var(--mono); font-size:.85em; background:var(--hover); padding:2px 6px; border-radius:3px; }
  article pre { margin:1.1em 0; padding:14px 16px; overflow:auto; border-radius:7px; background:var(--side); box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 8%,transparent); font:13px/1.55 var(--mono); }
  article pre code { padding:0; background:transparent; font-size:inherit; }
  article pre.ascii-diagram { tab-size:4; line-height:1.35; white-space:pre; }
  article pre.diagram-mermaid { padding:18px; text-align:center; background:var(--paper); }
  article pre.diagram-mermaid svg { display:block; max-width:100%; height:auto; margin:0 auto; }
  article blockquote { margin:1em 0; padding-left:14px; border-left:3px solid var(--ink); color:var(--dim); }
  article img { max-width:100%; outline:1px solid rgba(0,0,0,.1); outline-offset:-1px; }
  @media (prefers-color-scheme:dark) { article img { outline-color:rgba(255,255,255,.1); } }
  article table { border-collapse:collapse; font-size:14px; } article th, article td { border:1px solid var(--rule); padding:6px 10px; text-align:left; }
  .remote-caret { position:relative; display:inline-block; width:0; height:1.15em; vertical-align:-.18em; pointer-events:none; z-index:8; }
  .remote-caret::before { content:""; position:absolute; left:-1px; top:0; bottom:0; width:2px; border-radius:2px; background:var(--remote-color); animation:remote-caret-blink 1.05s steps(1,end) infinite; }
  .remote-caret-label { position:absolute; left:-2px; bottom:calc(100% + 2px); max-width:140px; padding:2px 5px; border-radius:4px 4px 4px 1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#191919; background:var(--remote-color); font:600 9.5px/1.25 var(--sans); box-shadow:0 1px 3px rgba(0,0,0,.18); }
  @keyframes remote-caret-blink { 0%,44%,100% { opacity:1; } 45%,78% { opacity:.18; } }
  mark.comment-anchor { padding:1px 0; color:inherit; background:color-mix(in srgb,var(--comment) 33%,transparent); border-bottom:2px solid var(--comment); cursor:pointer; }
  mark.comment-anchor.active { background:color-mix(in srgb,var(--comment) 55%,transparent); }
  .rail { position:sticky; top:78px; max-height:calc(100vh - 100px); overflow:auto; padding:2px; }
  .rail-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
  .rail-title { font-size:13px; font-weight:600; }
  .count { color:var(--faint); font:11px/1 var(--mono); font-variant-numeric:tabular-nums; }
  .comment-list { display:flex; flex-direction:column; gap:10px; }
  .comment-card, .composer { border-radius:10px; padding:12px; background:var(--paper); box-shadow:var(--shadow); }
  .comment-card.active { box-shadow:0 0 0 2px var(--comment),0 8px 24px rgba(0,0,0,.06); }
  .comment-card.resolved { opacity:.58; }
  .comment-byline { display:flex; align-items:baseline; gap:7px; font-size:11px; color:var(--faint); }
  .comment-author { color:var(--ink); font-weight:600; }
  .comment-quote { margin:8px 0; padding-left:8px; border-left:2px solid var(--comment); color:var(--dim); font-size:12px; line-height:1.45; overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
  .comment-body { font-size:13px; line-height:1.5; white-space:pre-wrap; text-wrap:pretty; }
  .comment-actions { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
  .comment-actions button { min-height:32px; padding:0 8px; font-size:11px; box-shadow:none; background:transparent; color:var(--dim); }
  .drift { color:var(--danger); font-size:10px; }
  .empty { color:var(--dim); font-size:13px; }
  .composer { display:none; margin-bottom:12px; }
  .composer.open { display:block; }
  .composer-quote { color:var(--dim); font-size:12px; margin-bottom:8px; max-height:54px; overflow:hidden; }
  textarea { width:100%; min-height:88px; resize:vertical; border:1px solid var(--rule); border-radius:6px; padding:9px 10px; color:var(--ink); background:var(--side); }
  .composer-actions, .editor-actions { display:flex; align-items:center; gap:7px; margin-top:8px; }
  .composer-actions button, .editor-actions button { min-height:36px; }
  .editor { display:none; }
  .editor.open { display:block; }
  .editor textarea { min-height:68vh; font:13px/1.55 var(--mono); padding:16px; }
  .status { min-height:20px; margin-top:8px; color:var(--dim); font-size:12px; }
  .status.error { color:var(--danger); }
  .selection-action { display:none; position:fixed; z-index:50; min-height:36px; color:var(--bg); background:var(--ink); box-shadow:0 8px 24px rgba(0,0,0,.18); }
  .selection-action.show { display:block; }
  .gate { max-width:440px; margin:15vh auto 0; padding:24px; border-radius:12px; background:var(--paper); box-shadow:var(--shadow); }
  .gate h1 { margin:0 0 8px; font-size:24px; text-wrap:balance; }
  .gate p { color:var(--dim); text-wrap:pretty; }
  .gate a { display:inline-flex; min-height:40px; align-items:center; margin-top:8px; padding:0 14px; border-radius:7px; color:var(--bg); background:var(--ink); text-decoration:none; font-weight:600; }
  .foot { margin-top:54px; padding-top:14px; border-top:1px solid var(--rule); color:var(--faint); font-size:11px; }
  .foot a { color:var(--dim); text-decoration:none; }
  @media (max-width:900px) { .layout { grid-template-columns:1fr; } .rail { position:static; max-height:none; border-top:1px solid var(--rule); padding-top:24px; } }
  @media (max-width:620px) { .topbar { align-items:flex-start; flex-wrap:wrap; } .location { flex-basis:calc(100% - 70px); } .toolbar { width:100%; } .toolbar button { flex:1; } .layout { padding:26px 18px 90px; } }
  @media (prefers-reduced-motion:reduce) { button { transition:none; } .remote-caret::before { animation:none; } }
</style>
</head>
<body>
<div id="app"><div class="gate"><h1>Opening shared document…</h1><p>Checking your Bashroom identity.</p></div></div>
<button id="selection-action" class="selection-action" type="button">Comment</button>
<script nonce="${nonce}">
(function(){
  "use strict";
  var slug = ${safeSlug};
  var role = ${safeRole};
  var tokenKey = "bashroom.token";
  var app = document.getElementById("app");
  var selectionAction = document.getElementById("selection-action");
  var state = { token: localStorage.getItem(tokenKey) || "", file:null, comments:[], handle:"", userId:"", owner:false, editing:false, pending:null, activeComment:"", mermaid:null, ws:null, viewers:0, draftTimer:0, draftLast:0, liveTimer:0, renderSeq:0, align:null };

  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>\"']/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"}[c]; });
  }
  function signInUrl(){ return "/web?return=" + encodeURIComponent(location.pathname + location.search); }
  function gate(message, error){
    app.innerHTML = '<div class="gate"><h1>' + (error ? 'Could not open this document' : 'Sign in to collaborate') + '</h1><p>' + esc(message) + '</p><a href="' + signInUrl() + '">Sign in to Bashroom</a></div>';
  }
  async function api(path, options){
    options = options || {};
    var headers = Object.assign({ authorization:"Bearer " + state.token }, options.headers || {});
    var response = await fetch(path, Object.assign({}, options, { headers:headers }));
    var data = await response.json().catch(function(){ return { ok:false, error:"invalid_response" }; });
    if (!response.ok || data.ok === false) {
      var err = new Error(data.error || "request_failed");
      err.status = response.status; err.data = data; throw err;
    }
    return data;
  }
  function timeAgo(value){
    var seconds = Math.max(1,Math.round((Date.now()-new Date(value).getTime())/1000));
    if (seconds < 60) return "just now";
    var minutes = Math.round(seconds/60); if (minutes < 60) return minutes + "m ago";
    var hours = Math.round(minutes/60); if (hours < 24) return hours + "h ago";
    return Math.round(hours/24) + "d ago";
  }
  function documentTextNodes(root){
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || parent.closest("svg,button,.comment-card,.composer,.remote-caret")) continue;
      out.push(node);
    }
    return out;
  }
  function documentText(root){ return documentTextNodes(root).map(function(node){ return node.data; }).join(""); }
  // ── Rendered <-> source alignment ─────────────────────────────────────
  // Comment anchors are canonical in raw Markdown SOURCE offsets: the server
  // remaps them through source ChangeSets (DocumentCollab.remapCommentAnchors
  // via mapRoomTextAnchors) and MCP agents post source offsets. The browser
  // only ever sees rendered DOM text, so each render builds ONE greedy
  // two-pointer subsequence alignment of the concatenated text nodes against
  // the source. Markdown syntax (#, **, [, ](url), fence lines) exists only
  // in the source and is skipped as a gap; HTML entities in the source
  // (&lt; -> <) are decoded in place; whitespace is soft on both sides
  // because marked inserts block-boundary newlines the source lacks. If any
  // visible rendered character has no source origin the alignment is null
  // and every consumer FAILS CLOSED: no comment offer, anchors surface as
  // drift ("Text moved") — never a guessed highlight.
  var SOFT_SPACE = /\\s/;
  var NAMED_ENTITIES = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'", nbsp:"\\u00a0", copy:"\\u00a9", reg:"\\u00ae", trade:"\\u2122", hellip:"\\u2026", mdash:"\\u2014", ndash:"\\u2013", lsquo:"\\u2018", rsquo:"\\u2019", ldquo:"\\u201c", rdquo:"\\u201d", laquo:"\\u00ab", raquo:"\\u00bb", times:"\\u00d7", middot:"\\u00b7", sect:"\\u00a7", para:"\\u00b6", deg:"\\u00b0", plusmn:"\\u00b1", bull:"\\u2022", dagger:"\\u2020", larr:"\\u2190", rarr:"\\u2192" };
  function decodeEntityAt(text, index){
    if (text.charCodeAt(index) !== 38) return null;
    var match = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(text.slice(index, index + 34));
    if (!match) return null;
    var body = match[1], ch = null;
    if (body.charAt(0) === "#") {
      var code = body.charAt(1) === "x" || body.charAt(1) === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (code >= 32 && code <= 65535 && !(code >= 55296 && code <= 57343)) ch = String.fromCharCode(code);
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) ch = NAMED_ENTITIES[body];
    if (!ch || ch.length !== 1) return null;
    return { ch: ch, length: match[0].length };
  }
  function buildSourceAlignment(rendered, source){
    rendered = String(rendered == null ? "" : rendered); source = String(source == null ? "" : source);
    var hardIdx = [], hardStart = [], hardEnd = [], cursor = 0;
    for (var r = 0; r < rendered.length; r++) {
      var c = rendered.charAt(r);
      if (SOFT_SPACE.test(c)) continue; // block-boundary newlines etc. need not line up 1:1
      var scan = cursor, matched = false;
      while (scan < source.length) {
        if (source.charAt(scan) === c) { hardIdx.push(r); hardStart.push(scan); hardEnd.push(scan + 1); cursor = scan + 1; matched = true; break; }
        var entity = decodeEntityAt(source, scan);
        if (entity && entity.ch === c) { hardIdx.push(r); hardStart.push(scan); hardEnd.push(scan + entity.length); cursor = scan + entity.length; matched = true; break; }
        scan++;
      }
      if (!matched) return null; // a visible char with no source origin: fail closed
    }
    return { source:source, renderedLength:rendered.length, hardIdx:hardIdx, hardStart:hardStart, hardEnd:hardEnd };
  }
  function lowerBound(values, limit){
    var lo = 0, hi = values.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (values[mid] >= limit) hi = mid; else lo = mid + 1; }
    return lo;
  }
  function renderedRangeToSource(align, start, end){
    if (!align || !(end > start) || start < 0 || end > align.renderedLength) return null;
    var first = lowerBound(align.hardIdx, start);
    if (first >= align.hardIdx.length || align.hardIdx[first] >= end) return null; // whitespace-only selection
    var last = lowerBound(align.hardIdx, end) - 1;
    return { start:align.hardStart[first], end:align.hardEnd[last] };
  }
  function sourceRangeToRendered(align, start, end){
    if (!align || !(end > start) || start < 0) return null;
    var first = lowerBound(align.hardEnd, start + 1); // first visible char whose source extent ends past start
    var afterLast = lowerBound(align.hardStart, end); // visible chars starting at/after end are outside
    if (first >= afterLast) return null; // anchor covers no visible text: drift, never a guess
    return { start:align.hardIdx[first], end:align.hardIdx[afterLast - 1] + 1 };
  }
  function renderedPointFromSource(align, offset){
    var index = lowerBound(align.hardEnd, offset + 1);
    return index < align.hardIdx.length ? align.hardIdx[index] : align.renderedLength;
  }
  function offsetsForSelection(root, range){
    if (range.startContainer.nodeType !== Node.TEXT_NODE || range.endContainer.nodeType !== Node.TEXT_NODE) return null;
    var nodes = documentTextNodes(root), start = 0, end = 0, foundStart = false, foundEnd = false;
    for (var i=0;i<nodes.length;i++) {
      if (nodes[i] === range.startContainer) { start += range.startOffset; foundStart = true; }
      else if (!foundStart) start += nodes[i].data.length;
      if (nodes[i] === range.endContainer) { end += range.endOffset; foundEnd = true; break; }
      end += nodes[i].data.length;
    }
    if (!foundStart || !foundEnd || end <= start) return null;
    // Rendered offsets are only a waypoint: the stored anchor is SOURCE
    // offsets and the quote is the raw source slice (markers included).
    // Require an alignment for the exact saved document — while a live
    // draft is rendered (align.source is the draft) commenting is refused
    // rather than anchored against the wrong document.
    var align = state.align;
    if (!align || !state.file || align.source !== state.file.content) return null;
    var full = documentText(root), raw = full.slice(start,end), left = raw.length - raw.trimStart().length, trimmed = raw.trim();
    if (!trimmed) return null;
    var src = renderedRangeToSource(align, start+left, start+left+trimmed.length);
    if (!src) return null;
    var quote = align.source.slice(src.start, src.end);
    if (!quote || quote.length > 2000) return null;
    return { anchor_start:src.start, anchor_end:src.end, quote:quote };
  }
  function resolvedAnchor(comment, source, align){
    // Stored offsets are the anchor authority IN SOURCE COORDINATES: the
    // server maps them through every accepted update (assoc -1 start / +1
    // end) and rewrites them via DocumentCollab.remapCommentAnchors. The
    // quote must equal the raw source slice, then the alignment projects
    // the range into rendered coordinates for the <mark>. There is no
    // quote-substring fallback — a moved or repeated quote must surface as
    // drift ("Text moved"), never highlight a guessed occurrence.
    var start = Number(comment.anchor_start), end = Number(comment.anchor_end);
    if (!(end > start) || source.slice(start,end) !== comment.quote) return null;
    return sourceRangeToRendered(align, start, end);
  }
  function wrapAnchor(root, anchor, id){
    var nodes = documentTextNodes(root), cursor = 0;
    for (var i=0;i<nodes.length;i++) {
      var node = nodes[i], next = cursor + node.data.length;
      var from = Math.max(anchor.start,cursor), to = Math.min(anchor.end,next);
      if (to > from) {
        var range = document.createRange();
        range.setStart(node,from-cursor); range.setEnd(node,to-cursor);
        var mark = document.createElement("mark");
        mark.className = "comment-anchor" + (state.activeComment === id ? " active" : "");
        mark.dataset.commentId = id;
        try { range.surroundContents(mark); } catch (_) {}
      }
      cursor = next;
      if (cursor >= anchor.end) break;
    }
  }
  function applyAnchors(source){
    var article = document.getElementById("doc"); if (!article) return;
    var align = state.align;
    state.comments.filter(function(c){ return !c.resolved_at; }).slice().sort(function(a,b){ return b.anchor_start-a.anchor_start; }).forEach(function(comment){
      var anchor = resolvedAnchor(comment,source,align); comment._anchor = anchor;
      if (anchor) wrapAnchor(article,anchor,comment.id);
    });
    article.querySelectorAll("mark.comment-anchor").forEach(function(mark){ mark.onclick = function(){ activateComment(mark.dataset.commentId || ""); }; });
  }
  async function enhanceDiagrams(article){
    var mermaidNodes = [];
    article.querySelectorAll("pre > code").forEach(function(code){
      var classes = Array.from(code.classList), language = "";
      classes.forEach(function(name){ if (name.indexOf("language-") === 0) language = name.slice(9).toLowerCase(); });
      var pre = code.parentElement; if (!pre) return;
      if (language === "mermaid") {
        pre.className = "diagram-mermaid"; pre.textContent = code.textContent || ""; mermaidNodes.push(pre);
      } else if (["ascii","text","plaintext","diagram","art"].indexOf(language) !== -1) {
        pre.classList.add("ascii-diagram");
      }
    });
    if (!mermaidNodes.length) return;
    try {
      if (!state.mermaid) {
        state.mermaid = import("https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs").then(function(mod){
          var instance = mod.default;
          instance.initialize({ startOnLoad:false, securityLevel:"strict", theme:matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default", fontFamily:'-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif' });
          return instance;
        });
      }
      var mermaid = await state.mermaid;
      await mermaid.run({ nodes:mermaidNodes, suppressErrors:true });
    } catch (_) { mermaidNodes.forEach(function(node){ node.classList.add("ascii-diagram"); }); }
  }
  async function renderMarkdown(source){
    var seq = ++state.renderSeq;
    var article = document.getElementById("doc"); if (!article) return;
    var text = String(source == null ? "" : source);
    article.innerHTML = DOMPurify.sanitize(marked.parse(text));
    await enhanceDiagrams(article);
    if (seq !== state.renderSeq) return false;
    // Align AFTER enhanceDiagrams on purpose: mermaid replaces code text
    // with SVG that documentTextNodes skips, so the alignment and the
    // anchor walker always see the same rendered text. A mermaid block is
    // therefore a pure source-side gap; selections inside SVG were already
    // rejected by inspectSelection.
    state.align = buildSourceAlignment(documentText(article), text);
    applyAnchors(text);
    return true;
  }
  function actorCursorColor(actor){
    var name = String(actor || "").toLowerCase();
    if (name.indexOf("claude") !== -1) return "#e8a68f";
    if (name.indexOf("codex") !== -1) return "#9cc0e8";
    if (name === String(state.handle || "").toLowerCase()) return "#8fc09a";
    return "#d9bc85";
  }
  function renderedCaretOffset(source,rawCaret){
    var content = String(source || ""), caret = Math.max(0,Math.min(Number(rawCaret) || 0,content.length));
    var marker = String.fromCharCode(0xe000,0xe001,0xe002);
    while (content.indexOf(marker) !== -1) marker += String.fromCharCode(0xe003);
    var probe = document.createElement("div");
    try {
      probe.innerHTML = DOMPurify.sanitize(marked.parse(content.slice(0,caret) + marker + content.slice(caret)));
      var visible = probe.textContent || "", found = visible.indexOf(marker);
      if (found !== -1) return found;
      probe.innerHTML = DOMPurify.sanitize(marked.parse(content.slice(0,caret)));
      return (probe.textContent || "").length;
    } catch (_) { return 0; }
  }
  function placeRemoteCaret(article,source,caret,actor){
    if (!article) return;
    article.querySelectorAll(".remote-caret").forEach(function(node){ node.remove(); });
    var content = String(source == null ? "" : source), clamped = Math.max(0,Math.min(Number(caret) || 0,content.length));
    // The alignment renderMarkdown just built maps the caret without a
    // second marked.parse; the sentinel probe survives as the fallback for
    // documents the aligner refused.
    var remaining = state.align && state.align.source === content ? renderedPointFromSource(state.align,clamped) : renderedCaretOffset(content,clamped);
    // Walk the SAME filtered node set the alignment was built over —
    // renderedPointFromSource offsets are documentTextNodes coordinates, so
    // an ad-hoc walker with a different filter (raw <button> HTML in the
    // document, say) would place the caret in the wrong spot.
    var nodes = documentTextNodes(article), target = null, localOffset = 0, last = null;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      last = node;
      if (remaining <= node.data.length) { target = node; localOffset = remaining; break; }
      remaining -= node.data.length;
    }
    if (!target && last) { target = last; localOffset = last.data.length; }
    var cursor = document.createElement("span");
    cursor.className = "remote-caret";
    cursor.style.setProperty("--remote-color",actorCursorColor(actor));
    cursor.setAttribute("role","img"); cursor.setAttribute("aria-label",String(actor || "Someone") + " cursor");
    var label = document.createElement("span"); label.className = "remote-caret-label"; label.textContent = String(actor || "Someone"); cursor.appendChild(label);
    if (target) {
      var range = document.createRange(); range.setStart(target,Math.max(0,Math.min(localOffset,target.data.length))); range.collapse(true); range.insertNode(cursor);
    } else article.appendChild(cursor);
    cursor.scrollIntoView({ block:"nearest", inline:"nearest" });
  }
  async function renderLiveDraft(source,caret,actor){
    if (await renderMarkdown(source)) placeRemoteCaret(document.getElementById("doc"),source,caret,actor);
  }
  function canResolve(comment){ return role === "edit" || state.owner || comment.author_user_id === state.userId; }
  function commentsHtml(){
    if (!state.comments.length) return '<div class="empty">Select text in the document to start a comment.</div>';
    return state.comments.map(function(comment){
      var active = state.activeComment === comment.id ? " active" : "";
      var resolved = comment.resolved_at ? " resolved" : "";
      var drift = !comment.resolved_at && !comment._anchor ? '<span class="drift">Text moved</span>' : '';
      var resolve = !comment.resolved_at && canResolve(comment) ? '<button type="button" data-resolve="' + esc(comment.id) + '">Resolve</button>' : '<span></span>';
      return '<div class="comment-card' + active + resolved + '" data-comment="' + esc(comment.id) + '">'
        + '<div class="comment-byline"><span class="comment-author">@' + esc(comment.author) + '</span><span>' + esc(timeAgo(comment.created_at)) + '</span></div>'
        + '<div class="comment-quote">' + esc(comment.quote) + '</div><div class="comment-body">' + esc(comment.body) + '</div>'
        + '<div class="comment-actions">' + resolve + drift + (comment.resolved_at ? '<span>resolved</span>' : '') + '</div></div>';
    }).join("");
  }
  function renderComments(){
    var list = document.getElementById("comment-list"), count = document.getElementById("comment-count");
    if (!list || !count) return;
    var open = state.comments.filter(function(c){ return !c.resolved_at; }).length;
    count.textContent = String(open) + " open"; list.innerHTML = commentsHtml();
    list.querySelectorAll("[data-comment]").forEach(function(card){ card.onclick = function(){ activateComment(card.dataset.comment || ""); }; });
    list.querySelectorAll("[data-resolve]").forEach(function(button){ button.onclick = function(event){ event.stopPropagation(); void resolveComment(button.dataset.resolve || ""); }; });
  }
  function activateComment(id){
    state.activeComment = id; renderComments();
    document.querySelectorAll("mark.comment-anchor").forEach(function(mark){ mark.classList.toggle("active",mark.dataset.commentId === id); });
    var card = document.querySelector('[data-comment="' + CSS.escape(id) + '"]'); if (card) card.scrollIntoView({ block:"nearest", behavior:"smooth" });
  }
  function openComposer(pending){
    state.pending = pending; selectionAction.classList.remove("show");
    var composer = document.getElementById("composer"), quote = document.getElementById("composer-quote"), input = document.getElementById("comment-body");
    if (!composer || !quote || !input) return;
    composer.classList.add("open"); quote.textContent = '“' + pending.quote + '”'; input.value = ""; input.focus();
  }
  function closeComposer(){ state.pending = null; var composer = document.getElementById("composer"); if (composer) composer.classList.remove("open"); }
  function inspectSelection(){
    if (state.editing) return;
    var article = document.getElementById("doc"), selection = getSelection();
    if (!article || !selection || selection.rangeCount === 0 || selection.isCollapsed) { selectionAction.classList.remove("show"); return; }
    var range = selection.getRangeAt(0), startEl = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
    if (!startEl || !article.contains(startEl) || startEl.closest("svg")) { selectionAction.classList.remove("show"); return; }
    var pending = offsetsForSelection(article,range); if (!pending) { selectionAction.classList.remove("show"); return; }
    var rect = range.getBoundingClientRect();
    selectionAction.style.left = Math.max(8,Math.min(innerWidth-110,rect.left+rect.width/2-45)) + "px";
    selectionAction.style.top = Math.max(8,rect.top-44) + "px";
    selectionAction.classList.add("show"); selectionAction.onclick = function(){ openComposer(pending); };
  }
  async function addComment(){
    var input = document.getElementById("comment-body"), button = document.getElementById("comment-submit");
    if (!input || !state.pending || !input.value.trim()) return;
    button.disabled = true;
    try {
      var data = await api("/web/api/shared/comment",{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ slug:slug, body:input.value, anchor_start:state.pending.anchor_start, anchor_end:state.pending.anchor_end, quote:state.pending.quote, document_etag:state.file.etag }) });
      state.comments = data.comments || []; closeComposer(); await renderMarkdown(state.file.content); renderComments();
    } catch (error) { setStatus(error.message || "comment_failed",true); }
    finally { button.disabled = false; }
  }
  async function resolveComment(id){
    try {
      var data = await api("/web/api/shared/comment",{ method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ slug:slug, comment_id:id }) });
      state.comments = data.comments || []; state.activeComment = ""; await renderMarkdown(state.file.content); renderComments();
    } catch (error) { setStatus(error.message || "resolve_failed",true); }
  }
  function setStatus(message,error){ var el = document.getElementById("status"); if (!el) return; el.textContent = message || ""; el.classList.toggle("error",Boolean(error)); }
  function paintIdentity(){
    var el = document.getElementById("identity"); if (!el) return;
    el.textContent = "Signed in as @" + state.handle + (state.viewers > 1 ? " · " + state.viewers + " viewing" : "");
  }
  function sendDraft(){
    if (role !== "edit" || !state.ws || state.ws.readyState !== 1) return;
    var input = document.getElementById("document-source");
    if (!input || input.value.length > 262144) return;
    try { state.ws.send(JSON.stringify({ type:"draft", path:state.file.path, caret:input.selectionStart || 0, content:input.value })); } catch (_) {}
  }
  function streamDraft(){
    var now = Date.now(), wait = 250 - (now - state.draftLast);
    if (wait <= 0) { clearTimeout(state.draftTimer); state.draftLast = now; sendDraft(); return; }
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(function(){ state.draftLast = Date.now(); sendDraft(); },wait);
  }
  function toggleEdit(){
    if (role !== "edit") return;
    state.editing = !state.editing;
    var article = document.getElementById("doc"), editor = document.getElementById("editor-pane"), button = document.getElementById("edit-toggle"), input = document.getElementById("document-source");
    if (!article || !editor || !button || !input) return;
    article.hidden = state.editing; editor.classList.toggle("open",state.editing); button.textContent = state.editing ? "Preview" : "Edit";
    if (state.editing) { input.value = state.file.content; input.focus(); }
    else void renderMarkdown(input.value);
  }
  async function saveDocument(){
    var input = document.getElementById("document-source"), button = document.getElementById("save-document"); if (!input) return;
    button.disabled = true; setStatus("Saving…",false);
    try {
      var data = await api("/web/api/shared",{ method:"PUT", headers:{"content-type":"application/json"}, body:JSON.stringify({ slug:slug, content:input.value, base_etag:state.file.etag }) });
      state.file = data.file; state.editing = false; document.getElementById("editor-pane").classList.remove("open"); document.getElementById("doc").hidden = false; document.getElementById("edit-toggle").textContent = "Edit";
      await renderMarkdown(state.file.content); setStatus("Saved",false);
    } catch (error) {
      if (error.status === 412) setStatus("Someone else saved first. Copy your draft, then reload the latest version.",true);
      else setStatus(error.message || "save_failed",true);
    } finally { button.disabled = false; }
  }
  function shell(){
    document.title = state.file.path + " — Bashroom";
    app.innerHTML = '<header class="topbar"><div class="location"><div class="path">' + esc(state.room) + '/' + esc(state.file.path) + '</div><div class="identity" id="identity"></div></div><span class="role">' + esc(role) + '</span><div class="toolbar">'
      + (role === "edit" ? '<button id="edit-toggle" type="button">Edit</button>' : '') + '<button id="copy-link" class="quiet" type="button">Copy link</button></div></header>'
      + '<main class="layout"><section class="document"><article id="doc"></article><div id="editor-pane" class="editor"><textarea id="document-source" spellcheck="false"></textarea><div class="editor-actions"><button id="save-document" class="primary" type="button">Save changes</button><button id="cancel-edit" type="button">Cancel</button></div></div><div id="status" class="status" aria-live="polite"></div><div class="foot">shared via <a href="https://bashroom.sdan.io">bashroom</a> — a filesystem for agents</div></section>'
      + '<aside class="rail"><div class="rail-head"><span class="rail-title">Comments</span><span id="comment-count" class="count"></span></div><div id="composer" class="composer"><div id="composer-quote" class="composer-quote"></div><textarea id="comment-body" placeholder="Add a comment…" maxlength="8000"></textarea><div class="composer-actions"><button id="comment-submit" class="primary" type="button">Comment</button><button id="comment-cancel" type="button">Cancel</button></div></div><div id="comment-list" class="comment-list"></div></aside></main>';
    var edit = document.getElementById("edit-toggle"); if (edit) edit.onclick = toggleEdit;
    document.getElementById("copy-link").onclick = async function(){ var ok = false; try { await navigator.clipboard.writeText(location.href); ok = true; } catch (_) {} this.textContent = ok ? "Copied" : "Copy failed"; var self=this; setTimeout(function(){ self.textContent="Copy link"; },1200); };
    document.getElementById("comment-submit").onclick = function(){ void addComment(); };
    document.getElementById("comment-cancel").onclick = closeComposer;
    var save = document.getElementById("save-document"); if (save) save.onclick = function(){ void saveDocument(); };
    var cancel = document.getElementById("cancel-edit"); if (cancel) cancel.onclick = toggleEdit;
    var source = document.getElementById("document-source");
    if (source) { source.oninput = streamDraft; source.onkeyup = streamDraft; source.onpointerup = streamDraft; source.onfocus = streamDraft; }
    paintIdentity();
  }
  async function load(initial){
    if (!state.token) { gate("Comment and Edit links require a named Bashroom account so changes have an audit trail.",false); return; }
    try {
      var data = await api("/web/api/shared?slug=" + encodeURIComponent(slug));
      if (!state.editing || initial) state.file = data.file;
      state.comments = data.comments || []; state.handle = data.handle || "user"; state.userId = data.user_id || ""; state.owner = Boolean(data.owner); state.room = data.room || "";
      if (initial) { shell(); await renderMarkdown(state.file.content); }
      else if (!state.editing) await renderMarkdown(state.file.content);
      renderComments();
    } catch (error) {
      if (error.status === 401) { localStorage.removeItem(tokenKey); state.token = ""; gate("Your Bashroom token is missing or expired. Sign in again to continue.",false); }
      else gate(error.message || "The link may have been revoked.",true);
    }
  }
  function connect(){
    var scheme = location.protocol === "https:" ? "wss://" : "ws://";
    var ws = new WebSocket(scheme + location.host + "/web/api/presence?slug=" + encodeURIComponent(slug),["bashroom","tok." + state.token]);
    state.ws = ws;
    var ping = setInterval(function(){ try { ws.send("ping"); } catch (_) {} },45000);
    ws.onmessage = function(event){
      var message; try { message=JSON.parse(event.data); } catch (_) { return; }
      if (message.type === "hello" || message.type === "viewers") { state.viewers = Number(message.viewers || 0); paintIdentity(); return; }
      if (message.path !== (state.file && state.file.path)) return;
      if (message.type === "comment") void load(false);
      if (message.type === "draft") {
        if (state.editing) setStatus((message.actor || "Someone") + " is editing this document too. Your save will be conflict-checked.",true);
        else {
          setStatus((message.actor || "Someone") + " is editing…",false);
          void renderLiveDraft(message.content || "",message.caret,message.actor || "Someone");
          clearTimeout(state.liveTimer);
          state.liveTimer = setTimeout(function(){ setStatus("",false); void load(false); },3500);
        }
      }
      if (message.type === "write") { clearTimeout(state.liveTimer); if (state.editing) setStatus("A newer version was saved while you are editing.",true); else void load(false); }
    };
    ws.onclose = function(){ if (state.ws === ws) state.ws = null; clearInterval(ping); setTimeout(connect,5000); };
  }
  document.addEventListener("selectionchange",function(){ setTimeout(inspectSelection,0); });
  window.addEventListener("resize",function(){ selectionAction.classList.remove("show"); });
  void load(true).then(function(){ if (state.file) connect(); });
})();
</script>
</body>
</html>`;
}
