import { describe, expect, it } from "vitest";
import {
  clampWindowPosition,
  clampWindowSize,
  resizeWindowRect,
  WINDOW_EDGE_MARGIN
} from "../src/ui/floating-window-geometry";
import { TITLE_BAR_HEIGHT } from "../src/ui/toolbar/titlebar-layout";

const VIEWPORT = { width: 1440, height: 900 };
const BOUNDS = { minWidth: 320, minHeight: 240 };

describe("floating window geometry", () => {
  it("prevents dragging or placing a window onto the titlebar", () => {
    const draggedUp = clampWindowPosition({ x: 200, y: 0 }, { width: 400, height: 500 }, VIEWPORT);
    expect(draggedUp.y).toBe(TITLE_BAR_HEIGHT);

    const negativeY = clampWindowPosition({ x: 200, y: -50 }, { width: 400, height: 500 }, VIEWPORT);
    expect(negativeY.y).toBe(TITLE_BAR_HEIGHT);

    const smallViewportCentered = clampWindowPosition(
      { x: 100, y: 20 },
      { width: 760, height: 520 },
      { width: 1200, height: 580 },
      { fitHeight: true }
    );
    expect(smallViewportCentered.y).toBe(TITLE_BAR_HEIGHT);
  });

  it("clamps horizontal position inside viewport margins and keeps header reachable at bottom", () => {
    const leftClamped = clampWindowPosition({ x: -100, y: 120 }, { width: 400, height: 500 }, VIEWPORT);
    expect(leftClamped.x).toBe(WINDOW_EDGE_MARGIN);

    const rightClamped = clampWindowPosition({ x: 2000, y: 120 }, { width: 400, height: 500 }, VIEWPORT);
    expect(rightClamped.x).toBe(VIEWPORT.width - 400 - WINDOW_EDGE_MARGIN);

    const bottomClamped = clampWindowPosition({ x: 100, y: 2000 }, { width: 400, height: 500 }, VIEWPORT);
    expect(bottomClamped.y).toBe(VIEWPORT.height - 80);
  });

  it("clamps initial size to viewport below titlebar while respecting minimum bounds", () => {
    const fit = clampWindowSize(
      { width: 760, height: 520 },
      { width: 700, height: 480 },
      { minWidth: 560, minHeight: 360 }
    );
    expect(fit.width).toBe(700 - WINDOW_EDGE_MARGIN * 2);
    expect(fit.height).toBe(480 - TITLE_BAR_HEIGHT - WINDOW_EDGE_MARGIN);
  });

  it("resizes from right and bottom edges without moving origin", () => {
    const start = { x: 200, y: 120, width: 400, height: 300 };

    const east = resizeWindowRect(start, { dx: 80, dy: 40 }, "e", VIEWPORT, BOUNDS);
    expect(east).toEqual({ x: 200, y: 120, width: 480, height: 300 });

    const south = resizeWindowRect(start, { dx: 80, dy: 60 }, "s", VIEWPORT, BOUNDS);
    expect(south).toEqual({ x: 200, y: 120, width: 400, height: 360 });
  });

  it("resizes from left and top edges while pinning the opposite edge", () => {
    const start = { x: 300, y: 200, width: 400, height: 300 };

    const west = resizeWindowRect(start, { dx: -50, dy: 0 }, "w", VIEWPORT, BOUNDS);
    expect(west).toEqual({ x: 250, y: 200, width: 450, height: 300 });
    expect(west.x + west.width).toBe(start.x + start.width);

    const north = resizeWindowRect(start, { dx: 0, dy: -60 }, "n", VIEWPORT, BOUNDS);
    expect(north).toEqual({ x: 300, y: 140, width: 400, height: 360 });
    expect(north.y + north.height).toBe(start.y + start.height);
  });

  it("resizes from all four corners while respecting minWidth, minHeight, and titlebar top bound", () => {
    const start = { x: 300, y: 150, width: 400, height: 300 };

    // Top-left corner pulled past titlebar and past left margin
    const nw = resizeWindowRect(start, { dx: -500, dy: -500 }, "nw", VIEWPORT, BOUNDS);
    expect(nw.x).toBe(WINDOW_EDGE_MARGIN);
    expect(nw.y).toBe(TITLE_BAR_HEIGHT);
    expect(nw.x + nw.width).toBe(start.x + start.width);
    expect(nw.y + nw.height).toBe(start.y + start.height);

    // Top-right corner shrunk past minimums
    const ne = resizeWindowRect(start, { dx: -200, dy: 200 }, "ne", VIEWPORT, BOUNDS);
    expect(ne.x).toBe(start.x);
    expect(ne.width).toBe(BOUNDS.minWidth);
    expect(ne.height).toBe(BOUNDS.minHeight);
    expect(ne.y + ne.height).toBe(start.y + start.height);

    // Bottom-left corner expanded
    const sw = resizeWindowRect(start, { dx: -40, dy: 50 }, "sw", VIEWPORT, BOUNDS);
    expect(sw).toEqual({ x: 260, y: 150, width: 440, height: 350 });

    // Bottom-right corner expanded
    const se = resizeWindowRect(start, { dx: 45, dy: 55 }, "se", VIEWPORT, BOUNDS);
    expect(se).toEqual({ x: 300, y: 150, width: 445, height: 355 });
  });
});
