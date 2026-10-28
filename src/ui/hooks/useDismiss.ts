import { useEffect, useRef } from "preact/hooks";

/**
 * The open dismissable panels and the layer each one sits on.
 *
 * A stack, because one press must be answered by exactly one panel: the innermost
 * it falls inside, and none of the panels beneath. The old single "this event was
 * taken" slot could not say that — it recorded whichever handler ran FIRST, and
 * listener order follows registration, so the host could still close on a press
 * that belonged to the picker it had opened.
 */
const DEPTH = new Map<HTMLElement, number>();

/**
 * Stops the rest of the gesture that just dismissed a nested picker.
 *
 * A press is several events and the one a panel hears is the first of them:
 * `pointerdown` closes the picker, then `mousedown` and `click` reach whatever is
 * underneath — the canvas, which clears the selection on both. Both are stopped
 * at capture for this press only; the listener is released by its own `click`
 * (the last event of the gesture) so the NEXT press is nobody's but the canvas's.
 */
function swallowPressRest(): void {
  const stop = (e: Event) => e.stopPropagation();
  const release = () => {
    document.removeEventListener("mousedown", stop, true);
    document.removeEventListener("click", stop, true);
  };
  document.addEventListener("mousedown", stop, true);
  document.addEventListener("click", stop, true);
  document.addEventListener("click", () => setTimeout(release, 0), { once: true, capture: true });
  // A press that never produces a click (dragged off, cancelled) must not leave
  // the canvas deaf.
  setTimeout(release, 500);
}

/** One layer above the panel that was innermost when this one opened. */
function nextDepth(): number {
  let top = 0;
  for (const value of DEPTH.values()) if (value > top) top = value;
  return top + 1;
}

/** Whether some panel opened AFTER this one is still standing. */
function isBelowPane(mine: HTMLElement | null): boolean {
  if (!mine) return false;
  const mineDepth = DEPTH.get(mine);
  if (mineDepth === undefined) return false;
  for (const [panel, depth] of DEPTH) if (depth > mineDepth || (depth === mineDepth && panel !== mine)) return true;
  return false;
}

/**
 * Whether another panel is still standing UNDER this one.
 *
 * A press that closes the top of a stack unwinds ONE layer: the panel beneath is
 * still on screen, so the press is not the canvas's. The difference is the whole
 * of why a nested picker is usable — the child closed, the canvas then cleared
 * the selection, and the host went with it, collapsing both on one press.
 */
function hasPaneBeneath(mine: HTMLElement | null): boolean {
  if (!mine) return false;
  const mineDepth = DEPTH.get(mine);
  if (mineDepth === undefined) return false;
  for (const [panel, depth] of DEPTH) if (panel !== mine && depth <= mineDepth) return true;
  return false;
}

/** Whether this panel is the one that opened a picker on top of itself. */
function isNestedResponder(mine: HTMLElement | null): boolean {
  if (!mine) return false;
  const mineDepth = DEPTH.get(mine);
  if (mineDepth === undefined) return false;
  for (const [panel, depth] of DEPTH) if (depth > mineDepth && panel !== mine) return true;
  return false;
}

/**
 * Dismisses a floating panel on Escape or on a pointer press outside it.
 *
 * `anchor` (normally the trigger) counts as inside, otherwise the very press
 * that opened the panel would also close it. `keepInside` names further
 * selectors that also count as inside — a panel that opens another panel (the
 * style picker's colour picker, its effect-type menu) would otherwise close the
 * parent on the press that opened the child.
 *
 * A panel that HOSTS a picker unwinds one layer per press: while the child is up
 * the press is the child's, and this panel goes on the next one.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  panel: { current: HTMLElement | null },
  anchor?: { current: HTMLElement | null },
  keepInside?: readonly string[],
  /** A picker this one opened is on top of it right now. */
  pickerAbove?: () => boolean
): void {
  /**
   * The listeners are registered ONCE per open and read the caller's closures
   * through this ref.
   *
   * Registering them per render — the deps used to be the inline arrows a caller
   * passes — moved this panel to the BACK of the listener list every time it
   * re-rendered, and the stack is read when the press arrives. By then the child,
   * whose handler now ran first, had closed itself and left the stack, so the
   * host read "nothing above me" and closed with it: one press, both panels.
   */
  const live = useRef({ close, anchor, keepInside, pickerAbove });
  live.current = { close, anchor, keepInside, pickerAbove };

  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    /**
     * A panel stops when a picker IT opened is still on screen above it; the
     * depth stack answers that for every panel, whatever order the listeners run in.
     */
    const standsDown = () => !!live.current.pickerAbove?.();

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const mine = panel.current;
      if (mine?.contains(target)) return;
      if (live.current.anchor?.current?.contains(target)) return;
      if (live.current.keepInside?.some((sel) => target.closest?.(sel))) return;
      if (standsDown()) return;
      // EVERY panel above this one stands down, not only the one whose event ran
      // first. "Did the child already take this press?" cannot be read from one
      // mutable slot: the child removes itself from the stack as it closes, so
      // this check has to see it still standing.
      if (isBelowPane(mine)) return;
      // The press belongs to the panel it lands in, so its `click` must reach
      // that panel's own buttons. The swallow is for a press that unwound one
      // layer of a stack — closing the top panel is the whole of what such a
      // press may do; letting it through also reaches the canvas, whose
      // `mousedown`/`click` clear the selection and take the hosting panel with
      // it. The LAST panel's press is the canvas's: nothing is beneath it, so
      // the same click that dismisses the picker also acts on what is under it.
      if (isNestedResponder(mine) || hasPaneBeneath(mine)) swallowPressRest();
      live.current.close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229) return;
      if (e.key !== "Escape") return;
      if (standsDown()) return;
      live.current.close();
    };
    // The panel's layer, claimed once: a second claim would take `nextDepth()`
    // again and put this panel ABOVE the picker it had just opened.
    if (el && !DEPTH.has(el)) DEPTH.set(el, nextDepth());
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (el) DEPTH.delete(el);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, panel]);
}
