import type { RenderFilmConfig } from "./film";
import {
  FILM_GRADES,
  DECODE_LUT,
  ENCODE_LUT,
  sampleLut,
  buildToneCurve
} from "./film-grade";

const CURVE_CACHE = new Map<string, Float32Array>();

/** Halation is a soft, low-frequency glow, so the mask lives at a quarter of the image. */
const HALATION_SCALE = 4;

/**
 * Split-tone weights: a bell in the shadows and one in the highlights, so a tint
 * lands on the tonal range it belongs to instead of scaling with pure black.
 * `(1 - luma)^2.2` paints the deepest blacks hardest, which is what turns a teal
 * grade into navy shadows.
 */
const TINT_STEPS = 256;
const SHADOW_WEIGHT = new Float32Array(TINT_STEPS);
const HIGHLIGHT_WEIGHT = new Float32Array(TINT_STEPS);
for (let i = 0; i < TINT_STEPS; i++) {
  const l = i / (TINT_STEPS - 1);
  const ds = (l - 0.14) / 0.24;
  const dh = (l - 0.88) / 0.22;
  SHADOW_WEIGHT[i] = Math.exp(-ds * ds);
  HIGHLIGHT_WEIGHT[i] = Math.exp(-dh * dh);
}

function toneCurve(gamma: number, contrast: number, shoulder: number, toe: number): Float32Array {
  const key = `${gamma}/${contrast}/${shoulder}/${toe}`;
  const cached = CURVE_CACHE.get(key);
  if (cached) return cached;
  const curve = buildToneCurve(gamma, contrast, shoulder, toe);
  CURVE_CACHE.set(key, curve);
  return curve;
}

/** Separable box blur, in place — only ever used on the halation mask. */
function boxBlur(field: Float32Array, width: number, height: number, radius: number): void {
  if (radius < 1) return;
  const span = radius * 2 + 1;
  const tmp = new Float32Array(field.length);
  const clamp = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += field[row + clamp(i, width)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / span;
      sum += field[row + clamp(x + radius + 1, width)] - field[row + clamp(x - radius, width)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += tmp[clamp(i, height) * width + x];
    for (let y = 0; y < height; y++) {
      field[y * width + x] = sum / span;
      sum += tmp[clamp(y + radius + 1, height) * width + x] - tmp[clamp(y - radius, height) * width + x];
    }
  }
}

/**
 * Highlight mask for halation, built at 1/4 resolution: threshold, then bloom.
 * Film scatters red light through the base, so the glow hugs hot areas instead of
 * following image structure — which is why it is a blur of a threshold, not an edge.
 */
function buildHalationMask(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { mask: Float32Array; w: number; h: number } {
  const scale = HALATION_SCALE;
  const w = Math.max(1, Math.ceil(width / scale));
  const h = Math.max(1, Math.ceil(height / scale));
  const mask = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const py = Math.min(height - 1, y * scale + (scale >> 1));
    for (let x = 0; x < w; x++) {
      const px = Math.min(width - 1, x * scale + (scale >> 1));
      const i = (py * width + px) * 4;
      if (data[i + 3] === 0) continue;
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      if (lum <= 0.76) continue;
      const v = (lum - 0.76) / 0.24;
      mask[y * w + x] = v * v;
    }
  }

  boxBlur(mask, w, h, Math.max(1, Math.round(Math.min(w, h) * 0.05)));
  return { mask, w, h };
}

function sampleBilinear(field: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
  const y = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = x - x0;
  const ty = y - y0;
  const top = field[y0 * w + x0] * (1 - tx) + field[y0 * w + x1] * tx;
  const bottom = field[y1 * w + x0] * (1 - tx) + field[y1 * w + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Analog film simulation.
 *
 * Colour work happens where a real lab does it: white balance and layer
 * crosstalk in linear light, then a per-channel print curve in display space,
 * then split toning, luminance-aware saturation, halation, lens falloff and grain.
 * The user-facing sliders only ride on top of that; they are not the grade.
 */
export function renderFilm(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData,
  config: RenderFilmConfig
): void {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  if (w < 1 || h < 1) return;

  const grade = FILM_GRADES[config.preset];
  const curves = [
    toneCurve(grade.gamma[0], grade.contrast, grade.shoulder, grade.toe),
    toneCurve(grade.gamma[1], grade.contrast, grade.shoulder, grade.toe),
    toneCurve(grade.gamma[2], grade.contrast, grade.shoulder, grade.toe)
  ];

  const [wbR, wbG, wbB] = grade.wb;
  const warm = config.warmth;
  // Warmth is a temperature move, so it belongs in linear light as channel gains —
  // adding an offset to R and subtracting one from B desaturates as it warms.
  // Amplitude stays modest: a strong global gain is what makes every stock read
  // as the same sepia wash, and the tint in the grade carries the rest.
  const gainR = wbR * (1 + warm * 0.0028);
  const gainG = wbG * (1 + warm * 0.0005);
  const gainB = wbB * (1 - warm * 0.0028);

  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = grade.matrix;
  const mono = grade.mono;
  const [sR, sG, sB] = grade.shadowTint;
  const [hR, hG, hB] = grade.highlightTint;

  const grainAmount = (config.grain / 100) * 44;
  const vignetteAmount = config.vignette / 100;
  const matteLift = (config.fade / 50) * 22;
  const leakAmount = config.lightLeak / 100;
  const halation = grade.halation;

  const { mask, w: mw, h: mh } =
    halation > 0 ? buildHalationMask(data, w, h) : { mask: null, w: 0, h: 0 };

  const cx = w / 2;
  const cy = h / 2;
  const maxDist = Math.hypot(cx, cy);
  const toMask = 1 / HALATION_SCALE;

  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const maskY = y * toMask;
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const a = data[idx + 3];
      if (a === 0) continue;

      // 1. White balance + layer crosstalk, in linear light.
      let lr = DECODE_LUT[data[idx]] * gainR;
      let lg = DECODE_LUT[data[idx + 1]] * gainG;
      let lb = DECODE_LUT[data[idx + 2]] * gainB;
      if (m0 !== 1 || m1 !== 0 || m2 !== 0 || m3 !== 0 || m4 !== 1 || m5 !== 0 || m6 !== 0 || m7 !== 0 || m8 !== 1) {
        const nr = m0 * lr + m1 * lg + m2 * lb;
        const ng = m3 * lr + m4 * lg + m5 * lb;
        const nb = m6 * lr + m7 * lg + m8 * lb;
        lr = nr;
        lg = ng;
        lb = nb;
      }

      // 2. Print curve, one LUT per layer.
      let r = sampleLut(curves[0], sampleLut(ENCODE_LUT, lr));
      let g = sampleLut(curves[1], sampleLut(ENCODE_LUT, lg));
      let b = sampleLut(curves[2], sampleLut(ENCODE_LUT, lb));

      // 3. Split toning: shadows and highlights pull toward different hues.
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const tintIndex = luma <= 0 ? 0 : luma >= 1 ? TINT_STEPS - 1 : (luma * (TINT_STEPS - 1)) | 0;
      const wS = SHADOW_WEIGHT[tintIndex];
      const wH = HIGHLIGHT_WEIGHT[tintIndex];
      r += sR * wS + hR * wH;
      g += sG * wS + hG * wH;
      b += sB * wS + hB * wH;

      // 4. Saturation, then vibrance that leaves already-saturated pixels alone.
      const mid = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = grade.saturation;
      r = mid + (r - mid) * sat;
      g = mid + (g - mid) * sat;
      b = mid + (b - mid) * sat;

      if (grade.vibrance > 0) {
        const max = r > g ? (r > b ? r : b) : g > b ? g : b;
        const min = r < g ? (r < b ? r : b) : g < b ? g : b;
        const vib = 1 + grade.vibrance * (1 - Math.min(1, (max - min) * 2));
        r = mid + (r - mid) * vib;
        g = mid + (g - mid) * vib;
        b = mid + (b - mid) * vib;
      }

      // 5. Monochrome stocks: weighted channel mix, not a flat luma average.
      if (mono) {
        const y0 = mono.weights[0] * r + mono.weights[1] * g + mono.weights[2] * b;
        r = y0;
        g = y0;
        b = y0;
      }

      // 6. Halation: red scatter blooming out of the hot areas. Amplitude stays
      // low — it is a halo around the light, not a bloom that eats the picture.
      if (mask) {
        const glow = sampleBilinear(mask, mw, mh, x * toMask, maskY) * halation;
        if (glow > 0) {
          r += glow * 0.3;
          g += glow * 0.1;
          b += glow * 0.02;
        }
      }

      // 7. Lens falloff.
      if (vignetteAmount > 0) {
        const dist = Math.hypot(x - cx, dy) / maxDist;
        if (dist > 0.32) {
          const falloff = Math.min(1, (dist - 0.32) / 0.68);
          const factor = 1 - falloff * falloff * vignetteAmount * 0.8;
          r *= factor;
          g *= factor;
          b *= factor;
        }
      }

      // 8. Light leak, top-right corner.
      if (leakAmount > 0) {
        const leakDist = Math.hypot(w - x, y) / Math.hypot(w, h);
        if (leakDist < 0.62) {
          const t = Math.pow(1 - leakDist / 0.62, 2) * leakAmount;
          r += 0.94 * t;
          g += 0.5 * t;
          b += 0.16 * t;
        }
      }

      // 9. Matte lift raises the black point; it is a print property, so it comes last.
      if (matteLift > 0) {
        const floor = matteLift / 255;
        r = floor + r * (1 - floor);
        g = floor + g * (1 - floor);
        b = floor + b * (1 - floor);
      }

      // 10. Grain, weighted toward the midtones like silver halide.
      if (grainAmount > 0) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const weight = Math.max(0.2, 1 - 4 * (lum - 0.5) * (lum - 0.5));
        const noise = (Math.random() + Math.random() - 1) * grainAmount * weight;
        r += noise / 255;
        g += noise / 255;
        b += noise / 255;
      }

      data[idx] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
      data[idx + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
      data[idx + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
