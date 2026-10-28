/**
 * Minimal 2D affine matrix used as the single coordinate machinery for the
 * editor.
 *
 * The matrix layout matches SVG's `transform="matrix(a b c d e f)"`:
 *
 *   ⎡ a  c  e ⎤
 *   ⎢ b  d  f ⎥
 *   ⎣ 0  0  1 ⎦
 *
 * A point is transformed as `p' = M · p`. `multiply(A, B)` returns the matrix
 * that applies B first and then A — the same semantics as SVG's transform list,
 * where later transforms run first.
 *
 * Everything here is pure and allocation-light on purpose: the renderer and
 * hit-testing run it per node, per frame.
 */

export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Point {
  x: number;
  y: number;
}

export const identityMatrix = (): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** Multiplication A·B — apply B first, then A. */
export function multiply(A: Matrix2D, B: Matrix2D): Matrix2D {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f
  };
}

export function translation(tx: number, ty: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function rotation(angleRad: number): Matrix2D {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** Rotation expressed in degrees for convenience. */
export function rotationDeg(angle: number): Matrix2D {
  return rotation((angle * Math.PI) / 180);
}

/** Rotation around an arbitrary pivot point. */
export function rotationAround(angleRad: number, cx: number, cy: number): Matrix2D {
  return multiply(translation(cx, cy), multiply(rotation(angleRad), translation(-cx, -cy)));
}

export function rotationAroundDeg(angle: number, cx: number, cy: number): Matrix2D {
  return rotationAround((angle * Math.PI) / 180, cx, cy);
}

export function scale(sx: number, sy: number): Matrix2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** `M⁻¹`. Returns `null` for a degenerate (non-invertible) matrix. */
export function invert(m: Matrix2D): Matrix2D | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv
  };
}

export function transformPoint(m: Matrix2D, p: Point): Point {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f
  };
}

/**
 * `m`'s LINEAR part applied to a delta — `transformPoint` without the shift.
 *
 * A difference of two points is a vector, and a translation moves both ends
 * equally, so the `e`/`f` terms cancel. Passing a delta to `transformPoint`
 * instead adds the translation to a quantity that has none, which for a drag is
 * the element's whole distance from the canvas origin.
 */
export function transformVector(m: Matrix2D, v: Point): Point {
  return {
    x: m.a * v.x + m.c * v.y,
    y: m.b * v.x + m.d * v.y
  };
}

/** Whether `m` maps everything to itself. */
export function isIdentityMatrix(m: Matrix2D): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
}

/**
 * The matrix as an SVG `transform` attribute, or `undefined` for the identity.
 *
 * `undefined` rather than `matrix(1 0 0 1 0 0)` on purpose: an SVG attribute that
 * carries no transform leaves the markup byte-identical to what an untransformed
 * node always produced, and the canvas's memo comparator is a byte-level whitelist
 * — spelling the identity out would put a `transform` on every one of the
 * thousands of unrotated nodes for nothing.
 */
export function matrixToSvg(m: Matrix2D): string | undefined {
  if (isIdentityMatrix(m)) return undefined;
  return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
}

/**
 * The rotation `m` applies, in degrees, measured off its own first basis vector.
 *
 * A reflection has no single angle, so a matrix with a negative determinant has
 * none to report and reads as 0 — a caller asking "which way is this box facing"
 * wants the turn, and a mirrored box does not have one.
 */
export function matrixRotationDeg(m: Matrix2D): number {
  if (m.a * m.d - m.b * m.c < 0) return 0;
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}
