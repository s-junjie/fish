import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";

export interface Placement {
  left: number;
  top: number;
}

interface AnchoredPositionParams {
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  /**
   * Where the panel goes. Called with the live nodes, not a rect, because the
   * placements differ in more than arithmetic: ColorPanel offsets from its HOST
   * panel rather than from the swatch that opened it, and clamps its own height
   * while it decides.
   */
  compute: (anchor: HTMLElement, panel: HTMLElement) => Placement | null;
  /** Re-measure when these change — a view mode, an open flag. */
  deps?: unknown[];
}

/**
 * Places a portalled panel against an anchor and keeps it there.
 *
 * Four components did this separately — the style picker, the effect-type menu,
 * the font picker, the colour panel — and the "measure once the panel exists"
 * step is where they were most alike and most fragile. Two rules matter and were
 * re-derived at each site:
 *
 *  - **Never render before measuring.** The first layout effect runs before the
 *    panel has a height, so a placement computed from a fallback height puts it
 *    somewhere wrong and the panel then jumps. `pos` stays `null` until a real
 *    measurement exists, and callers keep the panel `visibility: hidden` until
 *    then. A hidden element also cannot take focus, which is why focusing is a
 *    separate effect gated on `pos`.
 *  - **Re-place on every size change**, not just on mount: the panel's own
 *    ResizeObserver, the window resize, and any scroll (capture, because the
 *    panel may be scrolling inside a clipping ancestor).
 */
export function useAnchoredPosition({
  anchorRef,
  panelRef,
  compute,
  deps = []
}: AnchoredPositionParams): Placement | null {
  const [pos, setPos] = useState<Placement | null>(null);

  const placeRef = useRef<() => void>(() => {});
  placeRef.current = () => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const next = compute(anchor, panel);
    if (!next) return;
    // Sub-pixel noise must not re-render the panel on every scroll tick.
    setPos((cur) =>
      cur && Math.abs(cur.left - next.left) < 0.5 && Math.abs(cur.top - next.top) < 0.5 ? cur : next
    );
  };

  useLayoutEffect(() => {
    placeRef.current();
    const el = panelRef.current;
    const observer =
      el && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => placeRef.current())
        : null;
    if (el && observer) observer.observe(el);
    const onViewportChange = () => placeRef.current();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRef, panelRef, ...deps]);

  return pos;
}

/** The side panel family's shared edges: 8px viewport, 10px off the anchor, 20px bottom. */
export const SIDE_PANEL_MARGIN = 8;
export const SIDE_PANEL_GAP = 10;
export const SIDE_PANEL_BOTTOM = 20;

/**
 * A panel opened from inside another panel clears the HOST, not the swatch that
 * opened it — otherwise it lands underneath its own parent.
 */
export const HOST_POPOVER_SELECTOR = "[data-host-popover], [data-style-picker-popover]";

/**
 * Left-of-the-anchor, or right when the viewport cannot hold the preferred side.
 *
 * Eight panels spelled this arithmetic out inline, with a constant trio repeated
 * above each one; the flip is the part that was re-derived (and re-broken) at
 * every copy.
 */
export function sidePanelLeft(
  bounds: { left: number; right: number },
  width: number,
  gap = SIDE_PANEL_GAP,
  margin = SIDE_PANEL_MARGIN
): number {
  const preferred = bounds.left - width - gap;
  if (preferred >= margin) return preferred;
  return Math.max(margin, Math.min(bounds.right + gap, window.innerWidth - width - margin));
}

/**
 * The `compute` a side panel hands `useAnchoredPosition`: anchored to the left of
 * its host, flipped to the right when there is no room, and clamped vertically to
 * prefer below, then above, then a bottom-anchored fit.
 *
 * `hostSelector` defaults to `HOST_POPOVER_SELECTOR`; a nested picker prepends
 * its own attribute to that chain. `null` measures from the anchor itself.
 */
export function sidePanelCompute(
  width: number,
  fallbackHeight: number,
  hostSelector?: string | null
) {
  return (anchor: HTMLElement, panel: HTMLElement): Placement | null => {
    const a = anchor.getBoundingClientRect();
    // Unlaid-out anchors (a detached row, a hidden section) have an all-zero
    // rect; placing against it would park the panel at the viewport corner.
    if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) return null;
    const host = hostSelector === null ? null : anchor.closest(hostSelector ?? HOST_POPOVER_SELECTOR);
    const bounds = host ? host.getBoundingClientRect() : a;
    const left = sidePanelLeft(bounds, width);

    const height = panel.offsetHeight || fallbackHeight;
    const fitsBelow = a.top + height <= window.innerHeight - SIDE_PANEL_BOTTOM;
    const fitsAbove = a.top - height >= SIDE_PANEL_MARGIN;
    const top = fitsBelow
      ? a.top
      : fitsAbove
        ? a.top - height
        : Math.max(SIDE_PANEL_MARGIN, window.innerHeight - height - SIDE_PANEL_BOTTOM);
    return { left, top };
  };
}

/** The hidden-until-placed style every anchored panel shares. */
export function placementStyle(
  pos: Placement | null,
  width: number,
  extra?: Record<string, string | number | undefined>
): Record<string, string | number | undefined> {
  return {
    left: pos?.left ?? -9999,
    top: pos?.top ?? -9999,
    width,
    visibility: pos ? "visible" : "hidden",
    ...extra
  };
}
