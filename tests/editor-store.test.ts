import { describe, it, expect, vi } from "vitest";
import { getActivePage, updateActivePageElements } from "../src/core/dsl/document-ops";
import { EditorStore } from "../src/core/store/editor-store";
import { DesignDocument, DesignElement, RectElement } from "../src/core/dsl/types";
import { relayoutDocumentTree } from "../src/core/compile";
import { setTextMeasurer } from "../src/core/geometry/text-measure";

const makeTestDoc = (): DesignDocument => ({
  version: "0.1",
  id: "test_doc",
  name: "Test Doc",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  canvas: { width: 1000, height: 1000, background: { type: "solid", color: "#141414" }, unit: "px" },
  pages: [
    {
      id: "page_1",
      name: "Page 1",
      canvas: { width: 1000, height: 1000, background: { type: "solid", color: "#141414" }, unit: "px" },
      children: [
        { id: "r1", type: "rect", x: 10, y: 10, width: 100, height: 100 } as RectElement
      ]
    }
  ],
  activePageId: "page_1"
});

describe("EditorStore", () => {
  it("initializes with the active page's tree as the only copy", () => {
    const doc = makeTestDoc();
    const store = new EditorStore(doc);
    expect(store.getActivePage().children[0].id).toBe("r1");
    expect(store.getDoc().pages[0].children).toBe(store.getActivePage().children);
  });

  it("notifies subscribers on document change", () => {
    const store = new EditorStore(makeTestDoc());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispatch({
      type: "RENAME",
      patch: (doc) => ({ ...doc, name: "Renamed Doc" })
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getDoc().name).toBe("Renamed Doc");

    unsubscribe();
    store.dispatch({
      type: "RENAME",
      patch: (doc) => ({ ...doc, name: "Renamed Again" })
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("manages undo and redo history on dispatch", () => {
    const store = new EditorStore(makeTestDoc());
    expect(store.canUndo()).toBe(false);

    store.dispatch({
      type: "UPDATE_NAME",
      patch: (doc) => ({ ...doc, name: "V2" })
    });

    expect(store.canUndo()).toBe(true);
    expect(store.getPastCount()).toBe(1);
    expect(store.getDoc().name).toBe("V2");

    const undone = store.undo();
    expect(undone).toBe(true);
    expect(store.getDoc().name).toBe("Test Doc");
    expect(store.canRedo()).toBe(true);

    const redone = store.redo();
    expect(redone).toBe(true);
    expect(store.getDoc().name).toBe("V2");
  });

  it("consolidates multi-step gestures into a single undo snapshot", () => {
    const store = new EditorStore(makeTestDoc());
    store.startGesture();

    // Multiple drag move frames
    store.dispatch({
      type: "MOVE",
      recordHistory: false,
      patch: (doc) => updateActivePageElements(doc, [{ ...getActivePage(doc).children[0], x: 20 }])
    });

    store.dispatch({
      type: "MOVE",
      recordHistory: false,
      patch: (doc) => updateActivePageElements(doc, [{ ...getActivePage(doc).children[0], x: 30 }])
    });

    expect(store.getPastCount()).toBe(0); // No snapshots during gesture
    expect(getActivePage(store.getDoc()).children[0].x).toBe(30);

    store.endGesture();
    expect(store.getPastCount()).toBe(1); // Exactly 1 snapshot pushed

    store.undo();
    expect(getActivePage(store.getDoc()).children[0].x).toBe(10); // Reverts back to initial
  });

  it("can cancel an active gesture", () => {
    const store = new EditorStore(makeTestDoc());
    store.startGesture();

    store.dispatch({
      type: "MOVE",
      recordHistory: false,
      patch: (doc) => updateActivePageElements(doc, [{ ...getActivePage(doc).children[0], x: 100 }])
    });
    expect(getActivePage(store.getDoc()).children[0].x).toBe(100);

    store.cancelGesture();
    expect(getActivePage(store.getDoc()).children[0].x).toBe(10);
    expect(store.getPastCount()).toBe(0);
  });

  it("correctly records canvas background changes for undo", () => {
    const store = new EditorStore(makeTestDoc());
    store.startGesture();

    store.setPageBackground({ type: "solid", color: "#FF0000" }, { recordHistory: false });
    expect(store.getActivePage().canvas.background).toEqual({ type: "solid", color: "#FF0000" });

    store.endGesture();
    expect(store.canUndo()).toBe(true);

    store.undo();
    expect(store.getActivePage().canvas.background).toEqual({ type: "solid", color: "#141414" });
  });
});

/**
 * The two viewer states history mode is built from: a read-only reason, and a
 * redirect of what the UI renders. They are separate because the panel being
 * open makes the document unwritable while still showing the live one, and
 * clicking a row then swaps the view — and they are pinned here because the
 * only way a read-only mode can fail is silently, by writing somewhere the
 * caller did not think to check.
 */
describe("EditorStore viewer state", () => {
  const rename = (name: string) => ({ type: "RENAME", patch: (doc: DesignDocument) => ({ ...doc, name }) });

  it("refuses every write while read-only, and takes them again on exit", () => {
    const store = new EditorStore(makeTestDoc());
    store.dispatch(rename("Edited"));
    store.setReadOnly("history-preview");
    expect(store.isReadOnly()).toBe(true);
    expect(store.getReadOnlyReason()).toBe("history-preview");

    store.dispatch(rename("Nope"));
    store.commit({ ...store.getDoc(), name: "Nope" });
    store.setTransient({ ...store.getDoc(), name: "Nope" });
    store.updateActivePage((p) => ({ ...p, name: "Nope" }));
    expect(store.getDoc().name).toBe("Edited");

    // Undo and redo are writes too: they would move the document under a view
    // the user is looking at, or leave them with an edit they cannot reverse.
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);

    // A gesture opens with a snapshot of a document nothing may change, so it
    // is refused at the start rather than left to end against a stale baseline.
    store.startGesture();
    store.endGesture();
    store.cancelGesture();
    expect(store.getDoc().name).toBe("Edited");
    expect(store.getPastCount()).toBe(1);

    store.setReadOnly(null);
    expect(store.isReadOnly()).toBe(false);
    expect(store.getReadOnlyReason()).toBeNull();
    store.dispatch(rename("Writable again"));
    expect(store.getDoc().name).toBe("Writable again");
  });

  it("reports a redirected view as read-only even with no reason set", () => {
    const store = new EditorStore(makeTestDoc());
    store.setViewDoc({ ...makeTestDoc(), name: "Version" });
    expect(store.getViewDoc().name).toBe("Version");
    expect(store.getDoc().name).toBe("Test Doc");
    expect(store.isReadOnly()).toBe(true);
    store.commit({ ...store.getDoc(), name: "Nope" });
    expect(store.getDoc().name).toBe("Test Doc");
    store.setViewDoc(null);
    expect(store.getViewDoc()).toBe(store.getDoc());
    expect(store.isReadOnly()).toBe(false);
  });

  it("announces the viewer state without the channel auto-save flushes on", () => {
    const store = new EditorStore(makeTestDoc());
    const view = { ...makeTestDoc(), name: "Version" };
    const docListener = vi.fn();
    const viewListener = vi.fn();
    store.subscribe(docListener);
    store.onViewChange(viewListener);

    store.setViewDoc(view);
    store.setReadOnly("history-preview");
    expect(viewListener).toHaveBeenCalledTimes(2);
    // `subscribe` is auto-save's flush signal: if browsing fired it, every
    // click through history would write a recovery checkpoint.
    expect(docListener).not.toHaveBeenCalled();

    store.setViewDoc(null);
    store.setReadOnly(null);
    expect(viewListener).toHaveBeenCalledTimes(4);
    expect(docListener).not.toHaveBeenCalled();

    store.dispatch(rename("Edited"));
    expect(docListener).toHaveBeenCalledTimes(1);
  });
});

describe("gesture boundary signal", () => {
  it("fires once when a gesture opens and once when it closes, never per frame", () => {
    const store = new EditorStore(makeTestDoc());
    const seen: boolean[] = [];
    store.onGestureChange(() => seen.push(store.isGestureActive()));

    store.startGesture();
    store.setTransient(updateActivePageElements(store.getDoc(), []));
    store.setTransient(updateActivePageElements(store.getDoc(), []));
    expect(seen).toEqual([true]);

    store.endGesture();
    expect(seen).toEqual([true, false]);
    expect(store.isGestureActive()).toBe(false);
  });
});

/**
 * A document's first layout runs the moment it opens, and a webfont is not
 * downloaded yet: the pass measures the fallback face and writes those numbers
 * into a hugging box and every stack above it. When the file lands the glyphs
 * change and the boxes do not.
 *
 * `rebaselineInitialLayout` is that second pass — and it has to be invisible:
 * no undo step, no auto-save flush, and nothing at all once the user has started
 * editing, because those boxes are where the user put their hands.
 */
describe("EditorStore.rebaselineInitialLayout", () => {
  const twice = (content: string) => ({ width: content.length * 10, height: 20, lines: 1 });
  const wider = (content: string) => ({ width: content.length * 20, height: 20, lines: 1 });

  const huggingDoc = (): DesignDocument => {
    const label = {
      id: "label",
      type: "text",
      name: "Label",
      x: 10,
      y: 10,
      width: 1,
      height: 1,
      content: "abcd",
      sizing: { width: "fit-content", height: "fit-content" },
      style: { fontFamily: "Inter", fontSize: 16, lineHeight: 20, color: "#111111" }
    } as unknown as DesignElement;
    const base = makeTestDoc();
    return { ...base, pages: [{ ...base.pages[0], children: relayoutDocumentTree([label]) }] };
  };

  const widthOf = (store: EditorStore) => (store.getActivePage().children[0] as { width: number }).width;

  it("re-measures the fallback's boxes and touches neither history nor auto-save", () => {
    setTextMeasurer(twice);
    const store = new EditorStore(huggingDoc());
    expect(widthOf(store)).toBe(40);

    const autosave = vi.fn();
    const repaint = vi.fn();
    store.subscribe(autosave);
    store.onViewChange(repaint);

    setTextMeasurer(wider);
    expect(store.rebaselineInitialLayout()).toBe(true);
    expect(widthOf(store), "the box follows the real face").toBe(80);
    expect(store.canUndo(), "an arriving font is not an edit").toBe(false);
    expect(autosave, "and must not flush a save").not.toHaveBeenCalled();
    expect(repaint, "but the canvas has to draw the new box").toHaveBeenCalled();
  });

  it("leaves an edited document alone", () => {
    setTextMeasurer(twice);
    const store = new EditorStore(huggingDoc());
    store.dispatch({ type: "TOUCH", patch: (doc) => ({ ...doc, name: "Edited" }) });

    setTextMeasurer(wider);
    expect(store.rebaselineInitialLayout()).toBe(false);
    expect(widthOf(store), "the box stays where the user left it").toBe(40);
  });

  it("keeps the document identity when nothing measured differently", () => {
    setTextMeasurer(twice);
    const store = new EditorStore(huggingDoc());
    const before = store.getDoc();
    expect(store.rebaselineInitialLayout()).toBe(false);
    expect(store.getDoc()).toBe(before);
  });
});
