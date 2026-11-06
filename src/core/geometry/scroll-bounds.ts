import type { ContainerElement, DesignElement, InstanceElement, ScrollOverflow } from "../dsl/types";
import { resolvePadding } from "../layout/box";
import { findElementAtPoint } from "./tree-hit";
import { findParentById } from "./tree-query";

export interface ScrollBounds {
  maxScrollX: number;
  maxScrollY: number;
}

/**
 * Returns the effective translation offset for a child element inside a scrolling container,
 * respecting the child's constraint pins (e.g. fixed top/bottom headers or position: absolute).
 */
export function childScrollOffset(
  child: DesignElement,
  container: ContainerElement | InstanceElement,
  scrollX: number,
  scrollY: number
): { offsetX: number; offsetY: number } {
  if (scrollX === 0 && scrollY === 0) {
    return { offsetX: 0, offsetY: 0 };
  }

  const behavior = child.scrollBehavior;

  if (behavior === "fixed") {
    return { offsetX: 0, offsetY: 0 };
  }

  if (behavior === "sticky") {
    const offsetX =
      child.x - scrollX <= 0 &&
      (container.scrollOverflow === "horizontal" || container.scrollOverflow === "both")
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
  const parentHasLayout = Boolean((container as any).layout);

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
  resolvedChildren?: DesignElement[]
): ScrollBounds {
  const children = resolvedChildren ?? (container as ContainerElement).children ?? [];
  const padding = resolvePadding((container as any).padding);
  const [, pr, pb] = padding;

  let maxX = 0;
  let maxY = 0;
  for (const child of children) {
    if (child.visible === false) continue;
    const { offsetX, offsetY } = childScrollOffset(child, container, 1, 1);
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
    scrollOverflow?: ScrollOverflow;
    width: number;
    height: number;
    padding?: any;
    children?: DesignElement[];
  },
  nextScrollX: number,
  nextScrollY: number,
  resolvedChildren?: DesignElement[]
): { scrollX: number; scrollY: number } {
  const mode = el.scrollOverflow ?? "none";
  if (mode === "none") {
    return { scrollX: 0, scrollY: 0 };
  }
  const { maxScrollX, maxScrollY } = computeContainerScrollBounds(el as any, resolvedChildren);
  const canX = mode === "horizontal" || mode === "both";
  const canY = mode === "vertical" || mode === "both";

  return {
    scrollX: canX ? Math.max(0, Math.min(nextScrollX, maxScrollX)) : 0,
    scrollY: canY ? Math.max(0, Math.min(nextScrollY, maxScrollY)) : 0
  };
}

export function isScrollableContainer(
  el: DesignElement
): el is ContainerElement | InstanceElement {
  return (
    (el.type === "frame" || el.type === "component" || el.type === "instance") &&
    el.scrollOverflow !== undefined &&
    el.scrollOverflow !== "none"
  );
}

export function canContainerScroll(
  container: ContainerElement | InstanceElement,
  deltaX: number,
  deltaY: number,
  resolvedChildren?: DesignElement[]
): boolean {
  const mode = container.scrollOverflow ?? "none";
  if (mode === "none") return false;
  const { maxScrollX, maxScrollY } = computeContainerScrollBounds(container, resolvedChildren);
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
  y: number
): (ContainerElement | InstanceElement)[] {
  const hit = findElementAtPoint(elements, x, y, { includeLocked: true });
  if (!hit) return [];
  const candidates: (ContainerElement | InstanceElement)[] = [];
  let curr: DesignElement | null = hit;
  while (curr) {
    if (isScrollableContainer(curr)) {
      candidates.push(curr);
    }
    curr = findParentById(elements, curr.id);
  }
  return candidates;
}
