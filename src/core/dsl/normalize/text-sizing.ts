import type { TextStyle, TextSpan, AutoLayout, SizeMode, ElementSizing, ColorFilter, LineHeight, LetterSpacing } from "../types";
import { asNumber, clamp, canonicalKey, isPlainObject, lengthUnit, pxLength, ALIGN_ALIASES, VERTICAL_ALIGN_ALIASES, FONT_WEIGHT_WORDS, SIZE_MODE_ALIASES, ElementType, NormalizationRepair } from "./shared";
import { canonicalizeStyleKeys } from "./css-absorb";
import { WIDTH_SIZING_MODES } from "../schema-enums";
import { DEFAULT_FONT_FAMILY } from "../../font-stack";
import { normalizeTextDecoration } from "../text-decoration";
import { expandSizingShorthand, expandTextStyleShorthand } from "./shorthand";

/**
 * `textDecoration` in either spelling of the key, in either shape of the value.
 *
 */
const readTextDecoration = (style: Record<string, unknown>) =>
  normalizeTextDecoration(style.textDecoration);

/**
 * The same read on a RUN, where an explicitly empty set is a value rather than an
 * absence: `[]` says "no lines here", which is how a line comes off part of a
 * paragraph whose element draws it. See `normalizeTextDecoration`.
 */
const readSpanTextDecoration = (style: Record<string, unknown>) =>
  normalizeTextDecoration(style.textDecoration, { keepEmpty: true });

/**
 * Ceiling on `style.fontSize`. The value is pushed into the DOM and measured
 * (`text-measure.ts`), so an absurd one asks Chromium to lay out a gigapixel
 * line box, which is a multi-second freeze escalating to a renderer crash — and
 * it flows into the estimated text box as an SVG `width="7e17"`.
 */
export const MAX_FONT_SIZE = 1000;

/**
 * The size a text gets when the author names none.
 *
 * Named so that every reader that has to guess a size guesses the SAME one:
 * `validate` used to estimate a text box at 16px while normalize had already
 * committed 24px, so the same element measured two different heights depending
 * on who asked.
 */
export const DEFAULT_FONT_SIZE = 24;

export function normalizeFontWeight(raw: unknown): number | "normal" | "bold" | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return clamp(Math.round(raw), 1, 1000);
  if (typeof raw === "string") {
    const key = canonicalKey(raw);
    if (key === "normal") return "normal";
    if (key === "bold") return "bold";
    if (key in FONT_WEIGHT_WORDS) return FONT_WEIGHT_WORDS[key];
    const numeric = asNumber(key);
    if (numeric !== undefined) return clamp(Math.round(numeric), 1, 1000);
  }
  return undefined;
}

/**
 * A CSS `line-height` onto the DSL's tagged value. The unit decides the meaning,
 * never the magnitude (see `LineHeight`):
 *
 * - unitless / `em` → a multiplier, kept as a bare number
 * - `px` → an absolute length, kept as `"<n>px"`
 * - `%` → a multiplier (`150%` → `1.5`; no cross-element inheritance here, so a
 *   percentage and its ratio lay out identically)
 *
 * `normal` / `auto` / anything the parser does not recognise (a `rem`, a
 * `calc()`) → `undefined`, the engine's size-tiered default. The HTML importer
 * resolves the browser's own `normal` to a px FIRST (it can probe it), so an
 * imported box never reaches this fallback with a meaning to preserve.
 */
const LINE_HEIGHT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%|em)?$/;

export function normalizeLineHeight(raw: unknown): LineHeight | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const token = raw.trim().toLowerCase();
  if (!token || token === "normal" || token === "auto") return undefined;
  const match = LINE_HEIGHT_RE.exec(token);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (match[2] === "px") return `${Math.round(value * 100) / 100}px` as LineHeight;
  if (match[2] === "%") return Math.round((value / 100) * 100) / 100;
  return Math.round(value * 100) / 100;
}

/**
 * A CSS `letter-spacing` onto the DSL's tagged value. The unit decides the
 * meaning, never the magnitude (see `LetterSpacing`) — and the bare number is
 * the ABSOLUTE px spelling here, the opposite of `normalizeLineHeight`:
 *
 * - unitless / `px` → px, as a bare number (both spellings mean the same thing,
 *   so `"2px"` and `2` collapse to the one form the field has always used)
 * - `em` / `%` → `"<n>em"` (a percentage and its em ratio layout identically)
 *
 * `normal` / anything the parser does not recognise (a `rem`, a `calc()`) →
 * `undefined`, CSS's initial tracking.
 */
const LETTER_SPACING_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%|em)?$/;

export function normalizeLetterSpacing(raw: unknown): LetterSpacing | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const token = raw.trim().toLowerCase();
  if (!token || token === "normal") return undefined;
  const match = LETTER_SPACING_RE.exec(token);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  if (match[2] === "em") return `${Math.round(value * 100) / 100}em` as LetterSpacing;
  if (match[2] === "%") return `${Math.round((value / 100) * 100) / 100}em` as LetterSpacing;
  return Math.round(value * 100) / 100;
}

const FILTER_BOUNDS: Record<string, [number, number]> = {
  brightness: [0, Infinity],
  contrast: [0, Infinity],
  saturation: [0, Infinity],
  grayscale: [0, 1],
  invert: [0, 1],
  exposure: [-5, 5],
  temperature: [-1, 1],
  tint: [-1, 1],
  highlights: [-1, 1],
  shadows: [-1, 1]
};

export function normalizeColorFilter(raw: unknown): ColorFilter | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: ColorFilter = {};
  for (const [key, [min, max]] of Object.entries(FILTER_BOUNDS)) {
    const v = asNumber((raw as Record<string, unknown>)[key]);
    if (v !== undefined) (out as Record<string, number>)[key] = clamp(v, min, max);
  }
  const hue = asNumber((raw as any).hueRotate ?? (raw as any).hue);
  if (hue !== undefined) out.hueRotate = hue;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeTextStyle(
  raw: unknown,
  el: Record<string, unknown>,
  path?: string,
  repairs?: NormalizationRepair[]
): TextStyle {
  // Both halves of the authored surface land here: a compact `style` string is
  // expanded, then every key is canonicalized so `text-align`, `textAlign` and
  // `align` are one field before any reader looks at it.
  const style = canonicalizeStyleKeys(expandTextStyleShorthand(raw), path, repairs);
  // `%` and `em` font sizes name no box (the resolver folds `rem`/`calc` but not
  // these), so the reader falls back to the default rather than reading `150%` as
  // 150px (`asNumber("150%")` is 150). Say so: a wrong glyph size that no repair
  // mentions is the silent-failure class this normalizer exists to kill.
  const fontUnit = lengthUnit(style.fontSize ?? style.size);
  if (fontUnit && fontUnit !== "px" && fontUnit !== "") {
    repairs?.push({
      kind: "text",
      path: `${path ?? ""}/style/fontSize`,
      message: `fontSize ${JSON.stringify(style.fontSize ?? style.size)} carries "${fontUnit}"; fontSize is a px length and ${fontUnit} is not resolved here, so it fell back to the default 24`
    });
  }
  const color =
    (typeof style.color === "string" && style.color) ||
    (typeof style.fill === "string" && style.fill) ||
    (typeof style.textColor === "string" && style.textColor) ||
    (typeof el.color === "string" && el.color) ||
    (typeof el.textColor === "string" && el.textColor) ||
    "#000000";

  const alignRaw = typeof style.align === "string" ? canonicalKey(style.align) : undefined;
  const verticalRaw =
    typeof style.verticalAlign === "string" ? canonicalKey(style.verticalAlign) : undefined;

  const lineHeight = normalizeLineHeight(style.lineHeight);
  const letterSpacing = normalizeLetterSpacing(style.letterSpacing);
  const textTransform =
    typeof style.textTransform === "string" ? canonicalKey(style.textTransform) : undefined;

  const fontStyleRaw =
    typeof style.fontStyle === "string" ? canonicalKey(style.fontStyle) : undefined;
  const numericRaw =
    typeof style.fontVariantNumeric === "string" ? canonicalKey(style.fontVariantNumeric) : undefined;

  // Clamping is a whole number of lines, and "0 lines" would paint nothing while
  // still occupying the box — so the floor is 1, which is also the value that
  // means "never wrap".
  const maxLinesRaw = asNumber(style.maxLines);
  const maxLines =
    maxLinesRaw !== undefined && maxLinesRaw >= 1 ? Math.floor(maxLinesRaw) : undefined;
  const textOverflowRaw =
    typeof style.textOverflow === "string" ? canonicalKey(style.textOverflow) : undefined;

  const textDecoration = readTextDecoration(style);

  // Bound once, because the two spellings are re-read on both sides of the guard
  // and `style` is untyped: the `typeof` check narrows one expression and leaves
  // the next one `unknown`, so `.trim()` was a type error at every use.
  const textShadowRaw = style.textShadow;
  const textShadow = typeof textShadowRaw === "string" ? textShadowRaw.trim() : "";

  /* Keeping `textOverflow` out unless a line count gives it something to cut is
     right — a box that clamps nothing has nothing to ellipsize. Doing it without
     a word is not: `text-overflow: ellipsis` on its own looked applied and
     changed no pixel. Round-trips are unaffected, because the writer only emits
     the field alongside a `maxLines`. */
  if (repairs && textOverflowRaw !== undefined) {
    if (!["clip", "ellipsis"].includes(textOverflowRaw)) {
      repairs.push({
        kind: "dropped-property",
        path: `${path ?? ""}/style/textOverflow`,
        message: `textOverflow "${textOverflowRaw}" is not one of clip | ellipsis; ignored`
      });
    } else if (maxLines === undefined) {
      repairs.push({
        kind: "dropped-property",
        path: `${path ?? ""}/style/textOverflow`,
        message: `textOverflow "${textOverflowRaw}" needs a line count to clamp (maxLines); ignored`
      });
    }
  }

  return {
    // The family the author NAMED, never the fallback with it: the stack is
    // assembled at paint and measure time (`resolveStack`), so a family that is
    // not installed is detectable instead of hidden behind a generic.
    fontFamily: (typeof style.fontFamily === "string" && style.fontFamily) || DEFAULT_FONT_FAMILY,
    fontSize: Math.min(MAX_FONT_SIZE, Math.max(1, pxLength(style.fontSize ?? style.size) ?? DEFAULT_FONT_SIZE)),
    ...(normalizeFontWeight(style.fontWeight ?? style.weight) !== undefined
      ? { fontWeight: normalizeFontWeight(style.fontWeight ?? style.weight) }
      : {}),
    ...(fontStyleRaw && ["normal", "italic"].includes(fontStyleRaw)
      ? { fontStyle: fontStyleRaw as TextStyle["fontStyle"] }
      : {}),
    ...(numericRaw && ["normal", "tabular-nums"].includes(numericRaw)
      ? { fontVariantNumeric: numericRaw as TextStyle["fontVariantNumeric"] }
      : {}),
    ...(lineHeight !== undefined ? { lineHeight } : {}),
    ...(letterSpacing !== undefined ? { letterSpacing } : {}),
    ...(alignRaw && ALIGN_ALIASES[alignRaw] ? { align: ALIGN_ALIASES[alignRaw] } : {}),
    ...(verticalRaw && VERTICAL_ALIGN_ALIASES[verticalRaw]
      ? { verticalAlign: VERTICAL_ALIGN_ALIASES[verticalRaw] }
      : {}),
    color,
    ...(textDecoration ? { textDecoration } : {}),
    ...(textTransform && ["none", "uppercase", "lowercase", "capitalize"].includes(textTransform)
      ? { textTransform: textTransform as TextStyle["textTransform"] }
      : {}),
    ...(maxLines !== undefined ? { maxLines } : {}),
    // Kept out of the document unless a line count gives it something to cut: a
    // lone `textOverflow: "ellipsis"` on a box that clamps nothing would round-trip
    // as a capability in use and change no pixel.
    ...(maxLines !== undefined && textOverflowRaw && ["clip", "ellipsis"].includes(textOverflowRaw)
      ? { textOverflow: textOverflowRaw as TextStyle["textOverflow"] }
      : {}),
    ...(textShadow ? { textShadow } : {}),
    ...(isPlainObject(style.tokenBindings)
      ? { tokenBindings: style.tokenBindings as Record<string, string> }
      : {})
  };
}

export function normalizeSpanStyle(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[]
): TextSpan["style"] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const rawStyle = { ...(raw as Record<string, unknown>) };
  if (Object.prototype.hasOwnProperty.call(rawStyle, "tokenId")) {
    delete rawStyle.tokenId;
    repairs?.push({
      kind: "dropped-property",
      path: `${path ?? ""}/style/tokenId`,
      message:
        "span tokenId is unsupported: run colour is literal; bind a colour token on the text element's fills[].tokenId"
    });
  }
  const style = canonicalizeStyleKeys(rawStyle, path, repairs);
  const out: NonNullable<TextSpan["style"]> = {};

  if (typeof style.fontFamily === "string" && style.fontFamily) {
    out.fontFamily = style.fontFamily;
  }
  const size = pxLength(style.fontSize ?? style.size);
  if (size !== undefined && size > 0) {
    out.fontSize = Math.min(MAX_FONT_SIZE, size);
  }
  const weight = normalizeFontWeight(style.fontWeight ?? style.weight);
  if (weight !== undefined) {
    out.fontWeight = weight;
  }
  const fontStyle = typeof style.fontStyle === "string" ? canonicalKey(style.fontStyle) : undefined;
  if (fontStyle && ["normal", "italic"].includes(fontStyle)) {
    out.fontStyle = fontStyle as TextStyle["fontStyle"];
  }
  const color = (typeof style.color === "string" && style.color) || (typeof style.fill === "string" && style.fill);
  if (color) {
    out.color = color;
  }
  // `0` is a VALUE on a run, not an absence: it is how a run inside a spaced
  // paragraph says it is set normally. The element's own default is the absent
  // key, which is the same reading the LS field has always had.
  const letterSpacing = normalizeLetterSpacing(style.letterSpacing);
  if (letterSpacing !== undefined) {
    out.letterSpacing = letterSpacing;
  }
  const decoration = readSpanTextDecoration(style);
  if (decoration) {
    out.textDecoration = decoration;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalizes an authored `spans` array or extracts spans from inline HTML tags in `content`
 * like `<b>bold</b>`, `<u>underline</u>`, `<s>strikethrough</s>`, or `<span style="...">text</span>`.
 */
export function normalizeTextSpans(
  rawSpans: unknown,
  content: string,
  path?: string,
  repairs?: NormalizationRepair[]
): { content: string; spans?: TextSpan[] } {
  if (Array.isArray(rawSpans) && rawSpans.length > 0) {
    const validSpans: TextSpan[] = [];
    rawSpans.forEach((item, index) => {
      const itemPath = `${path ?? ""}/spans/${index}`;
      if (typeof item === "string") {
        validSpans.push({ text: item });
        return;
      }
      if (!isPlainObject(item) || typeof (item as any).text !== "string") {
        repairs?.push({
          kind: "dropped-property",
          path: itemPath,
          message: "span is not an object with a text string; dropped"
        });
        return;
      }
      const text = (item as any).text as string;
      for (const key of Object.keys(item)) {
        if (key === "text" || key === "style") continue;
        repairs?.push({
          kind: "dropped-property",
          path: `${itemPath}/${key}`,
          message:
            key === "tokenId"
              ? "span tokenId is unsupported: run colour is literal; bind a colour token on the text element's fills[].tokenId"
              : key === "color"
                ? 'span property "color" is unsupported; write style.color'
                : `span property "${key}" is unsupported; only "text" and "style" are read`
        });
      }
      const rawStyle = (item as any).style;
      let style: TextSpan["style"] | undefined;
      if (rawStyle === undefined) {
        style = undefined;
      } else if (isPlainObject(rawStyle)) {
        style = normalizeSpanStyle(rawStyle, itemPath, repairs);
      } else {
        repairs?.push({
          kind: "dropped-property",
          path: `${itemPath}/style`,
          message:
            typeof rawStyle === "string"
              ? 'span style must be an object, not a CSS declaration string; write style: { color: "…" }'
              : "span style must be an object; dropped"
        });
      }
      validSpans.push(style ? { text, style } : { text });
    });
    if (validSpans.length > 0) {
      const fullContent = validSpans.map((s) => s.text).join("");
      return { content: fullContent, spans: validSpans };
    }
  }

  // If no explicit spans, check whether content contains standard inline HTML tags —
  // and only a STYLING one, at that.
  //
  // The gate used to be "contains `<` and `>`", which made any tag-shaped text
  // markup: a text whose content is `<fish/>` was read as a `<fish>` element and
  // its glyphs were dropped, so the only reason a logo survived is that it was the
  // WHOLE content (nothing was left to be a run — the parser returned null). One
  // trailing space was enough to lose the logo: measured, `<fish/> ` normalized to
  // `" "`. Markup is only markup when it carries a format the engine draws; a tag
  // nobody handles is TEXT. See `INLINE_SPAN_TAGS`.
  if (content && content.includes("<") && INLINE_SPAN_TAG_RE.test(content)) {
    const parsed = parseInlineHtmlSpans(content);
    if (parsed) return parsed;
  }

  return { content };
}

/** The tags the parser below draws. Anything else is text, not markup. */
const INLINE_SPAN_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "strike", "del", "span"]);
const INLINE_SPAN_TAG_RE = /<\/?(?:b|strong|i|em|u|s|strike|del|span)\b/i;

/**
 * Parses simple inline HTML markup (e.g. `<b>`, `<u>`, `<s>`, `<span style="...">`)
 * into plain text content + structured TextSpan array for AI convenience.
 *
 * A tag outside `INLINE_SPAN_TAGS` is left in the text verbatim — see the gate in
 * `normalizeTextSpans`. It used to be consumed and dropped, which deleted whatever
 * text the author had written between angle brackets.
 */
function parseInlineHtmlSpans(html: string): { content: string; spans: TextSpan[] } | null {
  const TAG_REGEX = /<(\/)?([a-zA-Z0-9]+)([^>]*)>/g;
  if (!TAG_REGEX.test(html)) return null;
  TAG_REGEX.lastIndex = 0;

  const spans: TextSpan[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const styleStack: Array<NonNullable<TextSpan["style"]>> = [];

  const currentMergedStyle = (): NonNullable<TextSpan["style"]> => {
    const merged: NonNullable<TextSpan["style"]> = {};
    for (const layer of styleStack) {
      for (const [key, value] of Object.entries(layer)) {
        if (key === "textDecoration") {
          // Nested markup ADDS lines rather than replacing them: `<u><s>x</s></u>`
          // draws both, and a plain `Object.assign` keeps whatever tag was pushed
          // last, so the outer one would vanish for no reason the author could see.
          // Every other key holds a single value, and there the innermost tag is
          // the one that means to win.
          merged.textDecoration = normalizeTextDecoration(
            [...(merged.textDecoration ?? []), ...((value as string[] | undefined) ?? [])],
            { keepEmpty: true }
          );
        } else {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
    }
    return merged;
  };

  while ((match = TAG_REGEX.exec(html)) !== null) {
    const [fullTag, isClose, tagNameRaw, attrString] = match;
    const tagName = tagNameRaw.toLowerCase();
    // A tag this parser cannot draw stays in the text: neither consumed (which
    // deleted it) nor opened as a style layer (which pushed an empty one every
    // closing tag then popped). `lastIndex` — the chunk cursor — deliberately does
    // NOT move, so the whole tag comes back as literal characters in the next
    // chunk; the regex cursor moves one past the `<` so the same tag is not
    // matched again.
    if (!INLINE_SPAN_TAGS.has(tagName)) {
      TAG_REGEX.lastIndex = match.index + 1;
      continue;
    }
    const textChunk = html.slice(lastIndex, match.index);

    if (textChunk) {
      const style = currentMergedStyle();
      spans.push(Object.keys(style).length > 0 ? { text: textChunk, style } : { text: textChunk });
    }

    lastIndex = match.index + fullTag.length;

    if (isClose) {
      if (styleStack.length > 0) {
        styleStack.pop();
      }
    } else {
      const newStyle: NonNullable<TextSpan["style"]> = {};
      if (tagName === "b" || tagName === "strong") newStyle.fontWeight = "bold";
      // `INLINE_SPAN_TAGS` promises these are DRAWN, so each one needs a line here:
      // a tag that is consumed without producing a style is indistinguishable from
      // the tag being deleted, which is the defect the unknown-tag branch closes.
      else if (tagName === "i" || tagName === "em") newStyle.fontStyle = "italic";
      else if (tagName === "u") newStyle.textDecoration = ["underline"];
      else if (tagName === "s" || tagName === "strike" || tagName === "del") newStyle.textDecoration = ["line-through"];
      else if (tagName === "span" && attrString) {
        // parse style="..."
        const styleMatch = /style=["']([^"']*)["']/i.exec(attrString);
        if (styleMatch) {
          const declarations = styleMatch[1].split(";");
          for (const decl of declarations) {
            const [prop, val] = decl.split(":").map((s) => s.trim().toLowerCase());
            if (!prop || !val) continue;
            if (prop === "color") newStyle.color = val;
            else if (prop === "font-weight") {
              const w = normalizeFontWeight(val);
              if (w !== undefined) newStyle.fontWeight = w;
            } else if (prop === "font-size") {
              const sz = asNumber(val.replace("px", ""));
              if (sz !== undefined && sz > 0) newStyle.fontSize = sz;
            } else if (prop === "font-family") newStyle.fontFamily = val.replace(/['"]/g, "");
            else if (prop === "letter-spacing") {
              const ls = normalizeLetterSpacing(val);
              if (ls !== undefined) newStyle.letterSpacing = ls;
            } else if (prop === "font-style" && (val === "italic" || val === "normal")) {
              // `normal` is a value here, not the absence of one: it is how a run
              // inside an italic paragraph says it is upright.
              newStyle.fontStyle = val;
            } else if (prop === "text-decoration") {
              const lines = normalizeTextDecoration(val, { keepEmpty: true });
              if (lines) newStyle.textDecoration = lines;
            }
          }
        }
      }
      styleStack.push(newStyle);
    }
  }

  const remaining = html.slice(lastIndex);
  if (remaining) {
    const style = currentMergedStyle();
    spans.push(Object.keys(style).length > 0 ? { text: remaining, style } : { text: remaining });
  }

  if (spans.length === 0) return null;
  const content = spans.map((s) => s.text).join("");
  return { content, spans };
}

// ---------------------------------------------------------------------------
// sizing
// ---------------------------------------------------------------------------

/** CSS-ish spellings the model reaches for, mapped onto the four canonical modes. */
export type SizingAxis = "width" | "height";

export function sizeModeFrom(raw: unknown, axis: SizingAxis): SizeMode | undefined {
  if (typeof raw !== "string" && typeof raw !== "boolean") return undefined;
  const mode = SIZE_MODE_ALIASES[canonicalKey(String(raw))];
  if (!mode) return undefined;
  return mode === "max-content" && axis === "height" ? "fit-content" : mode;
}

/** The four size bounds, in the one spelling the DSL and CSS agree on. */
const BOUND_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
const BOUND_CANONICAL = new Set((BOUND_KEYS as readonly string[]).map(canonicalKey));
const isBoundKey = (key: string): boolean => BOUND_CANONICAL.has(canonicalKey(key));

const BOUND_VARIANTS: Record<typeof BOUND_KEYS[number], readonly string[]> = {
  minWidth: ["minWidth", "min-width"],
  maxWidth: ["maxWidth", "max-width"],
  minHeight: ["minHeight", "min-height"],
  maxHeight: ["maxHeight", "max-height"]
};

export function normalizeElementSizing(
  rawInput: unknown,
  path: string,
  repairs: NormalizationRepair[]
): ElementSizing | undefined {
  const raw = expandSizingShorthand(rawInput);
  if (!isPlainObject(raw)) {
    // A misspelt shorthand (`"max-contentpx"`) used to return here in silence,
    // leaving the element at whatever size it inherited and `repairs` empty.
    if (typeof rawInput === "string" ? rawInput.trim() !== "" : rawInput != null) {
      repairs.push({
        kind: "sizing",
        path: `${path}/sizing`,
        message:
          typeof rawInput === "string"
            ? `sizing ${JSON.stringify(rawInput)} is not a sizing mode; expected "fill", "hug", "max-content", "fixed", a two-token shorthand such as "fill hug", or an object with width/height`
            : `sizing ${JSON.stringify(rawInput)} is not a mode string or an object; expected e.g. "max-content hug" or { width, height }`
      });
    }
    return undefined;
  }

  const out: ElementSizing = {};
  // `"fixed"` is KEPT, not dropped as the default: an absent axis is `auto`, which
  // a grid cell stretches, so only the written-down value can say "this number is
  // the size" (see `axisIsPinned`).
  const set = (axis: SizingAxis, mode: SizeMode | undefined) => {
    if (!mode) return;
    if (axis === "width") out.width = mode;
    else if (mode !== "max-content") out.height = mode;
  };

  /**
   * The bound keys carry CSS's own names, because that is what an import writes
   * and what a hand reads — `min-width` and `sizing.minWidth` are the same
   * number. They are read before the mode, and they stand on their own: an
   * element can carry a bound without declaring a mode, since the bound only
   * has to bite when something else derives the size.
   */
  const bound = (key: string, value: unknown): void => {
    const unit = lengthUnit(value);
    const n = pxLength(value);
    if (n === undefined || !Number.isFinite(n) || n < 0) {
      repairs.push({
        kind: "sizing",
        path: `${path}/sizing/${key}`,
        message: `${JSON.stringify(value)} is not a px length${unit && unit !== "px" ? ` (carries "${unit}")` : ""}`
      });
      return;
    }
    (out as Record<string, unknown>)[key] = Math.round(n * 100) / 100;
  };
  for (const key of BOUND_KEYS) {
    for (const variant of BOUND_VARIANTS[key]) {
      if (raw[variant] !== undefined) {
        bound(key, raw[variant]);
        break;
      }
    }
  }

  if (raw.width !== undefined || raw.height !== undefined) {
    for (const axis of ["width", "height"] as const) {
      const raw_ = raw[axis];
      if (raw_ === undefined) continue;
      const mode = sizeModeFrom(raw_, axis);
      if (mode) {
        set(axis, mode);
        continue;
      }
      repairs.push({
        kind: "sizing",
        path: `${path}/sizing/${axis}`,
        message: `not a sizing mode (${WIDTH_SIZING_MODES.join("/")}); a pixel size goes in the element's own ${axis}`
      });
    }
    for (const key of Object.keys(raw)) {
      if (key !== "width" && key !== "height" && !isBoundKey(key)) {
        repairs.push({
          kind: "sizing",
          path: `${path}/sizing/${key}`,
          message: `unknown sizing key "${key}" (expected width/height)`
        });
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

