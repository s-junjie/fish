import { describe, it, expect } from "vitest";
import { createEmptyDocument } from "../src/core/data-bridge";
import { EditorStore } from "../src/core/store/editor-store";

/**
 * The store the editor actually runs — the only undo path with coverage. An
 * earlier version of this file also re-implemented the algorithm on local
 * arrays; it could only prove the algorithm self-consistent, and it stayed green
 * with `undo()` disabled outright.
 */
describe("EditorStore records only real steps", () => {
  const fresh = () => new EditorStore(createEmptyDocument());

  it("records a step when the document changes", () => {
    const store = fresh();
    store.commit({ ...store.getDoc(), name: "Renamed" });
    expect(store.getPastCount()).toBe(1);
    expect(store.undo()).toBe(true);
    expect(store.getDoc().name).not.toBe("Renamed");
  });

  it("records nothing when the commit changes nothing", () => {
    // `onCommitSnapshot(docRef.current)` — how the inspector sections close a
    // scrub — lands here whenever that scrub ended where it started. It used to
    // push an entry identical to the live document: the first ⌘Z did nothing,
    // so the user pressed it again and lost an edit instead.
    const store = fresh();
    store.commit(store.getDoc());
    expect(store.getPastCount()).toBe(0);
    expect(store.undo()).toBe(false);
  });

  it("keeps a gesture to one step, ignoring a no-op commit inside it", () => {
    const store = fresh();
    store.startGesture();
    store.setTransient({ ...store.getDoc(), name: "Mid-drag" });
    store.commit(store.getDoc());
    store.endGesture();
    expect(store.getPastCount()).toBe(1);
    expect(store.undo()).toBe(true);
    expect(store.getDoc().name).not.toBe("Mid-drag");
  });

  it("still lets a real transient change be undone in one step", () => {
    // The guard must not swallow the gesture's own snapshot: a scrub that did
    // move something still has to be one undo, not zero.
    const store = fresh();
    store.startGesture();
    store.setTransient({ ...store.getDoc(), name: "Moved" });
    store.endGesture();
    expect(store.getPastCount()).toBe(1);
  });
});
