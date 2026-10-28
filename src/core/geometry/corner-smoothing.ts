/**
 * Corner geometry for the shapes that generate their outline from a box.
 *
 * Figma has TWO independent controls here, and conflating them is the mistake
 * this module exists to avoid:
 *
 * - **corner radius** — how far the corner is cut back, in pixels. A px length,
 *   so it scales with the box.
 * - **corner smoothing** — 0..1, the *character* of an already-rounded corner.
 *   0 is a circular arc; Figma's `iOS` preset (0.6) approaches the continuous
 *   curvature of a squircle.
 *
 * Both are built from one cubic per corner whose handles lie along the two edges,
 * so the curve leaves and rejoins each edge tangentially. The handle length is
 * the only knob, and it has an exact value for a circle:
 *
 *     h = t · (4/3)·tan((π−θ)/4)·tan(θ/2)
 *
 * where `t` is the cut distance and `θ` the interior angle. Two things about that
 * formula are easy to get wrong, and both are invisible at 90°:
 *
 * - the arc spans π−θ (a 90° corner rounds through 90° of arc), so the tangent
 *   term is tan((π−θ)/4), NOT tan(θ/4) — they agree only when θ is 90°;
 * - the factor is **angle-dependent**, and equals 0.552 only at 90°. A hardcoded
 *   0.552 draws a visibly wrong corner on a pentagon (0.446) or a hexagon (0.619).
 *
 * Smoothing then lengthens the handle beyond that circular value, which pushes
 * curvature at the straight-edge junction toward zero: the corner gets fuller,
 * the way a squircle is fuller than its inscribed circle. `FULLNESS_MAX` is where
 * that stops — one cubic cannot express a true squircle (it would need the
 * junction curvature to reach exactly zero, which a single cubic with tangent
 * handles cannot do at both ends), so 1.0 is the fullest this construction
 * carries, and the shape is a close approximation rather than an exact one.
 */

/**
 * Handle length as a multiple of the cut distance, for a circular corner at
 * interior angle `theta`.
 */
export function circularHandleFactor(theta: number): number {
  const half = theta / 2;
  // The arc through a corner of `theta` spans PI - theta, so this is the tangent
  // of a QUARTER of that span. A degenerate corner has no interior to round.
  const quarterArc = (Math.PI - theta) / 4;
  if (!(half > 0) || !(quarterArc > 0)) return 0;
  return (4 / 3) * Math.tan(quarterArc) * Math.tan(half);
}

/**
 * How much longer than circular the handle is, at a given smoothing. 1 is a
 * perfect circle; the top of the range is the fullest a single cubic carries.
 */
const FULLNESS_MAX = 1.8;
export function handleFullness(smoothing: number): number {
  return 1 + Math.min(1, Math.max(0, smoothing)) * (FULLNESS_MAX - 1);
}

export interface OutlinePoint {
  x: number;
  y: number;
}

/** The four points of one rounded corner, in path-command order. */
export interface CornerCurve {
  /** Where the curve leaves the incoming edge. */
  a: OutlinePoint;
  c1: OutlinePoint;
  c2: OutlinePoint;
  /** Where the curve rejoins the outgoing edge. */
  b: OutlinePoint;
}

const sub = (p: OutlinePoint, q: OutlinePoint): OutlinePoint => ({ x: p.x - q.x, y: p.y - q.y });
const dist = (p: OutlinePoint, q: OutlinePoint): number => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * One rounded corner at `vertex`, cut back `radius` along each adjacent edge.
 *
 * `radius` is clamped per edge to half that edge's length: past halfway, two
 * neighbouring corners would meet in the middle of the edge and eat it.
 */
export function cornerCurve(vertex: OutlinePoint, prev: OutlinePoint, next: OutlinePoint, radius: number): CornerCurve {
  const d1 = dist(prev, vertex);
  const d2 = dist(next, vertex);
  const t1 = d1 > 0 ? Math.min(radius, d1 * 0.5) : 0;
  const t2 = d2 > 0 ? Math.min(radius, d2 * 0.5) : 0;
  if (t1 <= 0 || t2 <= 0) return { a: vertex, c1: vertex, c2: vertex, b: vertex };

  const a = { x: vertex.x + ((prev.x - vertex.x) / d1) * t1, y: vertex.y + ((prev.y - vertex.y) / d1) * t1 };
  const b = { x: vertex.x + ((next.x - vertex.x) / d2) * t2, y: vertex.y + ((next.y - vertex.y) / d2) * t2 };

  // Interior angle between the two edges, from the law of cosines on the triangle
  // vertex-prev-next. Measured from the EDGES (not the fillet tangent), which is
  // what the circular formula above is stated in.
  const across = dist(prev, next);
  const cosTheta = Math.min(1, Math.max(-1, (d1 * d1 + d2 * d2 - across * across) / (2 * d1 * d2)));
  const theta = Math.acos(cosTheta);
  const factor = circularHandleFactor(theta);

  // Handles run from each cut point back toward the vertex, along its own edge.
  return {
    a,
    c1: { x: a.x + (vertex.x - a.x) * factor, y: a.y + (vertex.y - a.y) * factor },
    c2: { x: b.x + (vertex.x - b.x) * factor, y: b.y + (vertex.y - b.y) * factor },
    b
  };
}

/**
 * A cubic for one corner at an explicit handle factor. Shared with the smoothing
 * path, which is `cornerCurve` with the factor scaled by `handleFullness`.
 */
export function cornerCurveWithFullness(
  vertex: OutlinePoint,
  prev: OutlinePoint,
  next: OutlinePoint,
  radius: number,
  fullness: number
): CornerCurve {
  const base = cornerCurve(vertex, prev, next, radius);
  if (fullness === 1) return base;
  const scale = (from: OutlinePoint, handle: OutlinePoint): OutlinePoint => ({
    x: from.x + (handle.x - from.x) * fullness,
    y: from.y + (handle.y - from.y) * fullness
  });
  return {
    a: base.a,
    c1: scale(base.a, base.c1),
    c2: scale(base.b, base.c2),
    b: base.b
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Path data for a closed outline through `verts`, rounding every corner to
 * `radius` px and shaping it with `smoothing` 0..1.
 *
 * At `radius` 0 this is a plain closed polyline, so a shape with its corners left
 * sharp emits exactly the bytes it always did.
 */
export function closedOutlineToPathData(verts: OutlinePoint[], radius: number, smoothing: number): string {
  const n = verts.length;
  if (n < 3) return "";
  const cut = Math.max(0, radius);
  if (!(cut > 0)) {
    const parts = verts.map((v, i) => `${i === 0 ? "M" : "L"} ${round2(v.x)} ${round2(v.y)}`);
    return `${parts.join(" ")} Z`;
  }

  const fullness = handleFullness(smoothing);
  const curves: CornerCurve[] = verts.map((v, i) =>
    cornerCurveWithFullness(v, verts[(i - 1 + n) % n], verts[(i + 1) % n], cut, fullness)
  );

  const start = curves[0].a;
  const parts: string[] = [`M ${round2(start.x)} ${round2(start.y)}`];
  for (let i = 0; i < n; i++) {
    const c = curves[i];
    parts.push(
      `C ${round2(c.c1.x)} ${round2(c.c1.y)} ${round2(c.c2.x)} ${round2(c.c2.y)} ${round2(c.b.x)} ${round2(c.b.y)}`
    );
    // The straight run between one corner's exit and the next corner's entry.
    const next = curves[(i + 1) % n].a;
    parts.push(`L ${round2(next.x)} ${round2(next.y)}`);
  }
  parts.push("Z");
  return parts.join(" ");
}