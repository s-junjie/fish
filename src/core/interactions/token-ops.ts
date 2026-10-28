/**
 * Colour tokens: one hex value per token, with one value per mode.
 *
 * A token is a VALUE and the `type` tag says what kind, so the document's colour
 * half is `doc.tokens.filter(t => t.type === "color")` — membership decides the
 * role, never the shape of the value.
 */

import { ColorToken, DesignDocument, DesignElement, DesignToken, GradientStop, Paint, Stroke } from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { createId } from "../id";
import { parseColorAlpha } from "../geometry/color-utils";
import { resolveColorTokenHex } from "./style-sync";

/** The `doc.tokens[]` entries that are colours. */
export function colorTokensOf(tokens: readonly DesignToken[] | undefined): ColorToken[] {
  return (tokens ?? []).filter((token): token is ColorToken => token.type === "color");
}

/** The solid colour of a colour token for the given theme (or base), or default. */
export function colorTokenColor(token: ColorToken, theme?: string): string {
  return resolveColorTokenHex(token, theme);
}

export function createColorToken(name: string, color: string, description?: string): ColorToken {
  return {
    id: createId("tok"),
    name: name.trim() || "Untitled Color Token",
    type: "color",
    value: color,
    ...(description?.trim() ? { description: description.trim() } : {})
  };
}

/** Edit a token in place, keeping its id and its per-mode values. */
export function updateColorToken(
  token: ColorToken,
  name: string,
  color: string,
  description?: string
): ColorToken {
  return {
    ...token,
    name: name.trim() || token.name,
    value: color,
    ...(description !== undefined
      ? description.trim()
        ? { description: description.trim() }
        : { description: undefined }
      : {})
  };
}

/** Put a reordered colour list back into place among the other token types. */
export function mergeTokenOrder(
  tokens: readonly DesignToken[],
  reordered: readonly ColorToken[]
): DesignToken[] {
  let cursor = 0;
  return tokens.map((token) => (token.type === "color" ? reordered[cursor++] ?? token : token));
}

/**
 * How many layer and style references name a token.
 *
 * A reference lives in one place per use: a paint's `tokenId`, a stroke's
 * `tokenId` (or its nested paint's), an effect's `tokenId`, or a `tokenBindings`
 * entry on the layer, its text style or its effect. `getActivePage(doc).children` mirrors the
 * active page, so counting it as well would report every use on page 1 twice —
 * hence a use is counted from `pages` only, and from the mirror only when the
 * document has no pages at all.
 */
/** How many references to `tokenId` one paint holds: its own, plus its stops'. */
const boundUses = (
  tokenId: string,
  own?: string,
  stops?: readonly GradientStop[]
): number => {
  let uses = own === tokenId ? 1 : 0;
  for (const stop of stops ?? []) if (stop.tokenId === tokenId) uses++;
  return uses;
};

const paintUses = (paint: Paint | undefined, tokenId: string): number => {
  if (!paint) return 0;
  const stops = "stops" in paint ? paint.stops : undefined;
  return boundUses(tokenId, paint.tokenId, stops);
};

const strokeUses = (stroke: Stroke, tokenId: string): number =>
  boundUses(tokenId, stroke.tokenId) + paintUses(stroke.paint, tokenId);

export function countTokenUses(doc: DesignDocument, tokenId: string): number {
  let count = 0;
  // A style that follows a token is a use of it too: renaming or deleting a
  // token the palette never names is exactly the mistake "Used by N" exists to
  // prevent, and the styles are the half a layer walk cannot see.
  for (const style of doc.styles ?? []) {
    if (style.styleType === "paint") {
      for (const paint of style.paints) count += paintUses(paint, tokenId);
    } else if (style.styleType === "stroke") {
      for (const stroke of style.strokes) count += strokeUses(stroke, tokenId);
    } else if (style.styleType === "effect") {
      for (const effect of style.effects) {
        if ((effect as { tokenId?: string }).tokenId === tokenId) count++;
        for (const bound of Object.values(effect.tokenBindings ?? {})) if (bound === tokenId) count++;
      }
    } else if (style.styleType === "text") {
      for (const bound of Object.values(style.style?.tokenBindings ?? {})) {
        if (bound === tokenId) count++;
      }
    }
  }
  const visit = (el: DesignElement): void => {
    for (const paint of el.fills ?? []) count += paintUses(paint, tokenId);
    for (const stroke of el.strokes ?? []) count += strokeUses(stroke, tokenId);
    for (const effect of el.effects ?? []) {
      if ((effect as { tokenId?: string }).tokenId === tokenId) count++;
      for (const bound of Object.values(effect.tokenBindings ?? {})) {
        if (bound === tokenId) count++;
      }
    }
    for (const bound of Object.values(el.tokenBindings ?? {})) {
      if (bound === tokenId) count++;
    }
    if (el.type === "text") {
      for (const bound of Object.values(el.style?.tokenBindings ?? {})) {
        if (bound === tokenId) count++;
      }
    }
    if (el.type === "instance" && Array.isArray(el.overrides)) {
      for (const override of el.overrides) {
        if (override.property === "fills" && Array.isArray(override.value)) {
          for (const paint of override.value as { tokenId?: string }[]) {
            if (paint?.tokenId === tokenId) count++;
          }
        }
      }
    }
    if ("children" in el && Array.isArray(el.children)) {
      for (const child of el.children) visit(child);
    }
  };

  if (doc.pages && doc.pages.length > 0) {
    for (const page of doc.pages) for (const el of page.children ?? []) visit(el);
  } else {
    for (const el of getActivePage(doc).children ?? []) visit(el);
  }
  return count;
}

/**
 * How many layer and style references name a STYLE.
 *
 * The token-shaped references a one-solid paint style used to receive are no
 * longer counted here: after the split they belong to `countTokenUses`, and a
 * style's own id can only be named by the matching `*StyleId` — never by a
 * stroke row, which has no style pointer at all.
 */
export function countStyleUses(doc: DesignDocument, styleId: string): number {
  let count = 0;

  const visit = (el: DesignElement): void => {
    if (el.fillStyleId === styleId) count++;
    if (el.strokeStyleId === styleId) count++;
    if (el.effectStyleId === styleId) count++;
    if (el.type === "text" && el.textStyleId === styleId) count++;
    if (el.type === "instance" && Array.isArray(el.overrides)) {
      for (const override of el.overrides) {
        if (
          (override.property === "fillStyleId" ||
            override.property === "strokeStyleId" ||
            override.property === "textStyleId" ||
            override.property === "effectStyleId") &&
          override.value === styleId
        ) {
          count++;
        }
      }
    }
    if ("children" in el && Array.isArray(el.children)) {
      for (const child of el.children) visit(child);
    }
  };

  if (doc.pages && doc.pages.length > 0) {
    for (const page of doc.pages) for (const el of page.children ?? []) visit(el);
  } else {
    for (const el of getActivePage(doc).children ?? []) visit(el);
  }
  return count;
}

export function reorderColorTokens(
  tokens: readonly ColorToken[],
  fromRow: number,
  insertBeforeRow: number
): ColorToken[] {
  const next = tokens.slice();
  if (fromRow < 0 || fromRow >= next.length) return next;
  const [moved] = next.splice(fromRow, 1);
  const target = insertBeforeRow > fromRow ? insertBeforeRow - 1 : insertBeforeRow;
  next.splice(Math.max(0, Math.min(next.length, target)), 0, moved);
  return next;
}

/** The alpha a token's encoded hex carries, for readouts that still show a percentage. */
export function tokenAlphaPct(token: ColorToken, theme?: string): number {
  return parseColorAlpha(colorTokenColor(token, theme)).alphaPct;
}
