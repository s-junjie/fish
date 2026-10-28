import { describe, expect, it } from "vitest";
import { parseCssColor } from "../src/core/import/css-values";
import { parseCssWideColor } from "../src/core/geometry/css-color-space";

/**
 * A computed colour in a modern space is NOT folded into `rgb()` by the browser:
 * `oklch(0.7 0.15 200)` comes back out of `getComputedStyle` as itself, so a
 * parser that knows only hex and `rgb()` reports "no colour here" and the
 * element silently loses its fill. Tailwind v4 ships an oklch palette, so this
 * is the common case rather than an exotic one.
 */
describe("parseCssColor wide-gamut", () => {
  it("reads oklch as sRGB", () => {
    // A mid blue: lightness 0.7, chroma 0.15, hue 200.
    const parsed = parseCssColor("oklch(0.7 0.15 200)");
    expect(parsed).not.toBeNull();
    expect(parsed!.color).toMatch(/^#[0-9A-F]{6}$/);
    // Blue-dominant, and not the fallback black the old parser produced.
    const b = parseInt(parsed!.color.slice(5, 7), 16);
    const r = parseInt(parsed!.color.slice(1, 3), 16);
    expect(b).toBeGreaterThan(r);
  });

  it("keeps the slash alpha of a wide-gamut colour", () => {
    const parsed = parseCssColor("oklch(0.7 0.15 200 / 0.4)");
    expect(parsed?.opacity).toBeCloseTo(0.4, 2);
  });

  it("reads display-p3, whose red is redder than sRGB allows", () => {
    expect(parseCssColor("color(display-p3 1 0 0)")?.color).toBe("#FF0000");
  });

  /**
   * A `color()` channel is written on that space's OWN curve, and the matrix onto
   * XYZ expects light — so the channels have to be decoded first. Both `1` and `0`
   * are fixed points of every one of these curves, which is why the case above
   * passes either way and only a MIDTONE can tell the two apart.
   */
  it("decodes a color() channel rather than treating it as light already", () => {
    const mid = parseCssColor("color(display-p3 0.5 0.5 0.5)");
    expect(mid).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(mid!.color.slice(i, i + 2), 16));
    // A neutral stays neutral, and 0.5 on the sRGB curve is a mid grey — reading
    // it as light already lands near #BBBBBB, whose error is too large to miss.
    expect(Math.abs(r - g)).toBeLessThan(2);
    expect(Math.abs(g - b)).toBeLessThan(2);
    expect(r).toBeGreaterThan(0x78);
    expect(r).toBeLessThan(0x86);
  });

  it("takes srgb's own channels on the same curve as rgb()", () => {
    const mid = parseCssColor("color(srgb 0.5 0.5 0.5)");
    expect(mid).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(mid!.color.slice(i, i + 2), 16));
    expect(Math.abs(r - 128)).toBeLessThan(3);
    expect(Math.abs(g - 128)).toBeLessThan(3);
    expect(Math.abs(b - 128)).toBeLessThan(3);
  });

  it("reads lab and lch through D50, adapting to sRGB's own white", () => {
    // A neutral grey: a = b = 0, so all three channels must land together.
    const grey = parseCssColor("lab(60 0 0)");
    expect(grey).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(grey!.color.slice(i, i + 2), 16));
    expect(Math.abs(r - g)).toBeLessThan(4);
    expect(Math.abs(g - b)).toBeLessThan(4);
    expect(parseCssColor("lch(60 40 30)")).not.toBeNull();
  });

  it("reads hsl and the ordinary spellings unchanged", () => {
    expect(parseCssColor("hsl(0 100% 50%)")?.color).toBe("#FF0000");
    expect(parseCssColor("rgb(255, 0, 0)")?.color).toBe("#FF0000");
    expect(parseCssColor("transparent")).toBeNull();
  });

  it("refuses a spelling it does not know rather than guessing a colour", () => {
    expect(parseCssWideColor("color(unknown-space 1 0 0)")).toBeNull();
    expect(parseCssWideColor("oklch(nonsense)")).toBeNull();
  });
});
