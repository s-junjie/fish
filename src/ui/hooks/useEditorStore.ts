import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { EditorStore } from "../../core/store/editor-store";
import { DesignDocument, getActivePage } from "../../core/dsl/types";
import { loadInitialDocument } from "../../core/data-bridge";


export interface ViewportSnapshot {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The document the UI renders, and the four ways to write to it.
 *
 * Rendered, not live: while a version is being viewed the store holds a
 * redirect and `doc`/`docRef` report that instead — which is what makes copy
 * copy the version. Writes still go to the store, which refuses them for as
 * long as the viewer state holds (see `EditorStore.writesRefused`).
 *
 * `docRef` is reassigned during render rather than in an effect on purpose: a
 * `useMemo` dependency or a gesture that reads it has to see the document of
 * THIS commit, and an effect runs a commit too late. Moving the assignment into
 * an effect is what silently freezes any memo that lists `docRef.current` as a
 * dependency — the dependency array is evaluated before the effect runs.
 */
export function useEditorStore(restoreViewport?: (v: ViewportSnapshot) => void) {
  const storeRef = useRef<EditorStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new EditorStore(loadInitialDocument());
  }
  const store = storeRef.current;
  // One snapshot for both facts the UI needs: which document it renders and
  // whether it may write it. They change on two different channels — an edit
  // and a viewer state — so a state each would mean one of them racing.
  const [view, setView] = useState(() => ({ doc: store.getViewDoc(), readOnly: store.isReadOnly() }));

  useEffect(() => {
    const refresh = () =>
      setView((prev) => {
        const doc = store.getViewDoc();
        const readOnly = store.isReadOnly();
        return prev.doc === doc && prev.readOnly === readOnly ? prev : { doc, readOnly };
      });
    const offDoc = store.subscribe(refresh);
    const offView = store.onViewChange(refresh);
    return () => {
      offDoc();
      offView();
    };
  }, [store]);

  const doc = view.doc;
  const docRef = useRef<DesignDocument>(doc);
  docRef.current = store.getViewDoc();

  const setDoc = useCallback(
    (updater: DesignDocument | ((prev: DesignDocument) => DesignDocument)) => {
      const next = typeof updater === "function" ? updater(store.getDoc()) : updater;
      store.setTransient(next);
      docRef.current = store.getViewDoc();
    },
    [store]
  );

  const commitSnapshot = useCallback(
    (newDoc: DesignDocument) => {
      store.commit(newDoc);
      docRef.current = store.getViewDoc();
    },
    [store]
  );

  const startDragGesture = useCallback(() => {
    store.startGesture();
  }, [store]);

  const endDragGesture = useCallback(() => {
    store.endGesture();
  }, [store]);

  // The viewport is not this hook's to own, so it is handed in rather than imported.
  const restoreRef = useRef(restoreViewport);
  restoreRef.current = restoreViewport;

  /**
   * A saved file carries the page it was saved on and the view it was saved
   * from, so reopening it comes back to both. Once, at boot: every later
   * restore is driven by an undo, a redo or a page switch, and re-running this
   * on one of those would drag the camera back over the step the user just took.
   */
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const viewport = getActivePage(store.getDoc()).metadata?.viewport;
    if (viewport) restoreRef.current?.({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  }, [store]);

  /**
   * A page's stored viewport is written once — when the user leaves that page —
   * so by the time any edit is undone it records where the page was *then*, not
   * where the user is now. Applying it to a same-page undo drags the canvas back
   * to the last page switch, which is what reads as "undo reset my view".
   *
   * Only a step that changed the active page gets it: the view being replaced is
   * of a page that is no longer on screen, so there is nothing to preserve.
   */
  const restoreAfterStep = useCallback(
    (pageIdBefore: string) => {
      const page = getActivePage(store.getDoc());
      if (page.id === pageIdBefore) return;
      const viewport = page.metadata?.viewport;
      if (viewport) restoreRef.current?.({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
    },
    [store]
  );

  const undo = useCallback(() => {
    const pageIdBefore = getActivePage(store.getDoc()).id;
    if (!store.undo()) return;
    restoreAfterStep(pageIdBefore);
  }, [store, restoreAfterStep]);

  const redo = useCallback(() => {
    const pageIdBefore = getActivePage(store.getDoc()).id;
    if (!store.redo()) return;
    restoreAfterStep(pageIdBefore);
  }, [store, restoreAfterStep]);

  return {
    store,
    doc,
    docRef,
    /** True while the document is a viewer's, not an author's — the one signal
     *  every read-only treatment (gates, greyed saves, armed tools) keys off. */
    readOnly: view.readOnly,
    setDoc,
    commitSnapshot,
    startDragGesture,
    endDragGesture,
    undo,
    redo
  };
}
