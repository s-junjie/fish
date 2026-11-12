/**
 * What a number token's binding looks like once it lands on a layer.
 *
 * One writer, because the shape is not obvious: a corner binding moves the whole
 * `borderRadius` tuple, a padding binding follows whether the author wrote one
 * number or four, a stroke-width binding moves every row, and the three type
 * numbers live inside `style` rather than beside it. `$token` shorthand lowers
 * onto this same function — an author who writes `borderRadius: "$radius-card"`
 * must get byte-for-byte what the inspector's bind command produces, or the two
 * roads disagree about a document the user can only see one of.
 *
 * Split in two because a REFERENCE that already exists also has to move its
 * value: `writeNumberValue` materialises, `bindNumberToken` records the binding
 * and then materialises. A load-time refresh must not rewrite the bindings it
 * was handed, which is what the split buys.
 *
 * Keyed by the STORED property name (`borderRadius`, `strokeWidth`, `fontSize`),
 * which is also the `tokenBindings` key, so a binder and its reader cannot drift.
 */

import { parseCornerRadii } from "../geometry/rounded-box";

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

/**
 * A token value spelled the way the DSL stores the bound property.
 *
 * Tokens are px (`NumberToken`'s contract), and every bound property keeps px as
 * a bare number — except `lineHeight`, where the DSL follows CSS and a bare
 * number is a MULTIPLE. Binding a px token there without spelling the unit turns
 * `1` into `1×` leading, which the inspector then shows as `100%`.
 */
export function numberTokenPropValue(prop: string, value: number): number | `${number}px` {
  return prop === "lineHeight" ? (`${value}px` as const) : value;
}

/** The value half: what the bound property holds for this number. */
export function writeNumberValue(
  el: Record<string, unknown>,
  property: string,
  value: number
): Record<string, unknown> {
  const next: Record<string, any> = { ...el };

  const cornerSlot = CORNER_SLOTS[property];
  if (cornerSlot !== undefined) {
    const currentRadii = parseCornerRadii(el.borderRadius as never);
    const nextRadii = [...currentRadii] as [number, number, number, number];
    nextRadii[cornerSlot] = value;
    next.borderRadius = nextRadii;
  } else if (property === "borderRadius") {
    if ("borderRadius" in el && Array.isArray(el.borderRadius)) {
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

  return next;
}

/**
 * The bindings a write to `property` supersedes.
 *
 * A binding names exactly one slot: the four corners are one tuple, so a
 * whole-radius binding replaces them and a corner binding replaces the
 * whole-radius one (and its sibling spelling of the same corner). Shared with
 * the PATCH surface, which writes a literal into the same slot and therefore
 * has to drop the same pointer — leaving it there makes the patch a no-op that
 * reports success, because the next read puts the token's number back.
 */
export function withoutNumberBinding(
  bindings: Record<string, string> | undefined,
  property: string
): Record<string, string> | undefined {
  if (!bindings) return undefined;
  const next: Record<string, string> = { ...bindings };
  delete next[property];

  const cornerSlot = CORNER_SLOTS[property];
  if (cornerSlot !== undefined) {
    delete next.borderRadius;
    for (const [alias, slot] of Object.entries(CORNER_SLOTS)) {
      if (slot === cornerSlot) delete next[alias];
    }
  } else if (property === "borderRadius") {
    for (const cornerProp of Object.keys(CORNER_SLOTS)) delete next[cornerProp];
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function bindNumberToken(
  el: Record<string, unknown>,
  property: string,
  tokenId: string,
  value: number
): Record<string, unknown> {
  const cleared = withoutNumberBinding(el.tokenBindings as Record<string, string> | undefined, property) ?? {};
  const nextBindings = { ...cleared, [property]: tokenId };

  return writeNumberValue({ ...el, tokenBindings: nextBindings }, property, value);
}
