import type { DesignElement } from "../../core/dsl/types";
import { childrenOf } from "../../core/geometry/tree-ops";
import { orderRowsForPanel, RowOrder } from "./row-order";

/** Rows under an element — the panel's resolver, so both walk the same tree. */
export type RowChildren = (el: DesignElement) => DesignElement[];

/** How a parent orders its own rows — the panel's, so both read the same rule. */
export type RowOrderOf = (parent: DesignElement) => RowOrder;

/**
 * Row ids in the order the layer panel paints them: depth-first, minus every
 * subtree a collapsed frame hides. Shift-range walks this list, so it must mirror
 * the panel's traversal exactly — a divergence silently selects the wrong span.
 * `rowsOf` is how it stays in step for instances, whose rows are resolved rather
 * than stored (`ui/layers/instance-rows.ts`), and `rowOrderOf` is how it stays in
 * step for a stack, whose children are listed first-child-first while a free
 * frame's are listed front-first (`ui/layers/row-order.ts`).
 */
export function visibleLayerRowIds(
  elements: DesignElement[],
  collapsedIds: ReadonlySet<string>,
  rowsOf: RowChildren = childrenOf,
  rowOrderOf: RowOrderOf = () => "z"
): string[] {
  const out: string[] = [];
  const walk = (list: DesignElement[], order: RowOrder) => {
    for (const el of orderRowsForPanel(list, order)) {
      out.push(el.id);
      if (collapsedIds.has(el.id)) continue;
      const children = rowsOf(el);
      if (children.length > 0) walk(children, rowOrderOf(el));
    }
  };
  // The page root has no parent, so it is always front-first — same reversal the
  // panel applies to `elements` before it paints them.
  walk(elements, "z");
  return out;
}

/**
 * The contiguous span between the anchor row and the clicked row, inclusive, in
 * paint order. Returns `null` when there is no usable anchor — no shift-click has
 * happened yet, the anchor was hidden by a collapse, or the selection was changed
 * elsewhere (canvas marquee, shortcut) so the anchor is no longer selected. The
 * caller must then fall back to a plain select rather than guess a span.
 */
export function layerRangeSelection(
  rowIds: string[],
  anchorId: string | null,
  targetId: string,
  selectedIds: ReadonlySet<string>
): Set<string> | null {
  if (!anchorId || !selectedIds.has(anchorId)) return null;
  const from = rowIds.indexOf(anchorId);
  const to = rowIds.indexOf(targetId);
  if (from === -1 || to === -1) return null;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return new Set(rowIds.slice(lo, hi + 1));
}
