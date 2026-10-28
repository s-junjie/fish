import { composeColorAlpha, parseColorAlpha } from "../geometry/color-utils";
import { parseCssWideColor } from "../geometry/css-color-space";
import { linearGradientLineLength } from "../geometry/gradient-utils";
import type { ColorFilter, GradientStop, Paint } from "../dsl/types";
import { splitTopLevel } from "./split";

const HEX = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export interface CssColor {
  color: string;
  opacity?: number;
}

/** Chrome reports computed colours as `rgb()` / `rgba()`; the DSL stores `#rrggbb`. */
export function parseCssColor(raw: string): CssColor | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return null;

  if (value.startsWith("#")) {
    if (value.length === 4) {
      return { color: `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toUpperCase() };
    }
    if (value.length === 7) return { color: value.toUpperCase() };
    if (value.length === 9) {
      const alpha = parseInt(value.slice(7, 9), 16) / 255;
      return { color: value.slice(0, 7).toUpperCase(), ...(alpha < 1 ? { opacity: alpha } : {}) };
    }
    return null;
  }

  const match = /^rgba?\(([^)]+)\)$/.exec(value);
  if (match) {
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    // `Number("100%")` is NaN, so a percentage-channel colour fails the numeric
    // path; hand it to the wide parser below rather than report it as a gap.
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      const [r, g, b, a] = parts;
      if (a !== undefined && a === 0) return null;
      return {
        color: `#${HEX(r)}${HEX(g)}${HEX(b)}`.toUpperCase(),
        ...(a !== undefined && a < 1 ? { opacity: a } : {})
      };
    }
  }

  return parseCssWideColor(value);
}

export function px(raw: string): number | undefined {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

const ABSOLUTE_UNITS = /^(?:\d+\.?\d*|\.\d+)(?:px|pt|pc|in|cm|mm|q)$/i;

/**
 * A length that means the same number whatever box it lands in.
 *
 * `px` cannot be used to read one: it parses the digits and stops, so `90%`
 * becomes `90` and a relative bound arrives as an absolute one. The two are told
 * apart HERE rather than at each call site because CSS resolves them at
 * different times — computed `padding`/`margin`/`gap` are already px, while
 * computed `min-width`/`max-width`/`min-height`/`max-height` KEEP their
 * percentage, so the same `px` call is right on one property and wrong on the
 * next. `sizing.minWidth` is a plain number with no relative spelling, so a
 * bound that arrives in `%` or `em` has to be reported as a gap rather than
 * frozen at the width it happened to have at import.
 */
export function absolutePx(raw: string): number | undefined {
  const value = raw.trim();
  if (value === "0") return 0;
  if (!ABSOLUTE_UNITS.test(value)) return undefined;
  return px(value);
}

/**
 * `object-position` as the fraction of the overflow each axis is offset by.
 *
 * Percentages and the five keywords only. A px offset is a distance from an edge
 * that has to be divided by the overflow, and the overflow is only known after
 * the bitmap's natural size meets the box — a case no page in hand needed, so it
 * is declined rather than guessed at.
 */
export function parseObjectPosition(raw: string): { x: number; y: number } | undefined {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return undefined;
  const axis = (token: string): number | undefined => {
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return 1;
    if (token === "center") return 0.5;
    if (token.endsWith("%")) {
      const n = parseFloat(token);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : undefined;
    }
    return undefined;
  };
  const x = parts.length === 2 && isVerticalKeyword(parts[0]) ? axis(parts[1]) : axis(parts[0]);
  const y = parts.length === 1 ? 0.5 : isVerticalKeyword(parts[0]) ? axis(parts[0]) : axis(parts[1]);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

/** `object-position: top right` names the vertical edge first, which CSS allows. */
function isVerticalKeyword(token: string): boolean {
  return token === "top" || token === "bottom";
}

/**
 * A single CSS colour stop position, which may be a percentage, a px length, or
 * absent (meaning "let the browser space it", which the DSL has no spelling for
 * and therefore drops).
 */
function stopOffset(raw: string, axisLength: number): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return undefined;
  if (value.endsWith("%")) return n / 100;
  if (value.endsWith("px") && axisLength > 0) return n / axisLength;
  return n;
}

/** A radial gradient's line runs from the centre to the farthest corner. */
function radialLineLength(width: number, height: number): number {
  return Math.hypot(width, height) / 2;
}

/** Splits on commas that are not inside parentheses. */
function splitTop(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseStops(raw: string, axisLength: number): GradientStop[] {
  const stops: Array<{ color: string; offset: number | null }> = [];
  for (const part of splitTop(raw)) {
    const match = /^(.*?)(?:\s+(-?[\d.]+(?:%|px)?))?$/.exec(part.trim());
    if (!match) continue;
    const colour = stopColor(match[1]);
    if (colour === null) continue;
    stops.push({ color: colour, offset: stopOffset(match[2] ?? "", axisLength) ?? null });
  }
  return spaceStops(stops);
}

/**
 * CSS's spacing for stops that were never given a position — which is not 0.
 *
 * The first is at 0%, the last at 100%, and an interior stop is spread evenly
 * between its two positioned neighbours. Reading them all as 0 collapses the
 * ramp: `linear-gradient(135deg, #4C6EF5, #7048E8)` — how nearly every
 * two-colour fill is written — arrives as two stops both at 0%, and SVG then
 * paints the whole box in the second colour with a hard diagonal of the first
 * left in the corner.
 *
 * Positions are also clamped non-decreasing, as the spec requires: an
 * out-of-order pair is otherwise painted as a hard edge where the page drew a
 * ramp.
 */
function spaceStops(raw: Array<{ color: string; offset: number | null }>): GradientStop[] {
  const n = raw.length;
  if (n === 0) return [];
  const offsets = raw.map((s) => s.offset);
  if (offsets[0] === null) offsets[0] = 0;
  if (n > 1 && offsets[n - 1] === null) offsets[n - 1] = 1;

  let positioned = 0;
  for (let i = 1; i < n; i++) {
    if (offsets[i] !== null) {
      positioned = i;
      continue;
    }
    let next = i + 1;
    while (next < n && offsets[next] === null) next++;
    const from = offsets[positioned] as number;
    const to = next < n ? (offsets[next] as number) : 1;
    offsets[i] = from + ((to - from) * (i - positioned)) / (next - positioned);
  }

  let floor = 0;
  return raw.map((s, i) => {
    floor = Math.max(floor, offsets[i] as number);
    return { color: s.color, offset: Math.round(floor * 1e4) / 1e4 };
  });
}

/**
 * The spellings that mean "no colour at all", which `parseCssColor` reports as
 * an absence.
 *
 * This is the difference between the TWO things a `null` from `parseCssColor`
 * can mean, and every reader that has to tell "the author hid it" from "I do not
 * understand this value" needs it: `transparent` is a decision, `color-mix(…)`
 * is a gap to report.
 *
 * Answered by the wide parser rather than by a second regex, so every Color 4
 * spelling of no-colour gets one answer: a ramp fading to `rgb(255 255 255 / 0)`
 * was neither recognised nor reported, and the dropped stop took the whole
 * gradient with it.
 */
export function isFullyTransparent(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "transparent" || v === "#0000" || v === "#00000000") return true;
  return parseCssWideColor(value)?.opacity === 0;
}

/**
 * A gradient stop's colour, alpha included.
 *
 * `parseCssColor` reads a transparent colour as an ABSENCE, which is right for a
 * fill and wrong for a stop: `linear-gradient(90deg, var(--rule) 0%, transparent
 * 100%)` is how nearly every fade and hairline in a dark UI is written, and
 * dropping the stop collapses the ramp to one colour — the gradient is then
 * reported as unmappable and the decoration disappears from the import.
 *
 * The alpha rides in 8-digit hex, which is the form `composeColorAlpha` writes
 * and `parseColorAlpha` reads, so the renderer and the colour pickers already
 * agree on it.
 */
function stopColor(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (parseCssColor(value) === null) return isFullyTransparent(value) ? "#00000000" : null;
  const { hex6, alphaPct } = parseColorAlpha(value);
  // Upper case to match the convention every other colour in this module is
  // written in; `composeColorAlpha` lower-cases, and one element's fill stack
  // spelling itself two ways is a needless inconsistency.
  return composeColorAlpha(hex6, alphaPct).toUpperCase();
}

/** The colour that opens a gradient argument, tolerating spaces inside `rgb(...)`. */
function leadingColor(part: string): string {
  const match = /^(?:rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/.exec(part.trim());
  return match ? match[0] : part.trim().split(/\s+/)[0] ?? "";
}

/**
 * `background-image` → the DSL's own gradient paints.
 *
 * Only the two the DSL models are read; a `conic-gradient`, a `url()`, or an
 * `image-set()` is reported rather than guessed at.
 */
export function paintFromBackgroundImage(
  raw: string,
  width: number,
  height: number
): Paint | null {
  const value = raw.trim();
  if (!value || value === "none") return null;

  const linear = /^linear-gradient\(([\s\S]*)\)$/.exec(value);
  if (linear) {
    const parts = splitTop(linear[1]);
    if (parts.length < 2) return null;

    let angle = 180;
    let from = 0;
    const direction = parts[0];
    if (/^(?:-?[\d.]+deg|to\s)/.test(direction)) {
      from = 1;
      angle = /deg$/.test(direction) ? parseFloat(direction) : angleFromSide(direction, { width, height });
    }
    const stops = parseStops(parts.slice(from).join(", "), linearGradientLineLength(width, height, angle));
    if (stops.length < 2) return null;
    return {
      type: "linear-gradient",
      from: stops[0].color,
      to: stops[stops.length - 1].color,
      angle,
      stops
    };
  }

  const radial = /^radial-gradient\(([\s\S]*)\)$/.exec(value);
  if (radial) {
    const args = splitTop(radial[1]);
    // `stopColor` for the test, not `part.split(/\s+/)[0]`: a computed `rgb(0, 0,
    // 0)` has spaces in it, so splitting on whitespace reads `rgb(0,` and every
    // spaced colour is discarded — a radial gradient then came out with no stops
    // at all and was reported as unmappable.
    const colourParts = args.filter((p) => stopColor(leadingColor(p)) !== null);
    const stops = parseStops(colourParts.join(", "), radialLineLength(width, height));
    if (stops.length < 2) return null;
    // Only `at` is carried, and only its position: the shape and the sizing
    // keyword (`closest-side`, an explicit radius) change how far the ramp runs,
    // which the DSL's objectBoundingBox radius does not measure the same way.
    const centre = gradientCentre(args[0] ? args[0].split(/\s+/) : []);
    return {
      type: "radial-gradient",
      from: stops[0].color,
      to: stops[stops.length - 1].color,
      stops,
      ...(centre ? { center: centre } : {})
    };
  }

  const conic = /^conic-gradient\(([\s\S]*)\)$/.exec(value);
  if (conic) {
    // The two clauses precede the stops and are written as words rather than as
    // comma-separated arguments, so they are peeled off the front of the string
    // before anything else reads it.
    let rest = conic[1].trim();
    let angle = 0;
    const from = /^from\s+(-?[\d.]+)deg\s*/i.exec(rest);
    if (from) {
      angle = parseFloat(from[1]);
      rest = rest.slice(from[0].length);
    }
    let centre: { x: number; y: number } | undefined;
    const at = /^at\s+([^\s,]+)\s+([^\s,]+)\s*,?\s*/i.exec(rest);
    if (at) {
      centre = gradientCentre(["at", at[1], at[2]]);
      rest = rest.slice(at[0].length);
    }
    // A conic line runs once around the centre, so a stop position is already a
    // share of the sweep and the axis length is 1 rather than the diagonal.
    const stops = parseStops(rest, 1);
    if (stops.length < 2) return null;
    return {
      type: "angular-gradient",
      from: stops[0].color,
      to: stops[stops.length - 1].color,
      angle,
      stops,
      ...(centre ? { center: centre } : {})
    };
  }

  return null;
}

/**
 * The keyword form of a gradient's direction, as the DSL's angle.
 *
 * Both word orders are accepted because Chrome serializes a corner in "
 * horizontal-then-vertical" order — `to bottom right` comes back as `to right
 * bottom` — so the four cases the dialects actually spell differ from the four
 * a stylesheet writes, and matching only the latter silently turned every
 * corner gradient into `to bottom`.
 *
 * A CORNER is not 45° unless the box is square: CSS points the gradient line at
 * the far corner, so its angle is `atan2(dx, -dy)` over the box's own
 * proportions. A 200×60 box's `to right bottom` is 106.7°, and writing 135 put
 * the ramp's highlight along the wrong diagonal. Single-keyword directions are
 * axis-aligned and need no box.
 */
export function angleFromSide(side: string, box?: { width: number; height: number }): number {
  const tokens = side.trim().split(/\s+/).filter((t) => t !== "to");
  const has = (word: string): boolean => tokens.includes(word);
  const vertical = has("top") ? -1 : has("bottom") ? 1 : 0;
  const horizontal = has("left") ? -1 : has("right") ? 1 : 0;

  if (!vertical && !horizontal) return 180;
  if (!vertical) return horizontal > 0 ? 90 : 270;
  if (!horizontal) return vertical > 0 ? 180 : 0;

  const width = Math.abs(box?.width ?? 0);
  const height = Math.abs(box?.height ?? 0);
  if (width <= 0 || height <= 0) {
    return horizontal > 0 ? (vertical > 0 ? 135 : 45) : vertical > 0 ? 225 : 315;
  }
  const deg = (Math.atan2(horizontal * width, -vertical * height) * 180) / Math.PI;
  return Math.round(((deg + 360) % 360) * 100) / 100;
}

/** CSS measures a gradient's angle clockwise from "to top"; the DSL from the top too. */
function gradientCentre(args: string[]): { x: number; y: number } | undefined {
  const at = args.indexOf("at");
  if (at < 0) return undefined;
  const parts = args.slice(at + 1).join(" ").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const fraction = (raw: string): number | undefined => {
    const value = raw.trim();
    if (value.endsWith("%")) {
      const n = Number.parseFloat(value);
      return Number.isFinite(n) ? n / 100 : undefined;
    }
    // Two keywords (`center`, `left top`) are the usual authoring spelling; a
    // bare length arrives here only from a computed value that kept one.
    const keyed: Record<string, number> = { left: 0, center: 0.5, right: 1, top: 0, bottom: 1 };
    const hit = keyed[value];
    if (hit !== undefined) return hit;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? clamp(n / 100, 0, 1) : undefined;
  };
  const x = fraction(parts[0]);
  const y = fraction(parts[1]);
  return x === undefined || y === undefined ? undefined : { x, y };
}

export function backgroundImageUrls(raw: string): string[] {
  const urls: string[] = [];
  for (const match of raw.matchAll(/url\((["']?)([^"')]+)\1\)/g)) urls.push(match[2]);
  return urls;
}

/**
 * `background-image` is a comma-separated LAYER list and the first layer paints
 * on TOP — the reverse of the DSL's fill stack, which is bottom-first. Splitting
 * here (rather than inside `paintFromBackgroundImage`) is what lets a two-layer
 * background survive: handed the whole string, its own comma splitting would
 * read layer 2's colour as layer 1's first stop.
 */
export function backgroundLayers(raw: string): string[] {
  const value = raw.trim();
  if (!value || value === "none") return [];
  return splitTop(value);
}

// ---------------------------------------------------------------------------
// box-shadow
// ---------------------------------------------------------------------------

export interface ParsedShadow {
  inset: boolean;
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
}

function lengthOf(token: string): number | undefined {
  const match = /^(-?[\d.]+)(px)?$/.exec(token);
  if (!match) return undefined;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * One or more CSS `box-shadow` values. Chrome writes them as
 * `rgba(0, 0, 0, 0.1) 0px 4px 8px 0px`; Firefox puts the colour last, so the
 * colour and the lengths are told apart by shape rather than by position.
 */
export function parseBoxShadows(raw: string): ParsedShadow[] {
  const value = raw.trim();
  if (!value || value === "none") return [];
  const out: ParsedShadow[] = [];
  for (const part of splitTop(value)) {
    const inset = /(^|\s)inset(\s|$)/.test(part);
    const lengths: number[] = [];
    const colour: string[] = [];
    for (const token of splitTopLevel(part.replace(/(^|\s)inset(\s|$)/g, " ").trim())) {
      const n = lengthOf(token);
      if (n !== undefined && lengths.length < 4) lengths.push(n);
      else colour.push(token);
    }
    if (lengths.length < 2) continue;
    out.push({
      inset,
      color: colour.join(" ") || "rgba(0, 0, 0, 0.25)",
      offsetX: lengths[0],
      offsetY: lengths[1],
      blur: Math.max(0, lengths[2] ?? 0),
      spread: lengths[3] ?? 0
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

export interface ParsedFilter {
  filter?: ColorFilter;
  /**
   * `blur(Npx)` as the DSL's RADIUS. CSS's argument is a Gaussian sigma and the
   * DSL's is a radius, so this is doubled on the way in; `cssBlurFilter` halves
   * it on the way out, and the two together round-trip.
   */
  blur?: number;
  shadows: ParsedShadow[];
  /** Function names the DSL has no spelling for, e.g. `sepia`, `opacity`. */
  unsupported: string[];
}

const ratio = (raw: string): number | undefined => {
  const value = raw.trim();
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return undefined;
  return value.endsWith("%") ? n / 100 : n;
};

export function parseFilterValue(raw: string | undefined): ParsedFilter {
  const value = (raw ?? "").trim();
  const out: ParsedFilter = { shadows: [], unsupported: [] };
  if (!value || value === "none") return out;
  const filter: ColorFilter = {};
  for (const match of value.matchAll(/([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const name = match[1];
    const args = match[2].trim();
    switch (name) {
      case "brightness": {
        const v = ratio(args);
        if (v !== undefined) filter.brightness = v;
        break;
      }
      case "contrast": {
        const v = ratio(args);
        if (v !== undefined) filter.contrast = v;
        break;
      }
      case "saturate": {
        const v = ratio(args);
        if (v !== undefined) filter.saturation = v;
        break;
      }
      case "hue-rotate": {
        const v = px(args);
        if (v !== undefined) filter.hueRotate = v;
        break;
      }
      case "grayscale": {
        const v = ratio(args);
        if (v !== undefined) filter.grayscale = v;
        break;
      }
      case "invert": {
        const v = ratio(args);
        if (v !== undefined) filter.invert = v;
        break;
      }
      case "blur": {
        const v = px(args);
        if (v !== undefined) out.blur = Math.max(0, v * 2);
        break;
      }
      case "drop-shadow": {
        const [shadow] = parseBoxShadows(args);
        if (shadow) out.shadows.push(shadow);
        break;
      }
      default:
        out.unsupported.push(name);
    }
  }
  if (Object.keys(filter).length > 0) out.filter = filter;
  return out;
}

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------

/**
 * The rotation a `transform` carries, or nothing when the matrix is not a pure
 * rotation.
 *
 * Computed `transform` is always a matrix, so the angle is recovered from
 * `atan2(b, a)` — but only once the matrix is known to be a rotation. A scale
 * or a skew lands in the same six numbers and has no DSL spelling at all, and
 * reading its `atan2` would invent a rotation the page never had.
 */
export function rotationFromTransform(raw: string): number | undefined {
  const value = raw.trim();
  if (!value || value === "none") return undefined;
  const match = /^matrix\(([^)]+)\)$/.exec(value);
  if (!match) return undefined;
  const parts = match[1].split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [a, b, c, d] = parts;
  if (Math.abs(Math.hypot(a, b) - 1) > 1e-3) return undefined;
  if (Math.abs(Math.hypot(c, d) - 1) > 1e-3) return undefined;
  if (Math.abs(a * c + b * d) > 1e-3) return undefined;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return Math.abs(deg) < 1e-3 ? undefined : Math.round(deg * 1000) / 1000;
}

/**
 * Whether a computed `transform-origin` is the default centre.
 *
 * Chrome serialises it as PIXELS — `"40px 20px"`, not `"50% 50%"` — so a test
 * against the percentage spelling was false for every element on every page,
 * and each of them fell through to the branch that reports the transform as
 * unmapped. Every `transform: rotate(...)` a page wrote was therefore being
 * named as a loss and drawn unrotated, which is why an icon, a chevron or a
 * badge came over square.
 *
 * Resolved against the box when there is one, since that is what turns the px
 * form back into "halfway along" — and without a box it can only answer the
 * literal question, which the old behaviour still covered.
 */
export function isCentredTransformOrigin(raw?: string, box?: { width: number; height: number }): boolean {
  const value = (raw ?? "").trim();
  if (!value) return true;
  const parts = splitTopLevel(value);
  if (parts.length < 2) return true;
  const centred = (part: string, size: number): boolean => {
    if (part === "50%" || part === "center") return true;
    const n = px(part);
    if (n === undefined || size <= 0) return false;
    return Math.abs(n - size / 2) < 0.5;
  };
  return centred(parts[0], box?.width ?? 0) && centred(parts[1], box?.height ?? 0);
}

/**
 * Whether a matrix is a translation and nothing else.
 *
 * Worth naming because a translation is not a gap: the import stores the box the
 * browser measured, and that box already has the translation baked into it. The
 * DSL draws the element at that origin, so the result is pixel-identical — and
 * reporting it as "unmapped" buries the transforms that really are lost.
 */
export function isPureTranslation(raw: string): boolean {
  const match = /^matrix\(([^)]+)\)$/.exec(raw.trim());
  if (!match) return false;
  const parts = match[1].split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b, c, d] = parts;
  return Math.abs(a - 1) < 1e-3 && Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3 && Math.abs(d - 1) < 1e-3;
}

/**
 * A box that was measured on screen, pulled back out of a rotation.
 *
 * `getBoundingClientRect()` reports the AXIS-ALIGNED box, so a rotated element
 * comes back larger than it is and its siblings come back skewed. The centre is
 * rotation-invariant, so the true size is recovered by solving
 * `W = w|cos| + h|sin|`, `H = w|sin| + h|cos|` and the origin follows from it.
 */
export function unrotateBox(
  rect: { x: number; y: number; width: number; height: number },
  degrees: number
): { x: number; y: number; width: number; height: number } {
  if (!degrees) return rect;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const det = cos * cos - sin * sin;
  if (Math.abs(det) < 1e-6) return rect;
  const width = Math.max(0, (rect.width * cos - rect.height * sin) / det);
  const height = Math.max(0, (rect.height * cos - rect.width * sin) / det);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/**
 * A vertical writing mode's box, re-expressed as horizontal text plus the turn
 * that puts it back.
 *
 * `writing-mode: vertical-*` measures one COLUMN — narrow and tall, with Latin
 * glyphs already turned a quarter turn clockwise so the line reads downward.
 * The DSL lays text out horizontally only, so the box is swapped about its
 * centre (the one point a turn leaves fixed) and the element carries the
 * quarter turn; the glyphs then read top-to-bottom, and successive lines land
 * to the left, which is what `vertical-rl` does too. `ownRotation` is the
 * element's own `transform` angle, which the browser has already folded into
 * the measured bound.
 */
export function sidewaysTextBox(
  rect: { x: number; y: number; width: number; height: number },
  ownRotation = 0
): { x: number; y: number; width: number; height: number; rotation: number } {
  const layout = unrotateBox(rect, ownRotation);
  const cx = layout.x + layout.width / 2;
  const cy = layout.y + layout.height / 2;
  return {
    x: cx - layout.height / 2,
    y: cy - layout.width / 2,
    width: layout.height,
    height: layout.width,
    rotation: ownRotation + 90
  };
}
