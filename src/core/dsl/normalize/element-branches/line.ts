import { asNumber, isPlainObject } from "../shared";
import { normalizeStrokes } from "../stroke";
import type { ElementBranch } from "./shared";

/**
 * An origin plus a delta, with the box derived from the delta so AABB helpers
 * stay correct. `from` / `to` is an alternative spelling for x/y → dx/dy
 * supported on the fly for hand-authored JSON.
 */
export const normalizeLine: ElementBranch = ({ el, base, path, repairs, box }) => {
  const from = isPlainObject(el.from) ? el.from : undefined;
  const to = isPlainObject(el.to) ? el.to : undefined;
  if (from) {
    base.x = asNumber(from.x) ?? box.x;
    base.y = asNumber(from.y) ?? box.y;
  }
  const hasDelta = typeof el.dx === "number" || typeof el.dy === "number";
  if (hasDelta) {
    base.dx = asNumber(el.dx) ?? 0;
    base.dy = asNumber(el.dy) ?? 0;
  } else {
    const absX2 = asNumber(to?.x) ?? (asNumber(base.x) ?? 0) + box.width;
    const absY2 = asNumber(to?.y) ?? asNumber(base.y) ?? 0;
    base.dx = absX2 - (base.x as number);
    base.dy = absY2 - (base.y as number);
  }

  // A line IS its stroke, so it always carries a stack of at least one: a line
  // that wrote none still has to paint something.
  base.strokes = normalizeStrokes(el, path, repairs) ?? [
    { color: "#000000", width: 1, style: "solid" }
  ];
  base.width = Math.max(0, Math.abs(base.dx as number));
  base.height = Math.max(0, Math.abs(base.dy as number));
};

/** An arrow is a line with optional arrowheads; the geometry is the line's. */
export const normalizeArrow: ElementBranch = normalizeLine;
