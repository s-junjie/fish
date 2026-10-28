import type { PhotoFxOptions } from "./types";
import { renderHalftoneDots, renderHalftoneLines } from "./halftone";
import { renderBarScreen } from "./bar-screen";
import { renderDither } from "./dither";
import { createTransitionMask } from "./transition";
import { renderGlitch } from "./glitch";
import { renderMosaic } from "./mosaic";
import { renderFilm } from "./film";
import { applyDuotoneToImageData } from "./color-utils";

/**
 * Draws image onto offscreen canvas and applies the selected photo-fx style.
 * If canvasElementWidth is provided, options.gridSize and block sizes are scaled
 * so the dot/line frequency relative to the image features exactly matches canvas display.
 */
export function processImageToCanvas(
  sourceImg: HTMLImageElement,
  targetCanvas: HTMLCanvasElement,
  options: PhotoFxOptions,
  maxDimension?: number,
  canvasElementWidth?: number
): void {
  let w = sourceImg.naturalWidth || sourceImg.width;
  let h = sourceImg.naturalHeight || sourceImg.height;

  if (maxDimension && (w > maxDimension || h > maxDimension)) {
    if (w > h) {
      h = Math.round((h * maxDimension) / w);
      w = maxDimension;
    } else {
      w = Math.round((w * maxDimension) / h);
      h = maxDimension;
    }
  }

  targetCanvas.width = w;
  targetCanvas.height = h;

  const ctx = targetCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  // Scale gridSize proportionally to target element width on canvas
  const effectiveScale =
    canvasElementWidth && canvasElementWidth > 0 ? w / canvasElementWidth : 1;
  const effectiveGridSize = Math.max(1.5, Math.round(options.gridSize * effectiveScale));
  const activeOptions: PhotoFxOptions = {
    ...options,
    gridSize: effectiveGridSize
  };

  // Draw source image to extract raw pixels
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(sourceImg, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);

  // 1. Analog Film Engine
  if (activeOptions.fxCategory === "film") {
    let filmData = imageData;
    if (activeOptions.colorMode === "duotone") {
      filmData = applyDuotoneToImageData(filmData, activeOptions.darkColor, activeOptions.lightColor);
    }
    renderFilm(ctx, filmData, {
      preset: activeOptions.filmPreset,
      grain: activeOptions.filmGrain,
      vignette: activeOptions.filmVignette,
      warmth: activeOptions.filmWarmth,
      fade: activeOptions.filmFade,
      lightLeak: activeOptions.filmLightLeak
    });
    return;
  }

  // 2. Digital Glitch Engine
  if (activeOptions.fxCategory === "glitch") {
    let glitched = imageData;
    if (activeOptions.colorMode === "duotone") {
      glitched = applyDuotoneToImageData(glitched, activeOptions.darkColor, activeOptions.lightColor);
    }
    renderGlitch(ctx, glitched, {
      rgbSplit: Math.round(activeOptions.rgbSplit * effectiveScale),
      scanlines: activeOptions.scanlines,
      sliceShift: Math.round(activeOptions.sliceShift * effectiveScale)
    });
    return;
  }

  // 2. Block Mosaic / Pixelate Engine
  if (activeOptions.fxCategory === "mosaic") {
    let mosaicData = imageData;
    if (activeOptions.colorMode === "duotone") {
      mosaicData = applyDuotoneToImageData(mosaicData, activeOptions.darkColor, activeOptions.lightColor);
    }
    renderMosaic(ctx, mosaicData, {
      blockSize: Math.max(2, Math.round(activeOptions.mosaicBlockSize * effectiveScale))
    });
    return;
  }

  // 3. Print & Screen Tone Engine (Halftone, Stripes, Crosshatch, Dither)
  const isReveal = activeOptions.transitionMode !== "none" && activeOptions.transitionBlend === "reveal";

  if (isReveal) {
    // Render pattern to offscreen canvas
    const patternCanvas = document.createElement("canvas");
    patternCanvas.width = w;
    patternCanvas.height = h;
    const pCtx = patternCanvas.getContext("2d");
    if (pCtx) {
      const pOptions: PhotoFxOptions = { ...activeOptions, transitionBlend: "fade" };
      if (activeOptions.mode === "dots") {
        renderHalftoneDots(pCtx, imageData, pOptions);
      } else if (activeOptions.mode === "lines") {
        renderHalftoneLines(pCtx, imageData, pOptions, false);
      } else if (activeOptions.mode === "bars") {
        renderBarScreen(pCtx, imageData, pOptions);
      } else if (activeOptions.mode === "crosshatch") {
        renderHalftoneLines(pCtx, imageData, pOptions, true);
      } else if (activeOptions.mode === "dither") {
        renderDither(pCtx, imageData, pOptions);
      }

      // Draw original photo onto target canvas
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(sourceImg, 0, 0, w, h);

      // Mask pattern and composite over photo
      const maskCanvas = createTransitionMask(w, h, activeOptions);
      const mCtx = maskCanvas.getContext("2d");
      if (mCtx) {
        mCtx.globalCompositeOperation = "source-in";
        mCtx.drawImage(patternCanvas, 0, 0);
        ctx.drawImage(maskCanvas, 0, 0);
      }
    }
  } else {
    // Apply pattern mode with direct canvas rendering (supporting overlay on photo)
    if (activeOptions.mode === "dots") {
      renderHalftoneDots(ctx, imageData, activeOptions, sourceImg);
    } else if (activeOptions.mode === "lines") {
      renderHalftoneLines(ctx, imageData, activeOptions, false, sourceImg);
    } else if (activeOptions.mode === "bars") {
      renderBarScreen(ctx, imageData, activeOptions);
    } else if (activeOptions.mode === "crosshatch") {
      renderHalftoneLines(ctx, imageData, activeOptions, true, sourceImg);
    } else if (activeOptions.mode === "dither") {
      renderDither(ctx, imageData, activeOptions);
    }
  }
}

/**
 * Exports retro-print result as a PNG data URI.
 */
export async function processToDataUri(
  sourceImg: HTMLImageElement,
  options: PhotoFxOptions,
  maxDimension?: number,
  canvasElementWidth?: number
): Promise<{ uri: string; width: number; height: number }> {
  const canvas = document.createElement("canvas");
  processImageToCanvas(sourceImg, canvas, options, maxDimension, canvasElementWidth);
  const uri = canvas.toDataURL("image/png");
  return {
    uri,
    width: canvas.width,
    height: canvas.height
  };
}
