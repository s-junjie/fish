import type { EdgeProfileShape, EdgeSample, EdgeSpec } from "./types";
import { clamp } from "./noise";

/**
 * The periodic profiles: a scallop and a zigzag.
 *
 * These carry no noise and no random seed — everything they are comes from
 * `scale`, which here IS the pitch. That is the evidence they belong in this
 * kernel rather than in an effect type of their own: the parameter structure did
 * not have to grow to admit them.
 */

/** How deep one period bites. A fraction of the wavelength, so a coarse pitch
 *  makes proportionally coarse scallops instead of a fixed size at every scale. */
const DEPTH = 0.22;

function amp(spec: EdgeSpec): number {
  return clamp(spec.scale, 0, 900) * DEPTH;
}

function phase(spec: EdgeSpec, t: number): number {
  const pitch = Math.max(4, clamp(spec.scale, 0, 900));
  return (t / pitch) % 1;
}

export const scallopProfile: EdgeProfileShape = {
  offset: (spec: EdgeSpec, s: EdgeSample) => Math.sin(phase(spec, s.t) * Math.PI * 2) * amp(spec),
  amplitude: amp,
  finish: "none"
};

export const zigzagProfile: EdgeProfileShape = {
  offset: (spec: EdgeSpec, s: EdgeSample) => (4 * Math.abs(phase(spec, s.t) - 0.5) - 1) * amp(spec),
  amplitude: amp,
  // Straight between crests: with Catmull-Rom tension 0 the control points land
  // on the endpoints and every cubic collapses to its own line.
  tension: 0,
  finish: "none"
};
