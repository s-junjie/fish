import { ColorFilter } from "./types";

/**
 * The axes a slider can drive: every field `ColorFilter` carries, in panel
 * order — one control per axis the document can express, so a filter with no
 * way in cannot exist here.
 *
 * `brightness` and `exposure` are one multiplication in the renderer
 * (`2^exposure * brightness`) and both are CSS `filter` functions, so both are
 * exposed and kept adjacent: a reader who multiplies the two nearby sliders is
 * reasoning about the gain the filter chain actually applies. `hueRotate`,
 * `invert` and `grayscale` were once rendered but unreachable — no way in at
 * all, or only whole from the `bw` preset.
 */
export type AdjustKey =
  | "exposure"
  | "brightness"
  | "contrast"
  | "saturation"
  | "temperature"
  | "tint"
  | "highlights"
  | "shadows"
  | "hueRotate"
  | "invert"
  | "grayscale";

/**
 * One slider axis. `neutral`/`atMin`/`atMax` are RENDERER units; the slider runs
 * -100..100 and where its neutral sits is `sliderNeutral`'s to say. The two unit
 * systems live only here so a slider can never drift from what the filter chain
 * applies.
 */
export interface AdjustAxis {
  key: AdjustKey;
  neutral: number;
  atMin: number;
  atMax: number;
}

export const ADJUST_AXES: AdjustAxis[] = [
  { key: "exposure", neutral: 0, atMin: -2, atMax: 2 },
  { key: "brightness", neutral: 1, atMin: 0, atMax: 2 },
  { key: "contrast", neutral: 1, atMin: 0, atMax: 2 },
  { key: "saturation", neutral: 1, atMin: 0, atMax: 2 },
  { key: "temperature", neutral: 0, atMin: -1, atMax: 1 },
  { key: "tint", neutral: 0, atMin: -1, atMax: 1 },
  { key: "highlights", neutral: 0, atMin: -1, atMax: 1 },
  { key: "shadows", neutral: 0, atMin: -1, atMax: 1 },
  // Modulo 360, so the useful span is half a turn either way of neutral.
  { key: "hueRotate", neutral: 0, atMin: -180, atMax: 180 },
  // One-way: nothing exists below neutral, so the slider is one-way too and the
  // knob parks at the far left (see `sliderNeutral`).
  { key: "invert", neutral: 0, atMin: 0, atMax: 1 },
  { key: "grayscale", neutral: 0, atMin: 0, atMax: 1 }
];

export const ADJUST_KEYS: AdjustKey[] = ADJUST_AXES.map((a) => a.key);

/** Samples in the highlights/shadows lookup table. Odd count keeps 0.5 exact. */
export const TONE_SAMPLES = 33;

const EPS = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

/** Float noise from the slider maths would otherwise reach the document. */
function tidy(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export function adjustAxis(key: AdjustKey): AdjustAxis | undefined {
  return ADJUST_AXES.find((a) => a.key === key);
}

/**
 * Where an axis's neutral value sits on the slider, in slider units.
 *
 * A two-way axis is neutral in the middle. `invert` and `grayscale` only run one
 * way — their neutral IS the bottom of their range — so parking them at 0 would
 * spend half the track on a value the renderer clamps straight back to neutral.
 * They park at the far left instead and the whole track drives the effect.
 */
export function sliderNeutral(axis: AdjustAxis): number {
  if (axis.atMin === axis.neutral) return -100;
  if (axis.atMax === axis.neutral) return 100;
  return 0;
}

/** Slider position (-100..100) -> renderer unit. */
export function sliderToValue(axis: AdjustAxis, slider: number): number {
  const v = clamp(slider, -100, 100);
  const neutralAt = sliderNeutral(axis);
  // Each arm of the track is measured against its own length: the two ends of an
  // axis are not equally far from neutral (contrast runs 1 -> 2 but 1 -> 0).
  const span = v >= neutralAt ? axis.atMax - axis.neutral : axis.neutral - axis.atMin;
  const reach = v >= neutralAt ? 100 - neutralAt : neutralAt + 100;
  if (reach === 0) return tidy(axis.neutral);
  return tidy(axis.neutral + ((v - neutralAt) / reach) * span);
}

/** Renderer unit -> slider position; exact inverse of `sliderToValue`. */
export function valueToSlider(axis: AdjustAxis, value: number | undefined): number {
  const v = value ?? axis.neutral;
  const neutralAt = sliderNeutral(axis);
  const span = v >= axis.neutral ? axis.atMax - axis.neutral : axis.neutral - axis.atMin;
  const reach = v >= axis.neutral ? 100 - neutralAt : neutralAt + 100;
  if (span === 0 || reach === 0) return neutralAt;
  return Math.round(clamp(neutralAt + ((v - axis.neutral) / span) * reach, -100, 100));
}

/** One axis's value on an object that says nothing about it: its neutral. */
function axisValue(f: ColorFilter | undefined | null, axis: AdjustAxis): number {
  return f?.[axis.key] ?? axis.neutral;
}

export function isNeutralColorFilter(f: ColorFilter | undefined | null): boolean {
  if (!f) return true;
  for (const axis of ADJUST_AXES) {
    // Compared below instead: 360° IS 0°, and `near` cannot see that.
    if (axis.key === "hueRotate") continue;
    if (!near(axisValue(f, axis), axis.neutral)) return false;
  }
  return near((((f.hueRotate ?? 0) % 360) + 360) % 360, 0);
}

/** Writes one slider axis; a neutral value removes the key, a neutral object is dropped. */
export function withAdjustValue(
  filter: ColorFilter | undefined,
  key: AdjustKey,
  slider: number
): ColorFilter | undefined {
  const axis = adjustAxis(key);
  if (!axis) return filter;
  const next: ColorFilter = { ...(filter || {}) };
  const value = sliderToValue(axis, slider);
  if (near(value, axis.neutral)) delete next[key];
  else next[key] = value;
  return isNeutralColorFilter(next) ? undefined : next;
}

export function colorFilterEquals(a: ColorFilter | undefined, b: ColorFilter | undefined): boolean {
  return ADJUST_AXES.every((axis) => near(axisValue(a, axis), axisValue(b, axis)));
}

export interface ColorFilterPreset {
  id: string;
  filter: ColorFilter;
}

export const COLOR_FILTER_PRESETS: ColorFilterPreset[] = [
  { id: "none", filter: {} },
  { id: "bw", filter: { grayscale: 1, contrast: 1.08 } },
  { id: "warm", filter: { temperature: 0.45, saturation: 1.08 } },
  { id: "cool", filter: { temperature: -0.45 } },
  { id: "vivid", filter: { saturation: 1.35, contrast: 1.15, exposure: 0.15 } },
  { id: "fade", filter: { contrast: 0.82, saturation: 0.8, shadows: 0.4 } },
  { id: "matte", filter: { contrast: 0.88, shadows: 0.55, highlights: -0.25 } },
  { id: "punch", filter: { contrast: 1.25, saturation: 1.2, highlights: 0.3 } }
];

export function presetFilter(id: string): ColorFilter | undefined {
  const preset = COLOR_FILTER_PRESETS.find((p) => p.id === id);
  if (!preset || isNeutralColorFilter(preset.filter)) return undefined;
  return { ...preset.filter };
}

/** The preset whose look the filter currently matches, or "custom". */
export function matchPreset(filter: ColorFilter | undefined): string {
  const preset = COLOR_FILTER_PRESETS.find((p) => {
    const target = isNeutralColorFilter(p.filter) ? undefined : p.filter;
    if (!target) return isNeutralColorFilter(filter);
    return !isNeutralColorFilter(filter) && colorFilterEquals(filter, target);
  });
  return preset ? preset.id : "custom";
}

/**
 * Highlights/shadows lookup. Both ends of the range stay pinned (white cannot
 * get brighter, black cannot get darker), so the curve can never invert.
 */
export function toneCurveTable(highlights: number, shadows: number): number[] {
  const table: number[] = [];
  for (let i = 0; i < TONE_SAMPLES; i++) {
    const x = i / (TONE_SAMPLES - 1);
    const high = Math.max(0, (x - 0.5) / 0.5);
    const low = Math.max(0, (0.5 - x) / 0.5);
    const y = x + 0.8 * (highlights * high * (1 - x) + shadows * low * x);
    table.push(Math.round(clamp(y, 0, 1) * 1000) / 1000);
  }
  return table;
}

export type ColorFilterPrimitive =
  | { kind: "linear-transfer"; slope: number; intercept: number }
  | { kind: "channel-matrix"; values: number[] }
  | { kind: "tone-curve"; table: number[] }
  | { kind: "hue-rotate"; degrees: number }
  | { kind: "saturate"; value: number };

/**
 * The SVG filter chain for a colour adjustment, in application order. Alpha is
 * never touched: every matrix keeps its 4th row at identity and the component
 * transfers only carry R/G/B functions.
 */
export function colorFilterPrimitives(filter: ColorFilter | undefined): ColorFilterPrimitive[] {
  if (isNeutralColorFilter(filter)) return [];
  const f = filter as ColorFilter;
  const out: ColorFilterPrimitive[] = [];

  // exposure * brightness are one gain, contrast one pivot at 0.5, invert a
  // mirror — all linear, so they collapse into a single component transfer.
  const invert = clamp(f.invert ?? 0, 0, 1);
  const contrast = Math.max(0, f.contrast ?? 1);
  const gain = Math.pow(2, f.exposure ?? 0) * Math.max(0, f.brightness ?? 1) * contrast;
  const fold = 1 - 2 * invert;
  const slope = gain * fold;
  const intercept = 0.5 * (1 - contrast) * fold + invert;
  if (!near(slope, 1) || !near(intercept, 0)) {
    out.push({ kind: "linear-transfer", slope: tidy(slope), intercept: tidy(intercept) });
  }

  const temperature = clamp(f.temperature ?? 0, -1, 1);
  const tint = clamp(f.tint ?? 0, -1, 1);
  if (!near(temperature, 0) || !near(tint, 0)) {
    const r = 1 + 0.3 * temperature - 0.15 * tint;
    const g = 1 + 0.3 * tint;
    const b = 1 - 0.3 * temperature - 0.15 * tint;
    out.push({
      kind: "channel-matrix",
      values: [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0].map(tidy)
    });
  }

  const highlights = clamp(f.highlights ?? 0, -1, 1);
  const shadows = clamp(f.shadows ?? 0, -1, 1);
  if (!near(highlights, 0) || !near(shadows, 0)) {
    out.push({ kind: "tone-curve", table: toneCurveTable(highlights, shadows) });
  }

  const hueRotate = f.hueRotate ?? 0;
  if (!near(((hueRotate % 360) + 360) % 360, 0)) out.push({ kind: "hue-rotate", degrees: hueRotate });

  // grayscale is saturate(1 - g), so one matrix covers both.
  const saturate = Math.max(0, f.saturation ?? 1) * (1 - clamp(f.grayscale ?? 0, 0, 1));
  if (!near(saturate, 1)) out.push({ kind: "saturate", value: tidy(saturate) });

  return out;
}
