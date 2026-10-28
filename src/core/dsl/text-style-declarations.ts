import type { TextStyle, TextStyleDeclaration } from "./types";

/**
 * The declarations a text STYLE owns, as a runtime list.
 *
 * The CONTRACT is the `TextStyleDeclaration` interface — that is what the
 * compiler holds, and what both UIs mirror: the style editor has one control per
 * field of it, and the layer inspector hides that whole block while a style is
 * bound. This list is the same set in a form normalize can iterate, and
 * `TEXT_STYLE_SCOPE_IS_EXACT` below makes a field added to one and not the other
 * a compile error, so the two cannot drift.
 *
 * One fixed set, not "whatever this style happens to declare": a per-key rule
 * made the same field move between the two panels from one style to the next
 * (a style that set no letter-spacing left the field in the inspector, a style
 * that set one took it away), so nobody could tell which panel owned a value.
 *
 * What is NOT here is the layer's on purpose: alignment and vertical alignment
 * place the box, `maxLines`/`textOverflow` clip it, `fontVariantNumeric` picks
 * figures, and `color` is ink — paint lives in `fills`.
 */
export const TEXT_STYLE_KEYS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textDecoration",
  "textTransform"
] as const satisfies readonly (keyof TextStyle)[];

/** `tokenBindings` rides along: it is how those three numbers follow a token. */
const OWNED: ReadonlySet<string> = new Set<string>([...TEXT_STYLE_KEYS, "tokenBindings"]);

/**
 * The list and the interface must name the SAME keys.
 *
 * The interface is what the compiler sees and the list is what normalize reads,
 * so a field added to one and not the other would be a declaration the engine
 * drops (or a key it keeps that the type forbids) with nothing to report it.
 * This assertion is the tie: either side gaining a member makes it `never`.
 */
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const TEXT_STYLE_SCOPE_IS_EXACT: SameKeys<
  keyof TextStyleDeclaration,
  (typeof TEXT_STYLE_KEYS)[number] | "tokenBindings"
> = true;

/** Why a key a style cannot own was refused, for the repair message. */
const REFUSALS: Record<string, string> = {
  color: "ink is the layer's fills",
  align: "alignment places the layer's box",
  verticalAlign: "alignment places the layer's box",
  maxLines: "clipping is the layer's box",
  textOverflow: "clipping is the layer's box",
  fontVariantNumeric: "figures are the layer's",
  textShadow: "a shadow belongs to the layer, or to an effect style"
};

export function textStyleRefusal(key: string): string {
  return REFUSALS[key] ?? "not a declaration a text style owns";
}

/**
 * A layer's style cut down to what a text style may declare.
 *
 * `dropped` is every key removed, in document order, so the caller can report
 * the ones the AUTHOR wrote (a normalizer supplies defaults — a colour, a
 * family — that were never in the file and must not be reported as lost).
 */
export function toTextStyleDeclaration(style: TextStyle): {
  declaration: TextStyleDeclaration;
  dropped: string[];
} {
  const declaration: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if (OWNED.has(key)) declaration[key] = value;
    else dropped.push(key);
  }
  return { declaration: declaration as unknown as TextStyleDeclaration, dropped };
}
