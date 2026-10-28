import type { Rect } from "./bounds";

/**
 * The canvas zoom range, in the units the viewport transform uses (`scale(zoom)`,
 * so 1 is 1:1). The ceiling is Figma's 6400% — the number Figma is known by, and
 * what a designer editing a 2px hairline or an 8px icon actually reaches for.
 * The floor is 2%, which is what makes a whole artboard or a phone-plus-its-
 * annotations legible on one screen: a floor of 10% already cannot show a 5000px
 * board whole, so a fit silently crops and the user reads that as the frame being
 * too small rather than as a zoom limit.
 *
 * It lives here, not in `useCanvasViewport`, because a page's stored
 * `metadata.viewport.zoom` is read back on undo, on redo and on a page switch.
 * That value comes out of the document, so a hand-edited file or a
 * model-authored one can carry anything, and clamping at those three call sites
 * is three chances to forget. The normalizer clamps on the way in instead, so
 * every reader — and every later one — inherits the bound.
 */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

/**
 * The world rect a container-local `area` is showing, through the canvas
 * transform the stage is written with: `translate(pan) scale(zoom)`.
 *
 * `area` is in the transform's own space (the one `fitRect` takes), so this is
 * the inverse of the mapping the gestures use — `screen = world * zoom + pan`.
 * It answers "what is the user looking at" for every insert that arrives with no
 * position, which is why it takes the area rather than measuring one: a caller
 * that can see the canvas passes the unobstructed box, and one that cannot still
 * gets the arithmetic right.
 */
export function visibleRectOf(area: Rect, zoom: number, pan: { x: number; y: number }): Rect {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    x: (area.x - pan.x) / z,
    y: (area.y - pan.y) / z,
    width: area.width / z,
    height: area.height / z
  };
}

/**
 * The top-left that centres a `size` box in `rect`.
 *
 * Rounded, because every caller writes the answer straight into an element's
 * `x`/`y`. A GROUP of sources is centred by `offsetCenteringSourcesIn`, which
 * measures them in their own coordinates; this is the single-box case a
 * positionless insert needs.
 */
export function centerInRect(
  rect: Rect,
  size: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: Math.round(rect.x + rect.width / 2 - size.width / 2),
    y: Math.round(rect.y + rect.height / 2 - size.height / 2)
  };
}

export const clampZoom = (zoom: number): number =>
  Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1;

export interface PageViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * How far one wheel event moves the zoom, as a factor.
 *
 * Exponential in the delta, and deliberately UNCAPPED: a trackpad pinch arrives
 * as a stream of small ctrl+wheel deltas and should scale with finger velocity,
 * and a mouse wheel arrives as ONE ±100..120 event that is meant to travel — one
 * notch is a 3.3x step, which is what makes the gesture feel like Figma's.
 *
 * The cost of that is real and measured: on a 3,120-element page at 7 % zoom the
 * p50 frame is 16.7 ms (the vsync floor) when the step is 1.00, 33.3 ms at 0.95,
 * 66.6 ms at 0.84 and 133.2 ms at 0.17 — because a bigger step mounts and
 * unmounts more of the tree in the same frame. The lever is the mount, not this
 * number; capping it here would be buying smoothness with the gesture.
 *
 * `deltaMode` is normalised to pixels first — a wheel that reports lines reports
 * 3 of them for the same notch.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  return Math.exp(-Math.max(-80, Math.min(80, pixels)) * 0.015);
}

/**
 * The rungs `+` / `-` and the title bar's own buttons step through:
 * Figma's doubling ladder, anchored on 1:1, spanning exactly the range above. A
 * multiplicative step of the wheel's kind would be wrong for a key press — the
 * wheel's 1.05 is a gesture that is repeated, a key press is one command that has
 * to move somewhere you can see.
 */
export const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64] as const;

/** The next rung in `direction`, clamped at the ends — so a press at the ceiling is a no-op rather than a jump back. */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  const current = Number.isFinite(zoom) ? zoom : 1;
  if (direction === 1) {
    for (const rung of ZOOM_STEPS) if (rung > current * 1.001) return rung;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current * 0.999) return ZOOM_STEPS[i];
  }
  return MIN_ZOOM;
}

/**
 * The zoom as the title bar reads it. A decimal below 10% because the
 * integer reading of the bottom of the range collapses six distinguishable
 * zooms onto "1%", and that is exactly where a designer is working when they need
 * to read it — rounded to 2 places first, so the 2% floor reads `2%` and not
 * `2.0%` off the back of a float.
 */
export function formatZoomPercent(zoom: number): string {
  const percent = Math.round((Number.isFinite(zoom) ? zoom : 1) * 100 * 100) / 100;
  if (percent >= 10) return `${Math.round(percent)}%`;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * A page's remembered viewport, or `undefined` when there isn't a usable one. A
 * non-finite `x`/`y`/`zoom` is dropped rather than clamped: `translate(NaNpx)`
 * and `scale(NaN)` paint nothing, so a corrupt value is not a view to restore.
 */
export function normalizePageViewport(raw: unknown): PageViewport | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { x, y, zoom } = raw as Record<string, unknown>;
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return undefined;
  return { x, y, zoom: clampZoom(zoom) };
}
