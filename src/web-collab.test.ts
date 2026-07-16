import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { changeSetFromWire, changeSetToWire } from "./room-text";
import { SelectiveUndoHistory, webCollaborativeShareHtml } from "./web-collab";

function doc(content: string): Text {
  return Text.of(content.split("\n"));
}

describe("SelectiveUndoHistory", () => {
  it("undoes only the local edit at the remapped position; redo leaves remote text untouched", () => {
    const history = new SelectiveUndoHistory();
    // A types " world" at the end.
    const doc0 = doc("hello");
    const aTyped = ChangeSet.of({ from: 5, insert: " world" }, doc0.length);
    const doc1 = aTyped.apply(doc0); // "hello world"
    history.applyTransaction({ changes: aTyped, docBefore: doc0 });
    expect(history.undoDepth).toBe(1);

    // B's update inserts at position 0 and arrives through receiveUpdates —
    // it must remap A's stored inverse, never join A's history.
    const bTyped = ChangeSet.of({ from: 0, insert: ">> " }, doc1.length);
    const doc2 = bTyped.apply(doc1); // ">> hello world"
    history.applyTransaction({ changes: bTyped, docBefore: doc1, remote: true });
    expect(history.undoDepth).toBe(1);

    // A undoes: the inverse is a brand-new forward op through the normal
    // push pipeline wire format, deleting A's text at the REMAPPED range.
    const undoOp = history.undo(doc2);
    expect(undoOp).not.toBeNull();
    const undoWire = changeSetToWire(undoOp!);
    expect(undoWire).toEqual([{ from: 8, to: 14, insert: "" }]);
    // Never a revision rollback: the op applies to the CURRENT document.
    const doc3 = changeSetFromWire(undoWire, doc2.length).apply(doc2);
    expect(doc3.toString()).toBe(">> hello");

    // The emitted op returns through the dispatch funnel marked fromHistory;
    // it must not be recorded or remapped a second time.
    history.applyTransaction({ changes: undoOp!, docBefore: doc2, fromHistory: true });
    expect(history.redoDepth).toBe(1);

    // A redoes: B's text stays untouched and the document round-trips
    // exactly (Figma rule: undo-copy-redo must not change the document).
    const redoOp = history.redo(doc3);
    expect(redoOp).not.toBeNull();
    const doc4 = changeSetFromWire(changeSetToWire(redoOp!), doc3.length).apply(doc3);
    expect(doc4.toString()).toBe(">> hello world");
    expect(doc4.toString()).toBe(doc2.toString());
  });

  it("keeps remote updates out of history even when a dispatch wrapper forces addToHistory", () => {
    const history = new SelectiveUndoHistory();
    const doc0 = doc("shared");
    const remote = ChangeSet.of({ from: 0, insert: "B: " }, doc0.length);
    // A buggy wrapper both marks the transaction remote AND asks for history.
    history.applyTransaction({ changes: remote, docBefore: doc0, remote: true, addToHistory: true });
    expect(history.undoDepth).toBe(0);
    expect(history.undo(remote.apply(doc0))).toBeNull();
  });

  it("remaps without recording when an own transaction opts out via addToHistory:false", () => {
    const history = new SelectiveUndoHistory();
    const doc0 = doc("abc");
    const typed = ChangeSet.of({ from: 3, insert: "def" }, doc0.length);
    const doc1 = typed.apply(doc0); // "abcdef"
    history.applyTransaction({ changes: typed, docBefore: doc0 });
    const programmatic = ChangeSet.of({ from: 0, insert: "0" }, doc1.length);
    const doc2 = programmatic.apply(doc1); // "0abcdef"
    history.applyTransaction({ changes: programmatic, docBefore: doc1, addToHistory: false });
    expect(history.undoDepth).toBe(1);
    expect(history.undo(doc2)!.apply(doc2).toString()).toBe("0abc");
  });

  it("cascades remapping through a multi-edit stack", () => {
    const history = new SelectiveUndoHistory();
    const doc0 = doc("base");
    const first = ChangeSet.of({ from: 4, insert: " one" }, doc0.length);
    const doc1 = first.apply(doc0); // "base one"
    history.applyTransaction({ changes: first, docBefore: doc0 });
    const second = ChangeSet.of({ from: 8, insert: " two" }, doc1.length);
    const doc2 = second.apply(doc1); // "base one two"
    history.applyTransaction({ changes: second, docBefore: doc1 });

    const remote = ChangeSet.of({ from: 0, insert: "B " }, doc2.length);
    const doc3 = remote.apply(doc2); // "B base one two"
    history.applyTransaction({ changes: remote, docBefore: doc2, remote: true });

    const undo1 = history.undo(doc3)!;
    const doc4 = undo1.apply(doc3);
    expect(doc4.toString()).toBe("B base one");
    const undo2 = history.undo(doc4)!;
    const doc5 = undo2.apply(doc4);
    // Both own edits reverted; the remote edit alone remains.
    expect(doc5.toString()).toBe("B base");

    const doc6 = history.redo(doc5)!.apply(doc5);
    const doc7 = history.redo(doc6)!.apply(doc6);
    expect(doc7.toString()).toBe("B base one two");
  });

  it("drops an inverse once a remote deletion fully absorbs the edit", () => {
    const history = new SelectiveUndoHistory();
    const doc0 = doc("keep keep");
    const typed = ChangeSet.of({ from: 4, insert: " NEW" }, doc0.length);
    const doc1 = typed.apply(doc0); // "keep NEW keep"
    history.applyTransaction({ changes: typed, docBefore: doc0 });

    // Remote deletes exactly what A inserted: nothing of A's edit remains to
    // revert, so its inverse leaves the stack instead of becoming a no-op.
    const remote = ChangeSet.of({ from: 4, to: 8 }, doc1.length);
    const doc2 = remote.apply(doc1); // "keep keep"
    history.applyTransaction({ changes: remote, docBefore: doc1, remote: true });
    expect(history.undoDepth).toBe(0);
    expect(history.undo(doc2)).toBeNull();
  });

  it("restores replaced text when a remote deletion removed the replacement", () => {
    const history = new SelectiveUndoHistory();
    const doc0 = doc("keep OLD keep");
    const typed = ChangeSet.of({ from: 5, to: 8, insert: "REPLACED" }, doc0.length);
    const doc1 = typed.apply(doc0); // "keep REPLACED keep"
    history.applyTransaction({ changes: typed, docBefore: doc0 });

    // Remote deletes the replacement. The inverse's deletion span collapses
    // but its insert survives: undo still restores what A's edit destroyed.
    const remote = ChangeSet.of({ from: 5, to: 13 }, doc1.length);
    const doc2 = remote.apply(doc1); // "keep  keep"
    history.applyTransaction({ changes: remote, docBefore: doc1, remote: true });
    expect(history.undoDepth).toBe(1);
    expect(history.undo(doc2)!.apply(doc2).toString()).toBe("keep OLD keep");
  });

  it("remaps redo across remote updates instead of clearing it", () => {
    const history = new SelectiveUndoHistory();
    const doc0 = doc("x");
    const typed = ChangeSet.of({ from: 1, insert: "y" }, doc0.length);
    const doc1 = typed.apply(doc0); // "xy"
    history.applyTransaction({ changes: typed, docBefore: doc0 });
    const undone = history.undo(doc1)!;
    const doc2 = undone.apply(doc1); // "x"
    history.applyTransaction({ changes: undone, docBefore: doc1, fromHistory: true });
    expect(history.redoDepth).toBe(1);

    const remote = ChangeSet.of({ from: 0, insert: "B" }, doc2.length);
    const doc3 = remote.apply(doc2); // "Bx"
    history.applyTransaction({ changes: remote, docBefore: doc2, remote: true });
    expect(history.redoDepth).toBe(1); // concurrent typing must not kill redo
    expect(history.redo(doc3)!.apply(doc3).toString()).toBe("Bxy");
  });

  it("clears redo on a fresh own edit", () => {
    const history = new SelectiveUndoHistory();
    const doc0 = doc("x");
    const typed = ChangeSet.of({ from: 1, insert: "y" }, doc0.length);
    const doc1 = typed.apply(doc0); // "xy"
    history.applyTransaction({ changes: typed, docBefore: doc0 });
    const undone = history.undo(doc1)!;
    const doc2 = undone.apply(doc1); // "x"
    history.applyTransaction({ changes: undone, docBefore: doc1, fromHistory: true });
    expect(history.redoDepth).toBe(1);

    const fresh = ChangeSet.of({ from: 1, insert: "z" }, doc2.length);
    history.applyTransaction({ changes: fresh, docBefore: doc2 }); // "xz"
    expect(history.redoDepth).toBe(0);
    expect(history.undoDepth).toBe(1);
  });
});

describe("webCollaborativeShareHtml", () => {
  it("keeps authenticated document bytes behind the shared API", () => {
    const html = webCollaborativeShareHtml({ slug: "abc12345", role: "comment", nonce: "nonce" });
    expect(html).toContain("/web/api/shared?slug=");
    expect(html).toContain('["bashroom","tok." + state.token]');
    expect(html).toContain("Sign in to collaborate");
    expect(html).not.toContain("users/");
  });

  it("renders Mermaid only through strict mode", () => {
    const html = webCollaborativeShareHtml({ slug: "abc12345", role: "edit", nonce: "nonce" });
    expect(html).toContain('securityLevel:"strict"');
    expect(html).toContain("mermaid@11.16.0");
    expect(html).toContain("ascii-diagram");
  });

  it("streams and renders actor-labelled caret positions", () => {
    const html = webCollaborativeShareHtml({ slug: "abc12345", role: "edit", nonce: "nonce" });
    expect(html).toContain('caret:input.selectionStart || 0');
    expect(html).toContain('source.onkeyup = streamDraft');
    expect(html).toContain('renderLiveDraft(message.content || "",message.caret,message.actor || "Someone")');
    expect(html).toContain('className = "remote-caret"');
    expect(html).toContain('className = "remote-caret-label"');
  });

  it("anchors comments by server-mapped SOURCE offsets only — no quote-substring fallback", () => {
    const html = webCollaborativeShareHtml({ slug: "abc12345", role: "comment", nonce: "nonce" });
    expect(html).not.toContain("text.indexOf(comment.quote");
    // Display validates the quote against the raw Markdown source slice…
    expect(html).toContain("source.slice(start,end) !== comment.quote");
    // …the alignment is rebuilt once per render, after diagram enhancement…
    expect(html).toContain("state.align = buildSourceAlignment(documentText(article), text)");
    // …and creation refuses to anchor against anything but the saved source.
    expect(html).toContain("align.source !== state.file.content");
  });

  it("escapes the embedded slug before the inline script boundary", () => {
    const html = webCollaborativeShareHtml({ slug: "</script><script>alert(1)", role: "edit", nonce: "nonce" });
    expect(html).not.toContain('var slug = "</script>');
    expect(html).toContain("\\u003c/script>");
  });
});

// ─── Rendered <-> source alignment ──────────────────────────────────────────
// These suites execute the EXACT bytes a browser receives: the alignment
// functions are cut out of the generated inline script and evaluated, so a
// template-escape regression (\s arriving as the letter s) fails here, not
// in production. The rendered-text fixtures are the concatenated text nodes
// marked produces for each source — including the block-boundary newlines
// that never exist in the Markdown.

type SourceAlignment = {
  source: string;
  renderedLength: number;
  hardIdx: number[];
  hardStart: number[];
  hardEnd: number[];
};
type AnchorRange = { start: number; end: number } | null;
type AlignmentHarness = {
  buildSourceAlignment: (rendered: string, source: string) => SourceAlignment | null;
  renderedRangeToSource: (align: SourceAlignment | null, start: number, end: number) => AnchorRange;
  sourceRangeToRendered: (align: SourceAlignment | null, start: number, end: number) => AnchorRange;
  renderedPointFromSource: (align: SourceAlignment, offset: number) => number;
  resolvedAnchor: (
    comment: { anchor_start: number; anchor_end: number; quote: string },
    source: string,
    align: SourceAlignment | null,
  ) => AnchorRange;
};

function inlineCollabScript(): string {
  const html = webCollaborativeShareHtml({ slug: "abc12345", role: "comment", nonce: "nonce" });
  const match = html.match(/<script nonce="nonce">([\s\S]*?)<\/script>\s*<\/body>/);
  if (!match) throw new Error("collaboration inline script not found");
  return match[1];
}

function inlineFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in inline script`);
  const open = script.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < script.length; i++) {
    if (script[i] === "{") depth += 1;
    else if (script[i] === "}") {
      depth -= 1;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`${name} has unbalanced braces`);
}

function alignmentHarness(): AlignmentHarness {
  const script = inlineCollabScript();
  const statement = (pattern: RegExp): string => {
    const match = script.match(pattern);
    if (!match) throw new Error(`${pattern} not found in inline script`);
    return match[0];
  };
  const body = [
    statement(/var SOFT_SPACE = [^;]+;/),
    statement(/var NAMED_ENTITIES = \{[^}]*\};/),
    inlineFunction(script, "decodeEntityAt"),
    inlineFunction(script, "buildSourceAlignment"),
    inlineFunction(script, "lowerBound"),
    inlineFunction(script, "renderedRangeToSource"),
    inlineFunction(script, "sourceRangeToRendered"),
    inlineFunction(script, "renderedPointFromSource"),
    inlineFunction(script, "resolvedAnchor"),
    "return { buildSourceAlignment, renderedRangeToSource, sourceRangeToRendered, renderedPointFromSource, resolvedAnchor };",
  ].join("\n");
  return new Function(body)() as AlignmentHarness;
}

const harness = alignmentHarness();

describe("markdown source alignment", () => {
  it("aligns plain text one-to-one", () => {
    const align = harness.buildSourceAlignment("hello world\n", "hello world");
    expect(align).not.toBeNull();
    expect(harness.renderedRangeToSource(align, 0, 11)).toEqual({ start: 0, end: 11 });
  });

  it("maps heading text past the # marker", () => {
    const align = harness.buildSourceAlignment("Title\nHello\n", "# Title\n\nHello");
    expect(harness.renderedRangeToSource(align, 0, 5)).toEqual({ start: 2, end: 7 });
    expect(harness.renderedRangeToSource(align, 6, 11)).toEqual({ start: 9, end: 14 });
  });

  it("maps across bold and italic markers", () => {
    const source = "*i* and **b**";
    const align = harness.buildSourceAlignment("i and b\n", source);
    expect(harness.renderedRangeToSource(align, 0, 1)).toEqual({ start: 1, end: 2 });
    expect(harness.renderedRangeToSource(align, 6, 7)).toEqual({ start: 10, end: 11 });
    // Spanning both: interior markers ride along inside the source slice.
    const span = harness.renderedRangeToSource(align, 0, 7)!;
    expect(source.slice(span.start, span.end)).toBe("i* and **b");
  });

  it("maps link text and treats the URL as a source-only gap", () => {
    const source = "[text](https://example.com)";
    const align = harness.buildSourceAlignment("text\n", source);
    const range = harness.renderedRangeToSource(align, 0, 4)!;
    expect(range).toEqual({ start: 1, end: 5 });
    expect(source.slice(range.start, range.end)).toBe("text");
  });

  it("treats inline-code backticks and fence lines as gaps", () => {
    const source = "run `x=1` now\n\n```js\ncall()\n```";
    const align = harness.buildSourceAlignment("run x=1 now\ncall()\n\n", source);
    const inline = harness.renderedRangeToSource(align, 4, 7)!;
    expect(source.slice(inline.start, inline.end)).toBe("x=1");
    const fenced = harness.renderedRangeToSource(align, 12, 18)!;
    expect(source.slice(fenced.start, fenced.end)).toBe("call()");
  });

  it("aligns decodable entities to their full source extent", () => {
    // &amp; renders as & — the trailing entity bytes are interior gap.
    const amp = harness.buildSourceAlignment("AT&T rocks\n", "AT&amp;T rocks");
    const brand = harness.renderedRangeToSource(amp, 0, 4)!;
    expect("AT&amp;T rocks".slice(brand.start, brand.end)).toBe("AT&amp;T");
    // &lt; renders as < — a character that never appears literally in source.
    const lt = harness.buildSourceAlignment("a < b\n", "a &lt; b");
    expect(harness.renderedRangeToSource(lt, 2, 3)).toEqual({ start: 2, end: 6 });
    // Round-trip through the entity stays put.
    expect(harness.sourceRangeToRendered(lt, 2, 6)).toEqual({ start: 2, end: 3 });
  });

  it("fails closed — null, never a wrong mapping — when a rendered char has no source origin", () => {
    // &euro; decodes to € in the browser but is not in the aligner's table.
    expect(harness.buildSourceAlignment("x € y\n", "x &euro; y")).toBeNull();
    // Rendered text that simply is not in the source.
    expect(harness.buildSourceAlignment("extra\n", "# nothing here")).toBeNull();
  });

  it("returns null for whitespace-only or out-of-range rendered selections", () => {
    const align = harness.buildSourceAlignment("Title\nHello\n", "# Title\n\nHello");
    expect(harness.renderedRangeToSource(align, 5, 6)).toBeNull(); // the block-boundary newline
    expect(harness.renderedRangeToSource(align, 0, 99)).toBeNull(); // beyond the rendered text
    expect(harness.renderedRangeToSource(null, 0, 5)).toBeNull(); // no alignment at all
  });
});

describe("comment anchor creation and display", () => {
  const source = "one **bold** two";
  const rendered = "one bold two\n";

  it("a rendered selection spanning bold yields source offsets whose slice includes the markers", () => {
    const align = harness.buildSourceAlignment(rendered, source);
    const anchor = harness.renderedRangeToSource(align, 0, 12)!;
    expect(anchor).toEqual({ start: 0, end: 16 });
    // The quote IS the raw source slice, ** markers and all.
    expect(source.slice(anchor.start, anchor.end)).toBe("one **bold** two");
  });

  it("places the highlight on the visually correct rendered span", () => {
    const align = harness.buildSourceAlignment(rendered, source);
    const mark = harness.resolvedAnchor({ anchor_start: 0, anchor_end: 16, quote: source }, source, align)!;
    expect(rendered.slice(mark.start, mark.end)).toBe("one bold two");
  });

  it("drifts — never guesses — when the quote no longer matches the source slice", () => {
    const align = harness.buildSourceAlignment(rendered, source);
    expect(harness.resolvedAnchor({ anchor_start: 0, anchor_end: 16, quote: "different words!" }, source, align)).toBeNull();
    expect(harness.resolvedAnchor({ anchor_start: 16, anchor_end: 16, quote: "" }, source, align)).toBeNull();
  });

  it("drifts when the anchor covers only invisible source (a bare link URL)", () => {
    const urlSource = "[x](http://foo)";
    const align = harness.buildSourceAlignment("x\n", urlSource);
    const anchor = { anchor_start: 4, anchor_end: 14, quote: urlSource.slice(4, 14) };
    expect(harness.resolvedAnchor(anchor, urlSource, align)).toBeNull();
  });

  it("round-trips rendered -> source -> rendered exactly where alignment is unambiguous", () => {
    const cases: Array<{ rendered: string; source: string; from: number; to: number }> = [
      { rendered: "Title\nHello\n", source: "# Title\n\nHello", from: 0, to: 5 },
      { rendered: "one bold two\n", source: "one **bold** two", from: 4, to: 8 },
      { rendered: "text\n", source: "[text](https://example.com)", from: 0, to: 4 },
      { rendered: "run x=1 now\ncall()\n\n", source: "run `x=1` now\n\n```js\ncall()\n```", from: 12, to: 18 },
    ];
    for (const test of cases) {
      const align = harness.buildSourceAlignment(test.rendered, test.source);
      const src = harness.renderedRangeToSource(align, test.from, test.to)!;
      expect(harness.sourceRangeToRendered(align, src.start, src.end)).toEqual({ start: test.from, end: test.to });
    }
  });

  it("keeps the highlight on the same words after a server-style remap of a preceding edit", () => {
    const sourceBefore = "intro\n\nsee **bold** words";
    const alignBefore = harness.buildSourceAlignment("intro\nsee bold words\n", sourceBefore);
    const anchor = harness.renderedRangeToSource(alignBefore, 6, 20)!;
    const quote = sourceBefore.slice(anchor.start, anchor.end);
    expect(quote).toBe("see **bold** words");

    // A collaborator prepends text; the server maps the stored offsets the
    // way mapRoomTextAnchors does (assoc -1 start / +1 end).
    const edit = ChangeSet.of({ from: 0, insert: "NEW " }, sourceBefore.length);
    const start = edit.mapPos(anchor.start, -1);
    const end = Math.max(start, edit.mapPos(anchor.end, 1));
    const sourceAfter = edit.apply(doc(sourceBefore)).toString();
    expect(sourceAfter.slice(start, end)).toBe(quote);

    const renderedAfter = "NEW intro\nsee bold words\n";
    const alignAfter = harness.buildSourceAlignment(renderedAfter, sourceAfter);
    const mark = harness.resolvedAnchor({ anchor_start: start, anchor_end: end, quote }, sourceAfter, alignAfter)!;
    expect(renderedAfter.slice(mark.start, mark.end)).toBe("see bold words");
  });

  it("maps remote carets through the alignment", () => {
    const align = harness.buildSourceAlignment(rendered, source)!;
    expect(harness.renderedPointFromSource(align, 0)).toBe(0);
    expect(harness.renderedPointFromSource(align, 6)).toBe(4); // before "bold"
    expect(harness.renderedPointFromSource(align, source.length)).toBe(rendered.length);
  });
});
