import { ContainerElement, DesignElement, ElementSizing, InstanceElement, SizeMode } from "../dsl/types";
import { DEFAULT_FLEX_ALIGN, DEFAULT_FLEX_DIRECTION, alignSelfOf, layoutOf, type FlatAutoLayout } from "../dsl/layout-flat";
import { isContainer } from "./tree-ops";

export type SizingAxis = "width" | "height";

export type AxisDowngrade =
  /** `fill` on a top-level element: there is no parent to distribute. */
  | "no-parent"
  /** `fill` inside a container that has no auto layout at all. */
  | "parent-not-layout"
  /** Parent hugs this axis, so there is no leftover space to distribute. */
  | "parent-fits-content"
  /** `max-content` on the height axis: wrapping has no meaning vertically. */
  | "height-has-no-max-content"
  /** The element type has no content to size from (shapes, images). */
  | "cannot-fit-content"
  /** A container with no auto layout: nothing runs a pass that could size it. */
  | "no-layout"
  /** A grid deriving its columns from its width cannot derive that width from them. */
  | "grid-auto-columns"
  /** A flex container with wrap cannot hug its main axis. */
  | "wrap-main-axis";

export interface AxisResolution {
  mode: SizeMode;
  downgrade?: AxisDowngrade;
}

/**
 * The element types whose size can come from something other than a stored number.
 *
 * An instance qualifies because its content IS the master's: a tag's width is its
 * label's width, and the layout pass gets that number from `ChildSizeResolver`
 * rather than from measuring a subtree the instance does not own. The instance's
 * own `sizing` is the master's, copied in by `createInstanceFromComponent` and
 * re-pointed by `propagateMasterSize`, so the declaration on the instance is the
 * same declaration the master is rendering under.
 */
export function canFitContent(el: DesignElement): boolean {
  return (
    el.type === "frame" ||
    el.type === "component" ||
    el.type === "text" ||
    el.type === "instance"
  );
}

/**
 * Whether Cmd/Ctrl turns a handle drag into a resize of this element's own box.
 *
 * A frame needs the modifier because the unmodified drag is free to hand the
 * resize on to its children. An instance needs it for a narrower reason: it is
 * not a container, so there is no such distinction to draw, but while it hugs
 * its master it has no box of its own to pull a size onto — the modifier is the
 * only gesture that can pin one. Both cases make the same promise, that the drag
 * pins the axis rather than feeding the engine.
 *
 * The selection overlay and the drag handler must agree on this: a modifier rule
 * the overlay draws no handle for is a dead end, and one it draws a handle for
 * but the handler refuses is a handle that lies.
 */
export function modifierResizesOwnBox(el: DesignElement): boolean {
  return isContainer(el) || el.type === "instance";
}

function isAutoColumnsGrid(el: DesignElement): boolean {
  if (!isContainer(el)) return false;
  const layout = layoutOf(el as FlatAutoLayout);
  return layout?.mode === "grid" && (layout.columnsMode ?? "fixed") === "auto";
}

/**
 * The single source of truth for "how does this axis of this element get its
 * length". The Inspector and the layout engine both call it, so a control can
 * never disagree with the geometry it renders.
 */
export function resolveAxis(
  el: DesignElement,
  parent: ContainerElement | null,
  axis: SizingAxis
): SizeMode {
  return resolveAxisDetail(el, parent, axis).mode;
}

export function resolveAxisDetail(
  el: DesignElement,
  parent: ContainerElement | null,
  axis: SizingAxis
): AxisResolution {
  const declared = (axis === "width" ? el.sizing?.width : el.sizing?.height) ?? "fixed";
  if (declared === "fixed") return { mode: "fixed" };

  if (declared === "fit-content" || declared === "max-content") {
    if (!canFitContent(el)) return { mode: "fixed", downgrade: "cannot-fit-content" };
    // A container's size comes out of a layout pass. With no `layout` there is no
    // pass, so the declaration has nothing to act on — and saying so is what keeps
    // the size menu from offering a mode that silently does nothing. An instance is
    // not a container and is measured by its master, so this does not apply to it.
    if (isContainer(el) && !layoutOf(el as FlatAutoLayout)) return { mode: "fixed", downgrade: "no-layout" };
    // A grid whose column count is derived from its width cannot also derive that
    // width from the columns; `applyGridLayout` keeps the authored width instead.
    if (axis === "width" && isAutoColumnsGrid(el)) {
      return { mode: "fixed", downgrade: "grid-auto-columns" };
    }
    // A flex container with wrap cannot hug its main axis (width for row, height for column).
    // The main axis must define the wrap boundary.
    const elLayout = layoutOf(el as FlatAutoLayout);
    if (
      isContainer(el) &&
      elLayout?.mode === "flex" &&
      elLayout.wrap === "wrap" &&
      ((elLayout.direction !== "column" && axis === "width") ||
       (elLayout.direction === "column" && axis === "height"))
    ) {
      return { mode: "fixed", downgrade: "wrap-main-axis" };
    }
    if (declared === "max-content") {
      if (axis === "height") return { mode: "fit-content", downgrade: "height-has-no-max-content" };
      return { mode: "max-content" };
    }
    return { mode: "fit-content" };
  }

  // `fill` is the only mode that reads an ancestor, so it is the only one that
  // can be impossible where the element currently sits. In a grid it means
  // "fill my own cell", which is distribution too — a grid cell is derived from
  // the container box exactly like a flex line's leftover space is.
  if (!parent) return { mode: "fixed", downgrade: "no-parent" };
  if (!layoutOf(parent as FlatAutoLayout)) return { mode: "fixed", downgrade: "parent-not-layout" };
  const parentMode = axis === "width" ? parent.sizing?.width : parent.sizing?.height;
  if (parentMode === "fit-content" || parentMode === "max-content") {
    return { mode: "fit-content", downgrade: "parent-fits-content" };
  }
  return { mode: "fill" };
}

export const AXIS_DOWNGRADE_MESSAGES: Record<AxisDowngrade, string> = {
  "no-parent": "is not inside a parent; treated as Fixed",
  "parent-not-layout": "needs a parent with Auto-Layout (Stack or Grid); treated as Fixed",
  "parent-fits-content": "parent hugs this axis, so there is no space to fill; treated as Fit Content",
  "height-has-no-max-content": "Max Content has no meaning on the height axis; treated as Fit Content",
  "cannot-fit-content": "this element type has no content to size from; treated as Fixed",
  "no-layout": "needs Auto-Layout (Stack or Grid) on this frame to size from; treated as Fixed",
  "grid-auto-columns": "this grid derives its columns from its width, so it cannot also hug that width; treated as Fixed",
  "wrap-main-axis": "a wrapping stack needs a fixed or fill boundary to wrap against; treated as Fixed"
};

/**
 * Whether this axis was written down as `"fixed"` — the one declaration that says
 * "the number on the element is the size".
 *
 * It has to be STORED, because the alternative is unreadable: an absent axis is
 * `auto` in the CSS sense, and `auto` is the container's to decide (a grid cell,
 * an `align-self: stretch` line). Spelling `fixed` by the absence left the
 * container unable to tell "unsaid" from "said 50px", so it stretched both, and
 * the pass then wrote the cell back over the number — `fixed` was a mode the
 * grid could not honour and a resize could not pin.
 */
export function axisIsPinned(el: DesignElement, axis: SizingAxis): boolean {
  return (axis === "width" ? el.sizing?.width : el.sizing?.height) === "fixed";
}

/**
 * Whether the parent, rather than the element, currently decides this axis's
 * size. Only a layout container's alignment does, so this is the one question a
 * resize has to ask before writing a number it would otherwise lose: the pin
 * (`"fixed"`) is the only thing the next pass cannot take back.
 */
export function containerSizesAxis(
  el: DesignElement,
  parent: ContainerElement | null,
  axis: SizingAxis
): boolean {
  const layout = parent ? layoutOf(parent as FlatAutoLayout) : undefined;
  if (!layout || axisIsPinned(el, axis)) return false;
  if (layout.mode === "grid") {
    const align = alignSelfOf(el) ?? layout.cellAlign ?? "stretch";
    return align === "stretch";
  }
  // A stack's MAIN axis is never distributed by alignment — a child that did not
  // ask for `fill` keeps its own size there. Only the cross axis is
  // `align-items`, which CSS defaults to `stretch`.
  const mainAxis: SizingAxis = (layout.direction ?? DEFAULT_FLEX_DIRECTION) === "row" ? "width" : "height";
  if (axis === mainAxis) return false;
  const align = alignSelfOf(el) ?? layout.align ?? DEFAULT_FLEX_ALIGN;
  return align === "stretch";
}

/** Writes one axis of the declaration, `fixed` included — see `axisIsPinned`. */
export function withAxisMode(el: DesignElement, axis: SizingAxis, mode: SizeMode): DesignElement {
  const next: ElementSizing = { ...(el.sizing ?? {}) };
  if (axis === "width") {
    next.width = mode;
  } else if (mode !== "max-content") {
    next.height = mode;
  }
  const empty = next.width === undefined && next.height === undefined;
  const sizing = empty ? undefined : next;

  if (mode === "fixed" && el.type === "instance") {
    return { ...el, sizing, sizeOverride: true } as InstanceElement;
  }
  return { ...el, sizing };
}
