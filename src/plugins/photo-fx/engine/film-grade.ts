import type { FilmPresetId } from "./film";

export type Vec3 = readonly [number, number, number];

/**
 * The parts of a stock that a user never touches: how its three emulsion layers
 * respond, where they bleed into each other, and how the print tone curve bends.
 *
 * Everything here is applied before the user-facing sliders (warmth / fade /
 * grain / vignette / leak), so those stay overrides on top of a real stock rather
 * than the only colour work in the pipeline.
 */
export interface FilmGrade {
  /** Linear-light channel gains — the stock's own white balance. */
  wb: Vec3;
  /** Channel crosstalk in linear light; row sums near 1 so neutrals stay neutral. */
  matrix: readonly [
    number, number, number,
    number, number, number,
    number, number, number
  ];
  /** Per-channel print gamma. The three differ, which is where a stock's hue drift comes from. */
  gamma: Vec3;
  /** S-curve strength, 0 = linear response. */
  contrast: number;
  /** Highlight compression. 0 clips like slide film, 1 goes milky. */
  shoulder: number;
  /** Shadow crush in the toe of the curve. */
  toe: number;
  /** Split toning, added in display space and weighted by luminance. */
  shadowTint: Vec3;
  highlightTint: Vec3;
  saturation: number;
  vibrance: number;
  /** Red-orange scatter around highlights — the signal that reads as "analog". */
  halation: number;
  /** Panchromatic response: how the three layers are mixed into one density. */
  mono?: { weights: Vec3 };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

export const FILM_GRADES: Record<FilmPresetId, FilmGrade> = {
  // Clean consumer negative: neutral-warm, gentle S, highlights roll off instead of clipping.
  classic35: {
    wb: [1.003, 1.0, 0.999],
    matrix: IDENTITY,
    gamma: [1.0, 1.0, 1.005],
    contrast: 0.22,
    shoulder: 0.3,
    toe: 0.05,
    shadowTint: [0.001, 0.004, 0.004],
    highlightTint: [0.011, 0.005, -0.004],
    saturation: 1.05,
    vibrance: 0.08,
    halation: 0.18
  },
  // Gold 200: creamy mids, warm highlights, olive shadows, generous red separation.
  kodakGold: {
    wb: [1.008, 1.0, 0.992],
    matrix: [
      1.05, -0.06, 0.01,
      -0.01, 1.03, -0.02,
      0.0, -0.045, 1.045
    ],
    gamma: [0.99, 1.0, 1.012],
    contrast: 0.3,
    shoulder: 0.35,
    toe: 0.05,
    shadowTint: [0.0, 0.008, 0.004],
    highlightTint: [0.024, 0.01, -0.01],
    saturation: 1.1,
    vibrance: 0.14,
    halation: 0.28
  },
  // Velvia: slide film — cyan shadows, dense greens, hard clipping, high chroma.
  fujiVelvia: {
    wb: [0.995, 1.0, 1.004],
    matrix: [
      1.1, -0.1, 0.0,
      -0.03, 1.1, -0.07,
      0.0, -0.03, 1.03
    ],
    gamma: [1.02, 0.98, 1.0],
    contrast: 0.45,
    shoulder: 0.1,
    toe: 0.1,
    shadowTint: [-0.002, 0.002, 0.004],
    highlightTint: [0.006, 0.0, 0.003],
    saturation: 1.2,
    vibrance: 0.16,
    halation: 0.06
  },
  // Tri-X 400: panchromatic response, deep shadows, cool neutral print.
  triX400: {
    wb: [1.0, 1.0, 1.0],
    matrix: IDENTITY,
    gamma: [1.0, 1.0, 1.0],
    contrast: 0.45,
    shoulder: 0.25,
    toe: 0.06,
    shadowTint: [0.0, 0.0, 0.0],
    highlightTint: [0.0, 0.0, 0.0],
    saturation: 1,
    vibrance: 0,
    halation: 0.12,
    mono: { weights: [0.32, 0.55, 0.13] }
  },
  // Instant 600: washed blacks, cyan-green shadows, warm-magenta highlights, low chroma.
  instantPolaroid: {
    wb: [1.005, 1.0, 0.995],
    matrix: [
      1.02, -0.06, 0.04,
      0.02, 0.98, 0.0,
      -0.02, 0.04, 0.98
    ],
    gamma: [1.03, 1.0, 0.97],
    contrast: 0.08,
    shoulder: 0.55,
    toe: 0,
    shadowTint: [-0.003, 0.005, 0.01],
    highlightTint: [0.01, 0.001, 0.004],
    saturation: 0.84,
    vibrance: 0.03,
    halation: 0.1
  },
  // Blockbuster grade: teal shadows against orange skin, mid contrast, slight desaturation.
  cinematic: {
    wb: [1.005, 1.0, 1.0],
    matrix: IDENTITY,
    gamma: [1.0, 1.0, 1.0],
    contrast: 0.26,
    shoulder: 0.4,
    toe: 0.05,
    shadowTint: [-0.012, 0.006, 0.024],
    highlightTint: [0.036, 0.012, -0.018],
    saturation: 0.93,
    vibrance: 0.04,
    halation: 0.2
  }
};

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** 8-bit sRGB byte -> linear light. Exact, because the input is exactly 256 values. */
export const DECODE_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
})();

export const ENCODE_STEPS = 1024;

/** Linear 0..1 -> display value, sampled with interpolation (a pow per pixel is too slow). */
export const ENCODE_LUT = (() => {
  const lut = new Float32Array(ENCODE_STEPS + 1);
  for (let i = 0; i <= ENCODE_STEPS; i++) lut[i] = linearToSrgb(i / ENCODE_STEPS);
  return lut;
})();

export function sampleLut(lut: Float32Array, t: number): number {
  if (t <= 0) return lut[0];
  if (t >= 1) return lut[lut.length - 1];
  const x = t * (lut.length - 1);
  const i = x | 0;
  const f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

/**
 * The stock's print curve: per-channel gamma, a smoothstep S in the mids, a toe
 * that adds density in the shadows and a shoulder that flattens the top so
 * highlights compress instead of clipping to paper white.
 */
export function buildToneCurve(
  gamma: number,
  contrast: number,
  shoulder: number,
  toe: number
): Float32Array {
  const lut = new Float32Array(ENCODE_STEPS + 1);
  // The shoulder only owns the top fifth. Starting it at the midpoint of the
  // upper range is what turns a grade into a haze: every highlight lifts and the
  // picture loses the snap the curve was supposed to add.
  const knee = 0.84;
  const shoulderPower = 1 + shoulder * 0.6;

  for (let i = 0; i <= ENCODE_STEPS; i++) {
    const x = i / ENCODE_STEPS;
    let y = gamma === 1 ? x : Math.pow(x, gamma);
    if (toe > 0) y = y * (1 - toe) + toe * y * y * y;
    if (contrast > 0) y += contrast * (y * y * (3 - 2 * y) - y);
    if (shoulder > 0 && y > knee) {
      const t = (y - knee) / (1 - knee);
      y = knee + (1 - knee) * Math.pow(t, 1 / shoulderPower);
    }
    lut[i] = y < 0 ? 0 : y > 1 ? 1 : y;
  }
  return lut;
}
