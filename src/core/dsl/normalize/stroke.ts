import type { CornerRadius, ElementSizing, Stroke, StrokeSide, StrokeSideWeights } from "../types";
import { DEFAULT_DASH } from "../constants";
import { topLayer } from "../paint-stack";
import {
  collapseCorners,
  cornerRadiusEqual,
  parseDynamicLength,
  resolveDynamicBorderRadius,
  type ResolvedBorderRadiusSpec
} from "../length-expr";
import { asNumber, canonicalKey, isPlainObject, lengthUnit, pxLength, NormalizationRepair } from "./shared";
import { normalizePaint } from "./paint";

const LINE_CAPS: readonly string[] = ["butt", "round", "square"];
const LINE_JOINS: readonly string[] = ["miter", "round", "bevel"];

/** The CSS `<line-style>` keywords. */
const BORDER_STYLES: readonly string[] = [
  "none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"
];

/** The keywords no stroke style can express, reported instead of silently flattened. */
const DECORATIVE_BORDER_STYLES: readonly string[] = [
  "double", "groove", "ridge", "inset", "outset"
];

/** The element-level spellings that mean CSS's `border`, in either case. */
const BORDER_SPELLINGS: ReadonlySet<string> = new Set([
  "border", "border-color", "border-width", "border-style",
  "border-top", "border-right", "border-bottom", "border-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style"
]);

const SIDE_NAMES = ["top", "right", "bottom", "left"] as const;
type SideName = (typeof SIDE_NAMES)[number];
const sideCap = (side: SideName): string => side[0].toUpperCase() + side.slice(1);
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

function normalizeStrokeStyle(
  styleRaw: string | undefined,
  onDecorative?: (styleName: string) => void
): { style: NonNullable<Stroke["style"]>; none: boolean } {
  const styleName = styleRaw?.trim().toLowerCase();
  if (!styleName || styleName === "solid") return { style: "solid", none: false };
  if (styleName === "none" || styleName === "hidden") return { style: "solid", none: true };
  if (styleName === "dotted") return { style: "dotted", none: false };
  if (styleName === "dashed") return { style: "dashed", none: false };
  if (DECORATIVE_BORDER_STYLES.includes(styleName)) onDecorative?.(styleName);
  return { style: "dashed", none: false };
}

/**
 * Whether a stroke sits inside a closed box. `line` / `arrow` are open segments
 * with no inside, and a `path` may be either, so those keep the renderer's
 * `center` rather than being clipped to a contour nobody promised.
 */
const OPEN_STROKE_TYPES: ReadonlySet<string> = new Set(["path", "line", "arrow"]);

const sitsInsideBox = (type: unknown): boolean =>
  typeof type === "string" && type.trim() !== "" && !OPEN_STROKE_TYPES.has(type.trim().toLowerCase());

/** Split a CSS value on whitespace that is not inside parentheses, so `rgb(1, 2, 3)` stays one token. */
function splitCssTokens(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch)) {
      if (i > start) parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (start < input.length) parts.push(input.slice(start));
  return parts;
}

/**
 * The CSS `border` shorthand, `<width> || <style> || <color>` in any order.
 *
 * The three parts used to be read as one: the whole string became `color`, so
 * `border: "1px solid #E2E8F0"` painted a stroke whose colour was the literal
 * text `1px solid #E2E8F0`, and the 1px width never existed. Each token is
 * classified by what it can only be, which is what makes the order irrelevant.
 *
 * `none` / `hidden` mean "no border at all": CSS renders nothing, and a stroke
 * with a colour and no width is exactly the border the author asked to remove.
 */
export function parseBorderShorthand(raw: string): { width?: number; style?: string; color?: string; none?: boolean } | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const out: { width?: number; style?: string; color?: string; none?: boolean } = {};
  for (const token of splitCssTokens(text)) {
    const lower = token.toLowerCase();
    if (!out.style && BORDER_STYLES.includes(lower)) {
      out.style = lower;
      if (lower === "none" || lower === "hidden") out.none = true;
      continue;
    }
    const px = pxLength(token);
    if (px !== undefined && out.width === undefined) {
      out.width = px;
      continue;
    }
    if (out.color === undefined) out.color = token;
  }
  if (out.width === undefined && out.style === undefined && out.color === undefined) return undefined;
  return out;
}

/**
 * Dash and gap lengths, in document order.
 *
 * An odd-length pattern is legal in SVG — it is doubled to tile evenly — and
 * capping the length would silently drop a value the author typed. Zero-length
 * entries are the one thing rejected: they mean "no gap" for a gap slot but make
 * the pattern stall for a dash slot.
 */
function normalizeDashArray(raw: unknown): number[] | undefined {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,]+/).filter(Boolean)
      : undefined;
  if (!list || list.length === 0) return undefined;
  const out: number[] = [];
  for (const v of list) {
    const n = asNumber(v);
    if (n === undefined || !Number.isFinite(n) || n < 0) continue;
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

/** One CSS border-radius token (`8`, `8px`, `50%`) to px, given a reference length for `%`. */
function radiusToken(token: string, reference: number): number | undefined {
  const text = token.trim();
  const percent = text.match(/^(\d+(?:\.\d+)?)%$/);
  if (percent) {
    if (!(reference > 0)) return undefined;
    return (Number(percent[1]) / 100) * reference;
  }
  const n = pxLength(text);
  return n !== undefined && n >= 0 ? n : undefined;
}

/**
 * The CSS `border-radius` string form: one to four space-/slash-separated
 * tokens, expanded the way CSS expands it (`"8px"` -> all four, `"8px 4px"` ->
 * `[tl,tr,br,bl]`). A `%` is resolved against `min(width, height)` of the box —
 * the DSL has one length per corner, so `50%` on a square is the circle it
 * means, and on a rectangle it is the closest a single radius can be.
 */
export function parseRadiusString(
  raw: string,
  box?: { width: number; height: number }
): CornerRadius | undefined {
  const parts = raw.trim().split(/[\s/]+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return undefined;
  const reference = box ? Math.min(box.width, box.height) : 0;
  const values = parts.map((p) => radiusToken(p, reference));
  if (values.some((v) => v === undefined)) return undefined;
  const [a, b, c, d] = values as number[];
  const corners: [number, number, number, number] =
    parts.length === 1 ? [a, a, a, a]
      : parts.length === 2 ? [a, b, a, b]
        : parts.length === 3 ? [a, b, c, b]
          : [a, b, c, d];
  return corners.every((v) => v === corners[0]) ? Math.max(0, corners[0]) : corners;
}

/** CSS names one corner per property; the DSL's corner object names the same four. */
const CORNER_LONGHANDS = [
  ["border-top-left-radius", "topLeft"],
  ["border-top-right-radius", "topRight"],
  ["border-bottom-right-radius", "bottomRight"],
  ["border-bottom-left-radius", "bottomLeft"]
] as const;

/** A radius already spread over four corners, or `undefined` when it is not one. */
const asFourCorners = (v: unknown): readonly [number, number, number, number] | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return [v, v, v, v];
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number")) {
    return v as [number, number, number, number];
  }
  return undefined;
};

/**
 * The radius under every spelling an author reaches for, CSS kebab included.
 *
 * A corner longhand is folded onto the corner object rather than rejected: CSS
 * says `border-top-left-radius` where the dialect says `{ topLeft }`, and an
 * author writing the standard property got `unknown property` for it. A corner
 * no longhand names keeps whatever the shorthand gave it, so
 * `border-radius: 8` with `border-top-left-radius: 20` is `[20, 8, 8, 8]`.
 */
export function cornerRadiusInput(el: Record<string, unknown>): unknown {
  const shorthand = el.borderRadius ?? el.radius ?? el.cornerRadius ?? el["border-radius"];
  const named: Record<string, unknown> = {};
  let anyCorner = false;
  for (const [key, corner] of CORNER_LONGHANDS) {
    if (el[key] !== undefined) {
      named[corner] = el[key];
      anyCorner = true;
    }
  }
  if (!anyCorner) return shorthand;
  const spread = asFourCorners(shorthand);
  const out: Record<string, unknown> = {};
  CORNER_LONGHANDS.forEach(([, corner], index) => {
    out[corner] = named[corner] !== undefined ? named[corner] : spread?.[index] ?? 0;
  });
  return out;
}

/**
 * One corner, from any spelling: a number, a px string, or a `%` of the box's
 * shorter side — the SAME rule `parseRadiusString` applies to the string form, so
 * `{ topLeft: "50%" }` and `"50%"` mean one thing. The array and object forms
 * used to read through `asNumber`, and `asNumber("50%")` is 50: a percentage
 * corner became 50 px with nothing reported.
 */
const cornerToken = (value: unknown, reference: number): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : undefined;
  if (typeof value === "string") {
    const n = radiusToken(value, reference);
    return n === undefined ? undefined : Math.max(0, n);
  }
  return undefined;
};

/** The first unit any string leaf under `value` carries, so a repair can name it.
 *  Bounded: a radius object is four corners, and this only has to reach the first. */
const firstUnit = (value: unknown, depth = 0): string | undefined => {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    const unit = lengthUnit(value);
    return unit && unit !== "px" && unit !== "" ? unit : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = firstUnit(entry, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      const hit = firstUnit(entry, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
};

interface CornerExprToken {
  expr: string;
  hasPercent: boolean;
  constantPx?: number;
}

function parseSingleCornerValue(value: unknown, reportAsEmpty = false): CornerExprToken | undefined {
  if (value === undefined && reportAsEmpty) return { expr: "0", hasPercent: false, constantPx: 0 };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const v = Math.round(value * 100) / 100;
    return { expr: v === 0 ? "0" : `${v}px`, hasPercent: false, constantPx: v };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const dyn = parseDynamicLength(trimmed);
    if (dyn) {
      if (!dyn.hasPercent && dyn.constantPx !== undefined) {
        return {
          expr: dyn.constantPx === 0 ? "0" : `${dyn.constantPx}px`,
          hasPercent: false,
          constantPx: dyn.constantPx
        };
      }
      if (dyn.expr) return { expr: dyn.expr, hasPercent: true };
    }
    const px = pxLength(trimmed);
    if (px !== undefined && px >= 0) {
      const v = Math.round(px * 100) / 100;
      return { expr: v === 0 ? "0" : `${v}px`, hasPercent: false, constantPx: v };
    }
  }
  return undefined;
}

/**
 * Full CSS `border-radius` resolver: supports `rx / ry` elliptical corners,
 * dynamic `%` (horizontal against `width`, vertical against `height`) &
 * mixed-unit `calc()`/`min()`/`max()`/`clamp()`, 4-tuples, and corner objects.
 */
export function normalizeBorderRadiusSpec(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[],
  box?: { width: number; height: number }
): ResolvedBorderRadiusSpec | undefined {
  const reportCorners = (value: unknown): void => {
    if (!path || !repairs) return;
    const unit = firstUnit(value);
    repairs.push({
      kind: "element",
      path: `${path}/borderRadius`,
      message: `${JSON.stringify(value)} is not a corner length (${
        box ? "px, or a % of the box" : "px"
      }${unit ? `; it carries "${unit}"` : ""})`
    });
  };

  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return { radius: raw };
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    const resolved = box
      ? resolveDynamicBorderRadius(trimmed, box)
      : trimmed.includes("%")
        ? undefined
        : resolveDynamicBorderRadius(trimmed, { width: 0, height: 0 });
    if (resolved !== undefined) return resolved;
    if (path && repairs) {
      repairs.push({
        kind: "element",
        path: `${path}/borderRadius`,
        message: `borderRadius ${JSON.stringify(raw)} is not a valid CSS length (px number${box ? " or %" : ""}); dropped`
      });
    }
    return undefined;
  }

  const evalCornerTokens = (tokens: readonly [CornerExprToken, CornerExprToken, CornerExprToken, CornerExprToken]): ResolvedBorderRadiusSpec | undefined => {
    const hasPercent = tokens.some((t) => t.hasPercent);
    if (hasPercent && !box) return undefined;
    const targetBox = box ?? { width: 0, height: 0 };
    const exprStr = tokens.every((t) => t.expr === tokens[0].expr)
      ? tokens[0].expr
      : tokens.map((t) => t.expr).join(" ");
    if (!hasPercent) {
      const nums = tokens.map((t) => Math.max(0, t.constantPx ?? 0)) as [number, number, number, number];
      return { radius: collapseCorners(nums) };
    }
    const evalCorner = (tok: CornerExprToken, w: number, h: number): [number, number] => {
      if (!tok.hasPercent && tok.constantPx !== undefined) {
        const v = Math.max(0, tok.constantPx);
        return [v, v];
      }
      const xRes = resolveDynamicBorderRadius(tok.expr, { width: w, height: h });
      if (!xRes) return [0, 0];
      const rx = Array.isArray(xRes.radius) ? xRes.radius[0] : xRes.radius;
      const ry = xRes.radiusY !== undefined ? (Array.isArray(xRes.radiusY) ? xRes.radiusY[0] : xRes.radiusY) : rx;
      return [rx, ry];
    };
    const pairs = tokens.map((t) => evalCorner(t, targetBox.width, targetBox.height));
    const rx = collapseCorners([pairs[0][0], pairs[1][0], pairs[2][0], pairs[3][0]]);
    const ry = collapseCorners([pairs[0][1], pairs[1][1], pairs[2][1], pairs[3][1]]);
    return {
      radius: rx,
      ...(cornerRadiusEqual(rx, ry) ? {} : { radiusY: ry }),
      expr: exprStr
    };
  };

  if (Array.isArray(raw) && raw.length === 4) {
    const tokens = raw.map((r) => parseSingleCornerValue(r));
    if (tokens.some((t) => !t)) {
      reportCorners(raw);
      return undefined;
    }
    const spec = evalCornerTokens(tokens as [CornerExprToken, CornerExprToken, CornerExprToken, CornerExprToken]);
    if (!spec) reportCorners(raw);
    return spec;
  }

  if (isPlainObject(raw)) {
    if (raw.all !== undefined) {
      const all = parseSingleCornerValue(raw.all);
      if (!all) {
        reportCorners(raw.all);
        return undefined;
      }
      const spec = evalCornerTokens([all, all, all, all]);
      if (!spec) reportCorners(raw.all);
      return spec;
    }
    const entries = [
      raw.topLeft ?? raw.tl,
      raw.topRight ?? raw.tr,
      raw.bottomRight ?? raw.br,
      raw.bottomLeft ?? raw.bl
    ];
    const parsed = entries.map((v) => parseSingleCornerValue(v, true));
    if (parsed.some((t) => !t)) {
      reportCorners(raw);
      return undefined;
    }
    const spec = evalCornerTokens(parsed as [CornerExprToken, CornerExprToken, CornerExprToken, CornerExprToken]);
    if (!spec) reportCorners(raw);
    return spec;
  }

  if (raw !== undefined) {
    const present = isPlainObject(raw) ? Object.keys(raw).length : 1;
    if (present > 0 && path && repairs) {
      repairs.push({
        kind: "element",
        path: `${path}/borderRadius`,
        message: `borderRadius ${JSON.stringify(raw)} is not a number, a 4-value array, an object or a CSS string; dropped`
      });
    }
  }
  return undefined;
}

/** Applies normalized corner radius + elliptical/dynamic metadata onto `base` and `sizing`. */
export function applyNormalizedBorderRadius(
  el: Record<string, unknown>,
  base: Record<string, unknown>,
  sizing: ElementSizing,
  path: string,
  repairs: NormalizationRepair[],
  box: { width: number; height: number }
): void {
  const spec = normalizeBorderRadiusSpec(cornerRadiusInput(el), path, repairs, box);
  if (!spec) return;
  base.borderRadius = spec.radius;
  if (spec.radiusY !== undefined) sizing.borderRadiusY = spec.radiusY;
  if (spec.expr !== undefined) sizing.borderRadiusExpr = spec.expr;
}

export function normalizeCornerRadius(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[],
  box?: { width: number; height: number }
): CornerRadius | undefined {
  const reference = box ? Math.min(box.width, box.height) : 0;
  const reportCorners = (value: unknown): void => {
    if (!path || !repairs) return;
    const unit = firstUnit(value);
    repairs.push({
      kind: "element",
      path: `${path}/borderRadius`,
      message: `${JSON.stringify(value)} is not a corner length (${
        box ? "px, or a % of the box's shorter side" : "px"
      }${unit ? `; it carries "${unit}"` : ""})`
    });
  };

  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = parseRadiusString(raw, box);
    if (parsed !== undefined) return parsed;
    if (path && repairs) {
      repairs.push({
        kind: "element",
        path: `${path}/borderRadius`,
        message: `borderRadius ${JSON.stringify(raw)} is not a valid CSS length (px number${box ? " or %" : ""}); dropped`
      });
    }
    return undefined;
  }
  if (Array.isArray(raw) && raw.length === 4) {
    const radii = raw.map((r) => cornerToken(r, reference));
    if (radii.some((r) => r === undefined)) {
      reportCorners(raw);
      return undefined;
    }
    const corners = radii as [number, number, number, number];
    // Four equal corners are the same value CSS writes as one radius, and the
    // writer compresses them to one — keeping the array here would make a
    // round trip change the stored shape.
    return corners.every((value) => value === corners[0]) ? corners[0] : corners;
  }
  if (isPlainObject(raw)) {
    // { topLeft, topRight, bottomRight, bottomLeft } / { all: 8 }
    // An absent corner is 0 (CSS lets you name one); a corner the author WROTE
    // and the reader cannot resolve fails the whole shape, so the same rule the
    // padding/margin object branches use applies — never a silent 0.
    const side = (value: unknown): number | undefined =>
      value === undefined ? 0 : cornerToken(value, reference);
    if (raw.all !== undefined) {
      const all = side(raw.all);
      if (all === undefined) {
        reportCorners(raw.all);
        return undefined;
      }
      return all;
    }
    const corners = [
      side(raw.topLeft ?? raw.tl),
      side(raw.topRight ?? raw.tr),
      side(raw.bottomRight ?? raw.br),
      side(raw.bottomLeft ?? raw.bl)
    ];
    if (corners.some((c) => c !== undefined)) {
      if (corners.some((c) => c === undefined)) {
        reportCorners(raw);
        return undefined;
      }
      return corners as [number, number, number, number];
    }
  }
  // The radius reader takes only number / 4-array / object / CSS string. Anything
  // else — the spelling an author writes — was dropped outright and silently.
  if (raw !== undefined && raw !== null && path && repairs) {
    const present = isPlainObject(raw) ? Object.keys(raw).length : 1;
    if (present > 0) {
      repairs.push({
        kind: "element",
        path: `${path}/borderRadius`,
        message: `borderRadius ${JSON.stringify(raw)} is not a number, a 4-value array, an object or a CSS string; dropped`
      });
    }
  }
  return undefined;
}

export function normalizeStroke(
  raw: unknown,
  el: Record<string, unknown>,
  path?: string,
  repairs?: NormalizationRepair[]
): Stroke | undefined {
  const direct = isPlainObject(raw) ? raw : typeof raw === "string" ? { color: raw } : undefined;

  // CSS-ish spellings the model reaches for. A `border` STRING is the
  // `<width> || <style> || <color>` shorthand, not a bare colour.
  const border = el.border;
  const borderShorthand = typeof border === "string" ? parseBorderShorthand(border) : undefined;
  const borderObj = isPlainObject(border) ? border : borderShorthand;
  // `border: "none"` removes the element-level border; it must not fall through
  // to `borderColor` / `borderWidth` and paint one anyway. An explicit `strokes`
  // row is unaffected: the stack outranks the element-level shorthand.
  if (borderShorthand?.none && raw === undefined) return undefined;

  // CSS's per-side shorthands (`border-top: "1px solid #E2E8F0"`).
  const sideShorthand = (side: SideName) => {
    const value = el[`border-${side}`] ?? el[`border${sideCap(side)}`];
    return typeof value === "string" ? parseBorderShorthand(value) : undefined;
  };
  const topBorder = sideShorthand("top");
  const rightBorder = sideShorthand("right");
  const bottomBorder = sideShorthand("bottom");
  const leftBorder = sideShorthand("left");
  const sideColor = SIDE_NAMES
    .map((side, i) => {
      const sh = [topBorder, rightBorder, bottomBorder, leftBorder][i];
      return nonEmptyString(el[`border${sideCap(side)}Color`] ?? el[`border-${side}-color`]) ?? nonEmptyString(sh?.color);
    })
    .find((value): value is string => Boolean(value));

  const color =
    (direct && typeof direct.color === "string" && direct.color) ||
    (borderObj && typeof borderObj.color === "string" && borderObj.color) ||
    (typeof el.borderColor === "string" && el.borderColor) ||
    (typeof el["border-color"] === "string" && (el["border-color"] as string)) ||
    sideColor ||
    undefined;

  // The first spelling that is present wins; `pxLength` then decides whether it
  // is a px length. `asNumber` would have read `"2em"` as 2 and `"5%"` as 5 — a
  // stroke of the wrong weight with nothing said — so a non-px width is dropped
  // and reported.
  const widthRaw =
    (direct ? direct.width ?? direct.strokeWidth : undefined) ??
    (borderObj ? borderObj.width : undefined) ??
    el.borderWidth ?? el["border-width"] ?? el.strokeWidth;
  const width = pxLength(widthRaw);
  if (widthRaw !== undefined && width === undefined && path && repairs) {
    const unit = lengthUnit(widthRaw);
    repairs.push({
      kind: "stroke",
      path: `${path}/strokeWidth`,
      message: `stroke width ${JSON.stringify(widthRaw)} is not a px length${unit ? ` (it carries "${unit}")` : ""}; dropped`
    });
  }

  /* CSS's border is a set of INDEPENDENT longhands, so `border-style` on its own
     and `border-top-width` on its own each draw a border — the initial value fills
     the parts the author left out. A JSON author writes the same fragments, and
     deciding "no stroke" from them dropped the declaration with nothing said, so
     the per-side weights and the style are resolved BEFORE the guard. */
  const rawSides =
    (direct && isPlainObject(direct.sides) ? direct.sides : undefined) ||
    (isPlainObject(el.strokeSides) ? (el.strokeSides as Record<string, unknown>) : undefined) ||
    (isPlainObject(el.borderSides) ? (el.borderSides as Record<string, unknown>) : undefined);

  // Per-side weights are INDEPENDENT declarations in CSS (`border-top-width` and
  // `border-right-width` are separate properties), so an unreadable one is
  // dropped and reported on its own and the other three still stand — unlike the
  // box-shape fields, where one shape has to fail whole.
  const sideWidth = (value: unknown, side: string): number | undefined => {
    if (value === undefined) return undefined;
    const n = pxLength(value);
    if (n === undefined) {
      const unit = lengthUnit(value);
      if (path && repairs) {
        repairs.push({
          kind: "stroke",
          path: `${path}/border-${side}-width`,
          message: `border-${side}-width ${JSON.stringify(value)} is not a px length${
            unit ? ` (it carries "${unit}")` : ""
          }; dropped`
        });
      }
      return undefined;
    }
    return n;
  };
  const sideWidthOf = (
    side: string,
    shorthand: ReturnType<typeof parseBorderShorthand>,
    longhand: unknown
  ): number | undefined => {
    // `none` / `hidden` is CSS's "no border on this side", and it outranks any
    // width longhand written beside it.
    if (shorthand?.none) return 0;
    return sideWidth(longhand, side) ?? shorthand?.width;
  };
  const t = sideWidthOf("top", topBorder, rawSides?.top ?? rawSides?.t ?? (direct as any)?.strokeTopWeight ?? el.borderTopWidth ?? el["border-top-width"] ?? el.strokeTopWeight);
  const r = sideWidthOf("right", rightBorder, rawSides?.right ?? rawSides?.r ?? (direct as any)?.strokeRightWeight ?? el.borderRightWidth ?? el["border-right-width"] ?? el.strokeRightWeight);
  const b = sideWidthOf("bottom", bottomBorder, rawSides?.bottom ?? rawSides?.b ?? (direct as any)?.strokeBottomWeight ?? el.borderBottomWidth ?? el["border-bottom-width"] ?? el.strokeBottomWeight);
  const l = sideWidthOf("left", leftBorder, rawSides?.left ?? rawSides?.l ?? (direct as any)?.strokeLeftWeight ?? el.borderLeftWidth ?? el["border-left-width"] ?? el.strokeLeftWeight);

  let sides: StrokeSideWeights | undefined;
  if (t !== undefined || r !== undefined || b !== undefined || l !== undefined) {
    sides = {
      top: Math.max(0, t ?? 0),
      right: Math.max(0, r ?? 0),
      bottom: Math.max(0, b ?? 0),
      left: Math.max(0, l ?? 0)
    };
  }

  // `none` on ONE side is a width, not a style: sharing it would remove the
  // other three borders too.
  const sideStyle = SIDE_NAMES
    .map((side, i) => {
      const sh = [topBorder, rightBorder, bottomBorder, leftBorder][i];
      const shStyle = sh && !sh.none && typeof sh.style === "string" ? sh.style : undefined;
      return nonEmptyString(el[`border${sideCap(side)}Style`] ?? el[`border-${side}-style`]) ?? shStyle;
    })
    .find((value): value is string => Boolean(value));
  const authoredStyle =
    (borderObj && typeof borderObj.style === "string" ? borderObj.style : undefined) ||
    (typeof el.borderStyle === "string" ? el.borderStyle : undefined) ||
    (typeof el["border-style"] === "string" ? (el["border-style"] as string) : undefined) ||
    sideStyle;
  // `border-style: none` is CSS's "no border", and it wins over a width or a
  // colour written beside it.
  if (authoredStyle?.trim().toLowerCase() === "none" && raw === undefined) return undefined;

  if (!color && width === undefined && !sides && authoredStyle === undefined && !direct?.paint) {
    return undefined;
  }

  const styleRaw =
    (direct && typeof direct.style === "string" ? direct.style : undefined) || authoredStyle;

  const { style } = normalizeStrokeStyle(styleRaw, (decorative) => {
    if (path && repairs) {
      repairs.push({
        kind: "stroke",
        path: `${path}/border-style`,
        message: `border-style "${decorative}" has no DSL spelling; drawn as dashed`
      });
    }
  });
  const declaredAlign = direct && typeof direct.align === "string" && ["inside", "center", "outside"].includes(direct.align)
    ? (direct.align as "inside" | "center" | "outside")
    : undefined;
  // CSS's border is painted INSIDE the box, and the HTML import has always said
  // so — but one written by hand fell through to the renderer's `center`, so the
  // same CSS drew two different boxes depending on the road in. An explicit
  // `strokes[]` row keeps the renderer's default: that `align` is the dialect's
  // own field, and `strokeWidth` is not a CSS border either.
  const fromCssBorder = Object.keys(el).some((key) => BORDER_SPELLINGS.has(canonicalKey(key)));
  const align =
    declaredAlign ??
    (direct === undefined && fromCssBorder && sitsInsideBox(el.type) ? "inside" : undefined);
  const enabled = direct && typeof direct.enabled === "boolean" ? direct.enabled : undefined;
  const opacity = direct && typeof direct.opacity === "number" ? direct.opacity : undefined;
  const paint =
    direct && isPlainObject(direct.paint)
      ? normalizePaint(direct.paint, path && `${path}/paint`, repairs)
      : undefined;
  // The row's colour token, which is what a theme switch repaints `color` from.
  // Dropped, a token-bound stroke kept the colour it was authored with and the
  // layer quietly became a value nobody could move again.
  //
  // It may ride on the `border` OBJECT as well as here: `$token` shorthand lowers
  // `borderColor: "$x"` onto `border.tokenId` instead of synthesising a row, so
  // the CSS border's own alignment and per-side weights stay untouched.
  const borderTokenId =
    isPlainObject(border) && typeof border.tokenId === "string" && border.tokenId.trim()
      ? border.tokenId.trim()
      : undefined;
  const tokenId =
    direct && typeof direct.tokenId === "string" && direct.tokenId ? direct.tokenId : borderTokenId;
  // Read by the renderer as `stroke-linecap` / `stroke-linejoin`; without this a
  // round-capped stroke reverted to butt/miter on the next save.
  const cap = direct && typeof direct.cap === "string" && LINE_CAPS.includes(direct.cap)
    ? (direct.cap as Stroke["cap"])
    : undefined;
  const join = direct && typeof direct.join === "string" && LINE_JOINS.includes(direct.join)
    ? (direct.join as Stroke["join"])
    : undefined;
  const miterLimitRaw = asNumber(direct?.miterLimit ?? (direct as any)?.strokeMiterLimit);
  // SVG's floor is 1; below it a miter is always cut back, which is the opposite
  // of what a smaller number reads like.
  const miterLimit = miterLimitRaw !== undefined ? Math.max(1, miterLimitRaw) : undefined;
  const dashArray = normalizeDashArray(
    direct?.dashArray ?? direct?.dash ?? (direct as any)?.strokeDashArray
  );
  const dashOffsetRaw = asNumber(direct?.dashOffset ?? (direct as any)?.strokeDashOffset);

  const sideMax = sides
    ? Math.max(sides.top ?? 0, sides.right ?? 0, sides.bottom ?? 0, sides.left ?? 0)
    : undefined;
  const rawSide =
    (direct && typeof direct.side === "string" ? direct.side.toLowerCase() : undefined) ||
    (direct && typeof (direct as any).strokeSide === "string" ? (direct as any).strokeSide.toLowerCase() : undefined) ||
    (typeof el.strokeSide === "string" ? el.strokeSide.toLowerCase() : undefined) ||
    (typeof el.borderSide === "string" ? el.borderSide.toLowerCase() : undefined);
  const side = rawSide && ["all", "top", "right", "bottom", "left", "custom"].includes(rawSide)
    ? (rawSide as StrokeSide)
    : sides
      ? "custom"
      : undefined;

  const res: Stroke = {
    color: color || (paint?.type === "solid" ? paint.color : "#000000"),
    width: Math.max(0, width ?? sideMax ?? 1),
    style
  };
  if (align) res.align = align;
  if (enabled !== undefined) res.enabled = enabled;
  if (opacity !== undefined) res.opacity = opacity;
  if (paint) res.paint = paint;
  if (tokenId) res.tokenId = tokenId;
  if (side) res.side = side;
  if (sides) res.sides = sides;
  if (cap) res.cap = cap;
  if (join) res.join = join;
  if (miterLimit !== undefined) res.miterLimit = miterLimit;
  // An explicit pattern outranks the shorthand in both directions: `dashed` with
  // no array still means the default pattern, `solid` with one is not solid.
  if (dashArray) res.dashArray = dashArray;
  else if (style === "dashed") res.dashArray = [...DEFAULT_DASH];
  if (dashOffsetRaw !== undefined) res.dashOffset = dashOffsetRaw;

  return res;
}

function normalizeElementBorders(
  el: Record<string, unknown>,
  path?: string,
  repairs?: NormalizationRepair[]
): Stroke[] | undefined {
  const border = el.border;
  const borderShorthand = typeof border === "string" ? parseBorderShorthand(border) : undefined;
  const borderObj = isPlainObject(border) ? border : borderShorthand;
  const borderTokenId =
    isPlainObject(border) && typeof border.tokenId === "string" && border.tokenId.trim()
      ? border.tokenId.trim()
      : undefined;

  const baseColor =
    nonEmptyString(borderObj?.color) ??
    nonEmptyString(el.borderColor) ??
    nonEmptyString(el["border-color"]);
  const baseStyleRaw =
    nonEmptyString(borderObj?.style) ??
    nonEmptyString(el.borderStyle) ??
    nonEmptyString(el["border-style"]);
  const baseStyleLower = baseStyleRaw?.trim().toLowerCase();
  const baseNone = Boolean(borderShorthand?.none || baseStyleLower === "none" || baseStyleLower === "hidden");

  const widthRaw = (borderObj ? borderObj.width : undefined) ?? el.borderWidth ?? el["border-width"] ?? el.strokeWidth;
  const baseWidth = pxLength(widthRaw);

  const rawSides =
    (isPlainObject(el.strokeSides) ? (el.strokeSides as Record<string, unknown>) : undefined) ||
    (isPlainObject(el.borderSides) ? (el.borderSides as Record<string, unknown>) : undefined);

  // Fast-check whether any side carries a CSS per-side color or style override;
  // when none do, `normalizeStroke` preserves every single-stroke edge case.
  let anySideColorOrStyle = false;
  const parsedSideData = SIDE_NAMES.map((side) => {
    const cap = sideCap(side);
    const shVal = el[`border-${side}`] ?? el[`border${cap}`];
    const sh = typeof shVal === "string" ? parseBorderShorthand(shVal) : undefined;
    const shObj = isPlainObject(shVal) ? shVal : sh;
    const shTokenId =
      isPlainObject(shVal) && typeof shVal.tokenId === "string" && shVal.tokenId.trim()
        ? shVal.tokenId.trim()
        : undefined;
    const sideColor = nonEmptyString(el[`border${cap}Color`] ?? el[`border-${side}-color`]) ?? nonEmptyString(shObj?.color);
    const sideStyle = nonEmptyString(el[`border${cap}Style`] ?? el[`border-${side}-style`]) ?? (sh?.none ? "none" : nonEmptyString(shObj?.style));
    if (sideColor !== undefined || sideStyle !== undefined) anySideColorOrStyle = true;
    const longWidth =
      rawSides?.[side] ??
      rawSides?.[side[0]] ??
      el[`stroke${cap}Weight`] ??
      el[`border${cap}Width`] ??
      el[`border-${side}-width`];
    return { side, cap, sh, shObj, shTokenId, sideColor, sideStyle, longWidth };
  });

  if (!anySideColorOrStyle) {
    const fromElement = normalizeStroke(undefined, el, path, repairs);
    return fromElement ? [fromElement] : undefined;
  }

  if (widthRaw !== undefined && baseWidth === undefined && path && repairs) {
    const unit = lengthUnit(widthRaw);
    repairs.push({
      kind: "stroke",
      path: `${path}/strokeWidth`,
      message: `stroke width ${JSON.stringify(widthRaw)} is not a px length${unit ? ` (it carries "${unit}")` : ""}; dropped`
    });
  }

  const hasBaseBorder = Boolean(baseColor || (baseStyleRaw && !baseNone) || borderObj || baseWidth !== undefined);
  const reportedDecorative = new Set<string>();
  const reportDecorative = (decorative: string) => {
    if (reportedDecorative.has(decorative)) return;
    reportedDecorative.add(decorative);
    if (path && repairs) {
      repairs.push({
        kind: "stroke",
        path: `${path}/border-style`,
        message: `border-style "${decorative}" has no DSL spelling; drawn as dashed`
      });
    }
  };

  interface ResolvedSide {
    side: SideName;
    width: number;
    color: string;
    style: NonNullable<Stroke["style"]>;
    none: boolean;
    tokenId?: string;
    authoredSideWeight: boolean;
  }

  const resolved: ResolvedSide[] = parsedSideData.map(({ side, sh, shObj, shTokenId, sideColor, sideStyle, longWidth }) => {
    let parsedLongWidth: number | undefined;
    if (longWidth !== undefined) {
      parsedLongWidth = pxLength(longWidth);
      if (parsedLongWidth === undefined && path && repairs) {
        const unit = lengthUnit(longWidth);
        repairs.push({
          kind: "stroke",
          path: `${path}/border-${side}-width`,
          message: `border-${side}-width ${JSON.stringify(longWidth)} is not a px length${
            unit ? ` (it carries "${unit}")` : ""
          }; dropped`
        });
      }
    }
    const shWidth = sh?.none ? 0 : isPlainObject(shObj) ? pxLength(shObj.width) : sh?.width;
    const explicitSideW = sh?.none ? 0 : (parsedLongWidth ?? shWidth);
    const effectiveStyleRaw = sideStyle ?? (baseNone ? "none" : baseStyleRaw);
    const parsedStyle = normalizeStrokeStyle(effectiveStyleRaw, reportDecorative);
    const effWidth = parsedStyle.none
      ? 0
      : explicitSideW !== undefined
        ? Math.max(0, explicitSideW)
        : baseWidth !== undefined
          ? Math.max(0, baseWidth)
          : hasBaseBorder || sideStyle !== undefined || sideColor !== undefined
            ? 1
            : 0;
    const color = sideColor ?? baseColor ?? "#000000";
    const tokenId = shTokenId ?? (!sideColor ? borderTokenId : undefined);
    return {
      side,
      width: effWidth,
      color,
      style: parsedStyle.style,
      none: parsedStyle.none,
      tokenId,
      authoredSideWeight: explicitSideW !== undefined
    };
  });

  const active = resolved.filter((r) => !r.none && r.width > 0);
  if (active.length === 0) return undefined;

  const align = sitsInsideBox(el.type) ? ("inside" as const) : undefined;
  const groupOrder: { color: string; style: NonNullable<Stroke["style"]>; tokenId?: string; sides: ResolvedSide[] }[] = [];
  for (const item of active) {
    const existing = groupOrder.find(
      (g) => g.color === item.color && g.style === item.style && g.tokenId === item.tokenId
    );
    if (existing) existing.sides.push(item);
    else groupOrder.push({ color: item.color, style: item.style, tokenId: item.tokenId, sides: [item] });
  }

  const makeStroke = (
    color: string,
    style: NonNullable<Stroke["style"]>,
    width: number,
    tokenId: string | undefined,
    extra: Partial<Stroke>
  ): Stroke => {
    const stroke: Stroke = {
      color,
      width,
      style,
      ...(align ? { align } : {}),
      ...(tokenId ? { tokenId } : {}),
      ...extra
    };
    if (style === "dashed") stroke.dashArray = [...DEFAULT_DASH];
    return stroke;
  };

  if (groupOrder.length === 1) {
    const g = groupOrder[0];
    const [topR, rightR, bottomR, leftR] = resolved;
    const allActive = active.length === 4;
    const sameWidth = resolved.every((r) => r.width === topR.width);
    const anyAuthoredWeights = resolved.some((r) => r.authoredSideWeight) || rawSides !== undefined;
    if (allActive && sameWidth && !anyAuthoredWeights) {
      return [makeStroke(g.color, g.style, topR.width, g.tokenId, {})];
    }
    const maxW = Math.max(topR.width, rightR.width, bottomR.width, leftR.width);
    return [
      makeStroke(g.color, g.style, maxW, g.tokenId, {
        side: "custom",
        sides: { top: topR.width, right: rightR.width, bottom: bottomR.width, left: leftR.width }
      })
    ];
  }

  return groupOrder.map((g) => {
    const widthBySide = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const s of g.sides) widthBySide[s.side] = s.width;
    const maxW = Math.max(widthBySide.top, widthBySide.right, widthBySide.bottom, widthBySide.left);
    if (g.sides.length === 1) {
      return makeStroke(g.color, g.style, maxW, g.tokenId, { side: g.sides[0].side });
    }
    return makeStroke(g.color, g.style, maxW, g.tokenId, {
      side: "custom",
      sides: widthBySide
    });
  });
}

/**
 * The element's stroke stack, bottom layer first — the only stroke spelling the
 * dialect has. It used to also hand back a singular `stroke` carrying the top of
 * the stack, which is where a second layer went to die: a writer that read it
 * back re-saved one stroke and lost the rest.
 */
export function normalizeStrokes(
  el: Record<string, unknown>,
  path?: string,
  repairs?: NormalizationRepair[]
): Stroke[] | undefined {
  if (Array.isArray(el.strokes)) {
    const list: Stroke[] = [];
    el.strokes.forEach((item, index) => {
      // `el`, not `{}`: the per-side weights (`borderTopWidth`,
      // `strokeTopWeight`) are element-level spellings, so a layer normalized
      // without the element could not author a non-uniform stroke at all.
      const s = normalizeStroke(item, el, path && `${path}/strokes/${index}`, repairs);
      if (s) list.push(s);
    });
    return list.length > 0 ? list : undefined;
  }
  return normalizeElementBorders(el, path, repairs);
}
