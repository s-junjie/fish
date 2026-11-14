import type { ContainerElement, DesignDocument, DesignElement, InstanceElement } from "../dsl/types";
import { resolveOverflow, type OverflowAxes, type OverflowFields } from "../dsl/overflow";
import { resolveContentInsets } from "../layout/box";
import { layoutOf } from "../dsl/layout-flat";
import { findElementAtPoint } from "./tree-hit";
import { findParentById } from "./tree-query";
import { findMasterComponent } from "../interactions/component-inventory";
import { resolveInstanceChildren } from "../interactions/instance-resolve";
import { instanceScaleOf } from "./scale-geometry";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface ScrollBounds {
  maxScrollX: number;
  maxScrollY: number;
}

/**
 * The axes a container paints and scrolls with. An instance stores only what it
 * owns, so anything it does not declare comes from the master it projects —
 * which is also the element whose auto layout decides whether a child is in the
 * flow.
 */
function axesFor(
  el: OverflowFields & { type?: string; componentId?: string },
  doc?: DesignDocument
): OverflowAxes {
  const master =
    el.type === "instance" && el.componentId && doc ? findMasterComponent(doc, el.componentId) : null;
  return resolveOverflow(el, master as OverflowFields | null);
}

/**
 * Returns the effective translation offset for a child element inside a scrolling container,
 * respecting the child's constraint pins (e.g. fixed top/bottom headers or position: absolute).
 *
 * `layoutHost` is the element whose auto layout decides whether the child is in
 * the flow, and whose overflow fields are the real ones when the container is an
 * INSTANCE — it stores no layout and, until the user overrides it, no overflow
 * of its own, so both belong to the master it projects.
 */
export function childScrollOffset(
  child: DesignElement,
  container: ContainerElement | InstanceElement,
  scrollX: number,
  scrollY: number,
  layoutHost?: object | null
): { offsetX: number; offsetY: number } {
  if (scrollX === 0 && scrollY === 0) {
    return { offsetX: 0, offsetY: 0 };
  }

  const axes = resolveOverflow(container as OverflowFields, layoutHost as OverflowFields | null);
  // Both renderers offset a container's children only while it clips, and that is
  // the whole test they make — the axis value decides whether the user MAY scroll,
  // not whether an offset already stored is painted. A reader that moved the box
  // for an offset nothing paints is the offset frame the selection shows for a
  // node that sits still; so this one mirrors the renderer exactly.
  if (axes.x === "visible" && axes.y === "visible") {
    return { offsetX: 0, offsetY: 0 };
  }
  const behavior = child.scrollBehavior;

  if (behavior === "fixed") {
    return { offsetX: 0, offsetY: 0 };
  }

  if (behavior === "sticky") {
    // Each axis sticks only if it can scroll: a `hidden` axis has no offset to
    // hold a child against, and reading its position as "reached the edge" is
    // what pinned a Y-sticky child inside a horizontally-scrolling frame.
    const offsetX = child.x - scrollX <= 0 && axes.x === "auto" ? -child.x : -scrollX;
    const offsetY = child.y - scrollY <= 0 && axes.y === "auto" ? -child.y : -scrollY;
    return { offsetX, offsetY };
  }

  if (behavior === "scroll") {
    return { offsetX: -scrollX, offsetY: -scrollY };
  }

  const c = child.constraints;
  const isAbs = child.position === "absolute";
  const parentHasLayout = layoutOf(layoutHost ?? container) !== undefined;

  let pinX = false;
  let pinY = false;

  if (isAbs) {
    pinX = true;
    pinY = true;
  } else if (!parentHasLayout && c) {
    if (c.horizontal === "right" || (c.horizontal === "left" && child.x <= 0)) {
      pinX = true;
    }
    if (c.vertical === "bottom" || (c.vertical === "top" && child.y <= 0)) {
      pinY = true;
    }
  }

  return {
    offsetX: pinX ? 0 : -scrollX,
    offsetY: pinY ? 0 : -scrollY
  };
}

/**
 * Computes the maximum horizontal and vertical scroll extent for a container.
 *
 * Scans visible non-pinned children and adds container padding-right and padding-bottom,
 * comparing against the container's authored box.
 */
export function computeContainerScrollBounds(
  container: ContainerElement | InstanceElement,
  resolvedChildren?: DesignElement[],
  doc?: DesignDocument
): ScrollBounds {
  let children = resolvedChildren ?? (container as ContainerElement).children;
  const instance = container.type === "instance" ? (container as InstanceElement) : null;
  const master = instance && doc ? findMasterComponent(doc, instance.componentId) : null;
  if (!children && master) children = resolveInstanceChildren(instance!, master);
  children = children ?? [];

  // The padding belongs to whatever authored the box: the frame's own, or the
  // master's for an instance, which stores none — and which is read whether or
  // not the caller brought its own children, because it bounds them either way.
  const padding = resolveContentInsets(
    (container as any).strokes ? container : (master ?? container),
    (container as any).padding ?? master?.padding
  );
  // A SCALED instance lays its children out at master × factor, so the padding
  // that bounds them travels with the same factor — right by the x one, bottom
  // by the y one, exactly as `scaleLayout` scales it for the pass itself.
  const scale = instance ? instanceScaleOf(instance) : { x: 1, y: 1 };
  const pr = round2(padding[1] * scale.x);
  const pb = round2(padding[2] * scale.y);

  let maxX = 0;
  let maxY = 0;
  for (const child of children) {
    if (child.visible === false) continue;
    const { offsetX, offsetY } = childScrollOffset(child, container, 1, 1, master);
    const pinX = offsetX === 0;
    const pinY = offsetY === 0;
    if (!pinX) {
      const right = child.x + child.width;
      if (right > maxX) maxX = right;
    }
    if (!pinY) {
      const bottom = child.y + child.height;
      if (bottom > maxY) maxY = bottom;
    }
  }

  const maxScrollX = Math.max(0, maxX + pr - container.width);
  const maxScrollY = Math.max(0, maxY + pb - container.height);
  return { maxScrollX, maxScrollY };
}

/**
 * Clamps a next offset to what the declared axes can actually reveal. An axis
 * set to `auto` still has to have room — the direction a wheel may travel is
 * measured, never stored.
 */
export function clampScrollOffset(
  el: OverflowFields & {
    type?: string;
    componentId?: string;
    width: number;
    height: number;
    padding?: any;
    children?: DesignElement[];
  },
  nextScrollX: number,
  nextScrollY: number,
  resolvedChildren?: DesignElement[],
  doc?: DesignDocument
): { scrollX: number; scrollY: number } {
  const axes = axesFor(el, doc);
  // Nothing scrolls and the children do not need measuring: this runs on every
  // wheel tick, and the scan below is proportional to the subtree.
  if (axes.x !== "auto" && axes.y !== "auto") {
    return { scrollX: 0, scrollY: 0 };
  }
  const { maxScrollX, maxScrollY } = computeContainerScrollBounds(el as any, resolvedChildren, doc);

  return {
    scrollX: axes.x === "auto" ? Math.max(0, Math.min(nextScrollX, maxScrollX)) : 0,
    scrollY: axes.y === "auto" ? Math.max(0, Math.min(nextScrollY, maxScrollY)) : 0
  };
}

export function isScrollableContainer(
  el: DesignElement,
  doc?: DesignDocument
): el is ContainerElement | InstanceElement {
  if (el.type !== "frame" && el.type !== "component" && el.type !== "instance") return false;
  const axes = axesFor(el as ContainerElement | InstanceElement, doc);
  return axes.x === "auto" || axes.y === "auto";
}

export function canContainerScroll(
  container: ContainerElement | InstanceElement,
  deltaX: number,
  deltaY: number,
  doc?: DesignDocument,
  resolvedChildren?: DesignElement[]
): boolean {
  const axes = axesFor(container, doc);
  const scrollableX = axes.x === "auto";
  const scrollableY = axes.y === "auto";
  if (!scrollableX && !scrollableY) return false;

  const { maxScrollX, maxScrollY } = computeContainerScrollBounds(container, resolvedChildren, doc);
  const curX = container.scrollX ?? 0;
  const curY = container.scrollY ?? 0;
  const canX = scrollableX && maxScrollX > 0;
  const canY = scrollableY && maxScrollY > 0;

  if (canX && deltaX !== 0) {
    if (deltaX > 0 && curX < maxScrollX) return true;
    if (deltaX < 0 && curX > 0) return true;
  }
  if (canY && deltaY !== 0) {
    if (deltaY > 0 && curY < maxScrollY) return true;
    if (deltaY < 0 && curY > 0) return true;
  }
  return false;
}

/**
 * The scrollable containers a hit sits in, innermost first — the chain a wheel
 * asks in order, because the closest one that can still move is the one that
 * scrolls.
 */
export function scrollableAncestors(
  elements: DesignElement[],
  hit: DesignElement | null,
  doc?: DesignDocument
): (ContainerElement | InstanceElement)[] {
  const candidates: (ContainerElement | InstanceElement)[] = [];
  let curr: DesignElement | null = hit;
  while (curr) {
    if (isScrollableContainer(curr, doc)) {
      candidates.push(curr as ContainerElement | InstanceElement);
    }
    curr = findParentById(elements, curr.id);
  }
  return candidates;
}

export function findScrollableContainersAtPoint(
  elements: DesignElement[],
  x: number,
  y: number,
  doc?: DesignDocument
): (ContainerElement | InstanceElement)[] {
  return scrollableAncestors(elements, findElementAtPoint(elements, x, y, { includeLocked: true }), doc);
}

/** Whether a declared `auto` axis actually has room left. */
export function hasScrollableOverflow(
  container: ContainerElement | InstanceElement,
  doc?: DesignDocument
): boolean {
  const { maxScrollX, maxScrollY } = computeContainerScrollBounds(container, undefined, doc);
  const axes = axesFor(container, doc);
  return (
    (axes.x === "auto" && maxScrollX > 0) ||
    (axes.y === "auto" && maxScrollY > 0)
  );
}
