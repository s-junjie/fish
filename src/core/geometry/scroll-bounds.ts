import type { ContainerElement, DesignDocument, DesignElement, InstanceElement, ScrollOverflow } from "../dsl/types";
import { resolvePadding } from "../layout/box";
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
 * Returns the effective translation offset for a child element inside a scrolling container,
 * respecting the child's constraint pins (e.g. fixed top/bottom headers or position: absolute).
 *
 * `layoutHost` is the element whose auto layout decides whether the child is in
 * the flow, and whose scroll fields are the real ones when the container is an
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

  const host = layoutHost as
    | { scrollOverflow?: ScrollOverflow; clipContent?: boolean }
    | null
    | undefined;
  const overflow: ScrollOverflow = container.scrollOverflow ?? host?.scrollOverflow ?? "none";
  // Both renderers offset a container's children only while it clips, and that is
  // the whole test they make — the mode decides whether the user MAY scroll, not
  // whether an offset already stored is painted. A reader that moved the box for
  // an offset nothing paints is the offset frame the selection shows for a node
  // that sits still; so this one mirrors the renderer exactly.
  const clips = container.clipContent ?? host?.clipContent;
  if (!clips) {
    return { offsetX: 0, offsetY: 0 };
  }
  const behavior = child.scrollBehavior;

  if (behavior === "fixed") {
    return { offsetX: 0, offsetY: 0 };
  }

  if (behavior === "sticky") {
    const offsetX =
      child.x - scrollX <= 0 && (overflow === "horizontal" || overflow === "both")
        ? -child.x
        : -scrollX;
    const offsetY = child.y - scrollY <= 0 ? -child.y : -scrollY;
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
  const padding = resolvePadding((container as any).padding ?? master?.padding);
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
 * Clamps nextScrollX and nextScrollY to [0, maxScroll] according to the
 * container's scrollOverflow mode ("none" | "vertical" | "horizontal" | "both").
 */
export function clampScrollOffset(
  el: {
    type?: string;
    componentId?: string;
    scrollOverflow?: ScrollOverflow;
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
  let mode = el.scrollOverflow;
  if (!mode && el.type === "instance" && el.componentId && doc) {
    const master = findMasterComponent(doc, el.componentId);
    mode = master?.scrollOverflow;
  }
  mode = mode ?? "none";
  if (mode === "none") {
    return { scrollX: 0, scrollY: 0 };
  }
  const { maxScrollX, maxScrollY } = computeContainerScrollBounds(el as any, resolvedChildren, doc);
  const canX = mode === "horizontal" || mode === "both";
  const canY = mode === "vertical" || mode === "both";

  return {
    scrollX: canX ? Math.max(0, Math.min(nextScrollX, maxScrollX)) : 0,
    scrollY: canY ? Math.max(0, Math.min(nextScrollY, maxScrollY)) : 0
  };
}

export function isScrollableContainer(
  el: DesignElement,
  doc?: DesignDocument
): el is ContainerElement | InstanceElement {
  if (el.type === "frame" || el.type === "component") {
    return el.scrollOverflow !== undefined && el.scrollOverflow !== "none";
  }
  if (el.type === "instance") {
    const inst = el as InstanceElement;
    if (inst.scrollOverflow !== undefined) {
      return inst.scrollOverflow !== "none";
    }
    if (doc) {
      const master = findMasterComponent(doc, inst.componentId);
      return master?.scrollOverflow !== undefined && master.scrollOverflow !== "none";
    }
  }
  return false;
}

export function canContainerScroll(
  container: ContainerElement | InstanceElement,
  deltaX: number,
  deltaY: number,
  doc?: DesignDocument,
  resolvedChildren?: DesignElement[]
): boolean {
  let mode = container.scrollOverflow;
  if (!mode && container.type === "instance" && doc) {
    const master = findMasterComponent(doc, (container as InstanceElement).componentId);
    mode = master?.scrollOverflow;
  }
  if (!mode || mode === "none") return false;
  const { maxScrollX, maxScrollY } = computeContainerScrollBounds(container, resolvedChildren, doc);
  const curX = container.scrollX ?? 0;
  const curY = container.scrollY ?? 0;
  const canX = (mode === "horizontal" || mode === "both") && maxScrollX > 0;
  const canY = (mode === "vertical" || mode === "both") && maxScrollY > 0;

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

export function findScrollableContainersAtPoint(
  elements: DesignElement[],
  x: number,
  y: number,
  doc?: DesignDocument
): (ContainerElement | InstanceElement)[] {
  const hit = findElementAtPoint(elements, x, y, { includeLocked: true });
  if (!hit) return [];
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
