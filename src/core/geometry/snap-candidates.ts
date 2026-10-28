import type { DesignElement } from "../dsl/types";
import { flattenElements } from "./tree-ops";
import { computeParentOrigin } from "./tree-coords";
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
  for (const el of flattenElements(page)) {
    if (draggedIds.has(el.id) || excludedIds.has(el.id)) continue;
    const origin = computeParentOrigin(page, el.id);
    const box = elementWorldAABB(el, origin.x, origin.y);
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
  }
  return out;
}
