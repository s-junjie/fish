import type { DesignDocument, DesignElement, InstanceElement } from "../../core/dsl/types";
import { isContainer } from "../../core/geometry/tree-ops";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { layoutOf } from "../../core/dsl/layout-flat";

/**
 * Which end of a sibling list the layer panel puts first.
 *
 * - `"z"` — front first. The last child paints on top, so the last child is the
 *   top row. This is the default and it is what a free frame and the page root
 *   both want: the list reads exactly like the stacking.
 * - `"flow"` — first child first. An auto-layout parent places `children[0]` at
 *   the start of the stack, so a list ordered front-first would read backwards
 *   against the canvas for a vertical stack and sideways for a horizontal one.
 *   Figma makes the same split, and pins it down from the other end: toggling
 *   First/Last on top changes the canvas stacking and leaves the layer order
 *   alone, which is only consistent if the panel was reading the flow.
 */
export type RowOrder = "z" | "flow";

/**
 * The order the rows under `parent` are listed in. The page root has no parent
 * and is always `"z"`.
 *
 * An instance stores no `layout` of its own, so its rows are ordered by the
 * MASTER's — the same reason `layerRowsOf` resolves them from the master, and
 * the same reason it has to ask: the canvas places an instance's children with
 * the master's recipe, so a panel that answered from the instance would disagree
 * with what it is listing.
 */
export function rowOrderOf(doc: DesignDocument | null | undefined, parent: DesignElement | null): RowOrder {
  if (!parent) return "z";
  if (isContainer(parent)) return layoutOf(parent) ? "flow" : "z";
  if (parent.type === "instance" && doc) {
    const master = findMasterComponent(doc, (parent as InstanceElement).componentId);
    return master && layoutOf(master) ? "flow" : "z";
  }
  return "z";
}

/**
 * The rows in panel order.
 *
 * A child that left the flow keeps its authored slot even in a `"flow"` list,
 * rather than being hoisted above the in-flow children the way Figma hoists it.
 * Its array index is a paint order, not a stack position, so it has no meaningful
 * place in the flow — but hoisting it would make every drop line that crosses the
 * boundary promise an index the splice does not take, and the indicator and the
 * result would silently disagree. Leaving it in place costs nothing the reader can
 * act on and keeps every line exact. If Figma parity is ever wanted here, this is
 * the one function it belongs in.
 */
export function orderRowsForPanel(rows: DesignElement[], order: RowOrder): DesignElement[] {
  return order === "flow" ? rows : [...rows].reverse();
}
