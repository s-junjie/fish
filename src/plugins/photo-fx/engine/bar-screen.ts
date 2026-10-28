import { parseHex, getLuminance, applyContrast } from "./color-utils";
import { computeFadeFactor } from "./transition";
import type { RetroPrintOptions } from "./types";

/** Below this ink fraction the bar is dropped entirely, so paper stays paper instead of collecting a 1px hairline. */
const INK_FLOOR = 0.02;

/**
 * Any bar that survives is at least a hairline of solid ink, the way a real
 * line screen prints. Without this a light tone thins the bar below one pixel and
 * it turns into a translucent grey line instead of a black one.
 */
const MIN_HALF_WIDTH = 0.7;

function clampIndex(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** Separable box blur, in place. Kills source grain without smearing the contours bars are supposed to trace. */
function blurField(field: Float32Array, width: number, height: number, radius: number): void {
  if (radius < 1) return;
  const span = radius * 2 + 1;
  const tmp = new Float32Array(field.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += field[row + clampIndex(i, width)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / span;
      sum +=
        field[row + clampIndex(x + radius + 1, width)] -
        field[row + clampIndex(x - radius, width)];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += tmp[clampIndex(i, height) * width + x];
    for (let y = 0; y < height; y++) {
      field[y * width + x] = sum / span;
      sum +=
        tmp[clampIndex(y + radius + 1, height) * width + x] -
        tmp[clampIndex(y - radius, height) * width + x];
    }
  }
}

/**
 * Bar screen ("slit" screen): straight bars on a fixed lattice whose width tracks
 * local ink demand, so each bar's edges follow the photo's tonal contours and
 * taper to a point where the tone lifts.
 *
 * Drawn as a per-pixel coverage mask, never as a stroke. A stroked path cannot
 * hold this look: `lineCap` rounds every tip, width can only change once per
 * segment so the edge scallops, and each segment is antialiased on its own.
 */
export function renderBarScreen(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData,
  options: RetroPrintOptions
): void {
  const { width, height, data } = imageData;
  if (width < 1 || height < 1) return;

  const period = Math.max(2, options.gridSize);
  const halfPeriod = period / 2;
  const angleRad = (options.angle * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const cx = width / 2;
  const cy = height / 2;
  const invPeriod = 1 / period;

  const inkRgb = parseHex(options.darkColor);
  const lightRgb = parseHex(options.lightColor);
  const inkFromSource = options.colorMode === "original";
  const level = Math.min(1, Math.max(0, options.barLevel ?? 0.78));
  const falloff = Math.min(8, Math.max(0.5, options.barFalloff ?? 2.2));
  const overlay = options.transitionBlend === "overlay";
  const hasFade = options.transitionMode !== "none";

  // Luminance -> ink fraction, folded once so the pixel loop does no tone math.
  // `level` is the tone that prints solid; `falloff` is how fast width decays above it.
  const toneLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const intensity = applyContrast(i / 255, options.contrast, options.invert);
    const ink = Math.min(1, Math.max(0, (level - intensity) * falloff));
    toneLut[i] = ink < INK_FLOOR ? 0 : ink;
  }

  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = getLuminance(data[i], data[i + 1], data[i + 2]);
  }
  blurField(lum, width, height, Math.max(1, Math.round(period * 0.12)));

  const out = ctx.createImageData(width, height);
  const px = out.data;

  // Pass 1 — the substrate: the photo (overlay), the paper, or nothing.
  for (let o = 0; o < px.length; o += 4) {
    if (overlay) {
      px[o] = data[o];
      px[o + 1] = data[o + 1];
      px[o + 2] = data[o + 2];
      px[o + 3] = data[o + 3];
    } else if (!options.transparentBg) {
      px[o] = lightRgb.r;
      px[o + 1] = lightRgb.g;
      px[o + 2] = lightRgb.b;
      px[o + 3] = 255;
    }
  }

  // Pass 2 — ink, source-over, with the bar's own edge coverage as the alpha.
  for (let y = 0; y < height; y++) {
    const ry = y - cy;
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const u = (x - cx) * cos + ry * sin;
      const dist = Math.abs(u - Math.round(u * invPeriod) * period);

      // Bar half-width at this pixel, plus how much of the pixel the bar covers.
      const ink = toneLut[Math.min(255, Math.max(0, (lum[idx] * 255) | 0))];
      if (ink === 0) continue;
      const halfWidth = Math.max(ink * halfPeriod, MIN_HALF_WIDTH);
      let coverage = halfWidth + 0.5 - dist;
      if (coverage <= 0) continue;
      if (coverage > 1) coverage = 1;

      const o = idx * 4;
      const srcAlpha = data[o + 3];
      if (srcAlpha < 16) continue;
      if (srcAlpha < 255) coverage *= srcAlpha / 255;
      if (hasFade) coverage *= computeFadeFactor(x, y, width, height, options);
      if (coverage <= 0) continue;

      const inkR = inkFromSource ? data[o] : inkRgb.r;
      const inkG = inkFromSource ? data[o + 1] : inkRgb.g;
      const inkB = inkFromSource ? data[o + 2] : inkRgb.b;

      const bgAlpha = px[o + 3] / 255;
      const outAlpha = coverage + bgAlpha * (1 - coverage);
      if (outAlpha <= 0) continue;
      const wInk = coverage / outAlpha;
      const wBg = (bgAlpha * (1 - coverage)) / outAlpha;

      px[o] = px[o] * wBg + inkR * wInk;
      px[o + 1] = px[o + 1] * wBg + inkG * wInk;
      px[o + 2] = px[o + 2] * wBg + inkB * wInk;
      px[o + 3] = outAlpha * 255;
    }
  }

  ctx.putImageData(out, 0, 0);
}
