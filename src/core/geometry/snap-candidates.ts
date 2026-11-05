import type { DesignElement } from "../dsl/types";
import { findParentById, isContainer } from "./tree-query";
import { elementWorldAABB } from "./tree-hit";
import { isElementInViewport, type ViewportBox } from "./cull";

/**
 * The elements a drag may snap to, in world coordinates.
 *
 * Rebuilt per drag frame on purpose: the dragged element moves, so the page
 * array is new and the origin/bounds caches keyed on it miss — and a sibling can
 * genuinely move under an auto-layout parent, so a list captured at drag start
 * would snap to boxes that are no longer there.
 *
 * The walk is scoped the way a move is meant to align: the moved roots'
 * siblings, the containers above them, and the page's top level. Descending
 * into unrelated frames used to pull deep icon paths into the candidate set,
 * and — worse — a dragged container's own children stayed candidates, so a
 * frame snapped to where its children stood when the gesture began. A subtree
 * is pruned as soon as it is dragged, excluded, or hidden.
 *
 * What it does not do is copy each candidate. The walk this replaced spread the
 * whole element — its children, fills, effects — to attach a box that
 * `calculateSnapping` reads through `elementAABB`, which needs seven fields;
 * that copy was most of the 0.5 ms a frame. `type` / `dx` / `dy` ride along so a
 * line still answers through its own geometry, exactly as before.
 */
export function snapCandidates(
  page: DesignElement[],
  draggedIds: ReadonlySet<string>,
  excludedIds: ReadonlySet<string>,
  viewport: ViewportBox | null
): DesignElement[] {
  const out: DesignElement[] = [];

  const allowedParents = new Set<string>();
  for (const id of draggedIds) {
    let parent = findParentById(page, id);
    while (parent) {
      allowedParents.add(parent.id);
      parent = findParentById(page, parent.id);
    }
  }

  const walk = (list: DesignElement[], parentId: string | null, ox: number, oy: number) => {
    if (parentId !== null && !allowedParents.has(parentId)) return;
    for (const el of list) {
      if (el.visible === false) continue;
      if (draggedIds.has(el.id) || excludedIds.has(el.id)) continue;
      const box = elementWorldAABB(el, ox, oy);
      if (viewport && !isElementInViewport(box, viewport)) continue;
      const line = el as DesignElement & { dx?: number; dy?: number };
      out.push({
        id: el.id,
        type: el.type,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        dx: line.dx,
        dy: line.dy
      } as unknown as DesignElement);
      if (isContainer(el)) walk(el.children || [], el.id, ox + el.x, oy + el.y);
    }
  };

  walk(page, null, 0, 0);
  return out;
}
