/**
 * Filing the design system an import produced on the document that receives it.
 *
 * Both importers mint tokens from the page's or the file's own design system,
 * and Figma's also mints the STYLES its layers point at. Tokens live in
 * `doc.tokens`, styles in `doc.styles`, and both hand back layers that already
 * carry `tokenId` / `tokenBindings` / `fillStyleId`. So the tables have to land
 * in the SAME commit as the elements: a reference to a token that is not on the
 * document yet renders from the materialised value but cannot be edited, and
 * reads as a broken binding.
 */

import type { DesignDocument, DesignStyle, DesignToken, DocumentMode } from "../dsl/types";
import { getDocumentModes, getDocumentNumberModes } from "../interactions/mode-ops";
import type { ImportedTokens } from "./html-types";

/** What an import contributes to the two tables, in the shape `ImportResult.tokens` carries. */
export function importedDesignSystem(
  tokens: readonly DesignToken[],
  modes: readonly DocumentMode[],
  styles: readonly DesignStyle[] = [],
  numberModes: readonly DocumentMode[] = []
): ImportedTokens {
  return {
    tokens: tokens.slice(),
    styles: styles.slice(),
    modes: modes.slice(),
    ...(numberModes.length > 0 ? { numberModes: numberModes.slice() } : {})
  };
}

export function withImportedDesignSystem(
  doc: DesignDocument,
  imported?: ImportedTokens
): Partial<DesignDocument> {
  if (!imported) return {};
  const next: Partial<DesignDocument> = {};
  if (imported.tokens.length > 0) {
    next.tokens = [...(doc.tokens ?? []), ...imported.tokens];
  }
  if (imported.styles.length > 0) next.styles = [...(doc.styles ?? []), ...imported.styles];
  // A mode goes in only when the document has no mode with that id, so importing
  // twice does not grow a second Dark. The base mode stays first: it is the one
  // `getActiveTheme` falls back to, and a file's Dark is an override, not a base.
  // Each axis is merged into its own list — a density mode must not become a
  // colour column, which is the whole point of keeping the two apart.
  const modes = getDocumentModes(doc);
  const added = imported.modes.filter((mode) => !modes.some((existing) => existing.id === mode.id));
  if (added.length > 0) next.modes = [...modes, ...added];

  const numberModes = getDocumentNumberModes(doc);
  const addedNumberModes = (imported.numberModes ?? []).filter(
    (mode) => !numberModes.some((existing) => existing.id === mode.id)
  );
  if (addedNumberModes.length > 0) next.numberModes = [...numberModes, ...addedNumberModes];
  return next;
}
