/**
 * Edge geometry: a silhouette with one side replaced by a break.
 *
 * This is geometry, not a filter. The break is a path, so it holds for a photo,
 * a solid fill, type or a whole frame, exports as plain `<path>`, and costs one
 * `<clipPath>` — no `feTurbulence`, which resvg cannot rasterize and Illustrator
 * drops on import, and no per-frame work.
 *
 * One kernel serves every profile. A profile contributes a single scalar field
 * (`offset`) plus whatever it wants painted along the seam; sampling, the curve,
 * the edge corrections and the box-nesting rules below belong here and are what
 * keep a scallop honest in the ways a tear already had to be.
 *
 * Determinism is the contract: the seed runs deterministic lattices, so the same
 * document draws the same break on canvas, in an export and on the next machine.
 */

import type { EdgeFinish, TearInput } from "../dsl/types";
import { edgeProfileShape, edgeScaleOf, edgeStepOf, resolveEdge } from "./edge-profiles";
import { bandD, boxD, curveD, pt, type Point } from "./edge-path";
import { holeGeometry } from "./edge-hole";
import type { EdgeEnv, EdgeRuns, EdgeSpec } from "./edge-profiles/types";
import { clamp, lattice } from "./edge-profiles/noise";

export type { Point };

export interface EdgeGeometry {
  /** The kept region, closed, in the element's local coordinates. */
  region: string;
  /** The break itself, open — stroked for the seam. */
  curve: string;
  /** Innermost bright paper ply, closed, stepping out from the break. */
  fringe: string;
  /** Middle warm paper ply, closed, stepping out past `fringe` in staggered bays. */
  ply: string;
  /** Outermost stone-tinted paper ply, closed, stepping out past `ply`. */
  veil: string;
  /** Where the break sits at each sample, for callers that need to place
   *  something on it. */
  points: Point[];
  finish: EdgeFinish;
}

/**
 * What a break looks like when nobody has said otherwise. `normalize` reads
 * these numbers too, so the panel's sliders and a hand-written document start
 * from the same place.
 */
export const EDGE_DEFAULT: Omit<TearInput, "seed"> = {
  side: "right",
  scale: 150,
  roughness: 0.6,
  fiber: 0
};

function awaySign(side: TearInput["side"]): number {
  return side === "right" || side === "bottom" ? 1 : -1;
}

/**
 * Build the break for a box whose origin is `(ox, oy)` in the space the paths
 * will be written in — which is the element's PARENT space, not its local one.
 *
 * The clip is referenced from a group that carries no translate (each branch of
 * the renderer translates itself), so a local-coordinate silhouette would be
 * cut at the page origin. Offsetting here rather than adding a wrapper transform
 * keeps the paths, the clip and the element's own translate in one space.
 *
 * A break ON the box edge is measured INWARD from it, never around it: a broken
 * layer must not paint outside the box its geometry declares, or alignment,
 * snapping and the export bounds all describe a shape the user cannot see. A
 * break INSIDE the box (`at` between 0 and 1) is centred on its guide instead,
 * because that is a cut through the sheet rather than an edge of it — and the
 * two halves of a split have to share the same curve to close the seam.
 *
 * This kernel builds ONE side — the `edge` form of a tear. The two loop forms
 * (`hole`, `scrap`) are `holeGeometry`; both are reached through `edgeFor`, which
 * is what the renderer and the inspector ask. A `form` of `hole` or `scrap` on
 * this input is ignored here rather than half-honoured.
 */
export function edgeGeometry(w: number, h: number, edge: TearInput, ox = 0, oy = 0): EdgeGeometry {
  const spec = resolveEdge(edge);
  const shape = edgeProfileShape(spec.profile);

  const width = Math.max(1, w);
  const height = Math.max(1, h);

  const side = spec.side;
  if (!side) {
    // Normalize refuses an open break with no side, so this is only reachable
    // from a hand-built effect — and the honest answer there is the plain box,
    // not an empty clip that hides the layer.
    return { region: boxD(ox, oy, width, height), curve: "", fringe: "", ply: "", veil: "", points: [], finish: "none" };
  }

  const s = edgeScaleOf(spec.scale);
  const step = edgeStepOf(s);

  // One lattice per shape, so two edges of the same document at the same seed
  // agree about what a break looks like.
  const base = lattice(spec.seed);
  const fibreLattice = lattice(spec.seed * 7919 + 13);

  const vertical = side === "left" || side === "right";
  const length = vertical ? height : width;
  const size = vertical ? width : height;

  const count = Math.max(2, Math.round(length / step));
  const actualStep = length / count;

  const amp = shape.amplitude(spec);
  const away = awaySign(side);

  /**
   * Where the break sits across the box at distance `t` along its side.
   *
   * One number is a break parallel to its edge; a pair tilts it, one end at each
   * corner, and everything in between is the straight run between them — which
   * is why the guide is a function of `t` here and a constant everywhere else.
   */
  const atOf = (t: number): number => {
    const one = spec.at;
    if (!Array.isArray(one)) return clamp(one ?? (side === "right" || side === "bottom" ? 1 : 0), 0, 1);
    const f = length > 0 ? clamp(t / length, 0, 1) : 0;
    return clamp(one[0], 0, 1) + (clamp(one[1], 0, 1) - clamp(one[0], 0, 1)) * f;
  };
  /** A break on the edge is measured inward by its own reach, so it never
   *  swings out through the box the layer declares. */
  const guideOf = (at: number): number => (at >= 1 ? size - amp : at <= 0 ? amp : at * size);

  const L = pt(ox);
  const T = pt(oy);
  const R = pt(ox + width);
  const B = pt(oy + height);

  /** The kept region: round the box, in along the break, and out again. */
  const regionOf = (first: Point, last: Point, body: string): string => {
    if (side === "right") return `M ${L} ${T} L ${pt(first.x)} ${T} ${body} L ${L} ${B} Z`;
    if (side === "left") return `M ${R} ${T} L ${pt(first.x)} ${T} ${body} L ${R} ${B} Z`;
    if (side === "top") return `M ${L} ${B} L ${L} ${pt(first.y)} ${body} L ${R} ${B} Z`;
    return `M ${L} ${T} L ${L} ${pt(first.y)} ${body} L ${R} ${pt(last.y)} L ${R} ${T} Z`;
  };

  /**
   * `scale: 0` is a straight cut, not a vanishing wave: no amplitude is left, so
   * the break IS the guide. Returned here, before any profile field is asked
   * for, because those fields divide by `scale` — and emitted as one segment,
   * which is also a fraction of the path data a sampled curve would carry.
   */
  if (amp === 0) {
    const g0 = guideOf(atOf(0));
    const g1 = guideOf(atOf(length));
    const first: Point = vertical ? { x: g0 + ox, y: oy } : { x: ox, y: g0 + oy };
    const last: Point = vertical ? { x: g1 + ox, y: oy + height } : { x: ox + width, y: g1 + oy };
    const cut = `M ${pt(first.x)} ${pt(first.y)} L ${pt(last.x)} ${pt(last.y)}`;
    return {
      region: regionOf(first, last, cut.slice(cut.indexOf("L"))),
      curve: cut,
      fringe: "",
      ply: "",
      veil: "",
      points: [first, last],
      finish: shape.finish
    };
  }

  /**
   * The offset actually used, i.e. the profile's field plus two corrections the
   * kernel owns and every profile inherits by asking for it through `offsetOf`.
   *
   * On an outer box edge the raw field is remapped from `[-amp, +amp]` onto
   * `[-amp, amp - headroom]`, reserving outward room for the plies without
   * flat-topping the wave peaks. Only a profile that steps plies out needs the
   * room, so a scallop gets its field untouched — which is also what keeps a
   * periodic profile exactly periodic.
   */
  const offsetOf = (which: EdgeSpec, t: number): number => {
    const at = atOf(t);
    const outer = at <= 0 || at >= 1;
    const raw = shape.offset(which, { t, base, away, outer });
    if (!outer || !shape.plies || which.fiber <= 0) return raw;
    const a = shape.amplitude(which);
    if (a <= 0) return raw;
    const headroom = Math.min(a * 0.62, (8.5 + 9.5 * which.fiber) * Math.min(1.25, s / 120));
    return raw * ((2 * a - headroom) / (2 * a)) - away * (headroom * 0.5);
  };

  const runs: EdgeRuns = { t: [], offset: [] };
  const posArr: number[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i * actualStep;
    const o = offsetOf(spec, t);
    runs.t.push(t);
    runs.offset.push(o);
    posArr.push(clamp(guideOf(atOf(t)) + o, 0, size));
  }

  const env: EdgeEnv = { fibre: fibreLattice, away, maxAmp: amp, offsetOf };
  const plyRuns = shape.plies ? shape.plies(spec, runs, env) : null;

  const points: Point[] = [];
  const innerPts: Point[] = [];
  const fringePts: Point[] = [];
  const plyPts: Point[] = [];
  const veilPts: Point[] = [];

  for (let i = 0; i <= count; i++) {
    const t = runs.t[i];
    const pos = posArr[i];
    const maxOutRoom = Math.max(0, (away > 0 ? size - pos : pos) - 0.35);
    const maxInRoom = Math.max(0, (away > 0 ? pos : size - pos) - 0.35);
    const w1 = plyRuns ? plyRuns.s1[i] : 0;
    const w2 = plyRuns ? plyRuns.s2[i] : 0;
    const w3 = plyRuns ? plyRuns.s3[i] : 0;

    // Tuck the inner seam slightly under the clipped artwork when any ply is
    // active, so anti-aliasing never leaves a hairline gap between them.
    const tuck = -Math.min(0.45, w3 * 0.3, maxInRoom) * away;
    const f1 = Math.min(w1, maxOutRoom) * away;
    const f2 = Math.min(w2, maxOutRoom) * away;
    const f3 = Math.min(w3, maxOutRoom) * away;

    if (vertical) {
      points.push({ x: pos + ox, y: t + oy });
      innerPts.push({ x: pos + tuck + ox, y: t + oy });
      fringePts.push({ x: pos + f1 + ox, y: t + oy });
      plyPts.push({ x: pos + f2 + ox, y: t + oy });
      veilPts.push({ x: pos + f3 + ox, y: t + oy });
    } else {
      points.push({ x: t + ox, y: pos + oy });
      innerPts.push({ x: t + ox, y: pos + tuck + oy });
      fringePts.push({ x: t + ox, y: pos + f1 + oy });
      plyPts.push({ x: t + ox, y: pos + f2 + oy });
      veilPts.push({ x: t + ox, y: pos + f3 + oy });
    }
  }

  const curve = curveD(points, shape.tension ?? 1 / 10);
  const first = points[0];
  const last = points[points.length - 1];
  const body = curve.slice(curve.indexOf("C") >= 0 ? curve.indexOf("C") : curve.length);

  const region = regionOf(first, last, body);

  const hasFibre = plyRuns !== null && spec.fiber > 0;
  return {
    region,
    curve,
    fringe: hasFibre ? bandD(innerPts, fringePts) : "",
    ply: hasFibre ? bandD(innerPts, plyPts) : "",
    veil: hasFibre ? bandD(innerPts, veilPts) : "",
    points,
    finish: shape.finish
  };
}

/**
 * Memoized per element, because the renderer asks on every pass and the answer
 * only changes when the box or a parameter does. Zoom and pan are not in the
 * key: a break is defined in the element's own coordinates, so scaling the
 * canvas must not re-break it.
 *
 * The one entry point for all three forms: the loop forms close the same field
 * into a loop, and everything downstream — the clip, the plies, the seam — reads
 * the same `EdgeGeometry` either way.
 */
const cache = new Map<string, EdgeGeometry>();
const CACHE_LIMIT = 256;

export function edgeFor(
  id: string,
  slot: number,
  x: number,
  y: number,
  w: number,
  h: number,
  edge: TearInput
): EdgeGeometry {
  const key =
    `${id}|${slot}|${Math.round(x)}|${Math.round(y)}|${Math.round(w)}|${Math.round(h)}|` +
    `${edge.side ?? ""}|${Array.isArray(edge.at) ? edge.at.join(",") : edge.at ?? ""}|` +
    `${edge.profile ?? "torn"}|${edge.scale}|${edge.roughness ?? ""}|${edge.fiber ?? ""}|${edge.seed}|` +
    `${edge.form ?? ""}|${edge.inset ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const loop = edge.form === "hole" || edge.form === "scrap";
  const next = loop ? holeGeometry(w, h, edge, x, y) : edgeGeometry(w, h, edge, x, y);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, next);
  return next;
}
