/**
 * A Figma node's geometry regions, as one `d`.
 *
 * `fillGeometry` / `strokeGeometry` are ARRAYS: one entry per region the shape
 * is made of, and a real file uses that — the iPad lock screen's clock is two
 * `Ticks` vectors of 48 and 12 strokes plus a `Hands` vector of four. Reading
 * only `[0]` kept one tick and one hand and reported nothing, which is the shape
 * of loss that looks like a design decision.
 *
 * The regions are concatenated rather than unioned: the renderer emits `d`
 * verbatim, every region is already in the same node-local space, and a boolean
 * union here would be a second, worse copy of Figma's own geometry.
 *
 * ONE RULE PER ELEMENT, so regions that disagree cannot both be exact. `evenodd`
 * wins when any region asks for it, because a hole is only expressible that way
 * — choosing `nonzero` for a donut fills the hole in. Regions that do not
 * overlap (every case seen so far) render identically under either rule; the
 * caller is told when they disagreed so the approximation is named rather than
 * discovered.
 */

import type { FigmaVectorPath } from "./figma-types";

export interface FigmaGeometry {
  /** Every region's path, space-separated. `d` for a path element or a text outline. */
  d: string;
  fillRule?: "evenodd";
  /** The regions carried different winding rules, so one of them was picked for all. */
  mixedWinding: boolean;
}

export function figmaGeometry(paths: FigmaVectorPath[] | undefined): FigmaGeometry | undefined {
  const regions = (paths ?? []).filter((p) => p && typeof p.path === "string" && p.path);
  if (regions.length === 0) return undefined;
  const evenodd = regions.filter((p) => p.windingRule === "EVENODD").length;
  return {
    d: regions.map((p) => p.path).join(" "),
    ...(evenodd > 0 ? { fillRule: "evenodd" as const } : {}),
    mixedWinding: evenodd > 0 && evenodd < regions.length
  };
}
