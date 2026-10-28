import { useEffect } from "preact/hooks";
import { DesignDocument, DesignElement, getActivePage, updateActivePageElements } from "../../core/dsl/types";
import { relayoutDocumentTree } from "../../core/compile";
import { instanceSizeResolver } from "../../core/interactions/instance-size";
import { clearHeldMasters } from "../../core/interactions/detached-masters";
import { perfClear, perfTotals } from "../../core/perf";

export interface UseTestBridgeOptions {
  docRef: { current: DesignDocument };
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  commitSnapshot: (doc: DesignDocument) => void;
  undo: () => void;
  redo: () => void;
}

/**
 * `window.__FISH_BRIDGE__`, the handle the test harness drives the editor through.
 *
 * Re-registered whenever the selection changes, which is what keeps
 * `getSelectedIds` honest: every other member reads the live document through the
 * ref and would otherwise never need re-registering at all.
 *
 * `getDoc()` hands back the document itself — the same object `__fish.doc` gives
 * an agent, with the tree in `pages[i].children` and nowhere else. A probe that
 * wants the active page's tree asks for it by name (`getElements`) rather than
 * for a field that only a test could see.
 */
export function useTestBridge({
  docRef,
  selectedIds,
  setSelectedIds,
  commitSnapshot,
  undo,
  redo
}: UseTestBridgeOptions) {
  useEffect(() => {
    (window as any).__FISH_BRIDGE__ = {
      getDoc: () => docRef.current,
      /** The active page's tree — the one thing a probe reads by the page, not by the document. */
      getElements: () => getActivePage(docRef.current).children,
      applyDoc: (newDoc: DesignDocument) => {
        // A wholesale document replacement is a new session of truth: definitions
        // held for a cut/deleted master belong to the document that is gone.
        clearHeldMasters();
        // Relayout for the same reason the file loader does (`loadEmbeddedDocument`):
        // a document arrives with authored numbers, and every box the layout owns has
        // to be measured before anything reads it. A fixture that skipped this would
        // store a hugging master's authored width while the canvas drew the hug, and
        // the next gesture would then start its drag from a number nothing displays.
        const cur = getActivePage(newDoc);
        commitSnapshot(
          updateActivePageElements(
            newDoc,
            relayoutDocumentTree(cur.children, instanceSizeResolver(newDoc))
          )
        );
      },
      /**
       * Put a tree on the active page, with an optional patch to the rest of the
       * document (`canvas`, `assets`, `styles`).
       *
       * This is what a fixture means when it says "here are the elements": the
       * page is the unit, so there is no document-level array to write and no
       * shape a probe could get wrong. `applyDoc` stays the wholesale door and
       * takes a document in the one form a document has.
       */
      setElements: (elements: DesignElement[], patch: Partial<DesignDocument> = {}) => {
        clearHeldMasters();
        const base: DesignDocument = { ...docRef.current, ...patch };
        commitSnapshot(
          updateActivePageElements(
            base,
            relayoutDocumentTree(elements, instanceSizeResolver(base))
          )
        );
      },
      insertElement: (el: DesignElement) => {
        const cur = getActivePage(docRef.current);
        commitSnapshot(updateActivePageElements(docRef.current, [...cur.children, el]));
      },
      selectElement: (id: string) => setSelectedIds(new Set([id])),
      /** The multi-select path a probe needs: shift-click builds the same thing. */
      selectElements: (ids: string[]) => setSelectedIds(new Set(ids)),
      getSelectedIds: () => Array.from(selectedIds),
      /**
       * Frame cost per instrumented seam — `fish.dragFrame`, `fish.snapCandidates`,
       * `fish.commit`, `fish.layerPlan` — as `{ count, totalMs, maxMs }`, or empty
       * until `window.__FISH_PERF__` is set.
       *
       * It lives here, not on `__fish`, because it is a diagnostic for whoever is
       * driving the editor, not a capability of the DSL: an agent authoring a
       * document neither causes nor can act on the editor's frame budget, and
       * `dsl.md` documents `__fish` exhaustively (see `version-consistency`).
       * Read `maxMs`, not the total — the frame that cost 250 ms is invisible in a
       * sum, and a vsync floor makes a frame-delta sampler useless for the same
       * reason.
       */
      perf: () => perfTotals(),
      perfClear: () => perfClear(),
      undo,
      redo
    };
  }, [selectedIds, docRef, setSelectedIds, commitSnapshot, undo, redo]);
}
