/**
 * Digital glitch algorithms: RGB split (chromatic aberration), CRT scanlines, and slice displacement.
 */

export interface GlitchOptions {
  rgbSplit: number; // 0 to 50
  rgbAngle?: number; // degrees, default 0
  scanlines: number; // 0 to 100 (%)
  scanlineSpacing?: number; // 2 to 8
  sliceShift: number; // 0 to 50
  sliceCount?: number; // 4 to 16
}

export function applyRgbSplit(
  imgData: ImageData,
  offset: number,
  angle = 0
): ImageData {
  if (offset <= 0) return imgData;
  const { width, height, data } = imgData;
  const copy = new Uint8ClampedArray(data);
  const rad = (angle * Math.PI) / 180;
  const dx = Math.round(Math.cos(rad) * offset);
  const dy = Math.round(Math.sin(rad) * offset);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const destIdx = (y * width + x) * 4;
      const rx = Math.min(width - 1, Math.max(0, x - dx));
      const ry = Math.min(height - 1, Math.max(0, y - dy));
      const rIdx = (ry * width + rx) * 4;

      const bx = Math.min(width - 1, Math.max(0, x + dx));
      const by = Math.min(height - 1, Math.max(0, y + dy));
      const bIdx = (by * width + bx) * 4;

      data[destIdx] = copy[rIdx]; // Shifted red
      data[destIdx + 2] = copy[bIdx + 2]; // Shifted blue
    }
  }
  return imgData;
}

export function applyScanlines(
  imgData: ImageData,
  opacityPct: number,
  spacing = 3
): ImageData {
  if (opacityPct <= 0) return imgData;
  const { width, height, data } = imgData;
  const factor = 1 - Math.min(0.9, opacityPct / 100);

  for (let y = 0; y < height; y++) {
    if (y % spacing === 0) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = Math.round(data[idx] * factor);
        data[idx + 1] = Math.round(data[idx + 1] * factor);
        data[idx + 2] = Math.round(data[idx + 2] * factor);
      }
    }
  }
  return imgData;
}

export function applySliceDisplacement(
  imgData: ImageData,
  maxShift: number,
  sliceCount = 8,
  seed = 57
): ImageData {
  if (maxShift <= 0 || sliceCount <= 0) return imgData;
  const { width, height, data } = imgData;
  const copy = new Uint8ClampedArray(data);

  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  const sliceHeight = Math.max(4, Math.floor(height / (sliceCount * 2.5)));

  for (let i = 0; i < sliceCount; i++) {
    const startY = Math.floor(rand() * (height - sliceHeight));
    const endY = Math.min(height, startY + Math.floor(rand() * sliceHeight) + 4);
    const shift = Math.round((rand() * 2 - 1) * maxShift);
    if (shift === 0) continue;

    for (let y = startY; y < endY; y++) {
      for (let x = 0; x < width; x++) {
        const destIdx = (y * width + x) * 4;
        const srcX = (x - shift + width) % width;
        const srcIdx = (y * width + srcX) * 4;

        data[destIdx] = copy[srcIdx];
        data[destIdx + 1] = copy[srcIdx + 1];
        data[destIdx + 2] = copy[srcIdx + 2];
        data[destIdx + 3] = copy[srcIdx + 3];
      }
    }
  }
  return imgData;
}

export function renderGlitch(
  ctx: CanvasRenderingContext2D,
  imgData: ImageData,
  opts: GlitchOptions
) {
  let processed = imgData;
  if (opts.sliceShift > 0) {
    processed = applySliceDisplacement(processed, opts.sliceShift, opts.sliceCount ?? 8);
  }
  if (opts.rgbSplit > 0) {
    processed = applyRgbSplit(processed, opts.rgbSplit, opts.rgbAngle ?? 0);
  }
  if (opts.scanlines > 0) {
    processed = applyScanlines(processed, opts.scanlines, opts.scanlineSpacing ?? 3);
  }
  ctx.putImageData(processed, 0, 0);
}
