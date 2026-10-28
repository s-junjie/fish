import { Pt } from "./path-data";

/**
 * Recovers Bézier geometry from the polygon soup a boolean operation returns.
 *
 * `polygon-clipping` speaks only polylines, so every curve handed to it has to
 * be flattened first and the answer comes back flattened too. Emitting that
 * answer verbatim turns a circle into an 80-gon, so the flat rings are fitted
 * back into cubics here: dense near-collinear runs stay `L`, and everything else
 * is fitted from the tangent directions the sampled points actually imply.
 *
 * A circle comes out as roughly a dozen cubics rather than the four an SVG
 * `circle` would use. The extra ones are the price of measuring the fit at
 * chord-length parameters, which is the only parameterisation available without
 * an iterative least-squares re-solve; the deviation is far below the tolerance
 * anything can see, and the split points are uneven as a result.
 */

export interface FittedEdge {
  kind: "line" | "cubic";
  /** Index into the returned `anchors` array of the edge's destination. */
  toIdx: number;
  to: Pt;
  ca?: Pt;
  cb?: Pt;
}

export interface FittedRing {
  /** `anchors[0]` is where `d` starts; each edge's `to` is the next anchor. */
  anchors: Pt[];
  edges: FittedEdge[];
}

/** Recursion guard: a run that still misses tolerance this deep keeps its cubic. */
const MAX_DEPTH = 8;
/**
 * A turn sharper than this is a CORNER, and a corner is not a fitting error to be
 * minimised — it is a shape decision. Fitted by deviation alone, a rectangle's
 * two visible corners round off, because a symmetric cubic can pass exactly
 * through all three points of a right angle while drawing a smooth diagonal
 * between the outer two. Splitting at corners first is what keeps them sharp.
 *
 * 30° sits clear of both: `ellipseRing` samples turn 4.5°, `rectRing`'s rounded
 * corners turn 11°, and a 24-gon turns 15°.
 */
const CORNER_TURN = 1 - Math.cos((30 * Math.PI) / 180);
/** A tangent doubling back on the chord collapses the handle-length factor. */
const MIN_HANDLE_DENOM = 0.05;

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });

const unit = (v: Pt): Pt => {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
};

/**
 * How far a fitted cubic is allowed to sit from the points it replaces.
 *
 * Scaled off the ring's own size so a 4px icon and a 4000px illustration land on
 * the same visual error, and clamped at both ends because the ratio only makes
 * sense between them. 1.5e-3 of the diagonal is a fraction of a pixel on any
 * shape this codebase deals with.
 */
export function fitTolerance(pts: Array<{ x: number; y: number }>): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.min(1, Math.max(0.02, Math.hypot(maxX - minX, maxY - minY) * 1.5e-3));
}

/**
 * Central difference, so a shared anchor yields the SAME direction from both
 * sides and neighbouring cubics meet G1-continuous. A one-sided chord estimate
 * instead is skewed by half a sample step, which on a short arc is most of the
 * arc's own turning — enough to push an easy quarter circle past tolerance.
 */
function tangentAt(pts: Pt[], i: number): Pt {
  const n = pts.length;
  if (i > 0 && i < n - 1) return unit(sub(pts[i + 1], pts[i - 1]));
  if (i === 0) return unit(sub(pts[1], pts[0]));
  return unit(sub(pts[n - 1], pts[n - 2]));
}

function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function isStraightWindow(pts: Pt[], from: number, to: number, tol: number): boolean {
  const a = pts[from];
  const v = sub(pts[to], a);
  const len = Math.hypot(v.x, v.y);
  if (len < 1e-9) return false;
  const normal = { x: -v.y / len, y: v.x / len };
  for (let i = from + 1; i < to; i++) {
    if (Math.abs(dot(sub(pts[i], a), normal)) > tol) return false;
  }
  return true;
}

/**
 * Handle length for an arc of chord `len` leaving at `dir`: (2/3)·len/(1+cos θ),
 * which is 4/3·r·tan(θ/4) rewritten in chord terms and lands on the textbook
 * 0.5523r for a quarter circle. A tangent that doubles back on the chord drives
 * the denominator to zero, so it falls back to a short stub instead of overshooting.
 */
function handleLength(len: number, denom: number): number {
  return denom > MIN_HANDLE_DENOM ? ((2 / 3) * len) / denom : len * 0.35;
}

/** Fits one window and reports how far it misses, plus where it misses worst. */
function fitWindow(
  pts: Pt[],
  from: number,
  to: number
): { ca: Pt; cb: Pt; err: number; idx: number } {
  const p0 = pts[from];
  const p3 = pts[to];
  const v = sub(p3, p0);
  const len = Math.hypot(v.x, v.y);
  let ca: Pt;
  let cb: Pt;
  if (len < 1e-9) {
    ca = p0;
    cb = p3;
  } else {
    const u = mul(v, 1 / len);
    // BOTH tangents make angle Δ/2 with the chord direction `u` — not with its
    // reverse — so both handle lengths get the same `1 + dot` factor. Using the
    // reverse for the end handle makes that factor vanish on short arcs and the
    // handle run away to hundreds of units.
    const t0 = tangentAt(pts, from);
    const t1 = tangentAt(pts, to);
    ca = add(p0, mul(t0, handleLength(len, 1 + dot(t0, u))));
    cb = sub(p3, mul(t1, handleLength(len, 1 + dot(t1, u))));
  }

  // Error is measured at ARC-LENGTH parameters, not at even steps: a cubic's t is
  // not uniform along a circular arc — it crowds near both ends — so measuring at
  // i/(n-1) reports several times the true deviation at the extremes and splits
  // quarters that already fit comfortably.
  const n = to - from;
  const chord: number[] = [0];
  for (let i = 1; i <= n; i++) {
    chord[i] = chord[i - 1] + Math.hypot(pts[from + i].x - pts[from + i - 1].x, pts[from + i].y - pts[from + i - 1].y);
  }
  const total = chord[n] || 1;

  const evalAt = (t: number): Pt => {
    const s = 1 - t;
    return {
      x: s * s * s * p0.x + 3 * s * s * t * ca.x + 3 * s * t * t * cb.x + t * t * t * p3.x,
      y: s * s * s * p0.y + 3 * s * s * t * ca.y + 3 * s * t * t * cb.y + t * t * t * p3.y
    };
  };

  let err = 0;
  let idx = from + 1;
  const note = (d: number, i: number) => {
    if (d > err) {
      err = d;
      idx = i;
    }
  };
  for (let i = from + 1; i < to; i++) {
    const b = evalAt(chord[i - from] / total);
    note(Math.hypot(b.x - pts[i].x, b.y - pts[i].y), i);
  }

  // The pass above only asks where the SOURCE points land, which cannot see a
  // curve that bulges between them — and on a short window that bulge is the
  // whole error. So walk the cubic too and measure it against the source
  // POLYLINE. Distance to the segments, not to the vertices: on a densely sampled
  // ring the nearest vertex is always half a sample step away, so measuring there
  // reports an error no curve could ever avoid and shatters the ring into lines.
  const dense = Math.min(32, Math.max(6, 4 * (to - from)));
  for (let k = 1; k < dense; k++) {
    const b = evalAt(k / dense);
    let best = Infinity;
    let nearest = from + 1;
    for (let i = from; i < to; i++) {
      const d = pointSegmentDistance(b, pts[i], pts[i + 1]);
      if (d < best) {
        best = d;
        nearest = i + 1;
      }
    }
    note(best, Math.min(to - 1, Math.max(from + 1, nearest)));
  }

  return { ca, cb, err, idx };
}

/** The sharpest interior corner of the window, or -1 when the run has none. */
function sharpestCornerIn(pts: Pt[], from: number, to: number): number {
  let best = -1;
  let worst = -1;
  for (let i = from + 1; i < to; i++) {
    const into = unit(sub(pts[i], pts[i - 1]));
    const outOf = unit(sub(pts[i + 1], pts[i]));
    const turn = 1 - dot(into, outOf);
    if (turn > worst) {
      worst = turn;
      best = i;
    }
  }
  return worst > CORNER_TURN ? best : -1;
}

/** `toIdx` inside the fitter still counts source points; the caller renumbers. */
type RawEdge = Omit<FittedEdge, "toIdx"> & { toIdx: number };

/** Index of the point furthest from `from` — where to open a closed window. */
function farthestFrom(pts: Pt[], from: number, to: number): number {
  let best = from + 1;
  let bestD = -1;
  for (let i = from + 1; i < to; i++) {
    const d = (pts[i].x - pts[from].x) ** 2 + (pts[i].y - pts[from].y) ** 2;
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Fits the walk `pts[from] → … → pts[to]`, splitting at the worst-fitting point
 * until each piece is within tolerance.
 *
 * Indices stay absolute through every recursion. Slicing instead would put each
 * window's boundaries at array edges, where `tangentAt` has nothing on one side
 * and has to fall back to a chord.
 */
function fitRun(pts: Pt[], from: number, to: number, tol: number, depth: number): RawEdge[] {
  if (to <= from) return [];
  const end = pts[to];
  if (to === from + 1) return [{ kind: "line", toIdx: to, to: end }];

  const p0 = pts[from];
  if (Math.hypot(end.x - p0.x, end.y - p0.y) < 1e-9) {
    // The window closes on itself — one full turn of a ring — so there is no
    // chord to fit a cubic against. Open it at the point furthest from the start
    // (the antipode, for a circle) and fit the two halves as ordinary runs.
    const mid = farthestFrom(pts, from, to);
    if (depth >= MAX_DEPTH || mid <= from || mid >= to) {
      return [{ kind: "line", toIdx: to, to: end }];
    }
    return [...fitRun(pts, from, mid, tol, depth + 1), ...fitRun(pts, mid, to, tol, depth + 1)];
  }

  if (isStraightWindow(pts, from, to, tol * 0.25)) {
    return [{ kind: "line", toIdx: to, to: end }];
  }

  const corner = depth < MAX_DEPTH ? sharpestCornerIn(pts, from, to) : -1;
  if (corner !== -1) {
    return [...fitRun(pts, from, corner, tol, depth + 1), ...fitRun(pts, corner, to, tol, depth + 1)];
  }

  const one = fitWindow(pts, from, to);
  if (one.err <= tol || depth >= MAX_DEPTH || one.idx <= from || one.idx >= to) {
    return [{ kind: "cubic", toIdx: to, to: end, ca: one.ca, cb: one.cb }];
  }

  // An edge is named by where it lands, so the halves tile the walk exactly:
  // this side owns `from+1 … idx`, the other owns `idx+1 … to`.
  return [...fitRun(pts, from, one.idx, tol, depth + 1), ...fitRun(pts, one.idx, to, tol, depth + 1)];
}

/** Where a ring's sharpest turn is — the safest place to cut the cycle open. */
function sharpestVertex(pts: Pt[]): number {
  const n = pts.length;
  let best = 0;
  let bestTurn = -1;
  for (let i = 0; i < n; i++) {
    const into = unit(sub(pts[i], pts[(i - 1 + n) % n]));
    const outOf = unit(sub(pts[(i + 1) % n], pts[i]));
    const turn = 1 - dot(into, outOf);
    if (turn > bestTurn) {
      bestTurn = turn;
      best = i;
    }
  }
  return best;
}

function dedupePoints(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(prev.x - p.x, prev.y - p.y) > 1e-9) out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9) out.pop();
    else break;
  }
  return out;
}

/**
 * Fits one closed ring into anchors plus edges. `d` starts at `anchors[0]` and
 * every edge appends `to`, so the caller gets the closing edge for free — its
 * destination is `anchors[0]` again, which is exactly the duplicate final anchor
 * `parsePathData` already knows to collapse via `zc`.
 */
export function fitRingToEdges(ring: Array<[number, number]>): FittedRing | null {
  const pts = dedupePoints(ring.map(([x, y]) => ({ x, y })));
  if (pts.length < 3) return null;
  const tol = fitTolerance(pts);

  const start = sharpestVertex(pts);
  const rotated = [...pts.slice(start), ...pts.slice(0, start)];
  const n = rotated.length;
  // One point of context on each side of the seam, so both window boundaries
  // still have a neighbour on the far side and `tangentAt` stays central.
  const ext = [rotated[n - 1], ...rotated, rotated[0], rotated[1]];
  const raw = fitRun(ext, 1, n + 1, tol, 0).filter((e) => e.toIdx <= n + 1);
  if (raw.length === 0) return null;

  // Renumber into anchor space. A fit keeps far fewer points than the ring it
  // replaces, so the source index and the anchor index are not the same number
  // and the segments would address past the end of `anchors`.
  const anchors: Pt[] = [rotated[0]];
  const edges: FittedEdge[] = raw.map((e, i) => {
    anchors.push(e.to);
    return { ...e, toIdx: i + 1 };
  });
  return { anchors, edges };
}
