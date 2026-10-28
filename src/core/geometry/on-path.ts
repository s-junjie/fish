import type { DesignElement, TextElement } from "../dsl/types";
import { getShapeLocalPath } from "./gradient-utils";
import { reversePathData } from "./path-data";
import { findElementById, flattenElements } from "./tree-ops";

/**
 * Text on Path, in one place.
 *
 * The feature has two halves that only mean anything together: which way the
 * guide is traversed, and which way the string runs along it. Chromium ignores
 * SVG2's `side` attribute, so "inside" is done by reversing the guide — glyphs
 * hang to the LEFT of travel, so a reversed path puts the run on the other side
 * of the shape — and the string is reversed with it so the reading order
 * survives. Reverse the path alone and the run reads backwards along the curve.
 *
 * Both halves come from here because the renderer draws one and the `<defs>`
 * author draws the other. Computed twice they would agree today and diverge the
 * first time a reversal is refused, which is exactly the case that renders
 * backwards with no way to see why.
 */

export interface OnPathGuide {
  /** Path data for the `<path>` the run is attached to, in the target's local space. */
  d: string;
  /** True when `d` was reversed, so the string must be too. */
  reversed: boolean;
}

const CLOSED_TYPES = new Set(["rect", "ellipse", "polygon", "star"]);

export function onPathGuide(elements: DesignElement[], el: TextElement): OnPathGuide | null {
  const onPath = el.onPath;
  if (!onPath?.pathId) return null;
  const target = findElementById(elements, onPath.pathId);
  if (!target) return null;

  const local = getShapeLocalPath(target);
  if (!local) return null;
  if (onPath.side !== "in") {
    // A closed shape is doubled so the run can wrap all the way round it; the
    // second copy is what the offset keeps walking into.
    const loop = CLOSED_TYPES.has(target.type) ? `${local} ${local}` : local;
    return { d: loop, reversed: false };
  }

  if (CLOSED_TYPES.has(target.type)) {
    // Reverse each copy and swap their order, rather than reversing the doubled
    // string as one path: the two copies are separate subpaths, so the reversal
    // refuses it and `side: "in"` would silently do nothing for exactly the
    // shapes it exists for.
    const flipped = reversePathData(local);
    if (!flipped) return { d: `${local} ${local}`, reversed: false };
    return { d: `${flipped} ${flipped}`, reversed: true };
  }

  const flipped = reversePathData(local);
  // A path the reversal refuses (two subpaths) renders on the outside rather
  // than on a side nobody asked for.
  return flipped ? { d: flipped, reversed: true } : { d: local, reversed: false };
}

/** The string as the run should draw it, given the guide it follows. */
export function onPathRunText(el: TextElement, guide: OnPathGuide | null): string {
  const content = el.content ?? "";
  if (!guide?.reversed) return content;
  // Code points, not UTF-16 units: an emoji outside the BMP is two units, and
  // splitting one in half renders as a replacement character.
  return Array.from(content).reverse().join("");
}

/**
 * Every text-on-path guide in a document, keyed by the text element's id.
 *
 * Built once per tree generation and handed to both the `<defs>` author and the
 * node renderer, so the path and the string can never come from different
 * answers.
 */
export function buildOnPathGuides(elements: DesignElement[]): Map<string, OnPathGuide> {
  const guides = new Map<string, OnPathGuide>();
  for (const el of flattenElements(elements)) {
    if (el.type !== "text") continue;
    const guide = onPathGuide(elements, el);
    if (guide) guides.set(el.id, guide);
  }
  return guides;
}
