/**
 * Value-token resolution: CSS custom properties (`var()`) and the length forms
 * CSS authors reach for that are not plain px — `rem` and constant
 * `calc()` / `min()` / `max()` / `clamp()`.
 *
 * It runs ONCE, over the raw document, before any branch reads it, so every
 * reader keeps taking the plain number it always did and none of them has to
 * learn a unit. Two things are deliberately NOT general string rewriting:
 *
 *  - `var()` is resolved in EVERY string, because `var(--x)` is explicit syntax
 *    and useful in copy as much as in a length. The document's `assets` table is
 *    the one exception, and it is skip-by-bulk rather than by semantics: those
 *    strings are bitmaps, and scanning them is the pass's whole cost.
 *  - the length rewrite is confined to keys that HOLD a length (`LENGTH_KEYS`),
 *    plus the per-side keys of a box object (`padding: { top: "2rem" }`), so a
 *    text element whose `text` is literally `"2rem"` is left as written — a
 *    blind rewrite would have silently turned the words into `"32px"`.
 *
 * `%` and `em` are left alone: both need a reference box the document does not
 * carry at normalize time (`em` on `font-size` is the parent's size, which is
 * inheritance this dialect does not have), so they are NOT folded here. Each
 * reader that takes a px length then rejects a unit it cannot read through
 * `pxLength` and, where it has a repair channel, reports it — `gap`, `padding`,
 * `margin`, `fontSize`, the `x`/`y`/`width`/`height` geometry axes, `strokeWidth`
 * and the `sizing` bounds all say so instead of reading `"5%"` as 5px. A reader
 * with no repair channel (an effect offset) still falls back to its default
 * rather than the wrong number. `rem` needs no such reference — the root font
 * size is a constant — which is why it IS resolved here.
 */

import { canonicalKey, isPlainObject } from "./shared";
import { evalConstantPx, simplifyLengthExpr } from "../length-expr";

/** CSS's default root font size; the dialect has no field to change it. */
const ROOT_FONT_SIZE = 16;

/**
 * The keys whose string values are lengths, canonicalised. A `rem` or a constant
 * `calc()` under one of these is folded to px; anything under a key NOT listed
 * is left exactly as written. `lineHeight` is absent on purpose — a unitless
 * `1.5` there is a multiplier, and `"1.5px"` would be a different (always
 * wrong) thing. `columnSizes` / `rowSizes` are absent because `fr` is not a
 * length.
 */
const LENGTH_KEYS = new Set([
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "gap",
  "row-gap",
  "column-gap",
  "column-width-min",
  "padding",
  "margin",
  "border-radius",
  "corner-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "stroke-width",
  "letter-spacing",
  "font-size",
  "x",
  "y",
  "offset-x",
  "offset-y",
  "blur"
]);

/**
 * Keys whose value may be a per-side BOX object (`{ top, right, bottom, left }`,
 * and the `{ topLeft, … }` radius form). A side key is not a length key on its
 * own — `top`/`left` are also inset names — so it is only folded when the object
 * sits under one of these, which is the one shape where the key means "a side".
 */
const BOX_SHAPE_KEYS = new Set(["padding", "margin", "border-radius", "corner-radius"]);
/**
 * Grid track lists are a string of lengths AND non-lengths (`1fr`, `auto`), so
 * the whole-string length rewrite cannot fold them. Each track token is folded
 * on its own instead; `repeat()` and `minmax()` are descended into so a `rem`
 * inside them reaches `trackSizeOf`, which only knows px and fr.
 */
const TRACK_LIST_KEYS = new Set(["grid-template-columns", "grid-template-rows"]);


export type Variables = Record<string, string | number>;

export interface VarModeContext {
  theme?: string;
  numberMode?: string;
}

export type TokenVarFallback = (name: string, modes?: VarModeContext) => string | number | undefined;

export const normalizeVarName = (name: string): string => {
  const trimmed = name.trim();
  return trimmed.startsWith("--") ? trimmed.slice(2) : trimmed;
};

/** A document's `variables` object, keyed without the leading `--`. */
export function collectVariables(raw: unknown): Variables {
  const vars: Variables = {};
  if (!isPlainObject(raw)) return vars;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number") vars[normalizeVarName(key)] = value;
  }
  return vars;
}

/** The first top-level comma of `inner`, or `undefined` when there is none. */
export function splitTopComma(inner: string): { name: string; fallback?: string } {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return { name: inner.slice(0, i), fallback: inner.slice(i + 1) };
  }
  return { name: inner };
}

/**
 * Whether `input` contains a `var(` call, case-insensitively.
 *
 * `(` first, because it is a native scan with no allocation and every `var(`
 * needs one: the document is walked whole, so this test also runs over every
 * inlined bitmap. `toLowerCase()` used to run unconditionally, which copied
 * 39.6 MB of base64 twice per normalize and cost 23 ms of the 49 ms.
 */
export function hasVarCall(input: string): boolean {
  if (!input.includes("(")) return false;
  return input.toLowerCase().includes("var(");
}

/** Deep check for `var(...)` calls anywhere inside a raw JSON value. */
export function hasVarCallInValue(value: unknown): boolean {
  if (typeof value === "string") return hasVarCall(value);
  if (Array.isArray(value)) return value.some(hasVarCallInValue);
  if (isPlainObject(value)) return Object.values(value).some(hasVarCallInValue);
  return false;
}

/** One substitution sweep: every outer `var(...)` whose name resolves (or has a
 * fallback) is replaced. An unresolved `var(...)` with no fallback is left in
 * place, so a later sweep cannot loop on it and the caller can report it. */
function substituteOnce(
  input: string,
  vars: Variables,
  tokenFallback?: TokenVarFallback,
  modes?: VarModeContext
): string {
  const lower = input.toLowerCase();
  let result = "";
  let cursor = 0;
  for (;;) {
    const idx = lower.indexOf("var(", cursor);
    if (idx === -1) {
      result += input.slice(cursor);
      return result;
    }
    result += input.slice(cursor, idx);
    const open = idx + 4;
    let depth = 1;
    let j = open;
    for (; j < input.length; j++) {
      const ch = input[j];
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    if (depth !== 0) {
      result += input.slice(idx);
      return result;
    }
    const { name, fallback } = splitTopComma(input.slice(open, j));
    const key = normalizeVarName(name);
    const value = Object.prototype.hasOwnProperty.call(vars, key)
      ? vars[key]
      : tokenFallback?.(key, modes);
    if (value !== undefined) {
      result += String(value);
    } else if (fallback !== undefined && fallback.trim() !== "") {
      result += substituteOnce(fallback.trim(), vars, tokenFallback, modes);
    } else {
      result += input.slice(idx, j + 1);
    }
    cursor = j + 1;
  }
}

function resolveVars(
  input: string,
  vars: Variables,
  tokenFallback?: TokenVarFallback,
  modes?: VarModeContext
): string {
  if (!hasVarCall(input)) return input;
  let out = input;
  for (let i = 0; i < 10; i++) {
    const next = substituteOnce(out, vars, tokenFallback, modes);
    if (next === out) return out;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// a small px/bare/% calculator for constant calc() / min() / max() / clamp()
// ---------------------------------------------------------------------------

/** A resolved length as a canonical px string, or `undefined` when unreadable. */
function toPx(expr: string, root: number): number | undefined {
  return evalConstantPx(expr.trim(), root);
}

/**
 * Folds a length string when it is a length or CSS math expression this pass
 * understands: constant `px`/`rem`/bare sums fold to `<n>px`, while `%` and
 * `%`-bearing `calc`/`min`/`max`/`clamp` expressions fold their constant/rem
 * sub-terms (`calc(100% - 2rem)` → `calc(100% - 32px)`). Unsupported units
 * (`2em`, `90vw`) and colours are returned unchanged.
 */
function rewriteLengthToken(token: string, root: number): string | undefined {
  const whole = toPx(token, root);
  if (whole !== undefined) return `${whole}px`;
  return simplifyLengthExpr(token, root);
}

function rewriteLengthString(input: string, root: number): string {
  const whole = rewriteLengthToken(input, root);
  if (whole !== undefined) return whole;

  const parts = splitTopLevel(input.trim());
  if (parts.length < 2) return input;
  const rewritten = parts.map((p) => (p === "/" ? "/" : rewriteLengthToken(p, root)));
  if (rewritten.some((p) => p === undefined)) return input;
  return rewritten.join(" ");
}

/** Split on top-level commas, so `minmax(8px, 4px)` stays one argument. */
function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === ",") {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function rewriteTrackToken(token: string, root: number): string {
  const whole = toPx(token, root);
  if (whole !== undefined) return `${whole}px`;
  const call = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(token.trim());
  if (!call) return token;
  const name = call[1].toLowerCase();
  const inner = call[2];
  if (name === "repeat") {
    const parts = splitTopLevelCommas(inner);
    if (parts.length < 2) return token;
    const trackList = parts.slice(1).join(",");
    return `repeat(${parts[0].trim()}, ${rewriteTrackList(trackList, root)})`;
  }
  if (name === "minmax" || name === "fit-content") {
    return `${call[1]}(${splitTopLevelCommas(inner).map((part) => rewriteTrackToken(part.trim(), root)).join(", ")})`;
  }
  return token;
}

function rewriteTrackList(input: string, root: number): string {
  const parts = splitTopLevel(input.trim());
  if (parts.length === 0) return input;
  return parts.map((part) => rewriteTrackToken(part, root)).join(" ");
}

/** Split on whitespace that is not inside parentheses, so `max(8px, 4px) 1rem`
 * stays two tokens rather than three fragments. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      if (i > start) parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (start < input.length) parts.push(input.slice(start));
  return parts.filter(Boolean);
}

export interface UnresolvedVar {
  path: string;
  text: string;
}

export interface ResolvedValues {
  value: unknown;
  unresolved: UnresolvedVar[];
}

function walk(
  value: unknown,
  key: string | undefined,
  vars: Variables,
  path: string,
  unresolved: UnresolvedVar[],
  forceLength = false,
  tokenFallback?: TokenVarFallback,
  modes?: VarModeContext
): unknown {
  if (typeof value === "string") {
    let out = resolveVars(value, vars, tokenFallback, modes);
    if (hasVarCall(out)) unresolved.push({ path, text: value });
    if (key !== undefined && TRACK_LIST_KEYS.has(canonicalKey(key))) {
      out = rewriteTrackList(out, ROOT_FONT_SIZE);
    } else if (forceLength || (key !== undefined && LENGTH_KEYS.has(canonicalKey(key)))) {
      out = rewriteLengthString(out, ROOT_FONT_SIZE);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      walk(entry, key, vars, `${path}/${index}`, unresolved, forceLength, tokenFallback, modes)
    );
  }
  if (isPlainObject(value)) {
    const nextTheme = typeof value.themeMode === "string" && value.themeMode ? value.themeMode : modes?.theme;
    const nextNumberMode =
      typeof value.numberMode === "string" && value.numberMode ? value.numberMode : modes?.numberMode;
    const childModes =
      nextTheme !== modes?.theme || nextNumberMode !== modes?.numberMode
        ? { theme: nextTheme, numberMode: nextNumberMode }
        : modes;
    // A side of a box shape is a length even though its own key (`top`, `left`,
    // `topLeft`) is not in `LENGTH_KEYS` — otherwise `padding: { top: "2rem" }`
    // reached the reader un-folded and the reader's own `?? 0` zeroed the side.
    const forceChildren = key !== undefined && BOX_SHAPE_KEYS.has(canonicalKey(key));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // The document's bitmap table, and the one subtree that is bulk rather
      // than markup: a `data:` URI holds neither a `var()` nor a length, and it
      // costs `hasVarCall` a full scan of the payload to establish that — twice,
      // because the caller checks the result as well. Handed over as it stands;
      // `normalizeAssetRefs` reads the table itself.
      if (path === "" && k === "assets") {
        out[k] = v;
        continue;
      }
      out[k] = walk(v, k, vars, `${path}/${k}`, unresolved, forceChildren, tokenFallback, childModes);
    }
    return out;
  }
  return value;
}

/**
 * Returns a copy of `input` with every `var()` against `vars` (falling back
 * to `tokenFallback` when provided) and every understood length token folded,
 * plus the paths of any `var()` that could not be resolved (so the caller can
 * say so rather than ship a broken value).
 */
export function resolveValueTokens(
  input: unknown,
  vars: Variables,
  tokenFallback?: TokenVarFallback
): ResolvedValues {
  const unresolved: UnresolvedVar[] = [];
  const value = walk(input, undefined, vars, "", unresolved, false, tokenFallback);
  return { value, unresolved };
}
