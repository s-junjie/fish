/**
 * What a box does with children that do not fit — the whole vocabulary is
 * CSS's, three values instead of five:
 *
 * - `hidden` covers `clip` too: we expose no scripted scrolling, so a box that
 *   clips and cannot be scrolled is the only thing either value can mean here.
 * - `auto` covers `scroll`: a real browser paints a scrollbar for `scroll` even
 *   when nothing overflows, and we never paint one. Writing `scroll` into a file
 *   a browser can read would be a promise this engine cannot keep.
 *
 * The axis a box actually scrolls is never stored — it is measured from the
 * children's extent (`computeContainerScrollBounds`). Storing it would let a
 * file claim an axis with nothing to scroll on.
 */
export type Overflow = "visible" | "hidden" | "auto";

/** The subset of an element the overflow helpers need. */
export interface OverflowFields {
  overflow?: Overflow;
  overflowX?: Overflow;
  overflowY?: Overflow;
}

export interface OverflowAxes {
  x: Overflow;
  y: Overflow;
}

/** Each axis: its longhand if the author wrote one, else the shorthand, else CSS's initial value. */
export function overflowAxes(el: OverflowFields | null | undefined): OverflowAxes {
  const shorthand = el?.overflow ?? "visible";
  return { x: el?.overflowX ?? shorthand, y: el?.overflowY ?? shorthand };
}

/**
 * The axes a box actually paints with, letting an instance inherit the master it
 * projects. Per axis the precedence is: the element's own longhand, its own
 * shorthand, then the host's axis — so locking only x on an instance still
 * inherits the master's y rather than silently resetting it to `visible`.
 */
export function resolveOverflow(
  el: OverflowFields | null | undefined,
  host?: OverflowFields | null
): OverflowAxes {
  const inherited = overflowAxes(host);
  return {
    x: el?.overflowX ?? el?.overflow ?? inherited.x,
    y: el?.overflowY ?? el?.overflow ?? inherited.y
  };
}

/**
 * Whether children are cut at the box edge. Any axis that is not `visible`
 * clips the WHOLE box, not just that axis: CSS never shows one axis clipped
 * while the other overflows (`hidden` on one axis promotes a `visible` other to
 * `auto`), so the asymmetric paint this would need is not a state any author
 * can reach. The reader repairs such a pair to `hidden` for the same reason.
 */
export function clipsContent(el: OverflowFields | null | undefined): boolean {
  return clipsAxes(overflowAxes(el));
}

export function clipsAxes(axes: OverflowAxes): boolean {
  return axes.x !== "visible" || axes.y !== "visible";
}

/** Whether the axis is allowed to scroll at all — the extent still has to be measured. */
export function scrollsAxis(el: OverflowFields | null | undefined, axis: "x" | "y"): boolean {
  return overflowAxes(el)[axis] === "auto";
}

/**
 * Canonical storage for a resolved pair: one shorthand when both axes agree, two
 * longhands when they must differ. `visible` is never stored — it is the value
 * the absence of the field already means.
 */
export function overflowFields(axes: OverflowAxes): OverflowFields {
  if (axes.x === axes.y) return axes.x === "visible" ? {} : { overflow: axes.x };
  return { overflowX: axes.x, overflowY: axes.y };
}

/** Whether the element declares scrolling on either axis. */
export function declaresScroll(el: OverflowFields | null | undefined): boolean {
  const { x, y } = overflowAxes(el);
  return x === "auto" || y === "auto";
}
