import { parseHex, lerpRgb, getLuminance, applyContrast } from "./color-utils";
import { computeFadeFactor } from "./transition";
import type { RetroPrintOptions } from "./types";

interface SampleGridPoint {
  x: number;
  y: number;
  intensity: number; // 0 = dark (max ink), 1 = light (no ink)
  color: { r: number; g: number; b: number };
}

/**
 * Samples the image data along an angled regular grid.
 */
function sampleGrid(
  imageData: ImageData,
  gridSize: number,
  angleRad: number,
  contrast: number,
  invert: boolean
): SampleGridPoint[] {
  const { width, height, data } = imageData;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  // Diagonal bound to cover the whole image regardless of rotation
  const diagonal = Math.ceil(Math.hypot(width, height));
  const cx = width / 2;
  const cy = height / 2;

  const points: SampleGridPoint[] = [];
  const halfGrid = gridSize / 2;

  for (let y = -diagonal; y <= diagonal; y += gridSize) {
    for (let x = -diagonal; x <= diagonal; x += gridSize) {
      // Rotate grid coordinate around center
      const imgX = Math.round(cx + x * cos - y * sin);
      const imgY = Math.round(cy + x * sin + y * cos);

      if (imgX < 0 || imgX >= width || imgY < 0 || imgY >= height) continue;

      // Area sample around the point for smoother anti-aliasing
      let totalR = 0;
      let totalG = 0;
      let totalB = 0;
      let totalA = 0;
      let sampleCount = 0;

      const sampleRadius = Math.max(1, Math.floor(halfGrid * 0.7));
      for (let sy = -sampleRadius; sy <= sampleRadius; sy += Math.max(1, Math.floor(sampleRadius / 2))) {
        for (let sx = -sampleRadius; sx <= sampleRadius; sx += Math.max(1, Math.floor(sampleRadius / 2))) {
          const px = Math.min(width - 1, Math.max(0, imgX + sx));
          const py = Math.min(height - 1, Math.max(0, imgY + sy));
          const idx = (py * width + px) * 4;
          totalR += data[idx];
          totalG += data[idx + 1];
          totalB += data[idx + 2];
          totalA += data[idx + 3];
          sampleCount++;
        }
      }

      if (sampleCount === 0) continue;
      const avgA = totalA / sampleCount;
      if (avgA < 16) continue; // Skip near-transparent pixels

      const avgR = totalR / sampleCount;
      const avgG = totalG / sampleCount;
      const avgB = totalB / sampleCount;

      const rawLum = getLuminance(avgR, avgG, avgB);
      const intensity = applyContrast(rawLum, contrast, invert);

      points.push({
        x: imgX,
        y: imgY,
        intensity,
        color: { r: Math.round(avgR), g: Math.round(avgG), b: Math.round(avgB) }
      });
    }
  }

  return points;
}

/**
 * Render Halftone Dots to Canvas
 */
export function renderHalftoneDots(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData,
  options: RetroPrintOptions,
  sourceImg?: CanvasImageSource
): void {
  const { width, height } = imageData;
  const angleRad = (options.angle * Math.PI) / 180;
  const darkRgb = parseHex(options.darkColor);
  const lightRgb = parseHex(options.lightColor);

  ctx.clearRect(0, 0, width, height);

  if (options.transitionBlend === "overlay" && sourceImg) {
    ctx.drawImage(sourceImg, 0, 0, width, height);
  } else if (!options.transparentBg) {
    ctx.fillStyle = options.lightColor;
    ctx.fillRect(0, 0, width, height);
  }

  const points = sampleGrid(imageData, options.gridSize, angleRad, options.contrast, options.invert);
  const maxRadius = (options.gridSize / Math.SQRT2) * 0.98;

  for (const pt of points) {
    const fade = computeFadeFactor(pt.x, pt.y, width, height, options);
    if (fade <= 0.01) continue;

    // 0 intensity (dark) -> max radius; 1 intensity (bright) -> 0 radius
    const radius = (1 - pt.intensity) * maxRadius * fade;
    if (radius <= 0.4) continue;

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);

    if (options.colorMode === "original") {
      ctx.fillStyle = `rgb(${pt.color.r},${pt.color.g},${pt.color.b})`;
    } else {
      // Slight ink bleeding / tone mapping
      const c = lerpRgb(darkRgb, lightRgb, pt.intensity * 0.25);
      ctx.fillStyle = `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
    }
    ctx.fill();
  }
}

/**
 * Render Engraving Lines / Crosshatch to Canvas
 */
export function renderHalftoneLines(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData,
  options: RetroPrintOptions,
  isCrosshatch = false,
  sourceImg?: CanvasImageSource
): void {
  const { width, height, data } = imageData;
  const angleRad = (options.angle * Math.PI) / 180;
  const angles = isCrosshatch ? [angleRad, angleRad + Math.PI / 2] : [angleRad];
  const darkRgb = parseHex(options.darkColor);

  ctx.clearRect(0, 0, width, height);

  if (options.transitionBlend === "overlay" && sourceImg) {
    ctx.drawImage(sourceImg, 0, 0, width, height);
  } else if (!options.transparentBg) {
    ctx.fillStyle = options.lightColor;
    ctx.fillRect(0, 0, width, height);
  }

  const diagonal = Math.ceil(Math.hypot(width, height));
  const cx = width / 2;
  const cy = height / 2;
  const step = Math.max(3, options.gridSize);

  for (const ang of angles) {
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);

    for (let d = -diagonal; d <= diagonal; d += step) {
      // Line perpendicular offset
      // Trace line from t = -diagonal to +diagonal
      const sampleDist = Math.max(2, Math.floor(step / 2));
      let isDrawing = false;
      let lastW = 0;

      for (let t = -diagonal; t <= diagonal; t += sampleDist) {
        const x = Math.round(cx + d * cos - t * sin);
        const y = Math.round(cy + d * sin + t * cos);

        if (x < 0 || x >= width || y < 0 || y >= height) {
          isDrawing = false;
          continue;
        }

        const idx = (y * width + x) * 4;
        const alpha = data[idx + 3];
        if (alpha < 16) {
          isDrawing = false;
          continue;
        }

        const lum = getLuminance(data[idx], data[idx + 1], data[idx + 2]);
        const intensity = applyContrast(lum, options.contrast, options.invert);

        const fade = computeFadeFactor(x, y, width, height, options);
        // Dark = thicker line, light = thin or zero, modulated by fade
        const lineW = (1 - intensity) * step * 0.95 * fade;

        if (lineW > 0.4) {
          ctx.beginPath();
          const prevX = Math.round(cx + d * cos - (t - sampleDist) * sin);
          const prevY = Math.round(cy + d * sin + (t - sampleDist) * cos);

          ctx.moveTo(isDrawing ? prevX : x, isDrawing ? prevY : y);
          ctx.lineTo(x, y);

          ctx.lineWidth = lineW;
          ctx.lineCap = "round";

          if (options.colorMode === "original") {
            ctx.strokeStyle = `rgb(${data[idx]},${data[idx + 1]},${data[idx + 2]})`;
          } else {
            ctx.strokeStyle = `rgb(${darkRgb.r},${darkRgb.g},${darkRgb.b})`;
          }
          ctx.stroke();
          isDrawing = true;
          lastW = lineW;
        } else {
          isDrawing = false;
        }
      }
    }
  }
}
