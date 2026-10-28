import type { RetroPrintOptions } from "./types";

/**
 * Computes a normalized fade factor in [0, 1] for coordinate (x, y).
 * 1 = full halftone pattern, 0 = completely faded out (tapered to point / photo).
 */
export function computeFadeFactor(
  x: number,
  y: number,
  width: number,
  height: number,
  options: RetroPrintOptions
): number {
  if (options.transitionMode === "none") return 1.0;

  const spread = Math.max(0.05, Math.min(1.0, options.transitionSpread ?? 0.5));
  let factor = 1.0;

  if (options.transitionMode === "horizontal") {
    // Left-to-right linear transition
    const nx = x / width;
    const halfSpread = spread * 0.5;
    const x0 = Math.max(0, 0.5 - halfSpread);
    const x1 = Math.min(1, 0.5 + halfSpread);

    if (nx <= x0) {
      factor = 0;
    } else if (nx >= x1) {
      factor = 1.0;
    } else {
      const t = (nx - x0) / (x1 - x0);
      factor = t * t * (3 - 2 * t);
    }
  } else if (options.transitionMode === "vertical") {
    // Top-to-bottom linear transition
    const ny = y / height;
    const halfSpread = spread * 0.5;
    const y0 = Math.max(0, 0.5 - halfSpread);
    const y1 = Math.min(1, 0.5 + halfSpread);

    if (ny <= y0) {
      factor = 0;
    } else if (ny >= y1) {
      factor = 1.0;
    } else {
      const t = (ny - y0) / (y1 - y0);
      factor = t * t * (3 - 2 * t);
    }
  } else if (options.transitionMode === "twoEnds") {
    // Two-ended vertical taper (top & bottom fade out to 0, center retains pattern)
    const fadeDepth = spread * 0.5;
    const deadZone = fadeDepth * 0.4;
    const ny = y / height;
    const distFromEdge = Math.min(ny, 1 - ny);

    if (distFromEdge <= deadZone) {
      factor = 0;
    } else if (distFromEdge >= fadeDepth) {
      factor = 1.0;
    } else {
      const t = (distFromEdge - deadZone) / (fadeDepth - deadZone);
      factor = t * t * (3 - 2 * t);
    }
  } else if (options.transitionMode === "radial") {
    // Radial center-outward transition
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.hypot(cx, cy);
    const r = Math.hypot(x - cx, y - cy);
    const nr = r / maxR;

    const halfSpread = spread * 0.5;
    const r0 = Math.max(0, 0.5 - halfSpread);
    const r1 = Math.min(1, 0.5 + halfSpread);

    if (nr <= r0) {
      factor = 1.0;
    } else if (nr >= r1) {
      factor = 0;
    } else {
      const t = (nr - r0) / (r1 - r0);
      factor = 1.0 - t * t * (3 - 2 * t);
    }
  }

  if (options.transitionInvert) {
    factor = 1.0 - factor;
  }

  return factor;
}

/**
 * Creates an offscreen mask canvas where alpha corresponds to computeFadeFactor.
 */
export function createTransitionMask(
  width: number,
  height: number,
  options: RetroPrintOptions
): HTMLCanvasElement {
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;

  const ctx = maskCanvas.getContext("2d");
  if (!ctx) return maskCanvas;

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const factor = computeFadeFactor(x, y, width, height, options);
      const alpha = Math.round(factor * 255);
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = alpha;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return maskCanvas;
}
