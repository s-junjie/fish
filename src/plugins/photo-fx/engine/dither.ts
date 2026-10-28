import { parseHex, lerpRgb, getLuminance, applyContrast } from "./color-utils";
import type { RetroPrintOptions } from "./types";

const BAYER_4: number[][] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

const BAYER_8: number[][] = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21]
];

export function renderDither(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData,
  options: RetroPrintOptions
): void {
  const { width, height } = imageData;
  const src = new Uint8ClampedArray(imageData.data);
  const out = ctx.createImageData(width, height);
  const outData = out.data;

  const darkRgb = parseHex(options.darkColor);
  const lightRgb = parseHex(options.lightColor);

  // Pre-calculate gray buffer with contrast
  const gray = new Float32Array(width * height);
  const alpha = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    alpha[i] = src[idx + 3];
    if (alpha[i] < 16) {
      gray[i] = 1.0;
      continue;
    }
    const lum = getLuminance(src[idx], src[idx + 1], src[idx + 2]);
    gray[i] = applyContrast(lum, options.contrast, options.invert);
  }

  const algo = options.ditherAlgo;

  if (algo === "bayer4" || algo === "bayer8") {
    const mat = algo === "bayer4" ? BAYER_4 : BAYER_8;
    const size = mat.length;
    const factor = 1 / (size * size);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (alpha[i] < 16) {
          if (!options.transparentBg) {
            setPixel(outData, i, lightRgb, 255);
          }
          continue;
        }

        const threshold = (mat[y % size][x % size] + 0.5) * factor;
        const val = gray[i] < threshold ? 0 : 1; // 0 = dark, 1 = light

        if (val === 0) {
          if (options.colorMode === "original") {
            const idx = i * 4;
            setPixel(outData, i, { r: src[idx], g: src[idx + 1], b: src[idx + 2] }, 255);
          } else {
            setPixel(outData, i, darkRgb, 255);
          }
        } else {
          if (options.transparentBg) {
            setPixel(outData, i, lightRgb, 0);
          } else {
            setPixel(outData, i, lightRgb, 255);
          }
        }
      }
    }
  } else if (algo === "floyd") {
    // Floyd-Steinberg error diffusion
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (alpha[i] < 16) {
          if (!options.transparentBg) setPixel(outData, i, lightRgb, 255);
          continue;
        }

        const oldVal = gray[i];
        const newVal = oldVal < 0.5 ? 0 : 1;
        const err = oldVal - newVal;

        if (newVal === 0) {
          if (options.colorMode === "original") {
            const idx = i * 4;
            setPixel(outData, i, { r: src[idx], g: src[idx + 1], b: src[idx + 2] }, 255);
          } else {
            setPixel(outData, i, darkRgb, 255);
          }
        } else {
          if (options.transparentBg) {
            setPixel(outData, i, lightRgb, 0);
          } else {
            setPixel(outData, i, lightRgb, 255);
          }
        }

        if (x + 1 < width) gray[i + 1] += err * (7 / 16);
        if (x - 1 >= 0 && y + 1 < height) gray[i + width - 1] += err * (3 / 16);
        if (y + 1 < height) gray[i + width] += err * (5 / 16);
        if (x + 1 < width && y + 1 < height) gray[i + width + 1] += err * (1 / 16);
      }
    }
  } else if (algo === "atkinson") {
    // Atkinson error diffusion (1/8 distributed across 6 neighbors)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (alpha[i] < 16) {
          if (!options.transparentBg) setPixel(outData, i, lightRgb, 255);
          continue;
        }

        const oldVal = gray[i];
        const newVal = oldVal < 0.5 ? 0 : 1;
        const err = (oldVal - newVal) / 8;

        if (newVal === 0) {
          if (options.colorMode === "original") {
            const idx = i * 4;
            setPixel(outData, i, { r: src[idx], g: src[idx + 1], b: src[idx + 2] }, 255);
          } else {
            setPixel(outData, i, darkRgb, 255);
          }
        } else {
          if (options.transparentBg) {
            setPixel(outData, i, lightRgb, 0);
          } else {
            setPixel(outData, i, lightRgb, 255);
          }
        }

        if (x + 1 < width) gray[i + 1] += err;
        if (x + 2 < width) gray[i + 2] += err;
        if (x - 1 >= 0 && y + 1 < height) gray[i + width - 1] += err;
        if (y + 1 < height) gray[i + width] += err;
        if (x + 1 < width && y + 1 < height) gray[i + width + 1] += err;
        if (y + 2 < height) gray[i + width * 2] += err;
      }
    }
  }

  ctx.putImageData(out, 0, 0);
}

function setPixel(data: Uint8ClampedArray, i: number, color: { r: number; g: number; b: number }, a: number) {
  const idx = i * 4;
  data[idx] = color.r;
  data[idx + 1] = color.g;
  data[idx + 2] = color.b;
  data[idx + 3] = a;
}
