import { ContainerElement, DesignElement } from "../dsl/types";
import { elementAABB, elementRotatedAABB, paintedSubtreeBounds } from "./element-bounds";
import { Rect, transformBoundsToAABB } from "./bounds";
import { identityMatrix, invert, multiply, transformPoint, translation, type Matrix2D } from "./matrix";
import { elementPivot, elementTransformMatrix } from "./transforms";
import { collectDescendantIds, findElementById, findParentById, isContainer } from "./tree-query";
import { insertElementIntoContainer, removeElementFromTree } from "./tree-edit";
import { reconcileSizingAfterReparent, reparentRefusal, type ReparentRefusal } from "./tree-reparent";
import { computeParentOrigin } from "./tree-coords";

/**
 * Returns the canvas-absolute AABB of an element given its parent's canvas origin.
 * For top-level elements, parentOriginX/Y = 0.
 */
export function elementWorldAABB(
  el: DesignElement,
  parentOriginX: number,
  parentOriginY: number
): Rect {
  const local = elementAABB(el);
  return {
    x: local.x + parentOriginX,
    y: local.y + parentOriginY,
    width: local.width,
    height: local.height
  };
}

/**
 * Whether the point can possibly hit anything in `el`'s subtree.
 *
 * Every hit test used to carry the point back into every element's own space —
 * an inverse matrix per node, per mousemove, over the whole page. The painted
 * subtree box is the one question that can be answered outside the subtree, and
 * a miss in it is a miss everywhere inside. Half a pixel of slack, the same
 * tolerance the box test itself uses.
 */
function reaches(worldM: Matrix2D, el: DesignElement, x: number, y: number): boolean {
  const box = transformBoundsToAABB(paintedSubtreeBounds(el), worldM);
  if (!box) return true;
  const eps = 0.5;
  return (
    x >= box.x - eps &&
    x <= box.x + box.width + eps &&
    y >= box.y - eps &&
    y <= box.y + box.height + eps
  );
}

export function findFrameAtPoint(
  elements: DesignElement[],
  x: number,
  y: number,
  excludeIds?: string | string[]
): ContainerElement | null {
  // An excluded id takes its whole subtree with it, which is what makes one
  // entry enough to hide a container the drop may not land in.
  const excluded = new Set<string>();
  const roots = excludeIds === undefined ? [] : Array.isArray(excludeIds) ? excludeIds : [excludeIds];
  for (const id of roots) {
    if (!id) continue;
    excluded.add(id);
    const target = findElementById(elements, id);
    if (target) {
      for (const descendantId of collectDescendantIds(target)) {
        excluded.add(descendantId);
      }
    }
  }

  // The chain the renderer draws with, so a frame inside a TURNED ancestor is
  // asked whether the point is in the frame where it actually paints. The old
  // walk carried only `originX/Y`, so it turned back the frame's own rotation
  // around a centre that a turned ancestor had already carried somewhere else,
  // and a drop landed in the wrong frame — or in none.
  function search(list: DesignElement[], parentM: Matrix2D): ContainerElement | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (excluded.has(el.id)) continue;
      if (el.visible === false || el.locked) continue;
      if (isContainer(el)) {
        const pivot = elementPivot(el);
        const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
        if (!reaches(worldM, el, x, y)) continue;
        // Children are emitted inside `translate(x, y)`.
        const childMatch = search(el.children || [], multiply(worldM, translation(el.x, el.y)));
        if (childMatch) return childMatch;

        // The point, carried back through everything this frame inherits AND its
        // own turn, lands in the frame's own box — which is the question the drop
        // is really asking, and which needs the whole chain to answer.
        const local = invert(worldM);
        if (!local) continue;
        const p = transformPoint(local, { x, y });
        const b = elementAABB(el);
        if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) {
          return el;
        }
      }
    }
    return null;
  }

  return search(elements, identityMatrix());
}

/**
 * Parent container for a frame being drawn over the canvas. Decided by the new
 * frame's box, not its center: the innermost existing frame whose box fully
 * contains the new frame. A frame that the new frame *encloses* is not a
 * container of the new frame (its box is inside the new box, so it can never
 * contain it), which is exactly what keeps an enclosing drag from nesting the
 * new frame *inside* the very frame it should swallow.
 */
export function findParentFrameForBox(
  elements: DesignElement[],
  box: Rect
): ContainerElement | null {
  let best: ContainerElement | null = null;
  let bestArea = Infinity;

  const walk = (list: DesignElement[], parentM: Matrix2D) => {
    for (const el of list) {
      if (isContainer(el) && el.visible !== false && !el.locked) {
        const pivot = elementPivot(el);
        const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
        // The frame's box where it PAINTS, which for a turned frame (or one under
        // a turned ancestor) is not the stored box shifted by an offset: the
        // containment test then ran against a rectangle the frame does not occupy,
        // and a new frame drawn over it was refused — or accepted — wrongly.
        const own = transformBoundsToAABB(elementAABB(el), worldM)!;
        const contains =
          own.x <= box.x &&
          own.y <= box.y &&
          own.x + own.width >= box.x + box.width &&
          own.y + own.height >= box.y + box.height;
        if (contains) {
          const area = el.width * el.height;
          if (area < bestArea) {
            best = el;
            bestArea = area;
          }
          walk(el.children || [], multiply(worldM, translation(el.x, el.y)));
        }
      }
    }
  };
  walk(elements, identityMatrix());
  return best;
}

export function reparentOnCanvasDrop(
  elements: DesignElement[],
  draggedId: string
): {
  elements: DesignElement[];
  reparented: boolean;
  refused: ReparentRefusal | null;
  affectedFrameIds: string[];
} {
  const dragged = findElementById(elements, draggedId);
  if (!dragged) return { elements, reparented: false, refused: null, affectedFrameIds: [] };

  const currentParent = findParentById(elements, draggedId);
  const currentParentOrigin = currentParent
    ? computeParentOrigin(elements, currentParent.id)
    : { x: 0, y: 0 };

  // Canvas-absolute position of the dragged element
  const draggedOriginX = currentParentOrigin.x + (currentParent?.x ?? 0);
  const draggedOriginY = currentParentOrigin.y + (currentParent?.y ?? 0);
  const draggedBox = elementRotatedAABB({
    ...dragged,
    x: dragged.x + draggedOriginX,
    y: dragged.y + draggedOriginY
  });
  const cx = draggedBox.x + draggedBox.width / 2;
  const cy = draggedBox.y + draggedBox.height / 2;
  const targetFrame = findFrameAtPoint(elements, cx, cy, draggedId);

  const affectedFrameIds: string[] = [];

  // The drag preview skips the instance's own master, so it never lights up as a
  // drop target. The refusal has to hold anyway (the preview is not always
  // tracked), and it must NOT decay into the "no frame under the pointer" branch
  // below — dropping on the master leaves the element exactly where it is.
  const refusal = targetFrame ? reparentRefusal(elements, draggedId, targetFrame.id) : null;
  if (refusal) {
    return { elements, reparented: false, refused: refusal, affectedFrameIds: [] };
  }

  if (targetFrame && targetFrame.id !== currentParent?.id) {
    // Convert dragged element's local coords to the new parent's local space.
    const targetOrigin = computeParentOrigin(elements, targetFrame.id);
    const targetAbsX = targetOrigin.x + targetFrame.x;
    const targetAbsY = targetOrigin.y + targetFrame.y;

    // Current canvas-absolute position of dragged element
    const absDragX = dragged.x + draggedOriginX;
    const absDragY = dragged.y + draggedOriginY;

    // Local coords within new parent
    const newLocalX = absDragX - targetAbsX;
    const newLocalY = absDragY - targetAbsY;

    const adjustedDragged: DesignElement = { ...dragged, x: newLocalX, y: newLocalY };
    const [withoutEl] = removeElementFromTree(elements, draggedId);
    // The parent it just gained decides what an undeclared `sizing` axis means, and
    // the stored default was written for the parent it just left.
    const nextElements = reconcileSizingAfterReparent(
      insertElementIntoContainer(withoutEl, adjustedDragged, targetFrame.id),
      draggedId,
      currentParent
    );

    affectedFrameIds.push(targetFrame.id);
    if (currentParent) affectedFrameIds.push(currentParent.id);
    return { elements: nextElements, reparented: true, refused: null, affectedFrameIds };
  }

  if (!targetFrame && currentParent) {
    // Moving to root: convert from local → canvas-absolute
    const [withoutEl, extractedEl] = removeElementFromTree(elements, draggedId);
    if (!extractedEl) return { elements, reparented: false, refused: null, affectedFrameIds: [] };

    const parentAbsX = currentParentOrigin.x + currentParent.x;
    const parentAbsY = currentParentOrigin.y + currentParent.y;
    const absEl: DesignElement = {
      ...extractedEl,
      x: extractedEl.x + parentAbsX,
      y: extractedEl.y + parentAbsY
    };
    // Out of the flow entirely: the wrap width it had was the container's.
    const nextElements = reconcileSizingAfterReparent([...withoutEl, absEl], draggedId, currentParent);
    affectedFrameIds.push(currentParent.id);
    return { elements: nextElements, reparented: true, refused: null, affectedFrameIds };
  }

  return { elements, reparented: false, refused: null, affectedFrameIds: [] };
}

/**
 * Finds the topmost element under the given (x, y) canvas coordinates.
 *
 * Locked layers are skipped by default because most callers ask "what would the
 * user be acting on" — the hover preview is the exception, and passes
 * `includeLocked` so it can see that a lock is what is on top: a locked layer
 * swallows the press, so previewing the layer *behind* it would promise a
 * selection the click will never make.
 *
 * An excluded id takes its whole subtree with it: the Alt read-out excludes the
 * selection so the pointer reads what lies BENEATH it, and a selected frame's
 * children are part of that selection, not something behind it.
 */
export function findElementAtPoint(
  elements: DesignElement[],
  x: number,
  y: number,
  opts: { excludeId?: string; excludeIds?: ReadonlySet<string>; includeLocked?: boolean } = {}
): DesignElement | null {
  const { excludeId, excludeIds, includeLocked = false } = opts;
  // The walk carries the same matrix the renderer draws with, and a node is hit
  // when the point — carried back through that matrix — lands in its OWN box.
  // Testing the canvas point against a canvas-space AABB cannot express this: a
  // turned layer's painted region is not axis-aligned, and a layer inside a
  // turned frame is not at the offset its `x`/`y` suggest, so both were missed
  // and the hover/Alt read-out named whatever happened to be under the corner of
  // the box the user was pointing at.
  function search(list: DesignElement[], parentM: Matrix2D): DesignElement | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (el.id === excludeId || excludeIds?.has(el.id)) continue;
      if (el.visible === false || (el.locked && !includeLocked)) continue;
      const pivot = elementPivot(el);
      const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
      if (!reaches(worldM, el, x, y)) continue;
      if (isContainer(el) && el.children && el.children.length > 0) {
        const childMatch = search(el.children, multiply(worldM, translation(el.x, el.y)));
        if (childMatch) return childMatch;
      }
      const local = invert(worldM);
      // A degenerate chain cannot be turned back — no local point is "the" point —
      // so the node cannot claim the hit.
      if (!local) continue;
      const p = transformPoint(local, { x, y });
      const b = elementAABB(el);
      // Half a pixel of slack, so a pointer exactly on an edge is the layer's and
      // not the canvas's. Matches what the DOM's own hit area gives the user.
      const eps = 0.5;
      if (p.x >= b.x - eps && p.x <= b.x + b.width + eps && p.y >= b.y - eps && p.y <= b.y + b.height + eps) {
        return el;
      }
    }
    return null;
  }
  return search(elements, identityMatrix());
}

export function dissolveFrame(
  elements: DesignElement[],
  frameId: string
): { elements: DesignElement[]; releasedIds: string[] } {
  let releasedIds: string[] = [];

  // Walk to find the parent's canvas-absolute origin so we can convert
  // the frame's children from local → absolute when releasing to root.
  const walk = (list: DesignElement[], originX: number, originY: number): DesignElement[] => {
    const out: DesignElement[] = [];
    for (const el of list) {
      if (el.id === frameId && isContainer(el)) {
        const children = el.children || [];
        releasedIds = children.map((c) => c.id);
        // Frame's canvas origin = parent origin + frame's local x/y
        const frameAbsX = originX + el.x;
        const frameAbsY = originY + el.y;
        // Convert each child from frame-local → canvas-absolute
        const released = children.map((child) => ({
          ...child,
          x: child.x + frameAbsX,
          y: child.y + frameAbsY
        }));
        out.push(...released);
      } else if (isContainer(el) && el.children) {
        const absX = originX + el.x;
        const absY = originY + el.y;
        out.push({
          ...el,
          children: walk(el.children, absX, absY)
        });
      } else {
        out.push(el);
      }
    }
    return out;
  };

  return { elements: walk(elements, 0, 0), releasedIds };
}
