import { describe, it, expect } from "vitest";
import type { DesignDocument } from "../src/core/dsl/types";
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
});
