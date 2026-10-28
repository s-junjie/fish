import { describe, it, expect } from "vitest";
import { calculateVisibleViewport, isElementInViewport } from "../src/core/geometry/cull";

describe("viewport culling", () => {
  it("calculates viewport bounding box with pan, zoom, and buffer", () => {
    const vp = calculateVisibleViewport({ x: 100, y: 50 }, 1, 800, 600, 200);
    expect(vp.x).toBe(-300); // -100 - 200 = -300
    expect(vp.y).toBe(-250); // -50 - 200 = -250
    expect(vp.width).toBe(1200); // 800 + 400 = 1200
    expect(vp.height).toBe(1000); // 600 + 400 = 1000
  });

  it("correctly identifies elements inside vs outside viewport", () => {
    const vp = { x: 0, y: 0, width: 1000, height: 800 };

    const insideEl = { x: 100, y: 100, width: 200, height: 150 };
    expect(isElementInViewport(insideEl, vp)).toBe(true);

    const outsideLeft = { x: -300, y: 100, width: 100, height: 100 };
    expect(isElementInViewport(outsideLeft, vp)).toBe(false);

    const outsideRight = { x: 1200, y: 100, width: 100, height: 100 };
    expect(isElementInViewport(outsideRight, vp)).toBe(false);

    const outsideBelow = { x: 100, y: 900, width: 100, height: 100 };
    expect(isElementInViewport(outsideBelow, vp)).toBe(false);
  });
});
