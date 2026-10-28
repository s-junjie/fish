import type { AutoLayout, DesignElement, ElementSizing, ElementType } from "../../types";
import type { NormalizationRepair } from "../shared";
import { asNumber } from "../shared";
import { normalizeFillStack } from "../paint";
import { normalizeStrokes } from "../stroke";

/**
 * What a per-type branch may read, and the one thing it may write.
 *
 * `base` already carries the element-wide fields (id, type, box, opacity,
 * effects, layout) resolved by the shared pass, and is mutated in place: a
 * branch owns only the payload keys its own type adds, and never rebuilds the
 * element.
 */
export interface ElementBranchContext {
  el: Record<string, unknown>;
  base: Record<string, unknown>;
  path: string;
  repairs: NormalizationRepair[];
  type: ElementType;
  /** As authored, before any branch rewrites it — a line re-derives its box from its delta. */
  box: { x: number; y: number; width: number; height: number };
  sizing: ElementSizing;
  ownLayout: AutoLayout | undefined;
  normalizeChild: (child: unknown, path: string, index: number) => DesignElement | null;
}

export type ElementBranch = (ctx: ElementBranchContext) => void;

/**
 * Figma's two corner controls, for the shapes that generate their outline from a
 * box. Both are written only when supplied, so a document that never set them
 * survives a round-trip byte-identical.
 *
 * `cornerRadius` is a px LENGTH and belongs beside `borderRadius`; on a rect the
 * two are the same field under two spellings, which `normalizeCornerRadius`
 * already folds together, so a rect passes `skipRadius`.
 */
export function normalizeCornerControls(
  el: Record<string, unknown>,
  base: Record<string, unknown>,
  skipRadius: boolean
): void {
  if (!skipRadius) {
    const radius = asNumber(el.cornerRadius);
    if (radius !== undefined) base.cornerRadius = Math.max(0, radius);
  }
  const smoothing = asNumber(el.cornerSmoothing);
  if (smoothing !== undefined) base.cornerSmoothing = Math.min(1, Math.max(0, smoothing));
}

/**
 * Paint for a closed shape: the fill stack, backfilled to transparent with a
 * repair when absent, plus both stroke spellings.
 *
 * One place because every closed shape owes the same thing and the repair names
 * the type that owed it — a star that silently came out unfilled would otherwise
 * be indistinguishable from a star painted white.
 */
export function paintClosedShape(
  el: Record<string, unknown>,
  base: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[],
  type: string
): void {
  const fills = normalizeFillStack(el, path, repairs);
  if (fills !== undefined) {
    base.fills = fills;
  } else {
    base.fills = [{ type: "solid", color: "transparent" }];
    repairs.push({
      kind: "paint",
      path: `${path}/fills`,
      severity: "info",
      message: `${type} without fills backfilled to transparent`
    });
  }
  const strokes = normalizeStrokes(el, path, repairs);
  if (strokes) base.strokes = strokes;
}
