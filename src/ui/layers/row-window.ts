import type { DesignElement } from "../../core/dsl/types";
import { collectDescendantIds, findElementById } from "../../core/geometry/tree-ops";
import { orderRowsForPanel, RowOrder } from "./row-order";

/**
 * The layer list's geometry, as one number per constant, because windowing has to
 * know a collapsed subtree's height without rendering it.
 *
 * All four are the panel's own CSS restated: `py-1.5` around a 14px control is the
 * 26px row `DESIGN.md` specifies, the list container's `space-y-1` is 4px, a
 * subtree container's `space-y-0.5` is 2px, and its `mt-0.5` is 2px. Change one
 * and the spacers stop lining up with the rows they replace — the scrollbar stops
 * matching the list.
 */
export const LAYER_ROW_HEIGHT = 26;
export const LAYER_ROW_GAP_ROOT = 4;
export const LAYER_ROW_GAP_NESTED = 2;
export const LAYER_SUBTREE_MARGIN = 2;
/** The list container's `p-2`. Folded into every row's `top` so it lines up with `scrollTop`. */
export const LAYER_LIST_PADDING = 8;

export interface PlannedRow {
  el: DesignElement;
  depth: number;
  order: RowOrder;
  /** This row's own box, in scroll-content coordinates. */
  top: number;
  /** The row PLUS everything expanded under it, gaps included. */
  blockHeight: number;
  /** Expanded descendants, in paint order. Empty when the row is collapsed. */
  children: PlannedRow[];
}

export interface RowPlan {
  /** Top-level rows in paint order. */
  roots: PlannedRow[];
  byId: Map<string, PlannedRow>;
  /** Full scrollable height, container padding included. */
  contentHeight: number;
}

export interface PlanOptions {
  /** A row hidden by this set contributes no height. */
  collapsedIds: ReadonlySet<string>;
  rowsOf: (el: DesignElement) => DesignElement[];
  rowOrderOf: (parent: DesignElement) => RowOrder;
}

/**
 * The list the panel is about to paint, laid out in pixels.
 *
 * The traversal mirrors the paint exactly — depth-first, skipping collapsed
 * subtrees, ordering siblings by the same rule the rows use — because the heights
 * are only right if the order is. A divergence here does not look wrong, it just
 * makes the scrollbar lie about how far down the list goes.
 *
 * No selection input: where the selection sits is a property of the ROW, and the
 * panel derives it from the selection itself. Taking it here re-laid out all
 * 1,841 rows every time the user clicked a different layer.
 */
export function planRows(elements: DesignElement[], options: PlanOptions): RowPlan {
  const { collapsedIds, rowsOf, rowOrderOf } = options;
  const byId = new Map<string, PlannedRow>();

  const build = (list: DesignElement[], depth: number, order: RowOrder, top: number): PlannedRow[] => {
    const out: PlannedRow[] = [];
    let y = top;
    const gap = depth === 0 ? LAYER_ROW_GAP_ROOT : LAYER_ROW_GAP_NESTED;

    for (const el of orderRowsForPanel(list, order)) {
      const row: PlannedRow = {
        el,
        depth,
        order,
        top: y,
        blockHeight: LAYER_ROW_HEIGHT,
        children: []
      };

      if (!collapsedIds.has(el.id)) {
        const kids = rowsOf(el);
        if (kids.length > 0) {
          const childTop = y + LAYER_ROW_HEIGHT + LAYER_SUBTREE_MARGIN;
          row.children = build(kids, depth + 1, rowOrderOf(el), childTop);
          row.blockHeight =
            LAYER_ROW_HEIGHT +
            LAYER_SUBTREE_MARGIN +
            row.children.reduce((sum, c) => sum + c.blockHeight, 0) +
            LAYER_ROW_GAP_NESTED * (row.children.length - 1);
        }
      }

      byId.set(el.id, row);
      out.push(row);
      y += row.blockHeight + gap;
    }
    return out;
  };

  // The page root has no parent, so it is always front-first — the same reversal
  // the panel applies to `elements` before painting them.
  const roots = build(elements, 0, "z", LAYER_LIST_PADDING);
  const contentHeight =
    LAYER_LIST_PADDING * 2 +
    roots.reduce((sum, r) => sum + r.blockHeight, 0) +
    LAYER_ROW_GAP_ROOT * Math.max(0, roots.length - 1);

  return { roots, byId, contentHeight };
}

/** The scroll band a row has to touch to be worth rendering, overscan included. */
export interface RowWindow {
  start: number;
  end: number;
}

/**
 * Rows this many places above and below the viewport are rendered anyway, so a
 * flick of the wheel does not reveal bare space for a frame.
 */
export const LAYER_OVERSCAN_ROWS = 8;

export function visibleRowWindow(scrollTop: number, viewportHeight: number, overscanRows = LAYER_OVERSCAN_ROWS): RowWindow {
  const pad = overscanRows * LAYER_ROW_HEIGHT;
  return { start: scrollTop - pad, end: scrollTop + viewportHeight + pad };
}

export function rowIsVisible(row: PlannedRow, window: RowWindow): boolean {
  return row.top < window.end && row.top + row.blockHeight > window.start;
}

/**
 * Height of `rows[from..to]` standing in for that run as ONE element.
 *
 * The `n - 1` gaps are the point: `space-y-*` puts a margin between siblings, so a
 * run of `n` rows replaced by one spacer owes exactly the gaps it swallowed.
 */
export function collapsedRunHeight(rows: PlannedRow[], from: number, to: number, gap: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += rows[i].blockHeight;
  return sum + gap * (to - from - 1);
}

/**
 * Every row that sits UNDER a selected one — the subtree wash, not the selected
 * row itself.
 *
 * It is a property of the selection rather than of the row geometry, which is why
 * `planRows` does not take it: folding it into the plan meant re-laying out all
 * 1,841 rows whenever the user clicked a different layer. Walking the selected
 * subtrees costs O(selection), and the panel looks the answer up per rendered
 * row — of which there are ~30.
 */
export function selectedSubtreeIds(
  elements: DesignElement[],
  selectedIds: ReadonlySet<string>
): Set<string> {
  const out = new Set<string>();
  for (const id of selectedIds) {
    const el = findElementById(elements, id);
    if (!el) continue;
    for (const childId of collectDescendantIds(el)) out.add(childId);
  }
  return out;
}
