import { ComponentSetElement, DesignDocument, getActivePage } from "../../core/dsl/types";
import { findComponentSetNode, findParentById } from "../../core/geometry/tree-ops";

/**
 * The `componentSet` node a selected element lives in, or null.
 *
 * The inspector asks this on every render of a variant's panel, and the answer
 * decides between two entirely different panels, so it reads the tree directly
 * rather than grouping every set in the document to find one it already has the
 * node id for.
 *
 * `findParentById` rather than a `setId` lookup on purpose: a variant names its set
 * even when no node backs that id (a legacy document, an ungrouped set), and
 * following the parent cannot disagree with where the layer actually is.
 */
export function setNodeOf(doc: DesignDocument, el: { id: string }): ComponentSetElement | null {
  const parent = findParentById(getActivePage(doc).children, el.id);
  if (parent?.type !== "componentSet") return null;
  return findComponentSetNode(getActivePage(doc).children, parent.id);
}
