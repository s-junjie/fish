/**
 * Number tokens: one px value per token, with one value per mode.
 *
 * The same split as colour tokens — a value lives in `doc.tokens[]`, a set of
 * declarations lives in `doc.styles[]` — so nothing here touches `doc.styles`.
 */

import {
  DesignDocument,
  DesignElement,
  DesignToken,
  NumberToken,
  NumberTokenCategory
} from "../dsl/types";
import { getActivePage } from "../dsl/document-ops";
import { createId } from "../id";
import { bindNumberToken, CORNER_SLOTS, numberTokenPropValue } from "../dsl/token-bindings";

/**
 * The write shape and the two constants live in the DSL: a `$token` shorthand
 * and the inspector's bind command must produce the same layer, so the lowering
 * is one function rather than two. Re-exported here because every existing
 * caller (and the sync pass) reads them from this module.
 */
export { CORNER_SLOTS, numberTokenPropValue };

export function isNumberToken(token: DesignToken): token is NumberToken {
  return token.type === "number";
}

export function createNumberToken(
  name: string,
  value: number,
  category: NumberTokenCategory = "spacing",
  description?: string
): NumberToken {
  return {
    id: createId("tok"),
    name: name.trim() || "Untitled Number Token",
    type: "number",
    value,
    category,
    ...(description?.trim() ? { description: description.trim() } : {})
  };
}

export function updateNumberToken(
  token: NumberToken,
  name: string,
  value: number,
  category?: NumberTokenCategory,
  description?: string
): NumberToken {
  return {
    ...token,
    name: name.trim() || token.name,
    value,
    ...(category ? { category } : {}),
    ...(description !== undefined
      ? description.trim()
        ? { description: description.trim() }
        : { description: undefined }
      : {})
  };
}

export function findNumberToken(tokens: readonly DesignToken[], tokenId?: string): NumberToken | undefined {
  if (!tokenId) return undefined;
  return tokens.find((token): token is NumberToken => token.type === "number" && token.id === tokenId);
}

/** Put a reordered number list back into place among the other token types. */
export function mergeNumberTokenOrder(
  tokens: readonly DesignToken[],
  reordered: readonly NumberToken[]
): DesignToken[] {
  let cursor = 0;
  return tokens.map((token) => (token.type === "number" ? reordered[cursor++] ?? token : token));
}

/**
 * How many layer, text-style and effect references bind a number token.
 *
 * Counted from `pages` only for the same reason `countTokenUses` is: the active
 * page is mirrored onto `getActivePage(doc).children`, and counting both reports one binding twice.
 */
export function countNumberTokenUses(doc: DesignDocument, tokenId: string): number {
  let count = 0;

  for (const s of doc.styles || []) {
    if (s.styleType === "text" && s.style?.tokenBindings) {
      for (const boundId of Object.values(s.style.tokenBindings)) {
        if (boundId === tokenId) count++;
      }
    } else if (s.styleType === "effect" && Array.isArray(s.effects)) {
      for (const ef of s.effects) {
        for (const boundId of Object.values(ef.tokenBindings ?? {})) {
          if (boundId === tokenId) count++;
        }
      }
    }
  }

  const visit = (el: DesignElement): void => {
    for (const boundId of Object.values(el.tokenBindings ?? {})) {
      if (boundId === tokenId) count++;
    }
    for (const ef of el.effects ?? []) {
      for (const boundId of Object.values(ef.tokenBindings ?? {})) {
        if (boundId === tokenId) count++;
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

export function reorderNumberTokens(
  tokens: readonly NumberToken[],
  fromRow: number,
  insertBeforeRow: number
): NumberToken[] {
  const next = tokens.slice();
  if (fromRow < 0 || fromRow >= next.length) return next;
  const [moved] = next.splice(fromRow, 1);
  const target = insertBeforeRow > fromRow ? insertBeforeRow - 1 : insertBeforeRow;
  next.splice(Math.max(0, Math.min(next.length, target)), 0, moved);
  return next;
}

export function bindNumberTokenToElement(
  el: DesignElement,
  property: string,
  tokenId: string,
  value: number
): DesignElement {
  return bindNumberToken(el as unknown as Record<string, unknown>, property, tokenId, value) as unknown as DesignElement;
}

export function unbindNumberTokenFromElement(
  el: DesignElement,
  property: string
): DesignElement {
  if (!el.tokenBindings) return el;
  const nextBindings = { ...el.tokenBindings };
  let removed = false;
  if (property in nextBindings) {
    delete nextBindings[property];
    removed = true;
  }
  const cornerSlot = CORNER_SLOTS[property];
  if (cornerSlot !== undefined) {
    for (const [alias, s] of Object.entries(CORNER_SLOTS)) {
      if (s === cornerSlot && alias in nextBindings) {
        delete nextBindings[alias];
        removed = true;
      }
    }
  } else if (property === "borderRadius") {
    for (const cornerProp of Object.keys(CORNER_SLOTS)) {
      if (cornerProp in nextBindings) {
        delete nextBindings[cornerProp];
        removed = true;
      }
    }
  }
  if (!removed) return el;
  return {
    ...el,
    tokenBindings: Object.keys(nextBindings).length > 0 ? nextBindings : undefined
  };
}

