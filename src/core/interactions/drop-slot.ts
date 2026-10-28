import { ContainerElement, DesignElement } from "../dsl/types";
import { resolvePadding } from "../layout/box";
import { layoutOf } from "../dsl/layout-flat";

export interface DropSlot {
  /** Index among the siblings that stay — the dragged children splice in here. */
  index: number;
  /** World-space box: a thin bar for flex, the target cell for grid. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The insertion point for a drop inside an auto-layout container, read off the
 * boxes actually on screen. Both parts of the old behaviour are replaced: the
 * order no longer comes from a re-sort of every child (which cannot express
 * "before this one" when the dragged box overlaps it), and the user can see the
 * slot while dragging instead of finding out on release.
 */
export function computeDropSlot(
  parent: ContainerElement,
  draggedIds: Set<string>,
  pointer: { x: number; y: number },
  parentOrigin?: { x: number; y: number }
): DropSlot | null {
  const layout = layoutOf(parent);
  if (!layout) return null;
  const children = parent.children ?? [];
  const siblings = children.filter((c) => !draggedIds.has(c.id));
  // A hidden sibling is out of the flow, so it has no box on screen to aim at —
  // and it is where the layout pass stopped placing it, which is not where the
  // user is looking. `index` stays a position among the siblings that stay, so a
  // hidden one still holds its slot in the array.
  const placeable = siblings.filter((c) => c.visible !== false);
  const [pt, pr, pb, pl] = resolvePadding(layout.padding);
  const originX = parentOrigin?.x ?? parent.x;
  const originY = parentOrigin?.y ?? parent.y;
  const contentX = originX + pl;
  const contentY = originY + pt;
  const contentW = Math.max(0, parent.width - pl - pr);
  const contentH = Math.max(0, parent.height - pt - pb);
  const gap = layout.gap ?? 0;

  // Nothing to displace: the slot is the whole content box.
  if (placeable.length === 0) {
    return { index: siblings.length, x: contentX, y: contentY, width: contentW, height: contentH };
  }

  let nearest = placeable[0];
  let nearestDist = Infinity;
  for (const sibling of placeable) {
    const sibWorldX = originX + sibling.x;
    const sibWorldY = originY + sibling.y;
    const dx = sibWorldX + sibling.width / 2 - pointer.x;
    const dy = sibWorldY + sibling.height / 2 - pointer.y;
    const d = dx * dx + dy * dy;
    if (d < nearestDist) {
      nearestDist = d;
      nearest = sibling;
    }
  }

  const index = siblings.indexOf(nearest);
  const nearestWorldX = originX + nearest.x;
  const nearestWorldY = originY + nearest.y;

  if (layout.mode === "grid") {
    // The cell itself is the clearest preview, and inserting before/after the
    // nearest occupant is decided by which half of it the pointer is in.
    const before = (layout.placement ?? "row") === "column"
      ? pointer.y < nearestWorldY + nearest.height / 2
      : pointer.x < nearestWorldX + nearest.width / 2;
    return {
      index: index + (before ? 0 : 1),
      x: nearestWorldX,
      y: nearestWorldY,
      width: nearest.width,
      height: nearest.height
    };
  }

  const isRow = layout.direction === "row";
  const before = isRow
    ? pointer.x < nearestWorldX + nearest.width / 2
    : pointer.y < nearestWorldY + nearest.height / 2;
  const at = before ? index : index + 1;
  if (isRow) {
    const x = before ? nearestWorldX - gap / 2 : nearestWorldX + nearest.width + gap / 2;
    return { index: at, x, y: contentY, width: 2, height: contentH };
  }
  const y = before ? nearestWorldY - gap / 2 : nearestWorldY + nearest.height + gap / 2;
  return { index: at, x: contentX, y, width: contentW, height: 2 };
}

/**
 * The children in their post-drop order: the dragged ones spliced in at
 * `index`, counted among the siblings that stay. Shared by the pointer-driven
 * drop and its tests — a multi-select drop moves the whole selection there.
 */
export function applyDropSlot(
  parent: ContainerElement,
  draggedIds: Set<string>,
  index: number
): DesignElement[] {
  const children = parent.children ?? [];
  const moving = children.filter((c) => draggedIds.has(c.id));
  if (moving.length === 0) return children;
  const rest = children.filter((c) => !draggedIds.has(c.id));
  const at = Math.max(0, Math.min(rest.length, index));
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/**
 * The slot a drop into a *different* container lands in. Reparenting appends,
 * so there is no insertion point to read off the geometry — the whole content
 * box is the honest preview.
 */
export function computeAppendSlot(
  parent: ContainerElement,
  draggedIds: Set<string>,
  parentOrigin?: { x: number; y: number }
): DropSlot | null {
  const layout = layoutOf(parent);
  if (!layout) return null;
  const siblings = (parent.children ?? []).filter((c) => !draggedIds.has(c.id));
  const [pt, pr, pb, pl] = resolvePadding(layout.padding);
  const originX = parentOrigin?.x ?? parent.x;
  const originY = parentOrigin?.y ?? parent.y;
  return {
    index: siblings.length,
    x: originX + pl,
    y: originY + pt,
    width: Math.max(0, parent.width - pl - pr),
    height: Math.max(0, parent.height - pt - pb)
  };
}
