import { describe, it, expect } from "vitest";
import { parseHex, rgbToHex, getLuminance, applyContrast, lerpRgb } from "../src/plugins/photo-fx/engine/color-utils";
import { renderHalftoneDots, renderHalftoneLines } from "../src/plugins/photo-fx/engine/halftone";
import { renderBarScreen } from "../src/plugins/photo-fx/engine/bar-screen";
import { renderDither } from "../src/plugins/photo-fx/engine/dither";
import { DEFAULT_OPTIONS, type RetroPrintOptions } from "../src/plugins/photo-fx/engine/types";

// Helper to create mock ImageData
function createMockImageData(width: number, height: number, fillRgb = [128, 128, 128, 255]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    data[idx] = fillRgb[0];
    data[idx + 1] = fillRgb[1];
    data[idx + 2] = fillRgb[2];
    data[idx + 3] = fillRgb[3];
  }
  return {
    width,
    height,
    data,
    colorSpace: "srgb"
  } as ImageData;
}

// Minimal mock 2D canvas context for testing canvas render calls
function createMockContext(width: number, height: number) {
  const calls: string[] = [];
  return {
    calls,
    clearRect: (x: number, y: number, w: number, h: number) => calls.push(`clearRect ${x},${y},${w},${h}`),
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`fillRect ${x},${y},${w},${h}`),
    beginPath: () => calls.push("beginPath"),
    arc: (x: number, y: number, r: number) => calls.push(`arc ${x.toFixed(1)},${y.toFixed(1)},${r.toFixed(1)}`),
    fill: () => calls.push("fill"),
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x},${y}`),
    stroke: () => calls.push("stroke"),
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4)
    }),
    putImageData: () => calls.push("putImageData"),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "round"
  } as unknown as CanvasRenderingContext2D & { calls: string[] };
}

describe("RetroPrint color utils", () => {
  it("parses hex correctly", () => {
    expect(parseHex("#381b35")).toEqual({ r: 56, g: 27, b: 53 });
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("converts rgb to hex", () => {
    expect(rgbToHex({ r: 56, g: 27, b: 53 })).toBe("#381b35");
    expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
  });

  it("calculates Rec.709 luminance", () => {
    expect(getLuminance(0, 0, 0)).toBe(0);
    expect(getLuminance(255, 255, 255)).toBeCloseTo(1.0, 4);
    // Green dominates Rec.709
    expect(getLuminance(0, 255, 0)).toBeGreaterThan(getLuminance(255, 0, 0));
  });

  it("applies contrast and invert", () => {
    expect(applyContrast(0.5, 1.0, false)).toBe(0.5);
    expect(applyContrast(0.5, 1.0, true)).toBe(0.5);
    expect(applyContrast(0.8, 1.0, true)).toBeCloseTo(0.2, 4);
    expect(applyContrast(0.7, 1.5, false)).toBeCloseTo(0.8, 4);
  });

  it("interpolates colors smoothly", () => {
    const dark = { r: 0, g: 0, b: 0 };
    const light = { r: 100, g: 200, b: 150 };
    const mid = lerpRgb(dark, light, 0.5);
    expect(mid).toEqual({ r: 50, g: 100, b: 75 });
  });
});

describe("RetroPrint Halftone algorithms", () => {
  it("renders halftone dots to canvas context", () => {
    const ctx = createMockContext(100, 100);
    const imgData = createMockImageData(100, 100, [60, 60, 60, 255]); // Dark image
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      gridSize: 20,
      angle: 0
    };

    renderHalftoneDots(ctx, imgData, opt);
    expect(ctx.calls.some((c) => c.startsWith("arc"))).toBe(true);
    expect(ctx.calls.some((c) => c === "fill")).toBe(true);
  });


  it("renders lines and crosshatch to canvas", () => {
    const ctx = createMockContext(100, 100);
    const imgData = createMockImageData(100, 100, [50, 50, 50, 255]);
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      mode: "lines",
      gridSize: 15
    };

    renderHalftoneLines(ctx, imgData, opt, false);
    expect(ctx.calls.some((c) => c.startsWith("moveTo"))).toBe(true);
    expect(ctx.calls.some((c) => c.startsWith("lineTo"))).toBe(true);
    expect(ctx.calls.some((c) => c === "stroke")).toBe(true);
  });
});

/** Renders through the mock context and hands back the pixels it painted. */
function renderBarPixels(imgData: ImageData, opt: RetroPrintOptions): ImageData {
  const ctx = createMockContext(imgData.width, imgData.height) as unknown as CanvasRenderingContext2D & {
    putImageData: (d: ImageData) => void;
  };
  let painted: ImageData | null = null;
  ctx.putImageData = (d: ImageData) => {
    painted = d;
  };
  renderBarScreen(ctx, imgData, opt);
  if (!painted) throw new Error("renderBarScreen painted nothing");
  return painted;
}

function twoToneImageData(width: number, height: number, left: number, right: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < width / 2 ? left : right;
      const idx = (y * width + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

function alphaAt(img: ImageData, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3];
}

describe("RetroPrint bar screen", () => {
  const bars = (over: Partial<RetroPrintOptions>): RetroPrintOptions => ({
    ...DEFAULT_OPTIONS,
    mode: "bars",
    angle: 0,
    gridSize: 10,
    contrast: 1,
    barLevel: 0.78,
    barFalloff: 2.2,
    transparentBg: true,
    transitionBlend: "fade",
    ...over
  });

  it("inks the dark half solid and leaves the light half bare", () => {
    const src = twoToneImageData(80, 40, 40, 240);
    const out = renderBarPixels(src, bars({}));

    // Dark: below the ink level, so the bar closes into a solid slab.
    expect(alphaAt(out, 10, 20)).toBe(255);
    // Light: above the ink level, so no bar prints at all.
    expect(alphaAt(out, 60, 20)).toBe(0);
  });

  it("keeps bar edges one pixel wide instead of a gradient", () => {
    const out = renderBarPixels(twoToneImageData(81, 20, 120, 120), bars({}));
    const row = 10;
    let partial = 0;
    for (let x = 0; x < out.width; x++) {
      const a = alphaAt(out, x, row);
      if (a > 0 && a < 255) partial++;
    }
    // One antialiased pixel per edge, two edges per bar — a stroked edge would smear wider.
    const barsAcrossRow = Math.ceil(out.width / 10);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThanOrEqual(barsAcrossRow * 2);
  });

  it("holds the lattice straight: every row prints the same widths", () => {
    const out = renderBarPixels(twoToneImageData(60, 24, 120, 120), bars({}));
    const rowAlpha = (y: number) => {
      let sum = 0;
      for (let x = 0; x < out.width; x++) sum += alphaAt(out, x, y);
      return sum;
    };
    expect(rowAlpha(4)).toBe(rowAlpha(12));
    expect(rowAlpha(12)).toBe(rowAlpha(20));
  });

  it("rotates the lattice with the angle", () => {
    const src = twoToneImageData(40, 40, 120, 120);
    // Bars run along the lattice, so on a flat tone one axis repeats exactly.
    const columnsAreConstant = (img: ImageData) => {
      for (let x = 0; x < img.width; x++) {
        for (let y = 1; y < img.height; y++) {
          if (alphaAt(img, x, y) !== alphaAt(img, x, 0)) return false;
        }
      }
      return true;
    };
    expect(columnsAreConstant(renderBarPixels(src, bars({ angle: 0 })))).toBe(true);
    expect(columnsAreConstant(renderBarPixels(src, bars({ angle: 90 })))).toBe(false);
  });
});

describe("RetroPrint Dither algorithms", () => {  it("renders Floyd-Steinberg dither", () => {
    const ctx = createMockContext(64, 64);
    const imgData = createMockImageData(64, 64, [100, 100, 100, 255]);
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      mode: "dither",
      ditherAlgo: "floyd"
    };

    renderDither(ctx, imgData, opt);
    expect(ctx.calls).toContain("putImageData");
  });

  it("renders Atkinson dither", () => {
    const ctx = createMockContext(64, 64);
    const imgData = createMockImageData(64, 64, [120, 120, 120, 255]);
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      mode: "dither",
      ditherAlgo: "atkinson"
    };

    renderDither(ctx, imgData, opt);
    expect(ctx.calls).toContain("putImageData");
  });

  it("renders Bayer 4x4 and 8x8 dither", () => {
    const ctx = createMockContext(32, 32);
    const imgData = createMockImageData(32, 32, [140, 140, 140, 255]);
    const opt4: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      mode: "dither",
      ditherAlgo: "bayer4"
    };
    renderDither(ctx, imgData, opt4);
    expect(ctx.calls).toContain("putImageData");

    const opt8: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      mode: "dither",
      ditherAlgo: "bayer8"
    };
    renderDither(ctx, imgData, opt8);
    expect(ctx.calls.filter((c) => c === "putImageData").length).toBe(2);
  });
});

describe("RetroPrint Transition & Overlay algorithms", () => {
  it("computes two-ended fade factor correctly (tapering at top and bottom)", async () => {
    const { computeFadeFactor } = await import("../src/plugins/photo-fx/engine/transition");
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      transitionMode: "twoEnds",
      transitionSpread: 0.5,
      transitionInvert: false
    };

    // At top (y = 0) and bottom (y = 100), factor is 0 (tapered to point)
    expect(computeFadeFactor(50, 0, 100, 100, opt)).toBe(0);
    expect(computeFadeFactor(50, 100, 100, 100, opt)).toBe(0);

    // At vertical center (y = 50), factor is 1 (full thickness)
    expect(computeFadeFactor(50, 50, 100, 100, opt)).toBe(1);
  });

  it("computes vertical linear transition factor correctly (top to bottom)", async () => {
    const { computeFadeFactor } = await import("../src/plugins/photo-fx/engine/transition");
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      transitionMode: "vertical",
      transitionSpread: 0.4,
      transitionInvert: false
    };

    // Top is 0, bottom is 1
    expect(computeFadeFactor(50, 0, 100, 100, opt)).toBe(0);
    expect(computeFadeFactor(50, 100, 100, 100, opt)).toBe(1);
  });

  it("computes horizontal transition factor correctly (left to right)", async () => {
    const { computeFadeFactor } = await import("../src/plugins/photo-fx/engine/transition");
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      transitionMode: "horizontal",
      transitionSpread: 0.4,
      transitionInvert: false
    };

    // Far left is 0, far right is 1
    expect(computeFadeFactor(0, 50, 100, 100, opt)).toBe(0);
    expect(computeFadeFactor(100, 50, 100, 100, opt)).toBe(1);
  });

  it("overlays lines on sourceImg when transitionBlend is overlay", () => {
    const ctx = createMockContext(100, 100);
    (ctx as any).drawImage = (img: any, x: number, y: number, w: number, h: number) => {
      ctx.calls.push(`drawImage ${x},${y},${w},${h}`);
    };

    const imgData = createMockImageData(100, 100, [40, 40, 40, 255]);
    const mockSourceImg = {} as CanvasImageSource;
    const opt: RetroPrintOptions = {
      ...DEFAULT_OPTIONS,
      mode: "lines",
      angle: 0,
      transitionMode: "twoEnds",
      transitionBlend: "overlay"
    };

    renderHalftoneLines(ctx, imgData, opt, false, mockSourceImg);
    expect(ctx.calls).toContain("drawImage 0,0,100,100");
    expect(ctx.calls.some((c) => c.startsWith("lineTo"))).toBe(true);
  });
});

describe("PhotoFX Glitch and Mosaic algorithms", () => {
  it("applies RGB split displacing red and blue channels", async () => {
    const { applyRgbSplit } = await import("../src/plugins/photo-fx/engine/glitch");
    const imgData = createMockImageData(10, 10, [100, 150, 200, 255]);
    const res = applyRgbSplit(imgData, 2, 0);
    expect(res.data.length).toBe(10 * 10 * 4);
    expect(res.width).toBe(10);
    expect(res.height).toBe(10);
  });

  it("applies CRT scanlines darkening alternating lines", async () => {
    const { applyScanlines } = await import("../src/plugins/photo-fx/engine/glitch");
    const imgData = createMockImageData(10, 10, [200, 200, 200, 255]);
    applyScanlines(imgData, 50, 2);
    // Line y=0 is affected by scanline (darkened)
    expect(imgData.data[0]).toBeLessThan(200);
    // Line y=1 is untouched
    const line1Idx = 10 * 4;
    expect(imgData.data[line1Idx]).toBe(200);
  });

  it("applies block mosaic pixelation", async () => {
    const { applyMosaic } = await import("../src/plugins/photo-fx/engine/mosaic");
    const imgData = createMockImageData(8, 8, [10, 20, 30, 255]);
    // Set center pixel of first 4x4 block to a distinct color
    const centerIdx = (2 * 8 + 2) * 4;
    imgData.data[centerIdx] = 255;
    imgData.data[centerIdx + 1] = 128;
    imgData.data[centerIdx + 2] = 64;

    applyMosaic(imgData, 4);
    // All pixels in that 4x4 block should have sampled the center pixel
    expect(imgData.data[0]).toBe(255);
    expect(imgData.data[1]).toBe(128);
    expect(imgData.data[2]).toBe(64);
  });

  it("applies duotone gradient tinting to ImageData", async () => {
    const { applyDuotoneToImageData } = await import("../src/plugins/photo-fx/engine/color-utils");
    // Mid-gray image
    const imgData = createMockImageData(2, 2, [128, 128, 128, 255]);
    applyDuotoneToImageData(imgData, "#000000", "#ffffff");
    // Mid gray should be approximately (128, 128, 128)
    expect(imgData.data[0]).toBeGreaterThan(120);
    expect(imgData.data[0]).toBeLessThan(136);
  });

  it("applies film simulation with grain, vignette, and warmth", async () => {
    const { renderFilm, FILM_PRESETS } = await import("../src/plugins/photo-fx/engine/film");
    expect(FILM_PRESETS.length).toBeGreaterThanOrEqual(6);

    const ctx = createMockContext(20, 20);
    const imgData = createMockImageData(20, 20, [140, 140, 140, 255]);
    renderFilm(ctx, imgData, {
      preset: "classic35",
      grain: 40,
      vignette: 30,
      warmth: 15,
      fade: 10,
      lightLeak: 0
    });
    expect(ctx.calls.some((c) => c === "putImageData")).toBe(true);
  });

  it("applies Tri-X monochrome film profile", async () => {
    const { renderFilm } = await import("../src/plugins/photo-fx/engine/film");
    const ctx = createMockContext(10, 10);
    let capturedData: ImageData | null = null;
    (ctx as any).putImageData = (data: ImageData) => {
      capturedData = data;
    };
    // Colored input image
    const imgData = createMockImageData(10, 10, [200, 50, 50, 255]);
    renderFilm(ctx, imgData, {
      preset: "triX400",
      grain: 0,
      vignette: 0,
      warmth: 0,
      fade: 0,
      lightLeak: 0
    });
    expect(capturedData).not.toBeNull();
    // Tri-X is monochrome: R, G, B should be equal
    expect(capturedData!.data[0]).toBe(capturedData!.data[1]);
    expect(capturedData!.data[1]).toBe(capturedData!.data[2]);
  });
});

describe("Film stock grading", () => {
  const rgbOf = (d: ImageData, i = 0) => [d.data[i * 4], d.data[i * 4 + 1], d.data[i * 4 + 2]];

  async function grade(
    preset: string,
    rgb: [number, number, number],
    over: Record<string, number> = {}
  ): Promise<[number, number, number]> {
    const { renderFilm } = await import("../src/plugins/photo-fx/engine/film");
    const imgData = createMockImageData(2, 2, [rgb[0], rgb[1], rgb[2], 255]);
    renderFilm(
      { putImageData: () => {} } as unknown as CanvasRenderingContext2D,
      imgData,
      {
        preset: preset as never,
        grain: 0,
        vignette: 0,
        warmth: 0,
        fade: 0,
        lightLeak: 0,
        ...over
      }
    );
    return rgbOf(imgData) as [number, number, number];
  }

  it("warms and cools through linear channel gains, not a red/blue offset", async () => {
    const cool = await grade("classic35", [128, 128, 128], { warmth: -30 });
    const warm = await grade("classic35", [128, 128, 128], { warmth: 30 });
    expect(warm[0]).toBeGreaterThan(cool[0]);
    expect(warm[2]).toBeLessThan(cool[2]);
    // Green must barely move: a temperature shift that drags green is a tint, not a white balance.
    expect(Math.abs(warm[1] - cool[1])).toBeLessThan(Math.abs(warm[0] - cool[0]));
  });

  it("keeps the ends of the range in place", async () => {
    // A warm stock prints a warm white, but it must not tint it into cream or crush it.
    const white = await grade("kodakGold", [255, 255, 255]);
    expect(Math.min(...white)).toBeGreaterThanOrEqual(248);
    expect(Math.max(...white) - Math.min(...white)).toBeLessThanOrEqual(8);
    const black = await grade("cinematic", [0, 0, 0]);
    expect(Math.max(...black)).toBeLessThan(6);
  });

  it("splits shadows and highlights into opposite hues", async () => {
    const shadow = await grade("cinematic", [45, 45, 45]);
    const highlight = await grade("cinematic", [215, 215, 215]);
    // Teal shadows, orange highlights — the whole point of the grade.
    expect(shadow[2] - shadow[0]).toBeGreaterThan(3);
    expect(highlight[0] - highlight[2]).toBeGreaterThan(3);
  });

  it("adds chroma on the slide stock", async () => {
    const src: [number, number, number] = [150, 120, 110];
    const out = await grade("fujiVelvia", src);
    const chroma = (c: number[]) => Math.max(...c) - Math.min(...c);
    expect(chroma(out)).toBeGreaterThan(chroma(src));
  });

  it("changes every stock, so no preset is a no-op", async () => {
    const { FILM_PRESETS } = await import("../src/plugins/photo-fx/engine/film");
    for (const preset of FILM_PRESETS) {
      const out = await grade(preset.id, [140, 120, 100]);
      expect(out).not.toEqual([140, 120, 100]);
    }
  });
});

