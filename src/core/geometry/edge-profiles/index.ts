import type { TearInput, EdgeProfile } from "../../dsl/types";
import type { EdgeProfileShape, EdgeSpec } from "./types";
import { clamp } from "./noise";
import { tornProfile } from "./torn";
import { scallopProfile, zigzagProfile } from "./periodic";

/**
 * The profiles a document may name.
 *
 * This table is the whole extension surface: a new kind of edge means one entry
 * here, not another effect type. `EDGE_PROFILES` in `schema-enums.ts` is its
 * runtime copy and carries the menu order.
 */
export const EDGE_PROFILE_SHAPES: Record<EdgeProfile, EdgeProfileShape> = {
  torn: tornProfile,
  scallop: scallopProfile,
  zigzag: zigzagProfile
};

/** The smallest wave that still resolves: below it the kernel's 3px sample step
 *  leaves fewer than five points per wavelength. */
export const EDGE_SCALE_FLOOR = 16;
export const EDGE_SCALE_CEILING = 900;

/**
 * `scale` as the kernel reads it.
 *
 * `0` is the straight cut — the wave has no amplitude left, so the break IS the
 * guide — and is the only value that may sit under the floor. Everything else
 * snaps into [16, 900] exactly as it always did, so no break authored before the
 * straight cut existed draws any differently.
 */
export function edgeScaleOf(scale: number): number {
  return scale <= 0 ? 0 : Math.min(EDGE_SCALE_CEILING, Math.max(EDGE_SCALE_FLOOR, scale));
}

/**
 * How far apart the kernel samples a break, in px.
 *
 * Derived from `scale` so a break keeps its character at any box size — roughly
 * 38 samples per wavelength — but never finer than 3px: below that the extra
 * points buy no detail and only add path data. `3.0-4.5` is where the vector
 * facets stay clean and graphic instead of breaking into sub-pixel sawtooth.
 */
export const EDGE_SAMPLE_MIN = 3.0;
export const EDGE_SAMPLE_MAX = 4.5;

export function edgeStepOf(scale: number): number {
  return clamp(scale / 38, EDGE_SAMPLE_MIN, EDGE_SAMPLE_MAX);
}

/** The fields a profile owns, at the values it starts from. */
export function profileDefaults(profile: EdgeProfile): Pick<EdgeSpec, "roughness" | "fiber"> {
  switch (profile) {
    case "scallop":
    case "zigzag":
      return { roughness: 0, fiber: 0 };
    default:
      // A clean break; the fibres arrive when the slider asks for them.
      return { roughness: 0.6, fiber: 0 };
  }
}

export function edgeProfileShape(profile: EdgeProfile): EdgeProfileShape {
  return EDGE_PROFILE_SHAPES[profile] ?? EDGE_PROFILE_SHAPES.torn;
}

/**
 * Fill in everything a partly specified edge left out.
 *
 * A break written before `profile` existed — or written by hand without one —
 * is a torn edge, because that is what the type used to mean.
 */
export function resolveEdge(input: TearInput): EdgeSpec {
  const profile = input.profile ?? "torn";
  const defaults = profileDefaults(profile);
  return {
    ...input,
    profile,
    scale: edgeScaleOf(input.scale),
    roughness: input.roughness ?? defaults.roughness,
    fiber: input.fiber ?? defaults.fiber
  };
}
