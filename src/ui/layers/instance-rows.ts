import type { DesignDocument, DesignElement, InstanceElement } from "../../core/dsl/types";
import { childrenOf } from "../../core/geometry/tree-ops";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { resolvedChildren, resolvedRoute } from "../../core/interactions/component-swap";

/**
 * Whether `el` has rows to show, without building them. An open instance is
 * resolved through `layerRowsOf`, which clones the whole subtree — far too much
 * to pay for a row that is collapsed, so the twisty asks this instead.
 */
export function hasRows(doc: DesignDocument | null | undefined, el: DesignElement): boolean {
  if (childrenOf(el).length > 0) return true;
  if (el.type !== "instance" || !doc) return false;
  const master = findMasterComponent(doc, (el as InstanceElement).componentId);
  return Boolean(master && (master.children || []).length > 0);
}

/**
 * The rows the layer tree paints under `el`, resolved. An instance stores no
 * children of its own — its subtree is the resolved clone the canvas paints — so
 * the tree asks the same resolver the renderer does. That is what makes a row
 * selected from the tree select the very node the canvas painted, and therefore
 * what lets the inspector edit it as an override.
 *
 * Every level BELOW the instance needs no special case: the clones carry their
 * own children, and a clone of a nested instance carries its `componentId`, so
 * this one call covers the whole subtree.
 */
export function layerRowsOf(doc: DesignDocument | null | undefined, el: DesignElement): DesignElement[] {
  return resolvedChildren(doc, el);
}

/**
 * The rows the tree must expand to reveal a node selected on the canvas: the
 * owning instance plus every row on the way down. A resolved clone is absent from
 * the document tree, so the panel's ordinary "walk up the parents" cannot reach
 * its rows at all. Empty when `id` is not a resolved clone.
 */
export function derivedRowPath(doc: DesignDocument | null | undefined, id: string): string[] {
  if (!doc) return [];
  const route = resolvedRoute(doc, id);
  return route ? route.map((row) => row.id) : [];
}
