import { DesignDocument, DesignElement } from "../dsl/types";
import { findParentById } from "../geometry/tree-ops";
import { canCreateComponentHere } from "./component-inventory";
import { createComponentFromElement } from "./component-ops";

/**
 * "Create multiple components" as a document transform.
 *
 * It was written inline in the inspector, which meant the right-click menu could
 * not offer it without a second copy — and a second copy is how the two entry
 * points come to disagree about which layers count. A selected element nested
 * inside another selected one is dropped here, once, for both: promoting the
 * outer one already carries it, and promoting both would nest a definition in a
 * definition.
 */
export function promotionTargets(elements: DesignElement[], selected: DesignElement[]): DesignElement[] {
  if (selected.length < 2) return [];
  const ids = new Set(selected.map((el) => el.id));
  const hasSelectedAncestor = (el: DesignElement) => {
    let cur = findParentById(elements, el.id);
    while (cur) {
      if (ids.has(cur.id)) return true;
      cur = findParentById(elements, cur.id);
    }
    return false;
  };
  return selected.filter((el) => canCreateComponentHere(elements, el) && !hasSelectedAncestor(el));
}

export interface PromotionResult {
  doc: DesignDocument;
  /** The components the selection became, in the order they were promoted. */
  created: string[];
  /** True when a promotion moved a main component out of the page it was on. */
  hoisted: boolean;
}

/**
 * Promotes each target into its own component, one step per target.
 *
 * Each step consumes the document the previous one produced: a promotion that
 * hoists a master out of a frame cannot leave a later target resolving against a
 * tree that no longer exists.
 */
export function promoteSelectionToComponents(
  doc: DesignDocument,
  targets: DesignElement[]
): PromotionResult | null {
  let next = doc;
  const created: string[] = [];
  let hoisted = false;
  for (const el of targets) {
    const step = createComponentFromElement(next, el.id);
    if (!step.component) continue;
    next = step.doc;
    created.push(step.component.id);
    if (step.hoisted.length > 0) hoisted = true;
  }
  return created.length === 0 ? null : { doc: next, created, hoisted };
}
