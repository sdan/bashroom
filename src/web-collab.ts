import type { ShareRole } from "./document-collab";

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
  var state = { token: localStorage.getItem(tokenKey) || "", file:null, comments:[], handle:"", userId:"", owner:false, editing:false, pending:null, activeComment:"", mermaid:null, ws:null, viewers:0, draftTimer:0, draftLast:0, liveTimer:0, renderSeq:0 };

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
    var full = documentText(root), raw = full.slice(start,end), left = raw.length - raw.trimStart().length, quote = raw.trim();
    if (!quote || quote.length > 2000) return null;
    return { anchor_start:start+left, anchor_end:start+left+quote.length, quote:quote };
  }
  function resolvedAnchor(comment, text){
    var start = Number(comment.anchor_start), end = Number(comment.anchor_end);
    if (text.slice(start,end) === comment.quote) return { start:start, end:end, drifted:false };
    var first = text.indexOf(comment.quote);
    if (first !== -1 && text.indexOf(comment.quote,first+1) === -1) return { start:first, end:first+comment.quote.length, drifted:true };
    return null;
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
  function applyAnchors(){
    var article = document.getElementById("doc"); if (!article) return;
    var text = documentText(article);
    state.comments.filter(function(c){ return !c.resolved_at; }).slice().sort(function(a,b){ return b.anchor_start-a.anchor_start; }).forEach(function(comment){
      var anchor = resolvedAnchor(comment,text); comment._anchor = anchor;
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
    article.innerHTML = DOMPurify.sanitize(marked.parse(source || ""));
    await enhanceDiagrams(article);
    if (seq !== state.renderSeq) return false;
    applyAnchors();
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
    var remaining = renderedCaretOffset(source,caret), walker = document.createTreeWalker(article,NodeFilter.SHOW_TEXT);
    var node = null, target = null, localOffset = 0, last = null;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || parent.closest("svg,.remote-caret,script,style")) continue;
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
