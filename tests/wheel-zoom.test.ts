import { describe, it, expect } from "vitest";
import { wheelZoomFactor } from "../src/core/geometry/viewport";

describe("a wheel tick travels", () => {
  // The gesture is the feature: one notch of a classic mouse wheel is ONE event
  // carrying ±100..120, and it is meant to move the zoom by a step you can see —
  // that is what makes zooming feel like Figma's rather than like a crawl. The
  // cost of it is a bigger mount per frame, and the lever for that is the mount,
  // not this number (see the note in `viewport.ts`).
  it("moves a mouse notch by about a third", () => {
    expect(wheelZoomFactor(100, 0)).toBeCloseTo(0.3012, 4);
    expect(wheelZoomFactor(120, 0)).toBeCloseTo(0.3012, 4);
    expect(wheelZoomFactor(-120, 0)).toBeCloseTo(3.3201, 4);
  });

  it("scales with the delta until the delta itself is clamped", () => {
    expect(wheelZoomFactor(2, 0)).toBeCloseTo(0.9704, 4);
    expect(wheelZoomFactor(10, 0)).toBeCloseTo(0.8607, 4);
    expect(wheelZoomFactor(40, 0)).toBeCloseTo(0.5488, 4);
    expect(wheelZoomFactor(1000, 0)).toBe(wheelZoomFactor(80, 0));
  });

  it("reads a wheel that reports lines as the same notch", () => {
    expect(wheelZoomFactor(3, 1)).toBe(wheelZoomFactor(48, 0));
    expect(wheelZoomFactor(1, 2)).toBe(wheelZoomFactor(80, 0));
  });

  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelZoomFactor(-10, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10, 0)).toBeLessThan(1);
    expect(wheelZoomFactor(0, 0)).toBe(1);
  });
});
