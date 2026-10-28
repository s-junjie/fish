import type { EdgeFinish, TearInput, EdgeProfile } from "../../dsl/types";

/**
 * One sample of the break, in the terms every profile asks for.
 *
 * A profile is a scalar field over `t` — the distance along the edge — and it
 * reads its randomness from `base` rather than rolling any of its own, so two
 * profiles at the same seed agree about what a break looks like.
 */
export interface EdgeSample {
  /** Distance along the edge, in px. */
  t: number;
  /** The main lattice for this edge's seed. */
  base: (x: number) => number;
  /** +1 when the break cuts toward larger coordinates, -1 toward smaller. */
  away: number;
  /** True when the break sits ON the box edge rather than through the middle. */
  outer: boolean;
}

/** A resolved edge: every profile-specific field present. */
export interface EdgeSpec extends TearInput {
  profile: EdgeProfile;
  roughness: number;
  fiber: number;
}

/** The samples the kernel has taken, handed to a profile that needs the whole run. */
export interface EdgeRuns {
  t: number[];
  /** The resolved inward offset at each sample, after the kernel's correction. */
  offset: number[];
}

export interface EdgeEnv {
  /** An independent lattice from `base`, for detail that must not track it. */
  fibre: (x: number) => number;
  away: number;
  /** Peak possible excursion, so a ply can scale its own outreach to it. */
  maxAmp: number;
  /**
   * The fully corrected inward offset for an arbitrary spec and distance.
   *
   * A paper ply has to measure how concave its surroundings are, which means
   * asking for the break at points off its own sample — and asking with the
   * correction applied, or the "bays" it is trying to bridge move.
   */
  offsetOf(spec: EdgeSpec, t: number): number;
}

/** Terraced paper-ply thicknesses, innermost first, one per sample. */
export interface EdgePlyRuns {
  s1: number[];
  s2: number[];
  s3: number[];
}

/**
 * What one profile contributes to the kernel.
 *
 * `offset` is a profile's whole personality and the only required member.
 * `plies` is both opt-in and WHOLE-RUN rather than per-sample: Ply 2 and Ply 3
 * are gated on a box-car smoothing of Ply 1's complete run, so no single sample
 * can answer for them.
 */
export interface EdgeProfileShape {
  /** Inward excursion at `t`, before the kernel's own edge correction. */
  offset(spec: EdgeSpec, s: EdgeSample): number;
  /** Peak excursion, so the kernel can place the guide and reserve headroom. */
  amplitude(spec: EdgeSpec): number;
  plies?(spec: EdgeSpec, runs: EdgeRuns, env: EdgeEnv): EdgePlyRuns;
  /**
   * Catmull-Rom tension for this profile's own curve.
   *
   * A break whose personality IS its corners wants the default; a zigzag has to
   * be straight between crests, so it asks for 0 and gets polyline segments.
   */
  tension?: number;
  /** What the renderer paints along the seam. */
  finish: EdgeFinish;
}
