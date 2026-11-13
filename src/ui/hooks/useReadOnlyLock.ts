import { useEffect } from "preact/hooks";
import type { EditorStore } from "../../core/store/editor-store";

/**
 * The store half of `docs/READONLY.md` R5.
 *
 * Every shell mounts the store, so every shell has to apply this lock — the
 * reader renders no editing surface, and this is what makes a stray shortcut, a
 * restored gesture or a plugin call unable to reach the document either. It is
 * deliberately not part of a document hook: `readOnly` is only ever true in the
 * reader and the bare embed, because `resolveViewMode` answers `viewer` before
 * anything else, so a lock owned by the editor would never run.
 */
export function useReadOnlyLock(store: EditorStore, readOnly: boolean) {
  useEffect(() => {
    if (readOnly) store.setReadOnly("shared-file");
  }, [readOnly, store]);
}
