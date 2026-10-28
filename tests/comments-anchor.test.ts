import { describe, it, expect } from "vitest";
import {
  computeRelativeOffset,
  resolveCommentCanvasPoint,
  canvasToViewportPoint
} from "../src/core/comments/anchor";

describe("comments anchor calculations", () => {
  it("computes normalized relative offsets clamped to [0, 1]", () => {
    const bounds = { x: 100, y: 200, width: 300, height: 100 };
    expect(computeRelativeOffset({ x: 250, y: 250 }, bounds)).toEqual({ u: 0.5, v: 0.5 });
    expect(computeRelativeOffset({ x: 50, y: 150 }, bounds)).toEqual({ u: 0, v: 0 });
    expect(computeRelativeOffset({ x: 500, y: 400 }, bounds)).toEqual({ u: 1, v: 1 });
  });

  it("resolves canvas point when target element moves or resizes", () => {
    const target = {
      elementId: "card_1",
      relativeOffset: { u: 0.5, v: 1.0 }, // Bottom center
      canvasPoint: { x: 50, y: 50 }
    };

    // First position: x: 100, y: 100, width: 200, height: 80
    const point1 = resolveCommentCanvasPoint(target, (id) =>
      id === "card_1" ? { x: 100, y: 100, width: 200, height: 80 } : undefined
    );
    expect(point1).toEqual({ x: 200, y: 180, isOrphan: false });

    // Moved & resized by Auto-Layout: x: 300, y: 400, width: 400, height: 120
    const point2 = resolveCommentCanvasPoint(target, (id) =>
      id === "card_1" ? { x: 300, y: 400, width: 400, height: 120 } : undefined
    );
    expect(point2).toEqual({ x: 500, y: 520, isOrphan: false });
  });

  it("falls back to canvasPoint with isOrphan: true when element is deleted", () => {
    const target = {
      elementId: "deleted_btn",
      relativeOffset: { u: 0.5, v: 0.5 },
      canvasPoint: { x: 123, y: 456 }
    };
    const point = resolveCommentCanvasPoint(target, () => undefined);
    expect(point).toEqual({ x: 123, y: 456, isOrphan: true });
  });

  it("converts canvas point to screen viewport coordinates", () => {
    const canvasPt = { x: 100, y: 200 };
    const viewport = { panX: 50, panY: -20, zoom: 2 };
    expect(canvasToViewportPoint(canvasPt, viewport)).toEqual({ x: 250, y: 380 });
  });
});
