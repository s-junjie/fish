/**
 * The `id` an HTML element was given, carried into the document.
 *
 * An `id` is the only handle a page can hand over: it is what an author writes
 * to address a box, and it is what `fish assets import --to` and a `patch`
 * target read back. Minting a fresh one instead makes the imported page a
 * lookup table — a caller that has just written `id="hero_img"` still has to
 * find the element before it can fill it.
 *
 * DOM-free on purpose: the walk reads `getAttribute("id")` and passes the
 * string, so the claiming rule is testable without a browser.
 */

import { createId, sanitizeElementId } from "../id";

export type AuthoredId =
  /** Usable. `renamedFrom` is set when sanitizing changed what the page wrote. */
  | { id: string; renamedFrom?: string }
  /** The page wrote an id the document already owns, so it cannot be reused. */
  | { conflict: string }
  | null;

/**
 * Claims the page's id for this import, or says why it cannot.
 *
 * `taken` is mutated: a claimed id is no longer available to the next element,
 * which is what keeps the document's document-wide id ledger honest (see
 * `normalize/element.ts::resolveElementId`). An author-written id is never
 * silently renamed to make room — a renamed anchor is one no caller can guess,
 * so the collision is reported and the element mints its own.
 */
export function claimAuthoredId(raw: string | null | undefined, taken: Set<string>): AuthoredId {
  const written = (raw ?? "").trim();
  if (!written) return null;
  const id = sanitizeElementId(written);
  if (taken.has(id)) return { conflict: written };
  taken.add(id);
  return id === written ? { id } : { id, renamedFrom: written };
}

/**
 * The id minter for ONE element.
 *
 * The first id it is asked for takes the authored one. Anything after that is a
 * box the walk synthesized out of the same element — a padded text leaf becomes
 * a frame around its text — which is a different element, so it mints its own.
 */
export function minterFor(authoredId: string | null): (kind: string) => string {
  let claimed = false;
  return (kind) => {
    if (!claimed && authoredId) {
      claimed = true;
      return authoredId;
    }
    return createId(kind);
  };
}
