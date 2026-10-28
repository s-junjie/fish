/**
 * Color and Alpha parsing/composition utilities.
 * Handles hex3, hex6, hex8, `rgb()`, `rgba()`, `transparent`, and every CSS
 * Color 4 spelling the colour-space converter knows (`oklch`, `lab`, `lch`,
 * `color(display-p3 …)`, …).
 *
 * STORED format is hex only (`composeColorAlpha` is the single writer). The
 * other notations exist as READOUTS — see `src/ui/color-model.ts`.
 */

import { parseCssWideColor } from "./css-color-space";
import { rgbToHex } from "./hex";

export { rgbToHex };

export interface ParsedColorAlpha {
  hex6: string;
  alphaPct: number;
}

export function isValidHex(value: string | undefined): boolean {
  if (!value) return false;
  let v = value.trim();
  if (!v.startsWith("#")) v = "#" + v;
  return (
    /^#[0-9a-fA-F]{3}$/.test(v) ||
    /^#[0-9a-fA-F]{4}$/.test(v) ||
    /^#[0-9a-fA-F]{6}$/.test(v) ||
    /^#[0-9a-fA-F]{8}$/.test(v)
  );
}

export function parseColorAlpha(value: string | undefined): ParsedColorAlpha {
  if (!value) return { hex6: "#000000", alphaPct: 100 };
  let v = value.trim();
  if (!v.startsWith("#") && !v.toLowerCase().startsWith("rgb") && /^[0-9a-fA-F]{3,8}$/.test(v)) {
    v = "#" + v;
  }

  // The keyword the engine ITSELF writes for "no fill" (`normalize/element.ts`).
  // Reading it as opaque black turned every no-fill layer into a black swatch and
  // every transparent ink colour into a contrast failure, while `#00000000` — the
  // same colour — read correctly.
  if (v.toLowerCase() === "transparent") return { hex6: "#000000", alphaPct: 0 };

  // #RGB
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const hex6 = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    return { hex6: hex6.toLowerCase(), alphaPct: 100 };
  }

  // #RGBA
  if (/^#[0-9a-fA-F]{4}$/.test(v)) {
    const hex6 = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    const alphaPct = Math.round((parseInt(v[4] + v[4], 16) / 255) * 100);
    return { hex6: hex6.toLowerCase(), alphaPct };
  }

  // #RRGGBB or #RRGGBBAA
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
    const alphaPct = v.length === 9 ? Math.round((parseInt(v.slice(7, 9), 16) / 255) * 100) : 100;
    return { hex6: v.slice(0, 7).toLowerCase(), alphaPct };
  }

  // rgb(...) or rgba(...)
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const hex6 =
      "#" +
      [1, 2, 3]
        .map((i) => Number(m[i]).toString(16).padStart(2, "0"))
        .join("");
    const alphaPct = m[4] !== undefined ? Math.round(parseFloat(m[4]) * 100) : 100;
    return { hex6: hex6.toLowerCase(), alphaPct: Math.min(100, Math.max(0, alphaPct)) };
  }

  // Everything else the engine can PAINT but this reader did not enumerate.
  // Returning `#000000` for these was a WRONG answer, not a missing one: the
  // canvas painted the real colour while every readout, swatch, picker and
  // contrast check saw black, and an `oklch()` gradient stop imported as a
  // black ramp. A spelling this cannot read either (`color-mix()`, a colour
  // keyword) still falls through, which is the gap the importer reports.
  const wide = parseCssWideColor(v);
  if (wide) {
    const alphaPct = wide.opacity === undefined ? 100 : Math.round(wide.opacity * 100);
    return { hex6: wide.color.toLowerCase(), alphaPct };
  }

  return { hex6: "#000000", alphaPct: 100 };
}

export function composeColorAlpha(hex6: string, alphaPct: number): string {
  const cleanHex = hex6.startsWith("#") ? hex6.slice(0, 7) : `#${hex6.slice(0, 6)}`;
  const clampedPct = Math.min(100, Math.max(0, Math.round(alphaPct)));
  if (clampedPct >= 100) return cleanHex.toLowerCase();
  const a = Math.round((clampedPct / 100) * 255);
  return (cleanHex + a.toString(16).padStart(2, "0")).toLowerCase();
}

/**
 * Splits CSS color into floodColor and floodOpacity for SVG filter primitives.
 */
export function parseFloodColor(color: string | undefined): { floodColor: string; floodOpacity: number } {
  if (!color) return { floodColor: "#000000", floodOpacity: 1 };
  const { hex6, alphaPct } = parseColorAlpha(color);
  return { floodColor: hex6, floodOpacity: Math.round((alphaPct / 100) * 100) / 100 };
}

/**
 * Resolves a paint/shadow color and opacity for blend modes whose intensity is
 * encoded in the RGB channels (Figma's `LINEAR_DODGE` -> `plus-lighter` and
 * `LINEAR_BURN` -> `color-burn`).
 *
 * In an SVG filter or isolated compositor layer where the backdrop is
 * transparent (`alpha = 0`), a `plus-lighter` shadow/fill of `#282828` at
 * `opacity = 1` would otherwise output premultiplied `(0.157, 0.157, 0.157, 1.0)`,
 * which composites over the canvas as 100% opaque dark charcoal instead of a
 * 15.7% additive white highlight. Similarly, a `color-burn` (`LINEAR_BURN`)
 * shadow of `#e6e6e6` at `opacity = 1` over transparent `SourceGraphic` would
 * output 100% opaque light gray instead of a 9.8% subtractive dark shadow.
 */
export function parseBlendFlood(
  color: string | undefined,
  blendMode?: string
): { floodColor: string; floodOpacity: number; effectiveBlendMode?: string } {
  if (!color) return { floodColor: "#000000", floodOpacity: 1, effectiveBlendMode: blendMode };
  const { hex6, alphaPct } = parseColorAlpha(color);
  const baseAlpha = alphaPct / 100;
  if (blendMode === "plus-lighter") {
    const { r, g, b } = hexToRgb(hex6);
    const m = Math.max(r, g, b) / 255;
    if (m <= 0) {
      return { floodColor: "#000000", floodOpacity: 0, effectiveBlendMode: "plus-lighter" };
    }
    return {
      floodColor: rgbToHex(r / m, g / m, b / m),
      floodOpacity: Math.round(baseAlpha * m * 1000) / 1000,
      effectiveBlendMode: "plus-lighter"
    };
  }
  if (blendMode === "color-burn") {
    const { r, g, b } = hexToRgb(hex6);
    const dr = (255 - r) / 255;
    const dg = (255 - g) / 255;
    const db = (255 - b) / 255;
    const md = Math.max(dr, dg, db);
    if (md <= 0) {
      return { floodColor: "#000000", floodOpacity: 0, effectiveBlendMode: "normal" };
    }
    return {
      floodColor: rgbToHex((1 - dr / md) * 255, (1 - dg / md) * 255, (1 - db / md) * 255),
      floodOpacity: Math.round(baseAlpha * md * 1000) / 1000,
      effectiveBlendMode: "normal"
    };
  }
  return {
    floodColor: hex6,
    floodOpacity: Math.round(baseAlpha * 100) / 100,
    effectiveBlendMode: blendMode
  };
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HSV {
  h: number; // 0 - 360
  s: number; // 0 - 100
  v: number; // 0 - 100
}

export function hexToRgb(hex: string): RGB {
  const { hex6 } = parseColorAlpha(hex);
  return {
    r: parseInt(hex6.slice(1, 3), 16),
    g: parseInt(hex6.slice(3, 5), 16),
    b: parseInt(hex6.slice(5, 7), 16)
  };
}

function calcHue(rn: number, gn: number, bn: number, max: number, delta: number): number {
  if (delta === 0) return 0;
  let h = (max === rn ? (gn - bn) / delta : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4) * 60;
  return h < 0 ? h + 360 : h;
}

function chromaToRgb(hue: number, c: number, m: number): RGB {
  const h = ((hue % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

/**
 * HSV conversions stay unrounded on purpose: rounding `s`/`v` to whole percent
 * loses up to 1/255 per channel, so a hex -> HSV -> hex round trip (run on
 * every picker render) would drift the stored colour by one step each time.
 */
export function rgbToHsv({ r, g, b }: RGB): HSV {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), delta = max - min;
  return { h: calcHue(rn, gn, bn, max, delta), s: max === 0 ? 0 : (delta / max) * 100, v: max * 100 };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const val = Math.max(0, Math.min(100, v)) / 100;
  const c = val * sat;
  return chromaToRgb(h, c, val - c);
}

export function hexToHsv(hex: string): HSV {
  return rgbToHsv(hexToRgb(hex));
}

export function hsvToHex(hsv: HSV): string {
  const { r, g, b } = hsvToRgb(hsv);
  return rgbToHex(r, g, b);
}

export interface HSL {
  h: number; // 0 - 360
  s: number; // 0 - 100
  l: number; // 0 - 100
}

/** Unrounded for the same reason `rgbToHsv` is — see the note above it. */
export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), delta = max - min;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h: calcHue(rn, gn, bn, max, delta), s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lum = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  return chromaToRgb(h, c, lum - c / 2);
}

export function hexToHsl(hex: string): HSL {
  return rgbToHsl(hexToRgb(hex));
}

export function hslToHex(hsl: HSL): string {
  const { r, g, b } = hslToRgb(hsl);
  return rgbToHex(r, g, b);
}

/** WCAG 2.1 relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 (identical) … 21 (black on white). Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** CSS `rgba(...)` string for preview rails, from a stored color of any format. */
export function toCssRgba(color: string, alphaOverride?: number): string {
  const { r, g, b } = hexToRgb(color);
  const alpha = alphaOverride ?? parseColorAlpha(color).alphaPct / 100;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}
