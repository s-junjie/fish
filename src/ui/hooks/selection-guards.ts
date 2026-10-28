import { DesignDocument, DesignElement } from "../../core/dsl/types";
import { editableIds } from "../../core/geometry/lock";
import { hasStoredSelection } from "../../core/interactions/instance-resolve";
import { t } from "../../i18n";

/**
 * The two guards every selection-driven edit runs first. Shared because they are
 * rules, not conveniences: "a resolved clone has no geometry of its own" and "a
 * locked layer stays selectable but is not the canvas's to move" have to hold for
 * the keyboard and the context menu alike, and a guard that exists twice is a
 * guard that will exist in one place only.
 */

/**
 * A derived id is a resolved clone of an instance's child: it is painted but never
 * stored. Every structural or geometric edit writes back by id, so on such a
 * selection they would commit nothing — refuse with a hint rather than pollute the
 * undo stack with a no-op.
 */
export function refuseDerivedEdit(
  doc: DesignDocument,
  selectedIds: Set<string>,
  setHintMessage?: (msg: string) => void
): boolean {
  if (selectedIds.size === 0) return false;
  if (hasStoredSelection(doc, selectedIds)) return false;
  setHintMessage?.(t("component.derivedChildLocked"));
  return true;
}

/** The part of a selection a canvas command may act on: a locked layer is not it. */
export function editableSelection(
  elements: DesignElement[],
  selectedIds: Set<string>
): Set<string> {
  return editableIds(elements, selectedIds);
}
