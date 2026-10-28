import { Rect } from "./bounds";

export interface FitResult {
  zoom: number;
  pan: { x: number; y: number };
}

export interface FitOptions {
  /** Breathing room left between the content and the edges of `area`, in px. */
  margin?: number;
  minZoom?: number;
  maxZoom?: number;
}

/**
 * Frame world-space `bounds` inside `area`, and report it as the canvas
 * transform's own two numbers.
 *
 * `area` is in the container's coordinates — the space `translate(pan)
 * scale(zoom)` is written in — so its origin is the container's top-left corner,
 * not the window's. Two callers need this: the editor's zoom-to-fit, and
 * presentation mode, which fits into an area it measures itself.
 *
 * Returns null when `area` has no usable extent, which is the only case where
 * "fit" has no answer at all.
 */
export function fitRect(bounds: Rect | null, area: Rect, options: FitOptions = {}): FitResult | null {
  const { margin = 48, minZoom = 0.1, maxZoom = 5 } = options;
  if (area.width <= 0 || area.height <= 0) return null;

  // An empty page has no box to frame, so it falls back to 1:1 centred on the
  // area — the one reading of "fit" that still means something there.
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return { zoom: 1, pan: { x: area.x + area.width / 2, y: area.y + area.height / 2 } };
  }

  const usableWidth = Math.max(1, area.width - margin * 2);
  const usableHeight = Math.max(1, area.height - margin * 2);
  const raw = Math.min(usableWidth / bounds.width, usableHeight / bounds.height);
  // `clampZoom` guards the non-finite case on purpose, and every reader of a
  // zoom inherits that: a NaN here becomes `scale(NaN)` and paints nothing at
  // all, with no error to find it by. The normalizer coerces the numbers that
  // reach this, so the guard is unreachable today and free to keep.
  const zoom = Number.isFinite(raw) ? Math.min(maxZoom, Math.max(minZoom, raw)) : 1;

  return {
    zoom,
    pan: {
      x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * zoom
    }
  };
}
