import { cornerRadiusEqual, evalLengthExpr, resolveDynamicBorderRadius } from "../dsl/length-expr";
import { layoutOf } from "../dsl/layout-flat";
import type { AutoLayoutFields, ContainerElement, CornerRadius, DesignElement, ElementSizing } from "../dsl/types";
import { clampAxis, hugsAxis, resolveContentInsets, round2 } from "./box";

function evalBoxExpr(expr: string | undefined, ref: number | undefined): number | undefined {
  if (typeof expr !== "string" || ref === undefined) return undefined;
  const v = evalLengthExpr(expr, ref);
  return v !== undefined && Number.isFinite(v) ? Math.max(0, round2(v)) : undefined;
}

/**
 * Keeps a `borderRadiusExpr` (`"50%"`, `"calc(50% - 4px)"`, `"50% / 25%"`) in
 * sync with an element's resolved `(width, height)`, returning `el` unchanged
 * (`===`) when nothing moved.
 */
export function syncElementBorderRadius<T extends DesignElement>(el: T): T {
  const sizing = (el as { sizing?: ElementSizing }).sizing;
  const expr = sizing?.borderRadiusExpr;
  if (typeof expr !== "string" || !sizing) return el;

  const spec = resolveDynamicBorderRadius(expr, { width: el.width, height: el.height });
  if (!spec) return el;

  const prevR = (el as { borderRadius?: CornerRadius }).borderRadius;
  const prevY = sizing.borderRadiusY;
  if (cornerRadiusEqual(prevR, spec.radius) && cornerRadiusEqual(prevY, spec.radiusY)) {
    return el;
  }

  let nextSizing = sizing;
  if (!cornerRadiusEqual(prevY, spec.radiusY)) {
    nextSizing = { ...sizing };
    if (spec.radiusY !== undefined) nextSizing.borderRadiusY = spec.radiusY;
    else delete nextSizing.borderRadiusY;
  }

  return {
    ...el,
    borderRadius: spec.radius,
    ...(nextSizing !== sizing ? { sizing: nextSizing } : {})
  };
}

/** Syncs dynamic `borderRadiusExpr` across direct children after layout sizing. */
export function syncChildrenBorderRadius<T extends ContainerElement>(container: T): T {
  const children = container.children || [];
  let changed = false;
  const next = children.map((c) => {
    const synced = syncElementBorderRadius(c);
    if (synced !== c) changed = true;
    return synced;
  });
  return changed ? { ...container, children: next } : container;
}

function resolveChildDynamicBox(
  child: DesignElement,
  refW: number | undefined,
  refH: number | undefined
): DesignElement {
  const s = (child as { sizing?: ElementSizing }).sizing;
  if (!s) return child;
  const hasExpr =
    s.widthExpr !== undefined ||
    s.heightExpr !== undefined ||
    s.minWidthExpr !== undefined ||
    s.maxWidthExpr !== undefined ||
    s.minHeightExpr !== undefined ||
    s.maxHeightExpr !== undefined ||
    s.borderRadiusExpr !== undefined;
  if (!hasExpr) return child;

  const minW = evalBoxExpr(s.minWidthExpr, refW);
  const maxW = evalBoxExpr(s.maxWidthExpr, refW);
  const minH = evalBoxExpr(s.minHeightExpr, refH);
  const maxH = evalBoxExpr(s.maxHeightExpr, refH);

  let nextSizing = s;
  const ensureSizingClone = () => {
    if (nextSizing === s) nextSizing = { ...s };
    return nextSizing;
  };
  if (minW !== undefined && minW !== s.minWidth) ensureSizingClone().minWidth = minW;
  if (maxW !== undefined && maxW !== s.maxWidth) ensureSizingClone().maxWidth = maxW;
  if (minH !== undefined && minH !== s.minHeight) ensureSizingClone().minHeight = minH;
  if (maxH !== undefined && maxH !== s.maxHeight) ensureSizingClone().maxHeight = maxH;

  const probe = (nextSizing === s ? child : { ...child, sizing: nextSizing }) as DesignElement;
  const rawW = evalBoxExpr(s.widthExpr, refW);
  const rawH = evalBoxExpr(s.heightExpr, refH);
  const nextW = rawW !== undefined ? round2(clampAxis(probe, "width", rawW)) : child.width;
  const nextH = rawH !== undefined ? round2(clampAxis(probe, "height", rawH)) : child.height;

  let next = child;
  if (nextSizing !== s || nextW !== child.width || nextH !== child.height) {
    if (nextW !== child.width && (child.type === "line" || child.type === "arrow")) {
      const sx = child.dx >= 0 ? 1 : -1;
      const sy = child.dy >= 0 ? 1 : -1;
      next = {
        ...child,
        width: nextW,
        height: nextH,
        dx: sx * nextW,
        dy: sy * nextH,
        ...(nextSizing !== s ? { sizing: nextSizing } : {})
      };
    } else {
      next = {
        ...child,
        width: nextW,
        height: nextH,
        ...(nextSizing !== s ? { sizing: nextSizing } : {})
      };
    }
  }

  return syncElementBorderRadius(next);
}

/**
 * Re-evaluates `%` / mixed-`calc()` sizes, bounds, and corner radii on direct
 * children of `container` against its current box, keeping strict object
 * identity (`===`) when settled.
 */
export function syncContainerDynamicChildren<T extends ContainerElement>(container: T, hasOwnLayout: boolean): T {
  const children = container.children || [];
  if (children.length === 0) return container;

  const layout = hasOwnLayout ? layoutOf(container as AutoLayoutFields) : undefined;
  const [pt, pr, pb, pl] = layout ? resolveContentInsets(container, layout.padding) : [0, 0, 0, 0];
  const contentRefW =
    layout && hugsAxis(container, "width") ? undefined : Math.max(0, container.width - pl - pr);
  const contentRefH =
    layout && hugsAxis(container, "height") ? undefined : Math.max(0, container.height - pt - pb);

  let changed = false;
  const nextChildren = children.map((child) => {
    const isAbs = !layout || child.position === "absolute";
    const refW = isAbs ? container.width : contentRefW;
    const refH = isAbs ? container.height : contentRefH;
    const updated = resolveChildDynamicBox(child, refW, refH);
    if (updated !== child) changed = true;
    return updated;
  });

  return changed ? { ...container, children: nextChildren } : container;
}
