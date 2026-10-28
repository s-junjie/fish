import { Rect } from "../geometry/bounds";
import { ContainerElement, DesignElement } from "../dsl/types";
import { elementAABB, translateElement } from "./line-ops";
import { relayoutDocumentTree, gridColumnCount, resolvePadding } from "../compile";
import { findParentById, findElementById, mapElements, isContainer } from "../geometry/tree-ops";
import { layoutOf } from "../dsl/layout-flat";

export type AlignmentType = 
  | "left" 
  | "center" 
  | "right" 
  | "top" 
  | "middle" 
  | "bottom" 
  | "distribute-h" 
  | "distribute-v";

export interface AlignContext {
  /** Full element tree, so a nested selection can find its containing frame. */
  allElements: DesignElement[];
  canvasWidth?: number;
  canvasHeight?: number;
}

/**
 * Figma parity: a single selection inside a frame aligns against that frame's
 * box; a top-level single selection aligns against the canvas. Multiple
 * selections always align to the union of their own boxes.
 */
export function getAlignReferenceBox(
  elements: DesignElement[],
  type: AlignmentType,
  context?: AlignContext
): Rect | null {
  if (type.startsWith("distribute")) return getSelectionBoundingBox(elements);
  if (elements.length === 1 && context) {
    const parent = findParentById(context.allElements, elements[0].id);
    if (parent) return { x: 0, y: 0, width: parent.width, height: parent.height };
    if (context.canvasWidth !== undefined && context.canvasHeight !== undefined) {
      return { x: 0, y: 0, width: context.canvasWidth, height: context.canvasHeight };
    }
  }
  return getSelectionBoundingBox(elements);
}

export function getSelectionBoundingBox(elements: DesignElement[]): Rect | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    const box = elementAABB(el);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

export function alignElements(
  elements: DesignElement[],
  type: AlignmentType,
  context?: AlignContext
): DesignElement[] {
  if (elements.length <= 1 && type.startsWith("distribute")) return elements;
  const bbox = getAlignReferenceBox(elements, type, context);
  if (!bbox) return elements;

  const boxes = elements.map((el) => elementAABB(el));

  switch (type) {
    case "left":
      return elements.map((el, i) => translateElement(el, Math.round(bbox.x - boxes[i].x), 0));
    case "center": {
      const center = bbox.x + bbox.width / 2;
      return elements.map((el, i) =>
        translateElement(el, Math.round(center - (boxes[i].x + boxes[i].width / 2)), 0)
      );
    }
    case "right": {
      const right = bbox.x + bbox.width;
      return elements.map((el, i) =>
        translateElement(el, Math.round(right - (boxes[i].x + boxes[i].width)), 0)
      );
    }
    case "top":
      return elements.map((el, i) => translateElement(el, 0, Math.round(bbox.y - boxes[i].y)));
    case "middle": {
      const middle = bbox.y + bbox.height / 2;
      return elements.map((el, i) =>
        translateElement(el, 0, Math.round(middle - (boxes[i].y + boxes[i].height / 2)))
      );
    }
    case "bottom": {
      const bottom = bbox.y + bbox.height;
      return elements.map((el, i) =>
        translateElement(el, 0, Math.round(bottom - (boxes[i].y + boxes[i].height)))
      );
    }

    case "distribute-h": {
      if (elements.length <= 2) return elements;
      const order = elements.map((_, i) => i).sort((a, b) => boxes[a].x - boxes[b].x);
      const totalWidth = order.reduce((sum, i) => sum + boxes[i].width, 0);
      const gap = (bbox.width - totalWidth) / (order.length - 1);

      let currentX = bbox.x;
      const dxByIndex = new Map<number, number>();
      for (const i of order) {
        dxByIndex.set(i, Math.round(currentX - boxes[i].x));
        currentX += boxes[i].width + gap;
      }
      return elements.map((el, i) => translateElement(el, dxByIndex.get(i)!, 0));
    }

    case "distribute-v": {
      if (elements.length <= 2) return elements;
      const order = elements.map((_, i) => i).sort((a, b) => boxes[a].y - boxes[b].y);
      const totalHeight = order.reduce((sum, i) => sum + boxes[i].height, 0);
      const gap = (bbox.height - totalHeight) / (order.length - 1);

      let currentY = bbox.y;
      const dyByIndex = new Map<number, number>();
      for (const i of order) {
        dyByIndex.set(i, Math.round(currentY - boxes[i].y));
        currentY += boxes[i].height + gap;
      }
      return elements.map((el, i) => translateElement(el, 0, dyByIndex.get(i)!));
    }

    default:
      return elements;
  }
}

/**
 * Arrow-key nudge distance, in document units, and what Shift multiplies it by.
 *
 * Named because a second reader needs them: the vector edit overlay nudges the
 * selected ANCHORS with the same keys, and an app where an arrow key moves a
 * layer by one amount and a point by another is a bug the user cannot report.
 */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_SHIFT = 8;

export function nudgeElements(
  elements: DesignElement[],
  selectedIds: Set<string>,
  dx: number,
  dy: number,
  shiftMultiplier = false
): DesignElement[] {
  const step = shiftMultiplier ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  const mx = dx * step;
  const my = dy * step;

  const moveTree = (list: DesignElement[]): DesignElement[] => {
    return list.map((el) => {
      if (selectedIds.has(el.id)) {
        return translateElement(el, mx, my);
      }
      if (isContainer(el) && el.children) {
        return { ...el, children: moveTree(el.children) };
      }
      return el;
    });
  };

  return moveTree(elements);
}

export type ArrowDirection = "left" | "right" | "up" | "down";

export interface AutoLayoutArrowMove {
  elements: DesignElement[];
  moved: boolean;
}

function arrowSlotDelta(parent: ContainerElement, direction: ArrowDirection): number {
  const layout = layoutOf(parent)!;
  const mainIsRow = layout.mode === "grid"
    ? (layout.placement ?? "row") !== "column"
    : layout.direction === "row";
  const alongMain = (direction === "left" || direction === "right") === mainIsRow;
  const forward = direction === "right" || direction === "down";
  if (alongMain) return forward ? 1 : -1;
  if (layout.mode !== "grid") return 0;
  // Masonry has no regular stride — items land in whichever column is shortest —
  // so the only meaningful move is one step along the placement order.
  if (layout.masonry === true) return forward ? 1 : -1;
  // Same derivation `applyGridLayout` uses, so the stride matches the grid the
  // user is actually looking at: `columnsMode: "auto"` derives the count from the
  // width and ignores `columns` entirely.
  const [, pr, , pl] = resolvePadding(layout.padding);
  const columns = gridColumnCount(layout, Math.max(0, parent.width - pl - pr));
  const derivedRows = Math.max(1, Math.ceil((parent.children ?? []).length / columns));
  const span = mainIsRow ? columns : Math.max(layout.rows ?? 1, derivedRows);
  return forward ? span : -span;
}

/**
 * A *direct* child of an auto-layout container owns no position — the stack does
 * — so arrows reorder it instead of nudging (Figma). `null` means the selection
 * is not arranged by a stack and the caller should fall back to nudge; `moved:
 * false` means it was consumed but the stack did not change.
 *
 * The parent lookup stops at the FIRST ancestor, and that is the whole point: a
 * plain frame inside a stack positions its own children, so a layer inside that
 * frame has a position of its own and arrows have to move it. Climbing past the
 * plain frame to the stack above made the arrow reorder the *frame* — the
 * selected layer never moved, and moving it was impossible.
 */
export function reorderInAutoLayout(
  elements: DesignElement[],
  selectedIds: Set<string>,
  direction: ArrowDirection
): AutoLayoutArrowMove | null {
  let parentEl: ContainerElement | null = null;
  const moveIds = new Set<string>();

  for (const id of selectedIds) {
    const parent = findParentById(elements, id);
    if (!parent || !layoutOf(parent)) return null;
    // A child that left the flow is positioned by its own coordinates, so an
    // arrow means "move it", not "walk it through the stack".
    if (findElementById(elements, id)?.position === "absolute") return null;
    if (parentEl && parent.id !== parentEl.id) return null;
    parentEl = parent;
    moveIds.add(id);
  }
  if (!parentEl) return null;

  const delta = arrowSlotDelta(parentEl, direction);
  if (delta === 0) return { elements, moved: false };

  const children = [...(parentEl.children ?? [])];
  const isMoving = (id: string) => moveIds.has(id);
  for (let step = 0; step < Math.abs(delta); step++) {
    if (delta > 0) {
      for (let i = children.length - 2; i >= 0; i--) {
        if (isMoving(children[i].id) && !isMoving(children[i + 1].id)) {
          const swap = children[i];
          children[i] = children[i + 1];
          children[i + 1] = swap;
        }
      }
    } else {
      for (let i = 1; i < children.length; i++) {
        if (isMoving(children[i].id) && !isMoving(children[i - 1].id)) {
          const swap = children[i];
          children[i] = children[i - 1];
          children[i - 1] = swap;
        }
      }
    }
  }

  const signature = (list: DesignElement[]) => list.map((c) => c.id).join("|");
  if (signature(parentEl.children ?? []) === signature(children)) {
    return { elements, moved: false };
  }

  // The reorder can change this frame's hug size, and that has to reach its
  // ancestors — reflowing only the frame the children moved in left every outer
  // box at the size it had before the move (LESSONS #20/#23/#27).
  const reordered = mapElements(elements, (el) =>
    el.id === parentEl!.id ? ({ ...parentEl, children } as DesignElement) : el
  );
  return { elements: relayoutDocumentTree(reordered), moved: true };
}

export function reorderZIndex(
  elements: DesignElement[],
  selectedIds: Set<string>,
  action: "front" | "back" | "forward" | "backward"
): DesignElement[] {
  const reorderSiblings = (list: DesignElement[]): DesignElement[] => {
    const selected = list.filter((el) => selectedIds.has(el.id));
    let reordered = list;

    if (selected.length > 0) {
      if (action === "front") {
        reordered = [...list.filter((el) => !selectedIds.has(el.id)), ...selected];
      } else if (action === "back") {
        reordered = [...selected, ...list.filter((el) => !selectedIds.has(el.id))];
      } else {
        const copy = [...list];
        if (action === "forward") {
          for (let i = copy.length - 2; i >= 0; i--) {
            if (selectedIds.has(copy[i].id) && !selectedIds.has(copy[i + 1].id)) {
              [copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
            }
          }
        } else {
          for (let i = 1; i < copy.length; i++) {
            if (selectedIds.has(copy[i].id) && !selectedIds.has(copy[i - 1].id)) {
              [copy[i], copy[i - 1]] = [copy[i - 1], copy[i]];
            }
          }
        }
        reordered = copy;
      }
    }

    const sameOrder = reordered.length === list.length && reordered.every((el, i) => el === list[i]);
    if (sameOrder) reordered = list;
    let changed = reordered !== list;
    const withChildren = reordered.map((el) => {
      if (!isContainer(el) || !el.children) return el;
      const nextChildren = reorderSiblings(el.children);
      if (nextChildren === el.children) return el;
      changed = true;
      return { ...el, children: nextChildren };
    });
    return changed ? withChildren : list;
  };

  return reorderSiblings(elements);
}
