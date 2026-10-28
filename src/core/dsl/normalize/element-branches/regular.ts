import { asNumber } from "../shared";
import { normalizeCornerControls, paintClosedShape, type ElementBranch } from "./shared";

export const normalizePolygon: ElementBranch = ({ el, base, path, repairs }) => {
  // Regular polygon; geometry is generated at compile time. `sides` accepts
  // any numeric spelling and is clamped to the schema's 3..24 range.
  const sides = Math.round(asNumber(el.sides) ?? 5);
  base.sides = Math.min(24, Math.max(3, Number.isFinite(sides) ? sides : 5));
  normalizeCornerControls(el, base, false);
  paintClosedShape(el, base, path, repairs, "polygon");
};

export const normalizeStar: ElementBranch = ({ el, base, path, repairs }) => {
  // Regular star; geometry is generated at compile time. `points` counts
  // spikes and is clamped like a polygon's `sides`, which is the same range
  // for the same reason: past ~24 the outline is all vertices and no shape.
  const points = Math.round(asNumber(el.points) ?? 5);
  base.points = Math.min(24, Math.max(3, Number.isFinite(points) ? points : 5));

  // Written only when supplied, so a star that never set either survives a
  // round-trip byte-identical — and so `?innerRadius` on a star means the
  // authored ratio rather than being backfilled to a polygon's 0.
  const innerRadius = asNumber(el.innerRadius);
  if (innerRadius !== undefined) base.innerRadius = Math.min(0.99, Math.max(0, innerRadius));
  normalizeCornerControls(el, base, false);

  paintClosedShape(el, base, path, repairs, "star");
};
