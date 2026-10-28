import { describe, it, expect } from "vitest";
import {
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEPS,
  clampZoom,
  zoomStep,
  formatZoomPercent,
  normalizePageViewport,
  visibleRectOf,
  centerInRect
} from "../src/core/geometry/viewport";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";

describe("clampZoom", () => {
  it("holds Figma's 6400% ceiling", () => {
    expect(MAX_ZOOM).toBe(64);
    expect(clampZoom(64)).toBe(64);
    expect(clampZoom(200)).toBe(64);
  });

  it("leaves the range in between, 1:1 included", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.8)).toBe(0.8);
    expect(clampZoom(37.5)).toBe(37.5);
  });

  it("holds the floor", () => {
    expect(MIN_ZOOM).toBe(0.02);
    expect(clampZoom(0.01)).toBe(0.02);
    expect(clampZoom(0)).toBe(0.02);
    expect(clampZoom(-4)).toBe(0.02);
  });

  it("falls back to 1:1 on a value that is not a number", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("zoomStep", () => {
  it("is anchored on 1:1 and spans exactly the range the clamp allows", () => {
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(MAX_ZOOM);
    expect(ZOOM_STEPS).toContain(1);
  });

  it("doubles going up from 1:1, Figma's ladder", () => {
    expect(zoomStep(1, 1)).toBe(2);
    expect(zoomStep(2, 1)).toBe(4);
    expect(zoomStep(16, 1)).toBe(32);
    expect(zoomStep(32, 1)).toBe(64);
  });

  it("halves going down from 1:1, all the way to the 2% floor", () => {
    expect(zoomStep(1, -1)).toBe(0.5);
    expect(zoomStep(0.5, -1)).toBe(0.25);
    expect(zoomStep(0.25, -1)).toBe(0.1);
    expect(zoomStep(0.1, -1)).toBe(0.05);
    expect(zoomStep(0.05, -1)).toBe(0.02);
  });

  it("reaches the 2% floor in a few presses, which is the point of lowering it", () => {
    let z = 1;
    const presses = [];
    while (z > MIN_ZOOM) {
      z = zoomStep(z, -1);
      presses.push(z);
    }
    expect(presses).toEqual([0.5, 0.25, 0.1, 0.05, 0.02]);
  });

  it("snaps a zoom that is between two rungs onto the next one, not past it", () => {
    expect(zoomStep(0.8, 1)).toBe(1);
    expect(zoomStep(0.8, -1)).toBe(0.5);
    expect(zoomStep(3.7, 1)).toBe(4);
    expect(zoomStep(3.7, -1)).toBe(2);
  });

  it("is a no-op at either end rather than a jump back", () => {
    expect(zoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(zoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(zoomStep(1e9, 1)).toBe(MAX_ZOOM);
    expect(zoomStep(-5, -1)).toBe(MIN_ZOOM);
  });

  it("reads a zoom of 1:1 as 1:1 in both directions, so a step always moves", () => {
    expect(zoomStep(1, 1)).toBeGreaterThan(1);
    expect(zoomStep(1, -1)).toBeLessThan(1);
  });
});

describe("formatZoomPercent", () => {
  it("reads the rungs as the integers a designer expects", () => {
    expect(formatZoomPercent(1)).toBe("100%");
    expect(formatZoomPercent(0.5)).toBe("50%");
    expect(formatZoomPercent(2)).toBe("200%");
    expect(formatZoomPercent(64)).toBe("6400%");
  });

  it("rounds above 10%", () => {
    expect(formatZoomPercent(0.8)).toBe("80%");
    expect(formatZoomPercent(1.533)).toBe("153%");
  });

  it("keeps a decimal below 10%, where integers would collapse the rungs together", () => {
    expect(formatZoomPercent(0.1)).toBe("10%");
    expect(formatZoomPercent(0.042)).toBe("4.2%");
    // The two are told apart, which the integer reading could not do.
    expect(formatZoomPercent(0.014)).not.toBe(formatZoomPercent(0.015));
  });

  it("reads the rungs and the floor as whole numbers, not 2.0% off a float", () => {
    expect(formatZoomPercent(MIN_ZOOM)).toBe("2%");
    expect(formatZoomPercent(0.05)).toBe("5%");
    expect(formatZoomPercent(0.25)).toBe("25%");
    expect(formatZoomPercent(0.5)).toBe("50%");
  });

  it("falls back to 1:1 on a value that is not a number", () => {
    expect(formatZoomPercent(Number.NaN)).toBe("100%");
  });
});

describe("normalizePageViewport", () => {
  it("keeps a viewport that is already in range", () => {
    expect(normalizePageViewport({ x: 390, y: 80, zoom: 2.5 })).toEqual({ x: 390, y: 80, zoom: 2.5 });
  });

  it("clamps a zoom above the ceiling rather than trusting it", () => {
    expect(normalizePageViewport({ x: 0, y: 0, zoom: 1e9 })).toEqual({ x: 0, y: 0, zoom: MAX_ZOOM });
  });

  it("clamps a zoom below the floor", () => {
    expect(normalizePageViewport({ x: 0, y: 0, zoom: 0 })).toEqual({ x: 0, y: 0, zoom: MIN_ZOOM });
  });

  it("drops a viewport it cannot restore, rather than one that paints nothing", () => {
    for (const raw of [
      undefined,
      null,
      "3",
      3,
      [],
      { x: 0, y: 0 },
      { x: 0, y: 0, zoom: "3" },
      { x: Number.NaN, y: 0, zoom: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 },
      { x: 0, y: 0, zoom: Number.NaN }
    ]) {
      expect(normalizePageViewport(raw)).toBeUndefined();
    }
  });
});

describe("the world rect a visible area is showing", () => {
  it("inverts the stage transform, so the screen centre reads back as the world centre", () => {
    // `screen = world * zoom + pan`, so the window's centre at (700, 400) is world
    // (320, 160) once the pan and the 2x zoom are taken back out.
    const area = { x: 240, y: 44, width: 920, height: 712 };
    expect(visibleRectOf(area, 2, { x: 60, y: 80 })).toEqual({
      x: (240 - 60) / 2,
      y: (44 - 80) / 2,
      width: 460,
      height: 356
    });
  });

  it("falls back to 1:1 rather than dividing by a zoom that paints nothing", () => {
    const area = { x: 0, y: 0, width: 100, height: 100 };
    expect(visibleRectOf(area, 0, { x: 0, y: 0 }).width).toBe(100);
    expect(visibleRectOf(area, Number.NaN, { x: 0, y: 0 }).width).toBe(100);
  });
});

describe("centring a box in a rect", () => {
  it("puts the box's own centre on the rect's centre", () => {
    expect(centerInRect({ x: 1000, y: 1000, width: 100, height: 100 }, { width: 100, height: 50 })).toEqual({
      x: 1000,
      y: 1025
    });
  });

  it("rounds, because the answer is an element's x and y", () => {
    expect(centerInRect({ x: 0, y: 0, width: 101, height: 101 }, { width: 24, height: 24 })).toEqual({
      x: 39,
      y: 39
    });
  });

  it("centres a box larger than the rect on the same point", () => {
    // A dropped image can be wider than the viewport at a high zoom: it still has
    // to be centred, not clamped to an edge.
    expect(centerInRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 400, height: 400 })).toEqual({
      x: -150,
      y: -150
    });
  });
});

describe("a page's stored viewport on the way in", () => {
  const page = (metadata: unknown) =>
    normalizeDesignDocument({
      pages: [{ id: "p1", name: "Page 1", canvas: { width: 100, height: 100 }, children: [], metadata }],
      activePageId: "p1"
    }).document;

  it("is clamped, so undo, redo and a page switch all read an in-range zoom", () => {
    const doc = page({ viewport: { x: 10, y: 20, zoom: 4096 } });
    expect(doc.pages[0].metadata?.viewport).toEqual({ x: 10, y: 20, zoom: MAX_ZOOM });
  });

  it("is left alone when it is already sane", () => {
    const doc = page({ viewport: { x: 10, y: 20, zoom: 1 } });
    expect(doc.pages[0].metadata?.viewport).toEqual({ x: 10, y: 20, zoom: 1 });
  });

  it("is dropped when it cannot be restored, and the rest of the metadata survives", () => {
    const doc = page({ viewport: { x: Number.NaN, y: 0, zoom: 1 }, note: "keep me" });
    expect(doc.pages[0].metadata).toEqual({ note: "keep me" });
  });

  it("leaves a page with no metadata without inventing one", () => {
    const doc = normalizeDesignDocument({
      pages: [{ id: "p1", name: "Page 1", canvas: { width: 100, height: 100 }, children: [] }],
      activePageId: "p1"
    }).document;
    expect(doc.pages[0].metadata).toBeUndefined();
  });
});
