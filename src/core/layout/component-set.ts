import { ComponentElement, ComponentSetElement } from "../dsl/types";

/**
 * The one container whose box is not a layout result: a component set fits itself.
 *
 * Auto-layout decides a frame's size from its children and padding it was given;
 * a set has neither, because its children are definitions placed freely (Figma
 * does not stack variants, and a stack here would make dragging one impossible).
 * So the set computes its own extent on every relayout, which is what stops it
 * from being the box the author happened to draw — dragging a variant down grows
 * the set, and the padding is what keeps the border off the artwork.
 */
export const COMPONENT_SET_PADDING = 24;

/**
 * The gap between two adjacent variants.
 *
 * Vertical, because Figma's default arrangement is a single column: "When you add
 * new variants to a component, Figma's default behavior is to add variants in a
 * single column, with equal spacing between them." A row reads well for two but
 * turns into an unreadable strip at six, and it contradicts `defaultVariant`,
 * which is defined as the top-LEFT-most variant — a definition that only makes
 * sense once the variants are stacked.
 *
 * A set may of course be arranged any other way by hand; Figma allows that too.
 * What this constant decides is where a NEW variant lands.
 */
export const COMPONENT_VARIANT_GAP = 24;

/** The variants a set actually paints: one when collapsed, all of them otherwise. */
export function visibleVariants(set: ComponentSetElement): ComponentElement[] {
  const variants = (set.children || []) as ComponentElement[];
  return set.collapsed ? variants.slice(0, 1) : variants;
}

/**
 * Where the next variant goes: directly below the last one, in the same column.
 *
 * The x is the first variant's rather than the last's, so a set whose members the
 * author has nudged out of line keeps a straight column for new arrivals instead
 * of inheriting one member's drift as the new baseline.
 */
export function nextVariantOrigin(set: ComponentSetElement): { x: number; y: number } {
  const variants = (set.children || []) as ComponentElement[];
  const first = variants[0];
  const last = variants[variants.length - 1];
  if (!first) return { x: COMPONENT_SET_PADDING, y: COMPONENT_SET_PADDING };
  return {
    x: first.x,
    y: last ? last.y + last.height + COMPONENT_VARIANT_GAP : first.y + first.height + COMPONENT_VARIANT_GAP
  };
}

/**
 * The set's own box, from the variants it paints.
 *
 * The origin is left alone and only the extent is rewritten. A set that grew and
 * shrunk around a moving child would slide under the cursor, which reads as the
 * canvas fighting the drag; the variants themselves are placed at and after
 * `COMPONENT_SET_PADDING`, so the origin is where the author drew it and a child
 * that is dragged left of it simply shows outside the border — the same thing a
 * non-clipping frame already allows everywhere else.
 *
 * `0` for an empty set: the alternatives (keep the stale box, or collapse onto the
 * padding) both leave a border around nothing, and a `0` box is also what makes
 * the node unclickable rather than a trap.
 *
 * Returns the input when nothing moved, which is the identity contract
 * `measureTreeBottomUp` relies on to keep an unchanged relayout a no-op.
 */
export function fitComponentSet(set: ComponentSetElement): ComponentSetElement {
  const shown = visibleVariants(set);
  const right = shown.reduce((max, c) => Math.max(max, c.x + c.width), 0);
  const bottom = shown.reduce((max, c) => Math.max(max, c.y + c.height), 0);
  const minWidth = shown.length > 0 ? COMPONENT_SET_PADDING + right : 0;
  const minHeight = shown.length > 0 ? COMPONENT_SET_PADDING + bottom : 0;
  const width = Math.max(set.width || 0, minWidth);
  const height = Math.max(set.height || 0, minHeight);
  if (width === set.width && height === set.height) return set;
  return { ...set, width, height };
}