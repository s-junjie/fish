import { DesignDocument, DesignElement, getActivePage, updateActivePageElements } from "../dsl/types";
import { mapElements } from "../geometry/tree-ops";
import { commitInstanceOverrides, isStoredNode, resolveInstanceSelection } from "./instance-resolve";

export interface DerivedOverrideResult {
  doc: DesignDocument;
  /** The ids that were written. A row two levels down has no instance of its
   * own to hold the override, so it is simply left out. */
  applied: string[];
}

/**
 * Writes `updater` onto nodes that exist only as resolved clones of an
 * instance's children — a nested instance, or any layer inside one.
 *
 * Those nodes have no place in the document tree, so a write addressed by id
 * silently commits nothing; the way to change one is an override on the
 * instance that projects it. Returns null when none of `ids` is a clone that
 * an instance can carry an override for, which is the caller's cue to fall
 * back to the ordinary tree write.
 */
export function overrideDerivedNodes(
  doc: DesignDocument,
  ids: Iterable<string>,
  updater: (el: DesignElement) => DesignElement
): DerivedOverrideResult | null {
  let next = doc;
  const applied: string[] = [];
  for (const id of ids) {
    // Resolved against `next`, so a second id sees the override the first wrote.
    const sel = resolveInstanceSelection(next, id);
    if (!sel || !sel.overridable) continue;
    const written = commitInstanceOverrides(next, [sel], updater);
    if (!written) continue;
    next = written;
    applied.push(id);
  }
  return applied.length > 0 ? { doc: next, applied } : null;
}

/**
 * One node edit, addressed the same way for a stored layer and a resolved clone.
 *
 * A canvas gesture writes by id, and a clone has no id in the tree — which is why
 * every gesture used to refuse one outright. Anything the gesture touches that is
 * ALSO overridable (`fills`, `borderRadius`) can be written here instead, and the
 * caller never has to know which kind of node it is holding. Returns null when
 * nothing changed, so a gesture can tell an unchanged frame from an unwritable
 * property.
 */
export function writeNodeEdit(
  doc: DesignDocument,
  id: string,
  updater: (el: DesignElement) => DesignElement
): DesignDocument | null {
  if (isStoredNode(doc, id)) {
    const children = getActivePage(doc).children;
    const next = mapElements(children, (el) => (el.id === id ? updater(el) : el));
    if (next === children) return null;
    return updateActivePageElements(doc, next);
  }
  return overrideDerivedNodes(doc, [id], updater)?.doc ?? null;
}
