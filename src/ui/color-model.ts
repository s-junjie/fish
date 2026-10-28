import {
  hexToHsl,
  hexToHsv,
  hexToRgb,
  hslToHex,
  hsvToHex,
  rgbToHex
} from "../core/geometry/color-utils";
import { t } from "../i18n";

/**
 * The NOTATIONS a colour can be described in, and how to read and write each one.
 *
 * Purely a presentation concern. The document stores hex and only hex
 * (`composeColorAlpha` is the single writer, and `src/core/dsl/versions.json` is
 * untouched), so switching notation here writes nothing — the same colour, named
 * four ways. Figma's picker behaves the same way, which is why this is its own
 * module rather than four fields in `ColorPanel`.
 *
 * The one thing that is NOT free is HSL: the panel's working space is HSV (the
 * saturation/value field and the hue rail are drawn from it), so HSB is a
 * re-spelling of what is already in hand and HSL is a real conversion. `hsvToRgb`
 * stays unrounded for exactly this reason — see `color-utils.ts`.
 */

export type ColorNotation = "hex" | "rgb" | "hsl" | "hsb";

/** Order the menu walks them in, and the order the tests assert against. */
export const COLOR_NOTATIONS: ColorNotation[] = ["hex", "rgb", "hsl", "hsb"];

const NOTATION_LABEL_KEY: Record<ColorNotation, string> = {
  hex: "colorNotation.hex",
  rgb: "colorNotation.rgb",
  hsl: "colorNotation.hsl",
  hsb: "colorNotation.hsb"
};

/** A notation's name. `HEX` / `RGB` / `HSL` / `HSB` — acronyms, not words. */
export const notationLabel = (notation: ColorNotation) => t(NOTATION_LABEL_KEY[notation]);

export interface Channel {
  /** The field's KEY — `R`, `H`, `L`. An initial, so it is not translatable. */
  key: string;
  /** The value as shown and as typed. Always a whole number: the stored colour
   *  is 8-bit, so a fraction here would read as precision the colour lacks. */
  value: number;
  min: number;
  max: number;
}

const ch = (key: string, value: number, max: number): Channel => ({ key, value, min: 0, max });

const rgbChannels = (hex6: string): Channel[] => {
  const { r, g, b } = hexToRgb(hex6);
  return [ch("R", r, 255), ch("G", g, 255), ch("B", b, 255)];
};

const hslChannels = (hex6: string, isHsb?: boolean): Channel[] => {
  const c = (isHsb ? hexToHsv(hex6) : hexToHsl(hex6)) as any;
  return [ch("H", Math.round(c.h), 360), ch("S", Math.round(c.s), 100), ch(isHsb ? "B" : "L", Math.round(isHsb ? c.v : c.l), 100)];
};

export function notationChannels(notation: ColorNotation, hex6: string): Channel[] {
  if (notation === "rgb") return rgbChannels(hex6);
  if (notation === "hsl") return hslChannels(hex6);
  if (notation === "hsb") return hslChannels(hex6, true);
  return [];
}

/**
 * `hex6` with channel `index` set to `value`.
 *
 * The two untouched channels are read UNROUNDED and the result is quantised once,
 * so editing H in HSB does not quietly round S and V on the way through. This is
 * the same invariant `rgbToHsv` is written around: a conversion that rounds
 * inside itself loses up to 1/255 per channel, and this runs on every keystroke.
 */
export function applyChannel(notation: ColorNotation, hex6: string, index: number, value: number): string {
  if (notation === "rgb") {
    const { r, g, b } = hexToRgb(hex6);
    const next = [r, g, b];
    next[index] = Math.round(clamp(value, 0, 255));
    return rgbToHex(next[0], next[1], next[2]);
  }
  const isHsl = notation === "hsl";
  if (isHsl || notation === "hsb") {
    const fn = isHsl ? hexToHsl : hexToHsv;
    const toHex = isHsl ? hslToHex : hsvToHex;
    const c = fn(hex6) as any;
    const keys = isHsl ? ["h", "s", "l"] : ["h", "s", "v"];
    c[keys[index]] = clamp(value, 0, index === 0 ? 360 : 100);
    return toHex(c);
  }
  return hex6;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));