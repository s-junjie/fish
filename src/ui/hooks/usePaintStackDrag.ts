import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { slotFromPointerY } from "../../core/dsl/paint-stack";

export interface StackDragUi {
  fromUi: number;
  slot: number;
  x: number;
  y: number;
  width: number;
  swatch: string;
  label: string;
}

interface StackDragParams<T> {
  /** The scrolling container the rows live in. Measured, never re-rendered from. */
  listRef: RefObject<HTMLElement | null>;
  /** Attribute stamped on every row; the drop slot is the midpoints of those. */
  rowAttr: string;
  /** What the floating ghost shows while a row is in flight. */
  ghostFor: (uiIndex: number) => { swatch: string; label: string };
  /** A drop that changed something. Decides whether it counts as one. */
  onCommit: (fromUi: number, insertBeforeUi: number) => void;
}

/**
 * Reordering for a vertical list of rows: the paint stacks (Fill, Stroke), the
 * style list. One implementation because the three call sites had drifted into
 * three copies of the same thirty lines, and only the row attribute differed.
 *
 * Row midpoints decide the landing slot, measured from the DOM because rows are
 * plain flow content. They are measured again on release, so a drop never lands
 * on a stale preview frame.
 *
 * `ghostFor` and `onCommit` are read through refs, so a re-render mid-drag — a
 * document write from the undo store, anything — swaps the callback instead of
 * tearing the window listeners down and dropping the drag on the floor.
 */
export function usePaintStackDrag<T>({
  listRef,
  rowAttr,
  ghostFor,
  onCommit
}: StackDragParams<T>) {
  const [dragUi, setDragUi] = useState<StackDragUi | null>(null);

  const ghostRef = useRef(ghostFor);
  ghostRef.current = ghostFor;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const slotAt = (clientY: number): number => {
    const els = listRef.current?.querySelectorAll<HTMLElement>(`[${rowAttr}]`);
    if (!els || els.length === 0) return 0;
    const centers = Array.from(els, (el) => {
      const b = el.getBoundingClientRect();
      return b.top + b.height / 2;
    });
    return slotFromPointerY(centers, clientY);
  };

  useEffect(() => {
    if (!dragUi) return;
    const fromUi = dragUi.fromUi;

    const onMove = (e: PointerEvent) => {
      const slot = slotAt(e.clientY);
      setDragUi((cur) =>
        cur && cur.slot === slot && cur.x === e.clientX && cur.y === e.clientY
          ? cur
          : cur
          ? { ...cur, slot, x: e.clientX, y: e.clientY }
          : cur
      );
    };

    const onUp = (e: PointerEvent) => {
      setDragUi(null);
      commitRef.current(fromUi, slotAt(e.clientY));
    };

    const onCancel = () => setDragUi(null);

    document.body.style.cursor = "grabbing";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragUi, rowAttr]);

  const beginDrag = (uiIndex: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = listRef.current?.getBoundingClientRect();
    setDragUi({
      fromUi: uiIndex,
      slot: uiIndex,
      x: e.clientX,
      y: e.clientY,
      width: rect?.width ?? 220,
      ...ghostRef.current(uiIndex)
    });
  };

  return { dragUi, beginDrag };
}
