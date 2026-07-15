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

  it("escapes the embedded slug before the inline script boundary", () => {
    const html = webCollaborativeShareHtml({ slug: "</script><script>alert(1)", role: "edit", nonce: "nonce" });
    expect(html).not.toContain('var slug = "</script>');
    expect(html).toContain("\\u003c/script>");
  });
});
