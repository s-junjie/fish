import { describe, expect, it } from "vitest";
import { angularSectors } from "../src/core/geometry/gradient-decomposition";

/**
 * A conic gradient has no SVG paint server, so it is drawn as a fan of sectors —
 * and how many it needs is a chord-error budget in PIXELS, which makes it a
 * function of how big the element is being drawn rather than of how big it is.
 *
 * The count used to come from `Math.round(max(width, height))`, the document
 * size, so a 100px disc got 100 sectors at every zoom: 0.03px of sagitta at
 * 100 %, and 0.26px at 800 %, where each sector is a flat cell you can count
 * around the rim. The code's own comment already said the count should scale
 * with the rendered size; these tests are what holds it to that.
 */
const conic = (over: Record<string, unknown> = {}) =>
  ({
    type: "angular-gradient",
    angle: 0,
    center: { x: 0.5, y: 0.5 },
    stops: [
      { position: 0, color: "#101820" },
      { position: 0.5, color: "#F2AA4C" },
      { position: 1, color: "#101820" }
    ],
    ...over
  }) as never;

const count = (w: number, h: number, viewScale?: number) =>
  angularSectors(conic(), w, h, 0, viewScale).length;

describe("angular gradient sector count", () => {
  it("is the element's document size at 1:1, as it always was", () => {
    expect(count(100, 100, 1)).toBe(100);
    expect(count(100, 100)).toBe(100);
  });

  it("scales with the device scale, because the sagitta it buys is a length", () => {
    expect(count(100, 100, 2)).toBe(200);
    expect(count(100, 100, 4)).toBe(360);
  });

  it("keeps a floor and a ceiling, so a 4K export cannot grow the DOM without bound", () => {
    expect(count(4, 4, 1)).toBe(32);
    expect(count(4000, 4000, 1)).toBe(360);
    expect(count(4000, 4000, 8)).toBe(360);
  });

  it("never asks for fewer sectors than 1:1 did", () => {
    for (const s of [1, 1.5, 2, 3, 4, 6, 8]) {
      expect(count(240, 90, s)).toBeGreaterThanOrEqual(count(240, 90, 1));
    }
  });

  it("still emits a full turn of sectors with no gap at the seam", () => {
    const sectors = angularSectors(conic(), 200, 200, 0, 4);
    const arc = (d: string) => Number(/A ([\d.]+)/.exec(d)?.[1] ?? 0);
    expect(sectors.length).toBe(360);
    // Every sector is a wedge from the centre out to the tile radius, inflated by
    // half a pixel so the next one paints over the antialiased seam.
    for (const s of sectors) {
      expect(s.d.startsWith("M 100 100 L ")).toBe(true);
      expect(s.d.endsWith(" Z")).toBe(true);
      expect(arc(s.d)).toBeGreaterThan(140);
    }
  });

  it("returns nothing for a degenerate box rather than dividing by zero", () => {
    expect(angularSectors(conic(), 0, 0, 0, 4)).toEqual([]);
  });
});
