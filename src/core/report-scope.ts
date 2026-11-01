/**
 * Which findings belong to the element a shot was cropped to.
 *
 * `?report=1&element=<id>` crops the picture but used to hand back the whole
 * document's diagnostics: five per-screen exports carried the same first-screen
 * warning five times, and "this screen has a problem" was read off a finding about
 * another one. Filtering outright would hide a real defect, so the split is
 * stated in both halves — what belongs to the crop, and what does not.
 */

import type { CompileDiagnostic } from "./compile";
import type { DesignDocument, DesignElement } from "./dsl/types";
import { getActivePage } from "./dsl/types";
import { findElementById, flattenElements } from "./geometry/tree-ops";

export interface ScopedValidate {
  elementId: string;
  /** Stored nodes in the crop's subtree — the ids a finding can be attributed to. */
  elements: number;
  inScope: CompileDiagnostic[];
  elsewhere: CompileDiagnostic[];
}

export function scopeValidate(
  doc: DesignDocument,
  elementId: string,
  diagnostics: CompileDiagnostic[]
): ScopedValidate | null {
  const found = findElementById(getActivePage(doc).children ?? [], elementId);
  if (!found) return null;

  const ids = new Set<string>([found.id]);
  for (const el of flattenElements((found as { children?: DesignElement[] }).children ?? [])) ids.add(el.id);

  const inScope: CompileDiagnostic[] = [];
  const elsewhere: CompileDiagnostic[] = [];
  // Attribution is by stored id, which is what the grader walks: a resolved clone
  // has no id in the tree and no finding of its own, so a guess at a derived
  // `<instance>_<node>` spelling would only misattribute a real sibling.
  for (const d of diagnostics) (d.elementId && ids.has(d.elementId) ? inScope : elsewhere).push(d);

  return { elementId, elements: ids.size, inScope, elsewhere };
}
