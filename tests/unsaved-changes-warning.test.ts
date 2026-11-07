import { describe, it, expect } from "vitest";
import type { DesignDocument } from "../src/core/dsl/types";
import { EditorStore } from "../src/core/store/editor-store";
import { MemoryBackend } from "../src/core/persistence/backend";
import { createRecoveryStore } from "../src/core/persistence/recovery";
import { createAssetStore } from "../src/core/persistence/assets";
import { AutosaveController } from "../src/core/persistence/autosave-controller";
import { shouldWarnBeforeUnload } from "../src/core/persistence/unload-guard";

/**
 * Grades the predicate the hook actually calls, not a copy of it. The previous
 * version of this file re-implemented "hash differs" locally, so it stayed green
 * while the shipped guard changed shape underneath it — which is how the guard's
 * cost (a full-document hash inside `beforeunload`) went unnoticed.
 */
function createTestDoc(): DesignDocument {
  return {
    docId: "doc_1",
    id: "doc_1",
    version: "0.1",
    name: "Test Document",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas: { width: 1000, height: 1000, unit: "px", background: { type: "solid", color: "#ffffff" } },
    elements: [],
    pages: [{ id: "p1", name: "Page 1", children: [] }]
  } as unknown as DesignDocument;
}

describe("shouldWarnBeforeUnload", () => {
  it("stays quiet when nothing has been committed since the write that landed", () => {
    const doc = createTestDoc();
    expect(shouldWarnBeforeUnload({ saved: doc, current: doc, owed: false })).toBe(false);
  });

  it("warns for a document that is not the object the file holds", () => {
    const doc = createTestDoc();
    const edited: DesignDocument = {
      ...doc,
      pages: [{ ...doc.pages[0], children: [{ id: "r1", type: "rect", x: 10, y: 10, width: 50, height: 50 } as never] }]
    };
    expect(shouldWarnBeforeUnload({ saved: doc, current: edited, owed: false })).toBe(true);
  });

  it("clears itself when undo restores the saved object", () => {
    // The history stack holds document REFERENCES, so stepping back to the
    // saved state hands the guard the very object it recorded. That is why a
    // reference comparison is not merely cheaper than a hash — it is exact.
    const doc = createTestDoc();
    const edited: DesignDocument = { ...doc, name: "Renamed" };
    expect(shouldWarnBeforeUnload({ saved: doc, current: edited, owed: false })).toBe(true);
    expect(shouldWarnBeforeUnload({ saved: doc, current: doc, owed: false })).toBe(false);
  });

  it("warns while a flush is still owed, even for the saved object", () => {
    // A debounce armed by a commit that produced equal content, or a flush whose
    // writes have not committed yet: the chain is awaits all the way down and
    // `pagehide` does not wait for it.
    const doc = createTestDoc();
    expect(shouldWarnBeforeUnload({ saved: doc, current: doc, owed: true })).toBe(true);
  });
});

describe("AutosaveController.hasPendingWork", () => {
  function controllerFor(doc: () => DesignDocument, notify: { cb: (d: DesignDocument) => void }) {
    const backend = new MemoryBackend();
    return new AutosaveController({
      getDoc: doc,
      subscribe: (cb) => {
        notify.cb = cb;
        return () => undefined;
      },
      recovery: createRecoveryStore(backend),
      assets: createAssetStore(backend),
      fileId: () => "fish_unload"
    });
  }

  it("is true from the moment an edit is debounced, and false once it is written", async () => {
    let current = createTestDoc();
    const notify = { cb: (_d: DesignDocument) => undefined };
    const controller = controllerFor(() => current, notify);
    await controller.ready();
    controller.enable();

    expect(controller.hasPendingWork()).toBe(false);

    current = { ...current, name: "Edited" };
    notify.cb(current);
    // Nothing is on disk yet: this is the window the unload guard has to cover.
    expect(controller.hasPendingWork()).toBe(true);

    await controller.flushNow();
    expect(controller.hasPendingWork()).toBe(false);
    controller.disable();
  });

  it("reports an in-flight flush as owed", async () => {
    const current = createTestDoc();
    const notify = { cb: (_d: DesignDocument) => undefined };
    const controller = controllerFor(() => current, notify);
    await controller.ready();
    controller.enable();

    notify.cb(current);
    const inFlight = controller.flushNow();
    expect(controller.hasPendingWork()).toBe(true);
    await inFlight;
    expect(controller.hasPendingWork()).toBe(false);
    controller.disable();
  });

  it("clears pending debounce timers on noteFileSaved so explicit save disarms beforeunload", async () => {
    let current = createTestDoc();
    const notify = { cb: (_d: DesignDocument) => undefined };
    const controller = controllerFor(() => current, notify);
    await controller.ready();
    controller.enable();

    current = { ...current, name: "Edited then saved via Cmd+S" };
    notify.cb(current);
    expect(controller.hasPendingWork()).toBe(true);

    await controller.noteFileSaved(current, "hash_after_save");
    expect(controller.hasPendingWork()).toBe(false);
    expect(
      shouldWarnBeforeUnload({
        saved: current,
        current,
        owed: controller.hasPendingWork()
      })
    ).toBe(false);
    controller.disable();
  });
});

describe("EditorStore.onRebaseline", () => {
  it("advances the saved baseline when async webfont layout replaces an untouched document", () => {
    const base = createTestDoc();
    const initial: DesignDocument = {
      ...base,
      pages: [
        {
          id: "p1",
          name: "Page 1",
          canvas: base.canvas,
          children: [
            {
              id: "t1",
              type: "text",
              name: "Title",
              x: 0,
              y: 0,
              width: 999,
              height: 999,
              content: "FISH",
              style: { fontSize: 24, fontFamily: "Bodoni Moda" },
              sizing: { width: "max-content", height: "fit-content" }
            } as never
          ]
        }
      ]
    };
    const store = new EditorStore(initial);
    const bootDoc = store.getDoc();
    let saved = bootDoc;
    store.onRebaseline((prev, next) => {
      if (saved === prev) saved = next;
    });

    store.rebaselineInitialLayout();
    expect(store.getDoc()).not.toBe(bootDoc);
    expect(saved).toBe(store.getDoc());
    expect(store.resolveBaseline(bootDoc)).toBe(store.getDoc());
    expect(shouldWarnBeforeUnload({ saved, current: store.getDoc(), owed: false })).toBe(false);
  });

  it("treats renderer-measured on-path text bounds as a baseline update rather than an unsaved edit", () => {
    const base = createTestDoc();
    const initial: DesignDocument = {
      ...base,
      pages: [
        {
          id: "p1",
          name: "Page 1",
          canvas: base.canvas,
          children: [
            {
              id: "seal_text",
              type: "text",
              name: "Seal",
              x: 894.4,
              y: 1055.7,
              width: 184.1,
              height: 179.7,
              content: "CIRCULAR TEXT",
              onPath: { pathId: "circle_1", startOffset: 0 }
            } as never
          ]
        }
      ]
    };
    const store = new EditorStore(initial);
    const savedBeforeMeasure = store.getDoc();
    let commitNotified = false;
    store.subscribe(() => {
      commitNotified = true;
    });

    const changed = store.recordMeasuredTextBounds("seal_text", {
      x: 894.95,
      y: 1056.25,
      width: 183.1,
      height: 178.7
    });
    expect(changed).toBe(true);
    expect(commitNotified).toBe(false);
    expect(store.resolveBaseline(savedBeforeMeasure)).toBe(store.getDoc());
    expect(
      shouldWarnBeforeUnload({
        saved: store.resolveBaseline(savedBeforeMeasure),
        current: store.resolveBaseline(store.getDoc()),
        owed: false
      })
    ).toBe(false);
  });
});
