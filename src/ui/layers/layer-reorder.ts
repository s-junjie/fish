import type { ContainerElement, DesignElement } from "../../core/dsl/types";
import type { RowOrder } from "./row-order";
import {
  computeParentOrigin,
  findElementById,
  findParentById,
  moveElementsInTree,
  preserveCanvasPositionsAfterReparent,
  reconcileSizingAfterReparent,
  ReparentRefusal,
  reparentRefusal
} from "../../core/geometry/tree-ops";
import { relayoutDocumentTree } from "../../core/compile";

export type LayerDropPosition = "before" | "after" | "inside";
export type LayerDropSlot = "above" | "below" | "inside";

/**
 * The drag payload's own MIME type. `text/plain` carries the pressed row alone,
 * which is what an external drop can read; this one carries the whole block, and
 * is what this panel reads back.
 */
export const LAYER_DRAG_MIME = "application/x-fish-layers";

export function arrayDropPosition(slot: LayerDropSlot, order: RowOrder): LayerDropPosition {
  if (slot === "inside") return "inside";
  const above = slot === "above";
  return (above && order === "z") || (!above && order === "flow") ? "after" : "before";
}

/**
 * The rows one press carries: the selection when the pressed row is part of one,
 * otherwise that row alone. A press on an unselected row must not drag the rest
 * of the selection along — the canvas answers the same way.
 */
export function layerDragBlock(selectedIds: Set<string>, pressedId: string): string[] {
  return selectedIds.has(pressedId) && selectedIds.size > 1 ? [...selectedIds] : [pressedId];
}

/** The block a drop carries, read back off the drag payload. */
export function readLayerDragIds(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return [];
  const packed = dataTransfer.getData(LAYER_DRAG_MIME);
  if (packed) {
    try {
      const ids: unknown = JSON.parse(packed);
      if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === "string");
    } catch {
      /* Not our payload — fall through to the plain one. */
    }
  }
  const single = dataTransfer.getData("text/plain");
  return single ? [single] : [];
}

/**
 * The rows a drop really moves.
 *
 * A selection can name a frame and one of its own children; the frame already
 * carries the child, so moving both would put the child in the tree twice. The
 * outermost rows are the move, exactly as they are on the canvas.
 */
function outermostSources(elements: DesignElement[], sourceIds: string[]): string[] {
  const wanted = new Set(sourceIds);
  return sourceIds.filter((id) => {
    // An id that is not in this tree is not a row: a drop from outside the panel
    // carries whatever `text/plain` held, and a block is a list of real rows.
    if (!wanted.has(id) || !findElementById(elements, id)) return false;
    let parent = findParentById(elements, id);
    while (parent) {
      if (wanted.has(parent.id)) return false;
      parent = findParentById(elements, parent.id);
    }
    return true;
  });
}

/**
 * Why a layer-tree drop did nothing. The tree's own refusals come from
 * `reparentRefusal`; `locked-target` is decided here because it is about the
 * panel's row, not about the document's structure.
 */
export type LayerDropRefusal = "locked-target" | ReparentRefusal;

/**
 * The layer tree's drop, minus the document plumbing: the caller supplies the
 * element list and commits what comes back.
 *
 * `sourceIds` is a block because a multi-selection reorders as one: the canvas
 * answers the same way, and a drop that moved only the pressed row would leave
 * the rest of the selection behind in an order the user never asked for.
 *
 * Both refusals live here rather than in the panel's handler so the row highlight
 * and the resulting tree cannot drift apart — a highlight that promises a drop
 * the tree will not make is the same lie as a drag handle that does nothing.
 * The caller only turns a refusal into wording.
 */
export function applyLayerDrop(
  elements: DesignElement[],
  sourceIds: string[],
  targetId: string,
  position: LayerDropPosition
): { elements: DesignElement[] } | { refused: LayerDropRefusal } {
  // Reparenting into a locked frame would put an unlocked child inside a locked
  // subtree — a state the lock model has no meaning for. Reordering *next to* a
  // locked row stays allowed: it does not touch that row.
  if (position === "inside" && findElementById(elements, targetId)?.locked) {
    return { refused: "locked-target" };
  }

  const block = outermostSources(elements, sourceIds);
  if (block.length === 0) return { elements };

  // `moveElementsInTree` refuses structural nonsense silently (it cannot report),
  // so the decision is taken here. `before`/`after` join the TARGET'S PARENT,
  // which is just as much "inside the master" as dropping on the master itself.
  const landingParentId = position === "inside" ? targetId : findParentById(elements, targetId)?.id ?? null;
  for (const id of block) {
    const refusal = reparentRefusal(elements, id, landingParentId);
    if (refusal) return { refused: refusal };
  }

  // Read before the move: which container each row left decides what the stored
  // `sizing` default now means (`reconcileSizingAfterReparent`), and where its
  // `x` / `y` were anchored (`preserveCanvasPositionsAfterReparent`).
  const previousParents = new Map<string, ContainerElement | null>(
    block.map((id) => [id, findParentById(elements, id)])
  );
  const originsBefore = new Map<string, { x: number; y: number }>(
    block.map((id) => [id, computeParentOrigin(elements, id)])
  );

  // The layer tree orders children; auto-layout owns their geometry. Without the
  // reflow the stack keeps the old slots and shows the old order until some
  // unrelated edit happens to relayout. The move itself is preserved:
  // `relayoutDocumentTree` never re-sorts `children`.
  let moved = moveElementsInTree(elements, block, targetId, position);
  moved = preserveCanvasPositionsAfterReparent(moved, originsBefore);
  for (const [id, previousParent] of previousParents) {
    moved = reconcileSizingAfterReparent(moved, id, previousParent);
  }
  return { elements: relayoutDocumentTree(moved) };
}
