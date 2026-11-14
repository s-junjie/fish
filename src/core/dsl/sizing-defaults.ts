import { DEFAULT_FLEX_ALIGN, DEFAULT_FLEX_DIRECTION } from "./layout-flat";
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
 * Nested auto-layout containers default to `"fill"` on a definite parent axis
 * that stretches by CSS alignment (column flex cross-axis, definite row height,
 * grid cells) when their own size is omitted, matching CSS block/flex item
 * stretch instead of collapsing away from `justify-content: space-between`.
 * Explicitly authored pixel sizes pin to `"fixed"` so parent stretch never
 * overwrites an explicit dimension.
 */
export interface SizingDefaultContext {
  type: ElementType;
  ownLayout: AutoLayout | undefined;
  /** The parent's layout, or null when there is no layout above this element. */
  parentLayout: AutoLayout | null;
  /** Parent's resolved sizing, used so nested containers don't `fill` a hugging parent axis. */
  parentSizing?: ElementSizing | null;
  authoredWidth: unknown;
  authoredHeight: unknown;
  isAbsolute?: boolean;
  alignSelf?: AutoLayout["align"];
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isHugging = (mode: ElementSizing["width"] | undefined): boolean =>
  mode === "fit-content" || mode === "max-content";

function parentStretchedAxis(ctx: SizingDefaultContext, axis: "width" | "height"): boolean {
  const parent = ctx.parentLayout;
  if (!parent || ctx.isAbsolute) return false;
  if (parent.mode === "grid") {
    return (ctx.alignSelf ?? parent.cellAlign ?? "stretch") === "stretch";
  }
  const mainAxis = (parent.direction ?? DEFAULT_FLEX_DIRECTION) === "row" ? "width" : "height";
  if (axis === mainAxis) return false;
  return (ctx.alignSelf ?? parent.align ?? DEFAULT_FLEX_ALIGN) === "stretch";
}

/**
 * Resolves CSS `width: "auto"` / `height: "auto"` in parent layout context:
 * containers and shapes along a parent-stretched definite axis stretch (`fill`),
 * matching CSS Flexbox/Grid default stretch; elsewhere it stays `fit-content`.
 */
export function resolveCssAutoMode(ctx: SizingDefaultContext, axis: "width" | "height"): "fill" | "fit-content" {
  if (
    ctx.type !== "text" &&
    ctx.parentLayout &&
    !ctx.isAbsolute &&
    parentStretchedAxis(ctx, axis) &&
    !isHugging(ctx.parentSizing?.[axis])
  ) {
    return "fill";
  }
  return "fit-content";
}

/** Fills in the axes `sizing` left unsaid, in place. */
export function applySizingDefaults(sizing: ElementSizing, ctx: SizingDefaultContext): void {
  const mode = ctx.ownLayout?.mode;
  const isContainer = mode === "flex" || mode === "grid";
  const parentIsLayout = !ctx.isAbsolute && (ctx.parentLayout?.mode === "flex" || ctx.parentLayout?.mode === "grid");

  if (isContainer) {
    for (const axis of ["width", "height"] as const) {
      if (sizing[axis]) continue;
      const authored = axis === "width" ? ctx.authoredWidth : ctx.authoredHeight;
      const stretches = parentStretchedAxis(ctx, axis);
      if (isNumber(authored)) {
        if (stretches) sizing[axis] = "fixed";
      } else if (stretches && !isHugging(ctx.parentSizing?.[axis])) {
        sizing[axis] = "fill";
      } else {
        sizing[axis] = "fit-content";
      }
    }
    return;
  }

  // In-flow text inside a layout parent wraps to the parent when width is omitted,
  // but honors an explicitly authored width or height as `"fixed"` (matching CSS).
  if (ctx.type === "text" && parentIsLayout) {
    if (!sizing.width) {
      sizing.width = isNumber(ctx.authoredWidth) ? "fixed" : "fit-content";
    }
    if (!sizing.height) {
      sizing.height = isNumber(ctx.authoredHeight) ? "fixed" : "fit-content";
    }
  }
}
