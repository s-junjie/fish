import type { EdgeInsets, TearInput } from "../dsl/types";
import type { EdgeGeometry } from "./edge";
import { edgeProfileShape, edgeScaleOf, edgeStepOf, resolveEdge } from "./edge-profiles";
import type { EdgeEnv, EdgeRuns, EdgeSpec } from "./edge-profiles/types";
import { clamp, lattice } from "./edge-profiles/noise";
import { bandD, boxD, curveD, type Point } from "./edge-path";

/**
 * The closed break: the same profile field, laid around a loop inside the sheet.
 *
 * A one-side break replaces one edge of the box, so everything it needs is
 * already axis-aligned. A hole has no axis — it needs a contour, an inside and
 * an outside — so the kernel here walks the inset rectangle's perimeter and
 * bends it by the field at arc length `t`.
 *
 * **The loop closes by mirroring.** A profile's field is written over a straight
 * run and has no reason to return to its starting value after one lap; sampling
 * it around a loop would leave a step at the seam. Mirroring about the seam —
 * `offset(u) = field(min(u, P - u))` — closes it exactly, for every profile and
 * every seed, without a second noise basis. The pattern is symmetric about the
 * seam, which is what a tear that reversed direction looks like, and the seam is
 * the one place a torn hole honestly has a notch.
 */

/** Past this the path data, not the fidelity, is what a hole costs. */
const MAX_SAMPLES = 720;

/**
 * Where the loop's nominal contour sits, in px from each box edge.
 *
 * The default is the tear's own reach, so an authored hole never swings out
 * through the edge the layer declares. Exported because the inspector has to
 * show the same numbers the kernel draws with — a control that starts at 0 while
 * the hole sits 30px in is a control that lies.
 *
 * Each margin is capped at half its own axis, so no pair of them can cross and
 * leave the loop inverted; the two axes cap independently, which is what lets a
 * full-width slot have a 90px top margin on a 200px-tall box.
 */
export function holeInsetsOf(edge: TearInput, w: number, h: number): EdgeInsets {
  const spec = resolveEdge(edge);
  const amp = edgeProfileShape(spec.profile).amplitude(spec);
  const short = Math.min(Math.max(1, w), Math.max(1, h));
  // A sheet with a hole in it, not a picture frame: the margin has to be worth
  // looking at — but never less than the tear's own reach, or the tear would
  // swing out through the layer's edge. Whole percents: this is a number the
  // panel shows, and a default of 32.4 is a number nobody typed.
  const reachPct = ((amp * 1.7) / Math.max(1, short / 2)) * 100;
  const auto = Math.round(clamp(Math.max(reachPct, 32), 0, 100));
  const raw = spec.inset;
  const one = typeof raw === "number" ? raw : auto;
  const m = Array.isArray(raw) ? raw : [one, one, one, one];
  return [clamp(m[0], 0, 100), clamp(m[1], 0, 100), clamp(m[2], 0, 100), clamp(m[3], 0, 100)];
}

export function holeGeometry(w: number, h: number, edge: TearInput, ox = 0, oy = 0): EdgeGeometry {
  const spec = resolveEdge(edge);
  const shape = edgeProfileShape(spec.profile);

  const width = Math.max(1, w);
  const height = Math.max(1, h);
  const s = edgeScaleOf(spec.scale);
  const step = edgeStepOf(s);
  const amp = shape.amplitude(spec);
  const base = lattice(spec.seed);
  const fibre = lattice(spec.seed * 7919 + 13);

  // Percentages are of the way in from each edge, so 100 is a loop of no size
  // and 0 is no margin at all. Every sampled point is also clamped into the box,
  // because a hand-written `inset` must not push the tear out through the
  // layer's own edge.
  const [topPct, rightPct, bottomPct, leftPct] = holeInsetsOf(edge, width, height);
  const x0 = ox + (leftPct / 100) * (width / 2);
  const y0 = oy + (topPct / 100) * (height / 2);
  const x1 = ox + width - (rightPct / 100) * (width / 2);
  const y1 = oy + height - (bottomPct / 100) * (height / 2);
  const hw = Math.max(2, x1 - x0);
  const hh = Math.max(2, y1 - y0);
  const P = 2 * (hw + hh);

  // The seam is the middle of the top edge, and it is not a control: it is where
  // the mirrored field turns around, so it moves the whole tear's symmetry with
  // it. Re-rolling the seed is what changes the break.
  const u0 = hw / 2;

  /** Point on the nominal contour and its outward normal, at arc length `u`. */
  const walk = (u: number): { x: number; y: number; nx: number; ny: number } => {
    let d = ((u % P) + P) % P;
    if (d < hw) return { x: x0 + d, y: y0, nx: 0, ny: -1 };
    d -= hw;
    if (d < hh) return { x: x1, y: y0 + d, nx: 1, ny: 0 };
    d -= hh;
    if (d < hw) return { x: x1 - d, y: y1, nx: 0, ny: 1 };
    d -= hw;
    return { x: x0, y: y1 - d, nx: -1, ny: 0 };
  };

  /**
   * +1 when a positive offset moves toward the removed side. A `cut` removes the
   * inside of the loop, a `scrap` everything outside it — so the same field, the
   * same plies and the same `bayDepth` logic serve both by flipping this one sign.
   */
  const away = spec.form === "scrap" ? -1 : 1;
  const dir = -away;

  const offsetAt = (which: EdgeSpec, u: number): number => {
    if (amp === 0) return 0;
    const m = ((u % P) + P) % P;
    const t = Math.min(m, P - m);
    return shape.offset(which, { t, base, away, outer: false });
  };

  const count = Math.round(clamp(P / step, 16, MAX_SAMPLES));
  const du = P / count;
  const inside = (p: Point): Point => ({
    x: clamp(p.x, ox + 0.5, ox + width - 0.5),
    y: clamp(p.y, oy + 0.5, oy + height - 0.5)
  });
  const runs: EdgeRuns = { t: [], offset: [] };
  for (let i = 0; i < count; i++) {
    runs.t.push(i * du);
    runs.offset.push(offsetAt(spec, i * du));
  }

  /**
   * Sample `i` of the tear, `extra` px further into the removed side.
   *
   * The tear's own offset is added HERE and nowhere else: a ply is a contour
   * `s` px in from the break, so it has to be `s` px in from the *break* — a ply
   * placed on the nominal rectangle would be a straight band beside a ragged
   * edge, which is not paper, it is a stripe.
   */
  const pointAt = (i: number, extra = 0): Point => {
    const q = walk(u0 + i * du);
    const o = runs.offset[i] + extra;
    return inside({ x: q.x + q.nx * dir * o, y: q.y + q.ny * dir * o });
  };

  const seam = runs.t.map((_, i) => pointAt(i));

  const env: EdgeEnv = { fibre, away, maxAmp: amp, offsetOf: offsetAt };
  const plyRuns = shape.plies ? shape.plies(spec, runs, env) : null;
  const hasFibre = plyRuns !== null && spec.fiber > 0;

  const stepRun = (widths: number[] | null, extra = 0): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i < count; i++) out.push(pointAt(i, (widths ? widths[i] : 0) + extra));
    return out;
  };
  const close = (ps: Point[]): Point[] => [...ps, ps[0]];

  const seamRun = close(seam);
  const contour = `${curveD(seamRun, shape.tension ?? 1 / 10)} Z`;

  // A `cut` is the sheet with the loop knocked out, so the clip carries both
  // subpaths and the renderer paints it `evenodd`; a `scrap` is the loop alone.
  const box = boxD(ox, oy, width, height);

  return {
    region: spec.form === "scrap" ? contour : `${box} ${contour}`,
    curve: contour,
    // Tucked 0.45px under the artwork, like the one-side kernel, so the ply and
    // the clipped sheet never leave a hairline of background between them.
    fringe: hasFibre ? bandD(close(stepRun(null, -0.45)), close(stepRun(plyRuns!.s1))) : "",
    ply: hasFibre ? bandD(close(stepRun(null, -0.45)), close(stepRun(plyRuns!.s2))) : "",
    veil: hasFibre ? bandD(close(stepRun(null, -0.45)), close(stepRun(plyRuns!.s3))) : "",
    points: seam,
    finish: shape.finish
  };
}
