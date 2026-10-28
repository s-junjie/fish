import { DesignElement } from "../../core/dsl/types";
import { childrenOf } from "../../core/geometry/tree-query";

/**
 * Whether a selection change is INSIDE this node's subtree.
 *
 * A node's own selected state arrives as its `isSelected` prop, which the memo
 * already compares. What it also has to do is pass the new state DOWN to the
 * children it renders — and only the nodes on the path to a changed id have
 * anything to pass. Comparing `ctx.selectedIds` for every node instead made a
 * mousedown on one layer re-render all 1,841 nodes on Page 1, because the set is
 * replaced rather than mutated.
 *
 * The descendant ids are built once per element object and cached: an unchanged
 * element keeps its identity across a selection change, so the walk happens the
 * first time the element is an ancestor of something selected and never again.
 *
 * An instance is the exception that has no stored children: its subtree is the
 * master resolved under this instance's id, so every id inside it starts with
 * `<instance id>_` at any nesting depth (see `resolveInstanceContent`).
 */
const descendants = new WeakMap<DesignElement, ReadonlySet<string>>();

function descendantIds(el: DesignElement): ReadonlySet<string> {
  const hit = descendants.get(el);
  if (hit) return hit;
  const ids = new Set<string>();
  const walk = (parent: DesignElement) => {
    for (const child of childrenOf(parent)) {
      ids.add(child.id);
      walk(child);
    }
  };
  walk(el);
  descendants.set(el, ids);
  return ids;
}

export function selectionTouchesSubtree(el: DesignElement, changed: ReadonlySet<string>): boolean {
  if (changed.size === 0) return false;
  if (childrenOf(el).length > 0) {
    const ids = descendantIds(el);
    for (const id of changed) if (ids.has(id)) return true;
  }
  if (el.type === "instance") {
    const prefix = `${el.id}_`;
    for (const id of changed) if (id.startsWith(prefix)) return true;
  }
  return false;
}
