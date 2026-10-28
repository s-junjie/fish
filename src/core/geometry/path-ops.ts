import {
  EditablePath,
  EditableSegment,
  Pt,
  normalizePathOrigin,
  parsePathData,
  removeAnchor,
  serializePathData
} from "./path-data";
import { DesignElement, PathElement } from "../dsl/types";
import { convertShapeToPathElement, isConvertibleToPath } from "./path-convert";

/**
 * Whole-path operations that rewrite the editable model rather than move one
 * point: splitting a path into its subpaths, subdividing a segment, and
 * flattening curves. They share the anchor/segment bookkeeping that
 * `parsePathData` and `serializePathData` agree on, which is why they sit
 * beside that model instead of in the UI that triggers them.
 */

export function cubicAt(p0: Pt, ca: Pt, cb: Pt, p1: Pt, t: number): Pt {
  const s = 1 - t;
  return {
    x: s * s * s * p0.x + 3 * s * s * t * ca.x + 3 * s * t * t * cb.x + t * t * t * p1.x,
    y: s * s * s * p0.y + 3 * s * s * t * ca.y + 3 * s * t * t * cb.y + t * t * t * p1.y
  };
}

export function quadAt(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const s = 1 - t;
  return {
    x: s * s * p0.x + 2 * s * t * c.x + t * t * p1.x,
    y: s * s * p0.y + 2 * s * t * c.y + t * t * p1.y
  };
}

const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
});

/**
 * The path cut at every anchor marked `m`, so each result is one subpath.
 *
 * A compound path — an outline with a hole in it — is a single `d` string but
 * several separate rings to anything geometric. Reading it as one ring welds
 * the hole to the outline and destroys both.
 */
export function splitSubpaths(path: EditablePath): EditablePath[] {
  const parts: EditablePath[] = [];
  const partOf: number[] = [];
  const localOf: number[] = [];
  for (let i = 0; i < path.anchors.length; i++) {
    if (path.anchors[i].m || parts.length === 0) {
      parts.push({ anchors: [], segments: [], closed: false });
    }
    const p = parts.length - 1;
    partOf[i] = p;
    localOf[i] = parts[p].anchors.length;
    parts[p].anchors.push({ x: path.anchors[i].x, y: path.anchors[i].y });
  }
  for (const seg of path.segments) {
    const pa = partOf[seg.a];
    const pb = partOf[seg.b];
    if (pa === undefined || pb === undefined || pa !== pb) continue;
    parts[pa].segments.push({ ...seg, a: localOf[seg.a], b: localOf[seg.b] } as EditableSegment);
  }
  // `closed` only ever described the last subpath, so that is where it lands.
  if (parts.length > 0) parts[parts.length - 1].closed = path.closed;
  return parts.filter((p) => p.anchors.length > 0);
}

/**
 * Inserts an anchor partway along a segment, splitting it in two.
 *
 * de Casteljau rather than a fresh handle guess: the original curve's control
 * polygon is halved, so the drawn shape is bit-for-bit unchanged and the new
 * anchor arrives already smooth — its two handles are collinear by construction.
 */
export function insertAnchorAt(path: EditablePath, segIdx: number, t: number): EditablePath {
  const seg = path.segments[segIdx];
  if (!seg) return path;
  const a = path.anchors[seg.a];
  const b = path.anchors[seg.b];
  if (!a || !b) return path;
  const u = Math.min(1, Math.max(0, t));

  // The new anchor goes where the segment starts, not at the end of the array.
  // Anchors are ordered by traversal — `serializePathData` reads them in segment
  // order and the `m` flag means "begins a subpath" — so appending would leave
  // the walk pointing backwards through the tail of the path.
  const at = seg.a + 1;
  const bump = (i: number) => (i >= at ? i + 1 : i);
  let mid: Pt;
  let left: EditableSegment;
  let right: EditableSegment;

  if (seg.kind === "line") {
    mid = lerpPt(a, b, u);
    left = { kind: "line", a: seg.a, b: at };
    right = { kind: "line", a: at, b: bump(seg.b), ...(seg.z ? { z: true as const } : {}) };
  } else if (seg.kind === "quad") {
    const q0 = lerpPt(a, seg.c, u);
    const q1 = lerpPt(seg.c, b, u);
    mid = lerpPt(q0, q1, u);
    left = { kind: "quad", a: seg.a, b: at, c: q0 };
    // `zc` marks a real segment that ENDS at the subpath start, so it travels onto
    // the half that still lands there.
    right = { kind: "quad", a: at, b: bump(seg.b), c: q1, ...(seg.zc ? { zc: true as const } : {}) };
  } else {
    const q0 = lerpPt(a, seg.ca, u);
    const q1 = lerpPt(seg.ca, seg.cb, u);
    const q2 = lerpPt(seg.cb, b, u);
    const r0 = lerpPt(q0, q1, u);
    const r1 = lerpPt(q1, q2, u);
    mid = lerpPt(r0, r1, u);
    // The left half keeps the HALVED first handle, not the original: its endpoint
    // slid to `mid`, so the handle beside it has to slide with it.
    left = { kind: "cubic", a: seg.a, b: at, ca: q0, cb: r0 };
    right = { kind: "cubic", a: at, b: bump(seg.b), ca: r1, cb: q2, ...(seg.zc ? { zc: true as const } : {}) };
  }

  const anchors = [...path.anchors];
  anchors.splice(at, 0, mid);
  const segments = path.segments.map((s) => ({ ...s, a: bump(s.a), b: bump(s.b) }) as EditableSegment);
  segments.splice(segIdx, 1, left, right);

  return { ...path, anchors, segments };
}

const controlPolygonLength = (a: Pt, b: Pt, c: Pt, d: Pt): number =>
  Math.hypot(b.x - a.x, b.y - a.y) +
  Math.hypot(c.x - b.x, c.y - b.y) +
  Math.hypot(d.x - c.x, d.y - c.y);

/**
 * Sample count from the curve's own size, so a 3px curve does not get 48 anchors
 * and a 600px one does not get 4.
 */
const samplesFor = (len: number, maxSegmentLength: number): number =>
  Math.min(48, Math.max(4, Math.ceil(len / maxSegmentLength)));

/**
 * Replaces every curve with straight segments. Line segments are left alone, so
 * a path that is already polygonal round-trips unchanged.
 */
export function flattenPathData(path: EditablePath, maxSegmentLength = 6): EditablePath {
  const anchors: Array<Pt & { m?: true }> = [];
  const segments: EditableSegment[] = [];
  let cur = -1;

  const beginSubpath = (p: Pt) => {
    anchors.push(anchors.length > 0 ? { x: p.x, y: p.y, m: true } : { x: p.x, y: p.y });
    cur = anchors.length - 1;
  };

  const pushEdge = (p: Pt): boolean => {
    const prev = anchors[cur];
    // A sample that lands on the previous point would emit a zero-length edge.
    if (prev && Math.hypot(prev.x - p.x, prev.y - p.y) < 1e-6) return false;
    const from = cur;
    anchors.push({ x: p.x, y: p.y });
    cur = anchors.length - 1;
    segments.push({ kind: "line", a: from, b: cur });
    return true;
  };

  for (const seg of path.segments) {
    const a = path.anchors[seg.a];
    const b = path.anchors[seg.b];
    if (!a || !b) continue;
    if ((seg.a !== 0 && a.m) || cur === -1) beginSubpath(a);

    // A synthetic closepath is drawn by Z alone — there is no edge to flatten.
    if (seg.kind === "line" && seg.z) {
      segments.push({ kind: "line", a: cur, b: cur, z: true });
      continue;
    }

    const n =
      seg.kind === "line"
        ? 1
        : seg.kind === "quad"
          ? samplesFor(
              Math.hypot(seg.c.x - a.x, seg.c.y - a.y) + Math.hypot(b.x - seg.c.x, b.y - seg.c.y),
              maxSegmentLength
            )
          : samplesFor(controlPolygonLength(a, seg.ca, seg.cb, b), maxSegmentLength);

    let pushed = false;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const p =
        seg.kind === "line"
          ? { x: b.x, y: b.y }
          : seg.kind === "quad"
            ? quadAt(a, seg.c, b, t)
            : cubicAt(a, seg.ca, seg.cb, b, t);
      if (pushEdge(p)) pushed = true;
    }
    // `zc` marks a real segment that ENDS at the subpath start, so it belongs on
    // the half that still lands there — the one just emitted.
    if (seg.zc && pushed && segments.length > 0) {
      (segments[segments.length - 1] as EditableSegment).zc = true;
    }
  }

  return { anchors, segments, closed: path.closed };
}

export interface PathHit {
  segIdx: number;
  t: number;
  point: Pt;
  dist: number;
}

/** Coarse sweep then ternary refinement — no derivative, so no Newton blowup. */
function closestOnSegment(seg: EditableSegment, a: Pt, b: Pt, target: Pt): { t: number; point: Pt; dist: number } {
  const at = (t: number): Pt =>
    seg.kind === "line"
      ? lerpPt(a, b, t)
      : seg.kind === "quad"
        ? quadAt(a, seg.c, b, t)
        : cubicAt(a, seg.ca, seg.cb, b, t);

  const COARSE = 32;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i <= COARSE; i++) {
    const t = i / COARSE;
    const p = at(t);
    const d = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  let lo = Math.max(0, bestT - 1 / COARSE);
  let hi = Math.min(1, bestT + 1 / COARSE);
  for (let i = 0; i < 24; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const p1 = at(m1);
    const p2 = at(m2);
    const d1 = (p1.x - target.x) ** 2 + (p1.y - target.y) ** 2;
    const d2 = (p2.x - target.x) ** 2 + (p2.y - target.y) ** 2;
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const point = at(t);
  return { t, point, dist: Math.hypot(point.x - target.x, point.y - target.y) };
}

/**
 * Closest spot on the path to `target`, in the path's own coordinates. Turns a
 * click anywhere near a segment into "insert an anchor right here".
 */
export function nearestPointOnPath(path: EditablePath, target: Pt): PathHit | null {
  let best: PathHit | null = null;
  for (let segIdx = 0; segIdx < path.segments.length; segIdx++) {
    const seg = path.segments[segIdx];
    const a = path.anchors[seg.a];
    const b = path.anchors[seg.b];
    if (!a || !b) continue;
    const hit = closestOnSegment(seg, a, b, target);
    if (best === null || hit.dist < best.dist) best = { segIdx, ...hit };
  }
  return best;
}

/** Flattens a `d` string; null when it does not parse or has no geometry. */
export function flattenPathString(d: string, maxSegmentLength?: number): string | null {
  const path = parsePathData(d);
  if (!path || path.anchors.length === 0) return null;
  return serializePathData(flattenPathData(path, maxSegmentLength)) || null;
}

/**
 * Flatten's whole-selection entry point: every curve becomes straight segments,
 * and a shape that only draws itself parametrically is converted to a path first
 * because otherwise there is no curve in it to flatten.
 *
 * Flattening shifts the box — a polyline's vertex bounds are a hair inside the
 * curve's — so the path is re-normalized rather than left claiming the old one.
 * Elements with no path geometry (frames, text, images) pass through untouched.
 */
export function flattenElement(el: DesignElement): DesignElement {
  if (el.type !== "path" && !isConvertibleToPath(el)) return el;
  const asPath = el.type === "path" ? (el as PathElement) : convertShapeToPathElement(el);
  if (!asPath) return el;
  const model = parsePathData(asPath.d);
  if (!model || model.anchors.length === 0) return el;
  // Asked of the INPUT, not the output: after flattening every segment is a line,
  // which is the success condition, so testing the result made the check fire on
  // exactly the paths it was meant to act on and Flatten did nothing at all.
  if (model.segments.every((s) => s.kind === "line")) return asPath;
  const flat = flattenPathData(model);
  const { normalized, offsetX, offsetY, width, height } = normalizePathOrigin(flat);
  return {
    ...asPath,
    x: round2(asPath.x + offsetX),
    y: round2(asPath.y + offsetY),
    width,
    height,
    d: serializePathData(normalized)
  };
}

export function flattenElements(elements: DesignElement[]): DesignElement[] {
  return elements.map(flattenElement);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * What the pen's add / remove modes can act on at one spot on a path.
 *
 * Shared by both places that offer the gesture — the pen tool's own overlay and
 * the vector-edit overlay — so "one handle's reach" means the same number in both.
 */
export interface PenTarget {
  model: EditablePath;
  /** Nearest point along the outline. */
  hit: PathHit | null;
  /** Nearest anchor, and how far the cursor sits from it. */
  anchorIdx: number;
  anchorDist: number;
}

export function resolvePenTarget(model: EditablePath, local: Pt, reach: number): PenTarget | null {
  const target: PenTarget = { model, hit: nearestPointOnPath(model, local), anchorIdx: 0, anchorDist: Infinity };
  model.anchors.forEach((p, i) => {
    const d = Math.hypot(local.x - p.x, local.y - p.y);
    if (d < target.anchorDist) {
      target.anchorDist = d;
      target.anchorIdx = i;
    }
  });
  const pathDist = target.hit ? target.hit.dist : Infinity;
  if (Math.min(target.anchorDist, pathDist) > reach) return null;
  return target;
}

/**
 * The new path for one click, or null when the click was not close enough to
 * anything. `remove` only takes an anchor — there is no such thing as removing a
 * point that was never placed — and it never strips a path below two anchors.
 */
export function applyPenTarget(
  target: PenTarget,
  mode: "add" | "remove",
  reach: number
): EditablePath | null {
  if (mode === "remove") {
    if (target.anchorDist > reach || target.model.anchors.length <= 2) return null;
    const next = removeAnchor(target.model, target.anchorIdx);
    return next.anchors.length === 0 ? null : next;
  }
  if (!target.hit || target.anchorDist <= reach) return null;
  return insertAnchorAt(target.model, target.hit.segIdx, target.hit.t);
}
