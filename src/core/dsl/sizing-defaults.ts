import { AutoLayout, ElementSizing, ElementType } from "./types";

/**
 * What `sizing` means when it is not written.
 *
 * An ABSENT axis is `auto` in the CSS sense: the element has an opinion about
 * its content (a container is driven by its children, a text inside a layout
 * parent wraps to it), but on the SIZE of an axis it has said nothing, and what
 * nothing means is the container's to decide — a grid cell, an `align-self:
 * "stretch"` line. So a situation-derived default cannot be derived at read
 * time and has to be STORED, and this is the function that stores it.
 *
 * The other half of the rule is that `"fixed"` is stored too (`axisIsPinned`):
 * it is the one declaration that says "the number on me is the size", and a
 * default cannot serve both readings.
 *
 * For a long time the stored default was "fixed" on both axes, which made two of
 * the dialect's most expensive traps the *default* behaviour: an auto-layout frame
 * with children collapsed to 0 tall (its fill, radius and effects painting on
 * nothing), and a text node measured from its character count, so a paragraph in
 * a 360 card came out 569 wide and did not wrap.
 *
 * Both defaults are now read from the element's situation instead, because in each
 * case there is exactly one reading nobody has ever meant the other way: a
 * container that opted into auto-layout is driven by its children, and text inside
 * a layout parent is meant to wrap to it.
 *
 * The storage is what makes this a SHARED function rather than a private step of
 * normalize: a stored default is a statement about the element's *situation*, and
 * a drag can change the situation without re-reading the file. The drop path calls
 * this again (see `reconcileSizingAfterReparent`) so a text that lands in a stack
 * behaves the same as one authored there.
 *
 * An authored pixel size wins for a CONTAINER, so the default only fills in what
 * was left unsaid. A TEXT is different on purpose: inside a layout parent its wrap
 * width is the container's, and the number on the element came out of a
 * measurement, so an authored width and a measured one are indistinguishable by the
 * time this runs. The width default therefore applies unconditionally, and a text
 * that must keep its own width is expressed with `fill` or `max-content` instead.
 */
export interface SizingDefaultContext {
  type: ElementType;
  ownLayout: AutoLayout | undefined;
  /** The parent's layout, or null when there is no layout above this element. */
  parentLayout: AutoLayout | null;
  authoredWidth: unknown;
  authoredHeight: unknown;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Fills in the axes `sizing` left unsaid, in place. */
export function applySizingDefaults(sizing: ElementSizing, ctx: SizingDefaultContext): void {
  const mode = ctx.ownLayout?.mode;
  const isContainer = mode === "flex" || mode === "grid";
  const parentIsLayout = ctx.parentLayout?.mode === "flex" || ctx.parentLayout?.mode === "grid";

  if (isContainer) {
    if (!sizing.width && !isNumber(ctx.authoredWidth)) sizing.width = "fit-content";
    if (!sizing.height && !isNumber(ctx.authoredHeight)) sizing.height = "fit-content";
    return;
  }

  // Text inside a layout parent is measured on BOTH axes, and for the same
  // reason: the layout pass is what gives it a box, and it only measures an axis
  // that resolves to fit-content. Leaving the height undeclared kept whatever
  // number the text was created with, so a paragraph that wrapped to three lines
  // still had a one-line box — and the sibling under it in the stack was placed
  // on top of the wrapped glyphs. That is the overlap an author cannot see coming.
  if (ctx.type === "text" && parentIsLayout) {
    // Width: fit-content, not fill — it wraps to the container like fill does but
    // does not stretch a short label across the cell it happens to sit in.
    if (!sizing.width) sizing.width = "fit-content";
    // Unlike the width, an authored height is honoured here: a callout with a
    // pinned height is a real design, and the height axis has no analogue of "the
    // container owns my wrap width".
    if (!sizing.height && !isNumber(ctx.authoredHeight)) sizing.height = "fit-content";
  }
}
