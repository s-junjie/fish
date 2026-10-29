import { useEffect, useState } from "preact/hooks";
import type { EditorStore } from "../../core/store/editor-store";

/** Whether a drag, scrub or slider is currently in flight. */
export function useGestureActive(store: EditorStore): boolean {
  const [active, setActive] = useState(store.isGestureActive());
  useEffect(() => {
    setActive(store.isGestureActive());
    return store.onGestureChange(() => setActive(store.isGestureActive()));
  }, [store]);
  return active;
}
