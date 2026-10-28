/**
 * The flat CSS authored surface: the top-level TEXT keys an author writes on the
 * box, folded into the nested `style` slot the engine reads. The sibling layout
 * surface — `display`, `flex-direction`, `gap` — is read flat by
 * `flat-layout.ts`, because its flat keys are the storage vocabulary rather than
 * a folded alias.
 *
 * It lives here rather than inside `element.ts` because it is a translation of
 * one vocabulary into another and nothing else: it holds no geometry, no ids and
 * no branch dispatch, so it can be read without the element normalizer around it.
 */

import { type SizeMode } from "../types";
import { deepEqual } from "../../deep-equal";
import { LAYOUT_FIELD_TO_FLAT } from "../layout-flat";
import { canonicalKey, isPlainObject, ElementType, NormalizationRepair } from "./shared";
import { sizeModeFrom, type SizingAxis } from "./text-sizing";
import { expandTextStyleShorthand } from "./shorthand";
import { LAYOUT_FIELDS } from "./auto-layout";

// ---------------------------------------------------------------------------
// flat CSS authored surface
// ---------------------------------------------------------------------------

/**
 * The top-level text keys that fold into `style`, and — seen from the other
 * side — every CSS spelling a key inside `style` may use. Exported because the
 * rig that grades the aliases iterates this table instead of restating it.
 */
export const FLAT_TEXT_KEYS: Record<string, string> = {
  "font-size": "fontSize",
  "font-weight": "fontWeight",
  "font-family": "fontFamily",
  "font-style": "fontStyle",
  "line-height": "lineHeight",
  "letter-spacing": "letterSpacing",
  "text-align": "align",
  "text-transform": "textTransform",
  "text-decoration": "textDecoration",
  // These have no element-level spelling at all: they live on `style` only, and
  // were rejected at the top level even though the engine read them a level
  // down. `line-clamp` is the standard property; `-webkit-line-clamp` is what
  // the shipped web actually writes, and `canonicalKey` cannot rebuild the
  // leading dash from `webkitLineClamp`, so the bare form is listed too.
  "vertical-align": "verticalAlign",
  "text-shadow": "textShadow",
  "font-variant-numeric": "fontVariantNumeric",
  "text-overflow": "textOverflow",
  "line-clamp": "maxLines",
  "-webkit-line-clamp": "maxLines",
  "webkit-line-clamp": "maxLines",
  // The DSL's own name, which `style` reads and the top level refused — so the
  // CSS spelling folded to a target the same author could not write directly.
  "max-lines": "maxLines",
  maxLines: "maxLines",
  // CSS's text ink. The paint layer reads a bare `color` as a fill; for text
  // both roads lead to the same paint (`element-branches/text.ts` derives
  // `style.color` from the top fill and the fill from `style.color`), and
  // folding here is what lets the writer state the colour the way CSS does.
  color: "color"
};

/**
 * Every `layout` spelling, to the canonical `AutoLayout` field it names. It is
 * the HINT table: a stray flat `columns` — which the flat surface reaches through
 * `grid-template-columns` — still points the author at the flat key rather than
 * saying nothing.
 */
const LAYOUT_HINT: Record<string, string> = Object.fromEntries(
  Object.entries(LAYOUT_FIELDS).flatMap(([field, spellings]) => spellings.map((spelling) => [spelling, field]))
);

/** The same table, widened to a field-name index so a hint can look one up. */
const FLAT_FIELD_NAME: Record<string, string> = LAYOUT_FIELD_TO_FLAT;

/**
 * Where a stray flat key belongs, for the unknown-key message. Derived from the
 * vocabulary tables rather than a second hand-written list, so a spelling added
 * to `LAYOUT_FIELDS` or `FLAT_TEXT_KEYS` cannot leave the hint behind.
 *
 * A `style.*` hint is offered only on a `text` element: the text spellings are
 * folded into `style` there before this runs, and `style.fontSize` on a frame is
 * the misleading half of the old hard-coded pair — a frame has no `style`.
 */
export function flatKeyHint(key: string, type: ElementType): string | undefined {
  const c = canonicalKey(key);
  const layoutField = LAYOUT_HINT[c];
  if (layoutField) return FLAT_FIELD_NAME[layoutField] ?? layoutField;
  if (type !== "text") return undefined;
  const textTarget = FLAT_TEXT_KEYS[c];
  return textTarget ? `style.${textTarget}` : undefined;
}

/**
 * A `width`/`height` that names a sizing MODE rather than a length, or the
 * sentinel `"percent"` for a percentage the DSL cannot hold (only `100%` maps to
 * `fill`; every other percentage is reported). A number or `"240px"` returns
 * `undefined` here and stays the authored pixel size it always was.
 */
export function flatSizeMode(raw: unknown, axis: SizingAxis): SizeMode | "percent" | undefined {
  if (typeof raw === "string") {
    const match = raw.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (match) return match[1] === "100" ? "fill" : "percent";
  }
  return sizeModeFrom(raw, axis);
}

/**
 * The keys a text `style` may hold that are NOT CSS properties, by their canonical
 * spelling, mapped to the name the reader stores them under.
 *
 * `normalizeTextStyle` reads `fill` / `textColor` for ink, `size` / `weight` for
 * the two numbers, and `tokenBindings` for the binding axis. Keyed by the
 * canonical form so `tokenBinding`'s three spellings (`tokenBindings`,
 * `token_bindings`, `token-bindings`) all reach the field, which is what makes
 * this a folding table rather than a whitelist that would report a key the
 * reader still honours.
 */
const STYLE_KEY_CANON: Record<string, string> = {
  fill: "fill",
  "text-color": "textColor",
  size: "size",
  weight: "weight",
  "token-bindings": "tokenBindings"
};

/** The stored vocabulary itself — a `style` that already says `align` needs no folding. */
const STORED_TEXT_KEYS: ReadonlySet<string> = new Set(Object.values(FLAT_TEXT_KEYS));

/**
 * Canonicalizes the keys INSIDE a text `style` object — the same surface as the
 * element level, one level down. Without this, `style.textAlign` (CSS's camel
 * spelling) was neither read nor reported: `normalizeTextStyle` looked only at
 * `style.align`, so the author's centring vanished with `repairs: 0` while the
 * same spelling at the element level folded correctly. Accepted-but-unapplied is
 * worse than rejected, so the second half of this pass is a gate: whatever is
 * still unknown after folding is named instead of dropped in silence.
 *
 * A canonical key wins over an alias that names it — the stored vocabulary is
 * the more specific statement — and a conflict between two spellings that
 * disagree is reported, since one of the two values is being thrown away.
 */
export function canonicalizeStyleKeys(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[]
): Record<string, unknown> {
  if (!isPlainObject(raw)) return {};
  const style = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const aliases: Array<{ key: string; target: string; value: unknown }> = [];
  const unknown: string[] = [];

  for (const key of Object.keys(style)) {
    // snake_case is not a dialect spelling; folding it would make this nested
    // reader accept a key the element-level gate refuses.
    if (key.includes("_")) {
      unknown.push(key);
      continue;
    }
    const canonical = canonicalKey(key);
    const target = FLAT_TEXT_KEYS[canonical];
    if (target !== undefined) {
      if (target === key) out[key] = style[key];
      else aliases.push({ key, target, value: style[key] });
    } else if (STORED_TEXT_KEYS.has(key)) {
      out[key] = style[key];
    } else {
      const stored = STYLE_KEY_CANON[canonical];
      if (stored) out[stored] = style[key];
      else unknown.push(key);
    }
  }
  for (const { key, target, value } of aliases) {
    if (out[target] === undefined) {
      out[target] = value;
    } else if (!deepEqual(out[target], value)) {
      repairs?.push({
        kind: "dropped-property",
        path: `${path ?? ""}/style/${key}`,
        message: `"${key}" ignored: style.${target} is already ${JSON.stringify(out[target])}`
      });
    }
  }
  for (const key of unknown) {
    repairs?.push({
      kind: "dropped-property",
      path: `${path ?? ""}/style/${key}`,
      message: `unknown property "${key}" is unsupported inside style; dropped`
    });
  }
  return out;
}

/**
 * Folds the top-level text keys into `style`, which is the one slot that reads
 * them, so this always creates the nested object and only reports the move.
 * The layout surface is NOT folded — its flat keys are the storage vocabulary,
 * read directly by `readFlatAutoLayout`.
 */
export function absorbFlatText(
  el: Record<string, unknown>,
  type: ElementType,
  path: string,
  repairs: NormalizationRepair[]
): Record<string, unknown> {
  if (type !== "text") return el;
  const folds: Array<{ key: string; target: string; value: unknown }> = [];
  for (const key of Object.keys(el)) {
    // `canonicalKey` folds `_` onto `-`, so a snake key matched here and was
    // deleted before the unknown-key gate ever saw it: `font_size` was applied
    // while `border_radius` was refused, one rule for two spellings of the same
    // thing. Left alone, both reach the gate and are refused by name. Inside
    // `style` snake_case is still read — that is a different vocabulary.
    if (key === "style" || key.includes("_")) continue;
    const target = FLAT_TEXT_KEYS[canonicalKey(key)];
    if (target) folds.push({ key, target, value: el[key] });
  }
  if (folds.length === 0) return el;

  // A `style` string is the compact shorthand (`"600 14 #fff"`), not a slot with
  // keys — expanding it first is what keeps a fold from replacing it with an
  // object holding only the folded key.
  const style: Record<string, unknown> = isPlainObject(el.style)
    ? { ...(el.style as Record<string, unknown>) }
    : typeof el.style === "string"
      ? { ...expandTextStyleShorthand(el.style) }
      : {};
  // `style` may already hold the field under any spelling (`textAlign`), and that
  // is the same statement as `style.align`: reading only the canonical key let an
  // outer `text-align` overwrite a `style.textAlign` that the inner level would
  // have won against had it been spelled `align`.
  const held = (target: string): { key: string; value: unknown } | undefined => {
    if (style[target] !== undefined) return { key: target, value: style[target] };
    for (const key of Object.keys(style)) {
      if (FLAT_TEXT_KEYS[canonicalKey(key)] === target) return { key, value: style[key] };
    }
    return undefined;
  };
  for (const { key, target, value } of folds) {
    const existing = held(target);
    if (!existing) {
      // Silent: this is the level the dialect WRITES (`document-json` flattens
      // the text style on the way out), so reporting it would put one info
      // repair on every text in every saved file and drown the real ones.
      style[target] = value;
    } else if (!deepEqual(existing.value, value)) {
      repairs.push({ kind: "dropped-property", path: `${path}/${key}`, message: `outer "${key}" ignored: style.${existing.key} is already set` });
    }
  }
  const out: Record<string, unknown> = { ...el, style };
  for (const { key } of folds) delete out[key];
  return out;
}
