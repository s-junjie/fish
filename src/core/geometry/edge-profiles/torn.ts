import type { EdgeEnv, EdgePlyRuns, EdgeProfileShape, EdgeRuns, EdgeSample, EdgeSpec } from "./types";
import { clamp, ridge } from "./noise";

/**
 * The torn break: a value-noise break with exposed paper fibres.
 *
 * One octave of noise is never enough — a tear is fractal-ish, and a single
 * wavelength reads as a wavy cut. Three do: the slow drift, the ragged middle
 * and the fibre, with `roughness` mixing the two finer ones against the coarse
 * one.
 */
interface TornShape {
  /** How hard the coarse wave is pressed against its clamp: high makes flat
   *  plateaus and hard corners, low leaves soft billows. */
  bigGain: number;
  bigAmp: number;
  /** Share of the coarse wave taken from the sharp-crested ridge rather than
   *  the rounded value noise. This is what makes or unmakes fracture corners. */
  bigRidge: number;
  midAmp: number;
  midRidge: number;
  fineAmp: number;
  fineRidge: number;
  /** Multiplies the terraced paper plies as a whole. */
  plyScale: number;
}

/** A sheared sheet: hard crests, deep middle texture, stray fibres. */
const TORN: TornShape = {
  bigGain: 1.7,
  bigAmp: 0.085,
  bigRidge: 0.3,
  midAmp: 0.045,
  midRidge: 0.46,
  fineAmp: 0.013,
  fineRidge: 0.44,
  plyScale: 1
};

function field(shape: TornShape, spec: EdgeSpec, s: EdgeSample): number {
  const sc = clamp(spec.scale, 16, 900);
  const r = clamp(spec.roughness, 0, 1);
  const cell = s.base;

  const u1 = s.t / sc;
  const warp = (cell(u1 * 0.85 + 19.4) - 0.5) * 0.38;
  const bigRaw =
    (cell(u1 + warp) - 0.5) * (1 - shape.bigRidge) + ridge(cell(u1 * 1.3 + 41.2)) * shape.bigRidge;

  // On a box edge the whole field is biased inward, so a crested sample cannot
  // shove the break outside the box the element declares.
  const inwardShift = s.outer ? -0.18 * s.away : 0;
  const big = clamp(bigRaw * shape.bigGain + inwardShift, -1, 1) * (sc * shape.bigAmp);

  const u2 = s.t / (sc / 3.8) + 31.7 + warp * 0.55;
  const midRaw = (cell(u2) - 0.5) * (1 - shape.midRidge) + ridge(cell(u2 * 1.15 + 13.8)) * shape.midRidge;
  const mid = clamp(midRaw * 2, -1, 1) * (sc * shape.midAmp * (0.25 + 0.75 * r));

  const u3 = s.t / 14.0 + 5.3;
  const fineRaw = (cell(u3) - 0.5) * (1 - shape.fineRidge) + ridge(cell(s.t / 9.0 + 67.1)) * shape.fineRidge;
  const fine = clamp(fineRaw * 2, -1, 1) * (sc * shape.fineAmp * (0.3 + 0.7 * r));

  return big + mid + fine;
}

/** Peak excursion: coarse, middle and fine waves all at full. `0` is the straight
 *  cut, and the only value below the 16px floor that reaches the kernel. */
function peak(shape: TornShape, spec: EdgeSpec): number {
  const sc = clamp(spec.scale, 0, 900);
  const r = clamp(spec.roughness, 0, 1);
  return sc * shape.bigAmp + sc * shape.midAmp * (0.25 + 0.75 * r) + sc * shape.fineAmp * (0.3 + 0.7 * r);
}

/**
 * Terraced vector strip wave in [0, 1]: alternates high and low paper-strip
 * plateaus modulated by `cell`, holding a gently tilted oblique vector facet
 * across `plateau` of each cell and stepping decisively across the rest.
 */
function terraceAt(cell: (x: number) => number, u: number, plateau = 0.64): number {
  const i = Math.floor(u);
  const f = u - i;
  const level = (k: number) =>
    ((k & 1) !== 0 ? 0.56 + 0.44 * cell(k * 1.63 + 0.17) : 0.04 * cell(k * 1.91 + 0.53));
  const a = level(i);
  const b = level(i + 1);
  if (f < plateau) return a + (b - a) * 0.18 * (f / plateau);
  const s = (f - plateau) / (1 - plateau);
  const step = s * s * (3 - 2 * s);
  return a + (b - a) * (0.18 + 0.82 * step);
}

/** Box-car smooth across `±radius` samples, so an outer ply steps out from a
 *  clean bridged carrier instead of copying every notch of the ply inside it. */
function smoothRun(arr: number[], radius: number): number[] {
  const n = arr.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let wSum = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = clamp(i + d, 0, n - 1);
      const w = radius + 1 - Math.abs(d);
      sum += arr[j] * w;
      wSum += w;
    }
    out[i] = sum / wSum;
  }
  return out;
}

/**
 * The three terraced ply runs.
 *
 * Each ply reads `terraceAt` at its own staggered phase and strip scale, so
 * their oblique facet transitions interleave along the edge instead of lining up
 * as parallel stripes. A concave bay — where the top sheet broke inward —
 * naturally exposes wider backing strata, which is what `bayBoost` widens.
 */
function plies(
  shape: TornShape,
  spec: EdgeSpec,
  runs: EdgeRuns,
  env: EdgeEnv
): EdgePlyRuns {
  const f = clamp(spec.fiber, 0, 1);
  const n = runs.t.length;
  const empty = new Array<number>(n).fill(0);
  if (f <= 0) return { s1: empty, s2: empty, s3: empty };

  const cell = env.fibre;
  const sc = clamp(spec.scale, 16, 900);
  const stripScale = clamp(sc * 0.26, 24, 52);
  const scaleFactor = (0.35 + 0.65 * f) * shape.plyScale;
  const broadSpec: EdgeSpec = { ...spec, roughness: spec.roughness * 0.25 };

  const raw1: number[] = [];
  const raw2: number[] = [];
  const raw3: number[] = [];

  for (let i = 0; i < n; i++) {
    const t = runs.t[i];
    const tearOffset = runs.offset[i];

    const broadO = env.offsetOf(broadSpec, t + 20) * 0.5 + env.offsetOf(broadSpec, Math.max(0, t - 20)) * 0.5;
    const bayDepth = Math.max(0, (broadO - tearOffset) * env.away + env.maxAmp * 0.08);
    const bayBoost = clamp(bayDepth / Math.max(1, env.maxAmp * 0.75), 0, 0.9);

    // Ply 1, innermost and brightest: wide oblique strips with brief clean pinches.
    const warp1 = (cell(t / (stripScale * 1.4) + 3.1) - 0.5) * 0.28;
    const u1 = t / stripScale + 0.12 + warp1;
    const r1 = terraceAt(cell, u1, 0.62) + (0.5 + ridge(cell(t / 15.0 + 41.2))) * 0.24 + bayBoost * 0.26;
    raw1.push(Math.pow(clamp((r1 - 0.12) / 0.78, 0, 1.25), 0.85) * (5.4 + bayDepth * 0.28) * scaleFactor);

    // Ply 2, staggered ~0.45 cycle so its steps interleave with Ply 1's contour.
    const warp2 = (cell(t / (stripScale * 1.55) + 19.8) - 0.5) * 0.28;
    const u2 = t / (stripScale * 1.14) + 0.58 + warp2;
    const r2 = terraceAt(cell, u2, 0.64) + (0.5 + ridge(cell(t / 18.5 + 83.5))) * 0.18 + bayBoost * 0.2;
    raw2.push(Math.pow(clamp((r2 - 0.2) / 0.72, 0, 1.25), 0.86) * (4.2 + bayDepth * 0.2) * f * shape.plyScale);

    // Ply 3, outermost and stone-tinted, staggered once more.
    const warp3 = (cell(t / (stripScale * 1.75) + 53.4) - 0.5) * 0.28;
    const u3 = t / (stripScale * 1.3) + 1.12 + warp3;
    const r3 = terraceAt(cell, u3, 0.66) + (0.5 + ridge(cell(t / 22.0 + 129.1))) * 0.16 + bayBoost * 0.18;
    raw3.push(Math.pow(clamp((r3 - 0.26) / 0.68, 0, 1.25), 0.88) * (3.6 + bayDepth * 0.18) * f * shape.plyScale);
  }

  // Envelope gating: Ply 2 and Ply 3 only step out where Ply 1 is present, so
  // the brightest ply always sits against the broken artwork and all three pinch
  // together cleanly instead of floating free of an absent inner neighbour.
  const w1Base = smoothRun(raw1, 4);
  const s2 = raw1.map((w1, i) => {
    const env1 = clamp((Math.min(w1, w1Base[i]) - 0.35) / 2.2, 0, 1);
    const step2 = raw2[i] * env1;
    return step2 <= 0.05 ? w1 : Math.max(w1, w1Base[i] * 0.88 + step2);
  });
  const w2Base = smoothRun(s2, 4);
  const s3 = s2.map((w2, i) => {
    const env2 = clamp((w2 - raw1[i] - 0.25) / 1.8, 0, 1);
    const step3 = raw3[i] * (0.35 + 0.65 * env2) * clamp((raw1[i] - 0.5) / 2.0, 0, 1);
    return step3 <= 0.05 ? w2 : Math.max(w2, w2Base[i] * 0.9 + step3);
  });
  return { s1: raw1, s2, s3 };
}

export const tornProfile: EdgeProfileShape = {
  offset: (spec, s) => field(TORN, spec, s),
  amplitude: (spec) => peak(TORN, spec),
  plies: (spec, runs, env) => plies(TORN, spec, runs, env),
  finish: "paper"
};
