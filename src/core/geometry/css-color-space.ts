/**
 * CSS Color 4 colour functions → `#rrggbb`.
 *
 * Two readers need this: the HTML importer, and `parseColorAlpha`, which every
 * readout, swatch, picker and contrast check goes through. It lives in
 * `geometry` rather than under `import` for that second reason — the converter
 * is the primitive, the importer is one of its callers.
 *
 * `rgb()` / `rgba()` reach here only for their Color 4 syntax — space-separated
 * channels, `%` channels, a slash alpha. The legacy comma form is the reader's
 * own regex and is answered before this is called, which is how `rgb(255, 0, 0)`
 * and `rgb(255 0 0)` came to disagree.
 *
 * Chrome does NOT fold these into `rgb()` at computed-value time — `oklch(0.7
 * 0.15 200)` and `color(display-p3 1 0 0)` come out of `getComputedStyle` as
 * themselves, so a parser that only knows hex and `rgb()` reports every one of
 * them as "no colour here" and the element silently loses its fill. Tailwind v4
 * ships an oklch palette, so this is the common case rather than an exotic one.
 *
 * The conversions are CSS Color 4's own, including the Bradford adaptation from
 * XYZ(D50) to XYZ(D65) that `lab()` / `lch()` need before sRGB: skipping it
 * lands about 3 channels off on a mid grey, which reads as a colour change
 * rather than as an error. Out-of-gamut channels are clipped rather than mapped,
 * because an author who wrote `display-p3 1 0 0` asked for the reddest red.
 */

import { rgbToHex } from "./hex";

export interface WideColor {
  color: string;
  opacity?: number;
}

type Triple = [number, number, number];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** sRGB transfer function, applied to each linear channel. */
function encode(c: number): number {
  const v = clamp01(c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * The same curve backwards, which is how every space but `xyz` arrives.
 *
 * A `color()` function is written in the space's OWN encoding — `color(display-p3
 * 1 0 0)` is 1 on P3's curve — while the matrix onto XYZ is the one for LIGHT.
 * Feeding the encoded channels straight in is the quiet half of this mistake: the
 * endpoints still come out right (0 and 1 are fixed points of every one of these
 * curves), so `1 0 0` and `0 0 0` look correct and only the midtones are wrong —
 * `color(display-p3 0.5 0.5 0.5)` landed at #BCBCBC instead of #808080.
 */
function decode(c: number): number {
  const v = Math.abs(c);
  const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return Math.sign(c) * linear;
}

/** A98's pure power law, `563/256`. */
function decodeA98(c: number): number {
  return Math.sign(c) * Math.abs(c) ** (563 / 256);
}

const REC2020_ALPHA = 1.09929682680944;
const REC2020_BETA = 0.018053968510807;

function decodeRec2020(c: number): number {
  const v = Math.abs(c);
  const linear = v < REC2020_BETA * 4.5 ? v / 4.5 : ((v + REC2020_ALPHA - 1) / REC2020_ALPHA) ** (1 / 0.45);
  return Math.sign(c) * linear;
}

/** ProPhoto's 1.8 gamma, with the linear segment below `1/512`. */
function decodeProPhoto(c: number): number {
  const v = Math.abs(c);
  const linear = v <= 16 / 512 ? v / 16 : v ** 1.8;
  return Math.sign(c) * linear;
}

const identityChannel = (c: number): number => c;

function hexOf(linear: Triple): string {
  const [r, g, b] = linear.map((c) => Math.round(encode(c) * 255)) as Triple;
  return rgbToHex(r, g, b).toUpperCase();
}

function multiply(m: readonly number[], v: Triple): Triple {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ];
}

const XYZ_D65_TO_LINEAR_SRGB = [
  3.2409699419045226, -1.537383177570094, -0.4986107602930034,
  -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
  0.05563007969699366, -0.20397695888897652, 1.0569715142428786
];

const XYZ_D50_TO_D65 = [
  0.9554734527042182, -0.023098536874261423, 0.0632593086610217,
  -0.0283697093338637, 1.0099954580058226, 0.021041398966943008,
  0.012314014688851899, -0.020507696433477912, 1.3303659366080753
];

const DISPLAY_P3_TO_XYZ_D65 = [
  0.4865709486482162, 0.26566769316909306, 0.1982172852343625,
  0.2289745640697488, 0.6917385218365064, 0.079286914093745,
  0, 0.04511338185890264, 1.043944368900976
];

const A98_RGB_TO_XYZ_D65 = [
  0.5766690429101305, 0.1855582379065463, 0.1882286462349947,
  0.29734497525053605, 0.6273635662554661, 0.07529145849399788,
  0.02703136138641234, 0.07068885253582723, 0.9913375368376388
];

const REC2020_TO_XYZ_D65 = [
  0.6369580483012914, 0.14461690358620832, 0.1688809751641721,
  0.2627002120112671, 0.6779980715188708, 0.05930171646986196,
  0, 0.028072693049087428, 1.060985057710791
];

const LINEAR_SRGB_TO_XYZ_D65 = [
  0.41239079926595934, 0.357584339383878, 0.1804807884018343,
  0.21263900587151027, 0.715168678767756, 0.07219231536073371,
  0.01933081871559182, 0.11919477979462597, 0.9505321522496607
];

const PROPHOTO_TO_XYZ_D50 = [
  0.7977604896723027, 0.13518583717574031, 0.0313493495815248,
  0.2880711282292934, 0.7118432178101014, 0.00008565396060525902,
  0, 0, 0.8251046025104602
];

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function oklabToLinearSrgb(l: number, a: number, b: number): Triple {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  ];
}

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

/** CIE Lab → XYZ(D50); CSS's `lab()` is defined against D50, not sRGB's D65. */
function labToXyzD50(l: number, a: number, b: number): Triple {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const invert = (t: number): number => (t ** 3 > LAB_EPSILON ? t ** 3 : (116 * t - 16) / LAB_KAPPA);
  return [invert(fx) * 0.9642956764295677, invert(fy) * 1, invert(fz) * 0.8251046025104602];
}

function xyzD50ToLinearSrgb(xyz: Triple): Triple {
  return multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(XYZ_D50_TO_D65, xyz));
}

function polarToAb(chroma: number, hueDeg: number): [number, number] {
  const rad = ((hueDeg % 360) * Math.PI) / 180;
  return [chroma * Math.cos(rad), chroma * Math.sin(rad)];
}

function hslToLinearSrgb(h: number, s: number, l: number): Triple {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const sector = Math.floor(hue / 60) % 6;
  const table: Triple[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ];
  const [r, g, b] = table[sector];
  return [r + m, g + m, b + m].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Triple;
}

/**
 * One computed colour word. A unitless number is the norm because Chrome
 * serializes percentages away; `deg` survives only on the hue of `lch`/`oklch`.
 */
function number(raw: string, percentOf?: number): number {
  const value = raw.trim();
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return Number.NaN;
  if (value.endsWith("%")) return percentOf === undefined ? n / 100 : (n / 100) * percentOf;
  return n;
}

/** Split `fn(...)` into its numeric arguments and the alpha after the slash. */
function argumentsOf(body: string): { parts: string[]; alphaPart?: string } {
  const segments = body.split("/");
  const head = segments[0] ?? "";
  // Commas survive inside the parenthesised colour syntax, and no argument
  // here contains one, so a flat split is enough.
  const parts = head.trim().split(/[\s,]+/).filter(Boolean);
  return { parts, alphaPart: segments[1]?.trim() };
}

function alphaOf(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = number(raw, 1);
  return Number.isFinite(n) ? clamp01(n) : undefined;
}

function finish(linear: Triple, alphaPart: string | undefined): WideColor {
  const color = hexOf(linear);
  const opacity = alphaOf(alphaPart);
  return opacity !== undefined && opacity < 1 ? { color, opacity } : { color };
}

/**
 * A `color()` target: the matrix onto XYZ, which white point that XYZ is referred
 * to, and the transfer curve its written channels carry. ProPhoto alone is
 * published against D50, so it is the one entry that still needs the adaptation
 * before sRGB's matrix can be applied.
 */
interface RgbSpace {
  matrix: readonly number[];
  white: "d50" | "d65";
  decode: (c: number) => number;
}

const COLOR_SPACES: Record<string, RgbSpace> = {
  srgb: { matrix: LINEAR_SRGB_TO_XYZ_D65, white: "d65", decode },
  "srgb-linear": { matrix: LINEAR_SRGB_TO_XYZ_D65, white: "d65", decode: identityChannel },
  // Display-P3 shares sRGB's curve; the others have their own.
  "display-p3": { matrix: DISPLAY_P3_TO_XYZ_D65, white: "d65", decode },
  "a98-rgb": { matrix: A98_RGB_TO_XYZ_D65, white: "d65", decode: decodeA98 },
  rec2020: { matrix: REC2020_TO_XYZ_D65, white: "d65", decode: decodeRec2020 },
  prophoto: { matrix: PROPHOTO_TO_XYZ_D50, white: "d50", decode: decodeProPhoto },
  // XYZ is already light, so its channels are taken as written.
  xyz: { matrix: IDENTITY, white: "d65", decode: identityChannel },
  "xyz-d65": { matrix: IDENTITY, white: "d65", decode: identityChannel },
  "xyz-d50": { matrix: IDENTITY, white: "d50", decode: identityChannel }
};

/**
 * The colour a wide-gamut computed value stands for, or `null` when it is not
 * one of the spellings this knows.
 */
export function parseCssWideColor(raw: string): WideColor | null {
  const value = raw.trim().toLowerCase();
  const call = /^([a-z-]+)\(([^()]*)\)$/.exec(value);
  if (!call) return null;
  const fn = call[1];
  const { parts, alphaPart } = argumentsOf(call[2]);
  const read = (i: number, percentOf?: number): number => (parts[i] === undefined ? Number.NaN : number(parts[i], percentOf));

  switch (fn) {
    case "oklch": {
      const light = read(0, 1);
      const chroma = read(1, 0.4);
      const hue = read(2);
      if (![light, chroma, hue].every(Number.isFinite)) return null;
      const [a, b] = polarToAb(chroma, hue);
      return finish(oklabToLinearSrgb(light, a, b), alphaPart);
    }
    case "oklab": {
      const light = read(0, 1);
      const a = read(1, 0.4);
      const b = read(2, 0.4);
      if (![light, a, b].every(Number.isFinite)) return null;
      return finish(oklabToLinearSrgb(light, a, b), alphaPart);
    }
    case "lab": {
      const light = read(0, 100);
      const a = read(1, 125);
      const b = read(2, 125);
      if (![light, a, b].every(Number.isFinite)) return null;
      return finish(xyzD50ToLinearSrgb(labToXyzD50(light, a, b)), alphaPart);
    }
    case "lch": {
      const light = read(0, 100);
      const chroma = read(1, 150);
      const hue = read(2);
      if (![light, chroma, hue].every(Number.isFinite)) return null;
      const [a, b] = polarToAb(chroma, hue);
      return finish(xyzD50ToLinearSrgb(labToXyzD50(light, a, b)), alphaPart);
    }
    case "hsl":
    case "hsla": {
      const hue = read(0);
      const sat = read(1, 1);
      const light = read(2, 1);
      if (![hue, sat, light].every(Number.isFinite)) return null;
      // The legacy comma form `hsla(h, s%, l%, a)` carries its alpha as a
      // FOURTH argument, and `argumentsOf` only splits a slash section — so the
      // alpha was dropped and every translucent `hsla()` came out opaque.
      return finish(hslToLinearSrgb(hue, sat, light), alphaPart ?? parts[3]);
    }
    // `%` channels carry their own scale and a bare channel is out of 255, hence
    // the percentOf here rather than the 0..1 every other case is written in.
    case "rgb":
    case "rgba": {
      const channels = [read(0, 255) / 255, read(1, 255) / 255, read(2, 255) / 255];
      if (channels.some((n) => !Number.isFinite(n))) return null;
      return finish(channels.map(decode) as Triple, alphaPart ?? parts[3]);
    }
    case "color": {
      const space = parts[0];
      const target = space ? COLOR_SPACES[space] : undefined;
      if (!target) return null;
      const channels = parts.slice(1).map((p) => number(p, 1));
      if (channels.length < 3 || channels.some((n) => !Number.isFinite(n))) return null;
      const light = channels.map(target.decode) as Triple;
      const xyz = multiply(target.matrix, light);
      const d65 = target.white === "d65" ? xyz : multiply(XYZ_D50_TO_D65, xyz);
      return finish(multiply(XYZ_D65_TO_LINEAR_SRGB, d65), alphaPart);
    }
    default:
      return null;
  }
}
