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
import { getActivePage } from "../dsl/types";
import { createId } from "../id";
import { parseCornerRadii } from "../geometry/rounded-box";

export function isNumberToken(token: DesignToken): token is NumberToken {
  return token.type === "number";
}

/**
 * A token value spelled the way the DSL stores the bound property.
 *
 * Tokens are px (`NumberToken`'s contract), and every bound property keeps px
 * as a bare number — except `lineHeight`, where the DSL follows CSS and a bare
 * number is a MULTIPLE. Binding a px token there without spelling the unit
 * turns `1` into `1×` leading, which the inspector then shows as `100%`.
 */
export function numberTokenPropValue(prop: string, value: number): number | `${number}px` {
  return prop === "lineHeight" ? (`${value}px` as const) : value;
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

export const CORNER_SLOTS: Record<string, number> = {
  topLeftRadius: 0,
  borderTopLeftRadius: 0,
  topRightRadius: 1,
  borderTopRightRadius: 1,
  bottomRightRadius: 2,
  borderBottomRightRadius: 2,
  bottomLeftRadius: 3,
  borderBottomLeftRadius: 3
};

export function bindNumberTokenToElement(
  el: DesignElement,
  property: string,
  tokenId: string,
  value: number
): DesignElement {
  const nextBindings = { ...(el.tokenBindings || {}), [property]: tokenId };
  const next: any = { ...el, tokenBindings: nextBindings };

  const cornerSlot = CORNER_SLOTS[property];
  if (cornerSlot !== undefined) {
    delete nextBindings.borderRadius;
    for (const [alias, s] of Object.entries(CORNER_SLOTS)) {
      if (s === cornerSlot && alias !== property) {
        delete nextBindings[alias];
      }
    }
    const currentRadii = parseCornerRadii((el as any).borderRadius);
    const nextRadii = [...currentRadii] as [number, number, number, number];
    nextRadii[cornerSlot] = value;
    next.borderRadius = nextRadii;
  } else if (property === "borderRadius") {
    for (const cornerProp of Object.keys(CORNER_SLOTS)) {
      delete nextBindings[cornerProp];
    }
    if ("borderRadius" in el && Array.isArray((el as any).borderRadius)) {
      next.borderRadius = [value, value, value, value];
    } else {
      next.borderRadius = value;
    }
  } else if (property === "strokeWidth") {
    if (Array.isArray(next.strokes)) {
      next.strokes = next.strokes.map((s: any) => ({ ...s, width: value }));
    }
  } else if (property === "padding") {
    if (Array.isArray(next.padding)) {
      next.padding = [value, value, value, value];
    } else {
      next.padding = value;
    }
  } else if (property === "fontSize" || property === "lineHeight" || property === "letterSpacing") {
    next.style = { ...(next.style || {}), [property]: numberTokenPropValue(property, value) };
  } else {
    next[property] = value;
  }

  return next as DesignElement;
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

