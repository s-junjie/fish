import { glassEllipseSdf, glassRoundedRectSdf } from "../../core/dsl/liquid-glass";
import { CANVAS_MASK_KEEP } from "./canvas-colors";

/**
 * The raster/SDF half of the glass bake: everything between "a shape and a grid
 * size" and "a signed distance, an outward normal and a coverage per texel".
 * Nothing here knows what the numbers mean to a filter — that reading lives in
 * `liquid-glass.ts`.
 */

export type AnalyticShape =
  | { kind: "rect"; radii: [number, number, number, number]; smoothing: number }
  | { kind: "ellipse" };

interface Field {
  d: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  cov: Float32Array;
  w: number;
  h: number;
}

export function evalAnalyticSdf(x: number, y: number, width: number, height: number, shape: AnalyticShape) {
  if (shape.kind === "ellipse") {
    return glassEllipseSdf(x, y, width, height);
  }
  return glassRoundedRectSdf(x, y, width, height, shape.radii, shape.smoothing);
}

/**
 * Signed distance, outward normal and coverage over a grid for arbitrary
 * non-analytic vector paths (`<path>`, `<polygon>`, `<star>`).
 */
export function samplePathField(
  width: number,
  height: number,
  pad: number,
  pathD: string,
  scale: number
): Field | null {
  const padPx = Math.round(pad * scale);
  const w = Math.max(1, Math.round(width * scale) + padPx * 2);
  const h = Math.max(1, Math.round(height * scale) + padPx * 2);
  const n = w * h;
  const d = new Float32Array(n);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const cov = new Float32Array(n);

  const mask = rasteriseMask(w, h, padPx, scale, width, height, pathD);
  if (!mask) return null;
  const signed = signedDistance(mask, w, h);
  if (!signed) return null;

  // Six separable binomial passes (~1.73 texels of Gaussian sigma) eliminate
  // pixel-staircase Voronoi ridges along shallow curves on rasterised paths.
  let smooth = signed;
  for (let pass = 0; pass < 6; pass++) {
    smooth = blurTexels(smooth, w, h);
  }
  const distSmooth = blurTexels(signed, w, h);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = i + j * w;
      const c = mask.coverage[k];
      cov[k] = c;
      // Preserve exact subpixel boundary distance on the edge texels, and use
      // the smoothed distance inside to prevent staircase kinks in `u = -d/depth`.
      d[k] = (c > 0 && c < 1 ? signed[k] : distSmooth[k]) / scale;
      const xm = i > 0 ? smooth[k - 1] : smooth[k];
      const xp = i < w - 1 ? smooth[k + 1] : smooth[k];
      const ym = j > 0 ? smooth[k - w] : smooth[k];
      const yp = j < h - 1 ? smooth[k + w] : smooth[k];
      const gx = xp - xm;
      const gy = yp - ym;
      const len = Math.hypot(gx, gy);
      if (len > 1e-6) {
        nx[k] = gx / len;
        ny[k] = gy / len;
      }
    }
  }
  return { d, nx, ny, cov, w, h };
}

/** One separable `[1,2,1]/4` pass over a grid. */
function blurTexels(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? src[base + x - 1] : src[base + x];
      const r = x < w - 1 ? src[base + x + 1] : src[base + x];
      tmp[base + x] = 0.25 * (l + r) + 0.5 * src[base + x];
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const t = y > 0 ? tmp[(y - 1) * w + x] : tmp[y * w + x];
      const b = y < h - 1 ? tmp[(y + 1) * w + x] : tmp[y * w + x];
      out[y * w + x] = 0.25 * (t + b) + 0.5 * tmp[y * w + x];
    }
  }
  return out;
}

/* ------------------------------------------------------------------- masks */

interface MaskRaster {
  inside: Uint8Array;
  coverage: Float32Array;
}

let sharedMaskCanvas: HTMLCanvasElement | null = null;
let sharedWorkCanvas: HTMLCanvasElement | null = null;

export function getWorkCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (!sharedWorkCanvas) sharedWorkCanvas = document.createElement("canvas");
  sharedWorkCanvas.width = w;
  sharedWorkCanvas.height = h;
  const ctx = sharedWorkCanvas.getContext("2d");
  if (!ctx) return null;
  return { canvas: sharedWorkCanvas, ctx };
}

function rasteriseMask(
  w: number,
  h: number,
  padPx: number,
  scale: number,
  width: number,
  height: number,
  pathD: string
): MaskRaster | null {
  if (!sharedMaskCanvas) sharedMaskCanvas = document.createElement("canvas");
  sharedMaskCanvas.width = w;
  sharedMaskCanvas.height = h;
  const ctx = sharedMaskCanvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(padPx, padPx);
  ctx.scale(scale, scale);
  ctx.fillStyle = CANVAS_MASK_KEEP;
  ctx.fill(new Path2D(pathD || `M0,0 H${width} V${height} H0 Z`));
  ctx.restore();

  const data = ctx.getImageData(0, 0, w, h).data;
  const inside = new Uint8Array(w * h);
  const coverage = new Float32Array(w * h);
  for (let k = 0; k < inside.length; k++) {
    const a = data[k * 4 + 3] / 255;
    coverage[k] = a;
    inside[k] = a >= 0.5 ? 1 : 0;
  }
  return { inside, coverage };
}

function signedDistance(mask: MaskRaster, w: number, h: number): Float32Array | null {
  const n = w * h;
  let inside = 0;
  for (let k = 0; k < n; k++) inside += mask.inside[k];
  if (inside === 0 || inside === n) return null;

  const toOutside = edt(mask.inside, w, h, 0);
  const toInside = edt(mask.inside, w, h, 1);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = mask.coverage[k];
    if (c > 0 && c < 1) {
      out[k] = 0.5 - c;
    } else if (mask.inside[k]) {
      out[k] = -(Math.sqrt(toOutside[k]) - 0.5);
    } else {
      out[k] = Math.sqrt(toInside[k]) - 0.5;
    }
  }
  return out;
}

function edt(binary: Uint8Array, w: number, h: number, feature: 0 | 1): Float32Array {
  const INF = 1e12;
  const grid = new Float32Array(w * h);
  const line = new Float64Array(Math.max(w, h));
  const dst = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);

  const sweep = (n: number): void => {
    let seeded = false;
    for (let q = 0; q < n; q++) if (line[q] < INF / 2) seeded = true;
    if (!seeded) {
      for (let q = 0; q < n; q++) dst[q] = INF;
      return;
    }
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const d = q - v[k];
      dst[q] = d * d + line[v[k]];
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = binary[y * w + x] === feature ? 0 : INF;
    sweep(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = dst[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = grid[y * w + x];
    sweep(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = dst[x];
  }
  return grid;
}
