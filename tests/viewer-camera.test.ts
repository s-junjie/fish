import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM } from "../src/core/geometry/viewport";
import {
  VIEWER_FIT_MARGIN,
  VIEWER_KEEP_VISIBLE,
  boardBounds,
  cameraViewportBox,
  clampCameraPan,
  fitCamera,
  panCamera,
  zoomCameraAt
} from "../src/ui/viewer/viewer-camera";

const PHONE = { width: 390, height: 844 };
const BOARD = { x: 0, y: 0, width: 2100, height: 1120 };

/** Where a world point lands on screen through `translate(pan) scale(zoom)`. */
const project = (camera: { zoom: number; pan: { x: number; y: number } }, x: number, y: number) => ({
  x: camera.pan.x + x * camera.zoom,
  y: camera.pan.y + y * camera.zoom
});

describe("boardBounds", () => {
  it("is the declared canvas when nothing spills out of it", () => {
    expect(boardBounds({ width: 800, height: 600 }, { x: 10, y: 10, width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600
    });
  });

  it("grows to hold content drawn outside the canvas", () => {
    expect(boardBounds({ width: 800, height: 600 }, { x: -50, y: 20, width: 1000, height: 100 })).toEqual({
      x: -50,
      y: 0,
      width: 1000,
      height: 600
    });
  });

  it("falls back to the default canvas when the page declares none", () => {
    expect(boardBounds(undefined, null)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});

describe("fitCamera", () => {
  it("fits the whole board inside the screen", () => {
    const camera = fitCamera(BOARD, PHONE);
    const topLeft = project(camera, BOARD.x, BOARD.y);
    const bottomRight = project(camera, BOARD.x + BOARD.width, BOARD.y + BOARD.height);
    expect(topLeft.x).toBeGreaterThanOrEqual(VIEWER_FIT_MARGIN - 0.5);
    expect(topLeft.y).toBeGreaterThanOrEqual(VIEWER_FIT_MARGIN - 0.5);
    expect(bottomRight.x).toBeLessThanOrEqual(PHONE.width - VIEWER_FIT_MARGIN + 0.5);
    expect(bottomRight.y).toBeLessThanOrEqual(PHONE.height - VIEWER_FIT_MARGIN + 0.5);
  });

  it("centres the board horizontally", () => {
    const camera = fitCamera(BOARD, PHONE);
    const left = project(camera, 0, 0).x;
    const right = project(camera, BOARD.width, 0).x;
    expect(left + right).toBeCloseTo(PHONE.width, 5);
  });

  it("never magnifies a board smaller than the screen", () => {
    expect(fitCamera({ x: 0, y: 0, width: 320, height: 200 }, PHONE).zoom).toBe(1);
  });

  it("returns the identity camera before the host has been measured", () => {
    expect(fitCamera(BOARD, { width: 0, height: 0 })).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
  });
});

describe("zoomCameraAt", () => {
  it("holds the world point under the pinch midpoint still", () => {
    const start = { zoom: 0.4, pan: { x: 30, y: -80 } };
    const next = zoomCameraAt(start, 120, 300, 1.8);
    const before = { x: (120 - start.pan.x) / start.zoom, y: (300 - start.pan.y) / start.zoom };
    const after = project(next, before.x, before.y);
    expect(after.x).toBeCloseTo(120, 6);
    expect(after.y).toBeCloseTo(300, 6);
  });

  it("clamps at the ceiling and reports no change", () => {
    const atMax = { zoom: MAX_ZOOM, pan: { x: 0, y: 0 } };
    expect(zoomCameraAt(atMax, 10, 10, 2)).toBe(atMax);
    expect(zoomCameraAt({ zoom: MIN_ZOOM, pan: { x: 0, y: 0 } }, 10, 10, 0.5).zoom).toBe(MIN_ZOOM);
  });
});

describe("clampCameraPan", () => {
  it("keeps a corner of the board on screen after a fling", () => {
    const camera = clampCameraPan({ zoom: 0.4, pan: { x: 99_999, y: 99_999 } }, BOARD, PHONE);
    const topLeft = project(camera, 0, 0);
    expect(topLeft.x).toBeLessThanOrEqual(PHONE.width - VIEWER_KEEP_VISIBLE + 0.5);
    expect(topLeft.y).toBeLessThanOrEqual(PHONE.height - VIEWER_KEEP_VISIBLE + 0.5);
  });

  it("keeps the board off the far edge too", () => {
    const camera = clampCameraPan({ zoom: 0.4, pan: { x: -99_999, y: -99_999 } }, BOARD, PHONE);
    const bottomRight = project(camera, BOARD.width, BOARD.height);
    expect(bottomRight.x).toBeGreaterThanOrEqual(VIEWER_KEEP_VISIBLE - 0.5);
    expect(bottomRight.y).toBeGreaterThanOrEqual(VIEWER_KEEP_VISIBLE - 0.5);
  });

  it("leaves a legal camera alone, by identity", () => {
    const fitted = fitCamera(BOARD, PHONE);
    expect(clampCameraPan(fitted, BOARD, PHONE)).toBe(fitted);
  });

  it("still works when the board is smaller than the screen", () => {
    const camera = clampCameraPan({ zoom: 1, pan: { x: -10_000, y: 10_000 } }, { x: 0, y: 0, width: 100, height: 100 }, PHONE);
    const topLeft = project(camera, 0, 0);
    expect(topLeft.x).toBeGreaterThanOrEqual(VIEWER_KEEP_VISIBLE - 100 - 0.5);
    expect(topLeft.y).toBeLessThanOrEqual(PHONE.height - VIEWER_KEEP_VISIBLE + 0.5);
  });
});

describe("cameraViewportBox", () => {
  // The helper behind it pads by 200 screen px so a cull never pops at the edge
  // of a pan; in world units that is 200 / zoom on each side.
  it("reads back the world rect the screen is showing", () => {
    const box = cameraViewportBox({ zoom: 0.5, pan: { x: -100, y: -50 } }, PHONE);
    expect(box).not.toBeNull();
    expect(box!.x).toBeCloseTo(-200, 5);
    expect(box!.y).toBeCloseTo(-300, 5);
    expect(box!.width).toBeCloseTo(390 / 0.5 + 800, 5);
    expect(box!.height).toBeCloseTo(844 / 0.5 + 800, 5);
  });

  it("is null before the host has been measured, so culling stays off", () => {
    expect(cameraViewportBox({ zoom: 1, pan: { x: 0, y: 0 } }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("panCamera", () => {
  it("moves the camera and keeps the zoom", () => {
    expect(panCamera({ zoom: 0.25, pan: { x: 5, y: 5 } }, -3, 9)).toEqual({
      zoom: 0.25,
      pan: { x: 2, y: 14 }
    });
  });
});
