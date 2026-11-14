import { useCallback, useEffect, useRef } from "preact/hooks";
import { DesignDocument } from "../../core/dsl/types";
import { EditorStore } from "../../core/store/editor-store";
import { shouldWarnBeforeUnload } from "../../core/persistence/unload-guard";

export function useDirtyBaseline(store: EditorStore, hasPendingWork: () => boolean) {
  // Reference identity rather than content hashing avoids blocking `beforeunload` on inline bitmaps.
  const lastSavedDocRef = useRef<DesignDocument | null>(null);
  if (lastSavedDocRef.current === null) lastSavedDocRef.current = store.getDoc();

  const hasPendingWorkRef = useRef(hasPendingWork);
  hasPendingWorkRef.current = hasPendingWork;

  // Follow font-loading rebaselines so untouched documents don't leave `beforeunload` armed.
  const rebaselinedRef = useRef<WeakMap<DesignDocument, DesignDocument>>(new WeakMap());

  const latestBaseline = useCallback(
    (doc: DesignDocument): DesignDocument => {
      let cur = store.resolveBaseline(doc);
      while (rebaselinedRef.current.has(cur)) {
        cur = store.resolveBaseline(rebaselinedRef.current.get(cur)!);
      }
      return cur;
    },
    [store]
  );

  useEffect(() => {
    return store.onRebaseline((prev, next) => {
      rebaselinedRef.current.set(prev, next);
      if (lastSavedDocRef.current === prev) {
        lastSavedDocRef.current = next;
      }
    });
  }, [store]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const saved = lastSavedDocRef.current;
      if (!saved) return;
      const dirty = shouldWarnBeforeUnload({
        saved: latestBaseline(saved),
        current: latestBaseline(store.getDoc()),
        owed: hasPendingWorkRef.current()
      });
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [store, latestBaseline]);

  const markSaved = useCallback(
    (doc: DesignDocument) => {
      lastSavedDocRef.current = latestBaseline(doc);
    },
    [latestBaseline]
  );

  const getLastSavedDoc = useCallback(() => lastSavedDocRef.current, []);

  const isDirty = useCallback(
    () =>
      lastSavedDocRef.current !== null &&
      latestBaseline(lastSavedDocRef.current) !== latestBaseline(store.getDoc()),
    [store, latestBaseline]
  );

  return {
    latestBaseline,
    markSaved,
    getLastSavedDoc,
    isDirty
  };
}
