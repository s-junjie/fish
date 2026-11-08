import type { Matrix2D } from "./matrix";

/** The transform fields an import can carry, read off a linear map. */
export interface AffineFields {
  rotation: number;
  skewX: number;
  skewY: number;
}

const EPS = 1e-3;

const deg = (radians: number): number => Math.round(((radians * 180) / Math.PI) * 1000) / 1000;

/**
 * The DSL's transform fields for a linear map, or nothing when it carries
 * something the DSL cannot hold.
 *
 * Four fields against four numbers, but they do not correspond: a rotation plus
 * a shear on both axes is five, so a matrix has more than one reading. Two are
 * tried, in the order pages write them:
 *
 * 1. **A bare shear** — `skewX()`, `skewY()`, `skew()` on their own. The
 *    diagonal is the scale and here it is 1, so the map IS the shear.
 * 2. **A rotation with a shear on X** — `rotate(r) skewX(a)`. The turn comes
 *    off the first column; a shear on Y would have moved that column, which is
 *    why this reading cannot carry one.
 *
 * Everything else — `rotate(r) skewY(a)`, a scale, a mirror — has no spelling in
 * these fields. Refusing it lets the caller NAME the loss, which is better than
 * writing a transform that is subtly not the author's.
 */
export function readAffine(m: Matrix2D): AffineFields | undefined {
  const { a, b, c, d } = m;
  if (![a, b, c, d].every(Number.isFinite)) return undefined;
  // A negative determinant is a mirror, which is a field of its own — the caller
  // reads it off the same matrix and must not have it folded into an angle.
  if (a * d - b * c <= EPS) return undefined;

  if (Math.abs(a - 1) <= EPS && Math.abs(d - 1) <= EPS) {
    return { rotation: 0, skewX: deg(Math.atan2(c, d)), skewY: deg(Math.atan2(b, a)) };
  }

  const length = Math.hypot(a, b);
  if (Math.abs(length - 1) > EPS) return undefined;
  const rotation = Math.atan2(b, a);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // `R(-θ)·M`: the upper-right entry is the shear, the lower-right the scale
  // left over — 1 when the map is only a turn and a shear.
  const shear = cos * c + sin * d;
  const scale = -sin * c + cos * d;
  if (Math.abs(scale - 1) > EPS) return undefined;
  return { rotation: deg(rotation), skewX: deg(Math.atan2(shear, scale)), skewY: 0 };
}
