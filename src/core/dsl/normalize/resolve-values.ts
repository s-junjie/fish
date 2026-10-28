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
 *    and useful in copy as much as in a length.
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

const normalizeVarName = (name: string): string => {
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
function splitTopComma(inner: string): { name: string; fallback?: string } {
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
function hasVarCall(input: string): boolean {
  if (!input.includes("(")) return false;
  return input.toLowerCase().includes("var(");
}

/** One substitution sweep: every outer `var(...)` whose name resolves (or has a
 * fallback) is replaced. An unresolved `var(...)` with no fallback is left in
 * place, so a later sweep cannot loop on it and the caller can report it. */
function substituteOnce(input: string, vars: Variables): string {
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
    const value = vars[normalizeVarName(name)];
    if (value !== undefined) {
      result += String(value);
    } else if (fallback !== undefined && fallback.trim() !== "") {
      result += substituteOnce(fallback.trim(), vars);
    } else {
      result += input.slice(idx, j + 1);
    }
    cursor = j + 1;
  }
}

function resolveVars(input: string, vars: Variables): string {
  if (!hasVarCall(input)) return input;
  let out = input;
  for (let i = 0; i < 10; i++) {
    const next = substituteOnce(out, vars);
    if (next === out) return out;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// a small px/bare calculator for constant calc() / min() / max() / clamp()
// ---------------------------------------------------------------------------

/** A length: `px: true` means the number is px, `false` means it is unitless. */
interface Len {
  px: boolean;
  v: number;
}

type Token = { t: "num"; len: Len } | { t: "op"; v: string } | { t: "(" } | { t: ")" } | { t: "," } | { t: "fn"; name: string };

const FUNCTIONS = new Set(["calc", "min", "max", "clamp"]);

function tokenize(input: string, root: number): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(" || ch === ")" || ch === ",") { tokens.push({ t: ch }); i++; continue; }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") { tokens.push({ t: "op", v: ch }); i++; continue; }
    const num = /^\d*\.?\d+/.exec(input.slice(i));
    if (num) {
      let j = i + num[0].length;
      const unit = /^(px|rem)/.exec(input.slice(j))?.[1];
      const isRem = unit === "rem";
      const isPx = unit === "px" || isRem;
      const v = Number(num[0]) * (isRem ? root : 1);
      tokens.push({ t: "num", len: { px: isPx, v } });
      i = j + (unit ? unit.length : 0);
      continue;
    }
    const name = /^[a-z]+/i.exec(input.slice(i));
    if (name && FUNCTIONS.has(name[0].toLowerCase())) {
      tokens.push({ t: "fn", name: name[0].toLowerCase() });
      i += name[0].length;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function evaluate(input: string, root: number): Len | undefined {
  const tokens = tokenize(input, root);
  if (!tokens) return undefined;
  let i = 0;
  const peek = (): Token | undefined => tokens[i];

  const addSub = (): Len | null => {
    let left = mulDiv();
    if (!left) return null;
    for (;;) {
      const t = peek();
      if (t?.t !== "op" || (t.v !== "+" && t.v !== "-")) break;
      i++;
      const right = mulDiv();
      if (!right || left.px !== right.px) return null;
      left = { px: left.px, v: t.v === "+" ? left.v + right.v : left.v - right.v };
    }
    return left;
  };

  const mulDiv = (): Len | null => {
    let left = factor();
    if (!left) return null;
    for (;;) {
      const t = peek();
      if (t?.t !== "op" || (t.v !== "*" && t.v !== "/")) break;
      i++;
      const right = factor();
      if (!right) return null;
      if (t.v === "*") {
        if (left.px && right.px) return null;
        left = { px: left.px || right.px, v: left.v * right.v };
      } else {
        if (right.px || !right.v) return null;
        left = { px: left.px, v: left.v / right.v };
      }
    }
    return left;
  };

  const factor = (): Len | null => {
    const t = peek();
    if (!t) return null;
    if (t.t === "op" && (t.v === "+" || t.v === "-")) {
      i++;
      const inner = factor();
      return inner ? { px: inner.px, v: t.v === "-" ? -inner.v : inner.v } : null;
    }
    if (t.t === "num") {
      i++;
      return t.len;
    }
    if (t.t === "(") {
      i++;
      const inner = addSub();
      if (!inner || peek()?.t !== ")") return null;
      i++;
      return inner;
    }
    if (t.t === "fn") {
      i++;
      if (peek()?.t !== "(") return null;
      i++;
      const args: Len[] = [];
      for (;;) {
        const arg = addSub();
        if (!arg) return null;
        args.push(arg);
        if (peek()?.t === ",") {
          i++;
          continue;
        }
        break;
      }
      if (peek()?.t !== ")" || !args.every((a) => a.px === args[0].px)) return null;
      i++;
      const vals = args.map((a) => a.v);
      if (t.name === "calc") return args.length === 1 ? args[0] : null;
      if (t.name === "min") return args.length ? { px: args[0].px, v: Math.min(...vals) } : null;
      if (t.name === "max") return args.length ? { px: args[0].px, v: Math.max(...vals) } : null;
      if (t.name === "clamp" && args.length === 3) {
        return { px: args[0].px, v: Math.min(vals[2], Math.max(vals[0], vals[1])) };
      }
      return null;
    }
    return null;
  };

  const value = addSub();
  return i === tokens.length ? value ?? undefined : undefined;
}

/** A resolved length as a canonical px string, or `undefined` when unreadable. */
function toPx(expr: string, root: number): number | undefined {
  const len = evaluate(expr.trim(), root);
  return len?.v;
}

/**
 * Folds a length string to px when it is a length this pass understands: a
 * single `<n>` / `<n>px` / `<n>rem` / constant `calc`-family expression, or a
 * whitespace shorthand (`"1rem 2rem"`) whose every token is one. Anything else
 * (`"50%"`, `"2em"`, a colour) is returned unchanged.
 */
function rewriteLengthString(input: string, root: number): string {
  const whole = toPx(input, root);
  if (whole !== undefined) return `${whole}px`;

  const parts = splitTopLevel(input.trim());
  if (parts.length < 2) return input;
  const nums = parts.map((p) => toPx(p, root));
  if (nums.some((n) => n === undefined)) return input;
  return nums.map((n) => `${n}px`).join(" ");
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
  forceLength = false
): unknown {
  if (typeof value === "string") {
    let out = resolveVars(value, vars);
    if (hasVarCall(out)) unresolved.push({ path, text: value });
    if (key !== undefined && TRACK_LIST_KEYS.has(canonicalKey(key))) {
      out = rewriteTrackList(out, ROOT_FONT_SIZE);
    } else if (forceLength || (key !== undefined && LENGTH_KEYS.has(canonicalKey(key)))) {
      out = rewriteLengthString(out, ROOT_FONT_SIZE);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((entry, index) => walk(entry, key, vars, `${path}/${index}`, unresolved, forceLength));
  if (isPlainObject(value)) {
    // A side of a box shape is a length even though its own key (`top`, `left`,
    // `topLeft`) is not in `LENGTH_KEYS` — otherwise `padding: { top: "2rem" }`
    // reached the reader un-folded and the reader's own `?? 0` zeroed the side.
    const forceChildren = key !== undefined && BOX_SHAPE_KEYS.has(canonicalKey(key));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k, vars, `${path}/${k}`, unresolved, forceChildren);
    return out;
  }
  return value;
}

/**
 * Returns a copy of `input` with every `var()` against `vars` and every
 * understood length token folded, plus the paths of any `var()` that could not
 * be resolved (so the caller can say so rather than ship a broken value).
 */
export function resolveValueTokens(input: unknown, vars: Variables): ResolvedValues {
  const unresolved: UnresolvedVar[] = [];
  const value = walk(input, undefined, vars, "", unresolved);
  return { value, unresolved };
}
