import { ContainerElement, DesignElement, LayoutConstraints } from "../dsl/types";
import { layoutOf, type FlatAutoLayout } from "../dsl/layout-flat";
import { scaleElementGeometry } from "./scale-geometry";
import { isContainer } from "./tree-ops";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const H_MODES: NonNullable<LayoutConstraints["horizontal"]>[] = [
  "left", "right", "center", "stretch", "scale"
];
const V_MODES: NonNullable<LayoutConstraints["vertical"]>[] = [
  "top", "bottom", "center", "stretch", "scale"
];

const isHMode = (v: unknown): v is NonNullable<LayoutConstraints["horizontal"]> =>
  H_MODES.includes(v as NonNullable<LayoutConstraints["horizontal"]>);
const isVMode = (v: unknown): v is NonNullable<LayoutConstraints["vertical"]> =>
  V_MODES.includes(v as NonNullable<LayoutConstraints["vertical"]>);

function resolveConstraints(el: DesignElement): {
  horizontal: NonNullable<LayoutConstraints["horizontal"]>;
  vertical: NonNullable<LayoutConstraints["vertical"]>;
} {
  const c = el.constraints;
  const horizontal = c && isHMode(c.horizontal) ? c.horizontal : "left";
  const vertical = c && isVMode(c.vertical) ? c.vertical : "top";
  return { horizontal, vertical };
}

function applyH(
  child: DesignElement,
  old: Bounds,
  cur: Bounds,
  next: Bounds
): Bounds {
  const mode = resolveConstraints(child).horizontal;
  const leftDist = child.x - old.x;
  const rightDist = old.x + old.width - (child.x + child.width);
  const out = { ...cur };
  switch (mode) {
    case "right":
      out.x = next.x + next.width - rightDist - child.width;
      break;
    case "center":
      out.x = child.x + (next.x - old.x) + (next.width - old.width) / 2;
      break;
    case "stretch":
      out.x = child.x + (next.x - old.x);
      out.width = Math.max(1, child.width + (next.width - old.width));
      break;
    case "scale": {
      const sx = next.width / Math.max(1, old.width);
      out.x = next.x + leftDist * sx;
      out.width = Math.max(1, child.width * sx);
      break;
    }
    default:
      out.x = child.x + (next.x - old.x);
  }
  return out;
}

function applyV(
  child: DesignElement,
  old: Bounds,
  cur: Bounds,
  next: Bounds
): Bounds {
  const mode = resolveConstraints(child).vertical;
  const topDist = child.y - old.y;
  const bottomDist = old.y + old.height - (child.y + child.height);
  const out = { ...cur };
  switch (mode) {
    case "bottom":
      out.y = next.y + next.height - bottomDist - child.height;
      break;
    case "center":
      out.y = child.y + (next.y - old.y) + (next.height - old.height) / 2;
      break;
    case "stretch":
      out.y = child.y + (next.y - old.y);
      out.height = Math.max(1, child.height + (next.height - old.height));
      break;
    case "scale": {
      const sy = next.height / Math.max(1, old.height);
      out.y = next.y + topDist * sy;
      out.height = Math.max(1, child.height * sy);
      break;
    }
    default:
      out.y = child.y + (next.y - old.y);
  }
  return out;
}

export function applyConstraintsToChildren(
  children: DesignElement[],
  old: Bounds,
  next: Bounds
): DesignElement[] {
  return children.map((child) => applyConstraintsToChild(child, old, next));
}

/** A resize ratio that cannot be `Infinity` when the old extent was already 0. */
function ratioTo(next: number, prev: number): number {
  return prev > 0 ? next / prev : 1;
}

function applyConstraintsToChild(child: DesignElement, old: Bounds, next: Bounds): DesignElement {
  let cb: Bounds = { x: child.x, y: child.y, width: child.width, height: child.height };
  cb = applyH(child, old, cb, next);
  cb = applyV(child, old, cb, next);
  const moved =
    cb.x !== child.x || cb.y !== child.y ||
    cb.width !== child.width || cb.height !== child.height;
  const rounded: Bounds = {
    x: Math.round(cb.x),
    y: Math.round(cb.y),
    width: Math.round(cb.width),
    height: Math.round(cb.height)
  };
  let updated: DesignElement = moved
    ? { ...child, ...rounded }
    : child;
  // A path or a line stores its drawn geometry beside the box, so `stretch` and
  // `scale` reach it twice: once for the box, once for the shape. Without this
  // the selection box follows the frame and the drawing stays where it was.
  if (moved) {
    updated = scaleElementGeometry(
      updated,
      ratioTo(rounded.width, child.width),
      ratioTo(rounded.height, child.height)
    );
  }
  // A stretched/scaled child container drags its own subtree along; recurse
  // so nested constraint sets see both the old and new inner bounds.
  if (moved && isContainer(updated) && updated.children?.length && !layoutOf(updated as FlatAutoLayout)) {
    updated = {
      ...updated,
      children: applyConstraintsToChildren(updated.children, { x: child.x, y: child.y, width: child.width, height: child.height }, rounded)
    } as ContainerElement;
  }
  return updated;
}

/**
 * Re-apply every child's constraint for a container whose box changed, in the
 * children's own (local) coordinate space. List-level on purpose: a frame resize
 * reaches it through `resizeContainerWithConstraints`, and an instance reaches it
 * from `resolveInstanceChildren` — an instance is not a container in the tree, so
 * it cannot come through the ContainerElement entry point.
 *
 * Sizes, not boxes, and that is the whole point. A child's distance to the frame's
 * left edge IS its own `x`, because `x` is local to the frame (LESSONS §4.2). Hand
 * this the frame's canvas box and the maths subtracts the frame's origin from a
 * child that never had it: a top-left-constrained child then drifted away from the
 * corner it is pinned to, by exactly the amount the frame's own origin moved.
 */
export function resizeContainerWithConstraints(
  container: ContainerElement,
  oldSize: { width: number; height: number },
  newSize: { width: number; height: number }
): ContainerElement {
  if (!container.children?.length) return container;
  const oldBox: Bounds = { x: 0, y: 0, width: oldSize.width, height: oldSize.height };
  const newBox: Bounds = { x: 0, y: 0, width: newSize.width, height: newSize.height };
  if (!layoutOf(container as FlatAutoLayout)) {
    return {
      ...container,
      children: applyConstraintsToChildren(container.children, oldBox, newBox)
    };
  }
  // A stack places its own children, so a constraint written on an in-flow child
  // would be silently overwritten by the next layout pass — the authoring
  // equivalent of a rule that does not apply. Only a child that left the flow can
  // be constrained, which is exactly Figma's rule for "Ignore auto layout".
  let changed = false;
  const children = container.children.map((child) => {
    if (child.position !== "absolute") return child;
    const next = applyConstraintsToChild(child, oldBox, newBox);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...container, children } : container;
}

export function resizeElementWithConstraints(
  el: DesignElement,
  next: Partial<Bounds>
): DesignElement {
  const oldBounds: Bounds = { x: el.x, y: el.y, width: el.width, height: el.height };
  const merged = { ...oldBounds, ...next };
  if (!isContainer(el) || !el.children?.length) {
    // The inspector's W / H fields land here, so a leaf is the one place a box
    // edit can be typed directly — and a typed width on a path is the same split
    // brain a constrained resize has, arrived at by hand.
    return scaleElementGeometry(
      { ...el, ...next },
      ratioTo(merged.width, el.width),
      ratioTo(merged.height, el.height)
    );
  }
  return resizeContainerWithConstraints(
    { ...el, ...merged } as ContainerElement,
    { width: el.width, height: el.height },
    { width: merged.width, height: merged.height }
  );
}
