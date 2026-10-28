import { AutoLayout, DesignElement, FrameElement } from "../dsl/types";
import { SizingAxis, resolveAxis } from "../geometry/resolve-axis";
import { envelopeOf, isLineElement, turnMixOf, type Envelope } from "../geometry/element-bounds";

/** Below this a child's own size no longer moves the extent it covers at all, so
 * a share cannot be turned into a size and it keeps the one it was measured at. */
const FLAT_TURN = 1e-6;

/**
 * The document's precision, applied to every size the layout engine measures.
 *
 * Every writer in the codebase rounds geometry to two decimals, so a measurement kept
 * at full float precision and then rounded by someone else is the only way a value ends
 * up different depending on which code path touched it. Whole pixels were the trap
 * here: the Scale tool BAKES its factor into geometry, so scaling a design to a tenth
 * produced boxes of 27.6px, and a `fit-content` frame measured back at 28px by this
 * rounding. Growing it to full size then read 280 off that 28 — a permanent 1.4%
 * stretch on every nested frame, and the frame ended up wider than the parent holding
 * it. A scale a user can undo by scaling back has to survive the round trip through
 * here, so nothing measured may be rounded below the document's own precision.
 */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * `Math.max(floor, ...values)` without the spread. The spread form is bounded by
 * the engine's argument limit — past roughly 125k arguments it throws a
 * `RangeError` from inside the layout pass, on a document that merely happens to
 * be large. NaN still propagates, exactly as `Math.max` does, so a non-finite
 * measurement is not quietly swallowed.
 */
export function maxFrom(values: ArrayLike<number>, floor = -Infinity): number {
  let out = floor;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) return NaN;
    if (v > out) out = v;
  }
  return out;
}

export function resolvePadding(padding: AutoLayout["padding"]): [number, number, number, number] {
  if (typeof padding === "number") return [padding, padding, padding, padding];
  if (Array.isArray(padding) && padding.length === 4) return padding as [number, number, number, number];
  return [0, 0, 0, 0];
}

export interface ResolvedMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * A child's margin inside a layout parent, in [top, right, bottom, left].
 *
 * Signed, and deliberately not clamped: a negative margin is how CSS pulls a
 * child back over its neighbour, and `margin-left: -3px` on a dock caret is an
 * ordinary thing to write. Padding cannot be negative — a box smaller than its
 * own content is not a thing — which is why the two share a shape but not a
 * floor.
 */
export function resolveMargin(margin: unknown): ResolvedMargin {
  if (typeof margin === "number" && Number.isFinite(margin)) {
    return { top: margin, right: margin, bottom: margin, left: margin };
  }
  if (Array.isArray(margin) && margin.length === 4) {
    const [top, right, bottom, left] = margin as number[];
    return { top: top ?? 0, right: right ?? 0, bottom: bottom ?? 0, left: left ?? 0 };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/**
 * Parent-independent: only `fill` reads an ancestor, and `fill` is never a hug.
 *
 * `max-content` counts. It reads as a text-only mode — on the height axis
 * `resolveAxis` downgrades it to `fit-content` anyway — so a container that
 * declared it kept whatever width it was authored with, which is usually 0, and
 * its children then overlapped. The schema, the normalizer and the size menu
 * all offer the mode on any element, so the layout has to honour it: for a
 * non-wrapping container max-content and fit-content are the same box, and for
 * a wrapping one fit-content is the only meaningful reading.
 */
export function hugsAxis(el: DesignElement, axis: SizingAxis): boolean {
  const mode = resolveAxis(el, null, axis);
  return mode === "fit-content" || mode === "max-content";
}

export function isFillAxis(child: DesignElement, parent: FrameElement, axis: SizingAxis): boolean {
  return resolveAxis(child, parent, axis) === "fill";
}

/**
 * A size the layout decided, held inside the element's declared bounds.
 *
 * What goes through here is every size a layout pass WRITES: a `fill` child in a
 * frame being dragged wider, a grid child stretched to a cell, a container that
 * hugs. That is the only place a bound has anything to say, and it is exactly
 * the place an import needs it — a `max-width: 290px` block has to stop at 290
 * when the frame around it grows.
 *
 * An element no pass ever runs on keeps the size it was authored with, which is
 * the same case where `fill` is meaningless and is downgraded for the same
 * reason: with nothing deriving a size there is nothing for a bound to bound.
 *
 * The order is CSS 2.1 §10.4's: `max-width` is applied first and `min-width`
 * second, so a pair that contradicts itself — 300 and 40 — settles on 300 in a
 * browser and must settle on 300 here. Applying the floor first would make the
 * ceiling win, which is a difference nobody would ever design on purpose and
 * everybody would see as a bug.
 */
export function clampAxis(el: DesignElement, axis: SizingAxis, value: number): number {
  const sizing = el.sizing;
  if (!sizing) return value;
  const min = axis === "width" ? sizing.minWidth : sizing.minHeight;
  const max = axis === "width" ? sizing.maxWidth : sizing.maxHeight;
  let out = value;
  if (typeof max === "number" && Number.isFinite(max)) out = Math.min(max, out);
  if (typeof min === "number" && Number.isFinite(min)) out = Math.max(min, out);
  return out;
}

/**
 * How big a child REALLY is, when its own stored box is not the answer.
 *
 * The pass reads `child.width` off the document, which is right for everything
 * except an instance whose master hugs: the instance is stored at whatever width
 * it was authored with and is resolved to its content at RENDER time, so a parent
 * laid a tag out against 60px while the tag painted at 92px and the next sibling
 * landed on top of it. The caller owns the document, so the resolver comes from
 * the caller rather than from here — `core/layout` must not depend on
 * `core/interactions`, which already depends on this module.
 */
export type ChildSizeResolver = (el: DesignElement) => { width: number; height: number } | null;

/** The resolver's answer when it has one, else the element's own box. */
export function childBox(
  el: DesignElement,
  resolveChild?: ChildSizeResolver
): { width: number; height: number } {
  return resolveChild?.(el) ?? { width: el.width, height: el.height };
}

/**
 * The envelope a child covers once turned — what a gap, a track, a sibling and a
 * hugging parent all have to clear, and not the size the document stores for it.
 *
 * The bound goes on BEFORE the turn: `clampAxis` bounds the size the child is
 * GIVEN, not the envelope that size covers.
 */
export function childEnvelope(el: DesignElement, resolveChild?: ChildSizeResolver): Envelope {
  const box = childBox(el, resolveChild);
  return envelopeOf(el, clampAxis(el, "width", box.width), clampAxis(el, "height", box.height));
}

/**
 * The size a child has to be GIVEN on one axis for its envelope to measure
 * `target` there. The inverse of the extent `childEnvelope` reports: a `fill`
 * share is a share of the envelope, not of the box.
 *
 * `fallback` — the size the child was measured at — is the answer whenever there
 * is nothing to solve. At a quarter turn the child's own size cannot change what
 * it covers on that axis. A LINE never has an inverse: a share of the envelope is
 * one equation in the segment's length with two roots (and none at a quarter
 * turn), so there is no size to pick and the segment keeps the one it has.
 */
export function sizeForEnvelope(
  el: DesignElement,
  target: number,
  other: number,
  fallback: number
): number {
  if (isLineElement(el)) return fallback;
  const [c, s] = turnMixOf(el);
  return c > FLAT_TURN ? (target - other * s) / c : fallback;
}
