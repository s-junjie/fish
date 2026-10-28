import { DesignElement } from "../../core/dsl/types";
import { SmartSelectionInfo } from "../../core/geometry/smart-selection";
import { applyAutoLayout } from "../../core/compile";
import { placeChildAt } from "../../core/geometry/element-bounds";

/**
 * Re-place an element at an absolute position, cascading the offset into its
 * descendants. Reorder/gap previews move direct children only, so a nested
 * frame's own children would otherwise stay behind and drift out of it.
 *
 * The no-op case needs no test here: `placeChildAt` returns the same reference
 * for an unchanged box, and a preview that reallocates a node it did not move
 * would defeat every memo keyed on element identity.
 */
export function placeAt(el: DesignElement, x: number, y: number): DesignElement {
  return placeChildAt(el, x, y, el.width, el.height);
}

/**
 * Where EVERY element of the row comes to rest, in the same stored coordinates the
 * settle will write.
 *
 * One function, called by the live preview AND by the settle — for the dragged
 * element's dashed box and for the elements that move because of it. The dropped
 * object was only half the disagreement: the preview slid the passive elements to
 * the dragged one's ORIGINAL slot while the settle re-flowed the row, so they
 * moved on screen one way and landed another. A preview that describes only its own
 * element is not a preview of the move.
 *
 * Per path, because each one answers differently:
 *
 *  - a 1D row / column re-flows by its gap sequence (`reflowRow`);
 *  - a 2D grid swaps the two cells onto each other's slot — every other cell is
 *    already on its column and row, so it does not appear in the plan;
 *  - an auto-layout frame asks the layout engine, because its child positions come
 *    out of padding, gap and the other children's sizes and no stored slot is the
 *    answer. That plan covers the whole stack, which is also what makes the
 *    between-slots shift correct rather than a one-slot-at-a-time guess.
 *
 * Elements the plan does not mention have not moved, and the caller leaves them
 * where they are.
 */
export function landingPlan(
  info: SmartSelectionInfo,
  sorted: DesignElement[],
  origins: Map<string, { x: number; y: number }>,
  source: DesignElement,
  targetIndex: number | null,
  targetPos: { x: number; y: number } | undefined
): Map<string, { x: number; y: number }> | null {
  if (!targetPos) return null;

  if (info.parentFrame) {
    if (targetIndex === null) return null;
    const frame = info.parentFrame;
    const children = [...(frame.children ?? [])];
    const from = children.findIndex((c) => c.id === source.id);
    if (from === -1 || targetIndex < 0 || targetIndex >= children.length) return null;
    const [moved] = children.splice(from, 1);
    children.splice(targetIndex, 0, moved);
    const laid = applyAutoLayout({ ...frame, children });
    const plan = new Map<string, { x: number; y: number }>();
    for (const child of laid.children ?? []) plan.set(child.id, { x: child.x, y: child.y });
    return plan;
  }

  if (info.axis === "grid") {
    const here = origins.get(source.id);
    if (!here) return null;
    return new Map([
      [source.id, { x: targetPos.x, y: targetPos.y }],
      [targetPos === here ? source.id : findIdAt(origins, targetPos), { x: here.x, y: here.y }]
    ]);
  }

  if (targetIndex === null) return null;
  const order = [...sorted];
  const from = order.findIndex((el) => el.id === source.id);
  if (from === -1 || from === targetIndex) return null;
  const [moved] = order.splice(from, 1);
  order.splice(targetIndex, 0, moved);
  return reflowRow(order, sorted, origins, info.axis);
}

/** The id whose origin is exactly `pos` — the grid's counterpart element. */
function findIdAt(origins: Map<string, { x: number; y: number }>, pos: { x: number; y: number }): string {
  for (const [id, p] of origins) if (p.x === pos.x && p.y === pos.y) return id;
  return "";
}

/**
 * Where each element of a REORDERED row goes, so the row keeps the gaps it had.
 *
 * `order` is the new order and `sorted` the one the row started in; `origins` are
 * the pre-gesture positions. The n−1 gaps are read from the original order and
 * applied, in that order, to the new one — the row keeps the same spacing between
 * its elements, which is the whole promise of the control that started this: the
 * gap pills are the reason the reorder dots are worth reaching for, and a swap
 * that changed the gaps would take them away.
 *
 * Per-pair gaps could not survive a rotation (the pair now in slots 1 and 2 was
 * never adjacent), so it is the gap SEQUENCE that is preserved, not the pairing.
 *
 * The head holds the row's original leading edge — a reorder does not slide the
 * whole row sideways — and the cross axis is left exactly where each element
 * already is: a column's top edges are slots, its left edges are not.
 */
function reflowRow(
  order: DesignElement[],
  sorted: DesignElement[],
  origins: Map<string, { x: number; y: number }>,
  axis: "x" | "y"
): Map<string, { x: number; y: number }> {
  const sizeOf = (el: DesignElement) => (axis === "x" ? el.width : el.height);
  const leadOf = (p: { x: number; y: number }) => (axis === "x" ? p.x : p.y);
  const at = (el: DesignElement) => {
    const p = origins.get(el.id);
    return p ? leadOf(p) : (axis === "x" ? el.x : el.y);
  };

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(at(sorted[i]) - (at(sorted[i - 1]) + sizeOf(sorted[i - 1])));
  }

  const placed = new Map<string, { x: number; y: number }>();
  let cursor = at(sorted[0]);
  for (let i = 0; i < order.length; i++) {
    if (i > 0) cursor += sizeOf(order[i - 1]) + (gaps[i - 1] ?? 0);
    const base = origins.get(order[i].id) ?? { x: order[i].x, y: order[i].y };
    placed.set(
      order[i].id,
      axis === "x" ? { x: Math.round(cursor), y: base.y } : { x: base.x, y: Math.round(cursor) }
    );
  }
  return placed;
}
