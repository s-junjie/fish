import type { CornerRadius, Stroke, StrokeSide, StrokeSideWeights } from "../types";
import { DEFAULT_DASH } from "../types";
import { topLayer } from "../paint-stack";
import { asNumber, isPlainObject, lengthUnit, pxLength, NormalizationRepair } from "./shared";
import { normalizePaint } from "./paint";

const LINE_CAPS: readonly string[] = ["butt", "round", "square"];
const LINE_JOINS: readonly string[] = ["miter", "round", "bevel"];

/** The CSS `<line-style>` keywords. */
const BORDER_STYLES: readonly string[] = [
  "none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"
];

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
function parseBorderShorthand(raw: string): { width?: number; style?: string; color?: string; none?: boolean } | undefined {
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
function parseRadiusString(
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

  // CSS's per-side shorthands (`border-top: "1px solid #E2E8F0"`). The model
  // holds one colour and one style for the whole stroke, so those parts are
  // shared; the WIDTH belongs to the side it names, and `none` removes just it.
  const sideShorthand = (side: string) => {
    const value = el[`border-${side}`];
    return typeof value === "string" ? parseBorderShorthand(value) : undefined;
  };
  const topBorder = sideShorthand("top");
  const rightBorder = sideShorthand("right");
  const bottomBorder = sideShorthand("bottom");
  const leftBorder = sideShorthand("left");
  const sideColor = [topBorder, rightBorder, bottomBorder, leftBorder]
    .map((side) => (typeof side?.color === "string" ? side.color : undefined))
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
  const sideStyle = [topBorder, rightBorder, bottomBorder, leftBorder]
    .map((side) => (side && !side.none && typeof side.style === "string" ? side.style : undefined))
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

  const style = styleRaw && styleRaw.toLowerCase() !== "solid" ? "dashed" : "solid";
  const align = (direct && typeof direct.align === "string" && ["inside", "center", "outside"].includes(direct.align)) ? (direct.align as "inside" | "center" | "outside") : undefined;
  const enabled = direct && typeof direct.enabled === "boolean" ? direct.enabled : undefined;
  const opacity = direct && typeof direct.opacity === "number" ? direct.opacity : undefined;
  const paint =
    direct && isPlainObject(direct.paint)
      ? normalizePaint(direct.paint, path && `${path}/paint`, repairs)
      : undefined;
  // The row's colour token, which is what a theme switch repaints `color` from.
  // Dropped, a token-bound stroke kept the colour it was authored with and the
  // layer quietly became a value nobody could move again.
  const tokenId =
    direct && typeof direct.tokenId === "string" && direct.tokenId ? direct.tokenId : undefined;
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
  // No stack, but the element-level spellings still author one: `border-width`,
  // `border-top-width`, `border-color`. A document that says only those would
  // otherwise lose its stroke entirely, and it is a common way to write one.
  // An explicit EMPTY stack is "no stroke" and is never backfilled from these.
  // Reported at `path`, not `path/stroke`: these spellings are element-level
  // (`border-top-width`, `strokeWidth`), and naming a `stroke` field that the
  // dialect does not have would point a reader at nothing.
  const fromElement = normalizeStroke(undefined, el, path, repairs);
  return fromElement ? [fromElement] : undefined;
}
