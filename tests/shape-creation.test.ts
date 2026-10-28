import { describe, it, expect } from "vitest";
import {
  computeShapeDraftBounds,
  getDefaultShapeBounds,
  isCreatableTool
} from "../src/core/geometry/shape-creation";

describe("shape-creation geometry", () => {
  it("recognizes creatable tools", () => {
    expect(isCreatableTool("rect")).toBe(true);
    expect(isCreatableTool("ellipse")).toBe(true);
    expect(isCreatableTool("line")).toBe(true);
    expect(isCreatableTool("arrow")).toBe(true);
    expect(isCreatableTool("frame")).toBe(true);
    expect(isCreatableTool("polygon")).toBe(true);
    expect(isCreatableTool("text")).toBe(true);
    expect(isCreatableTool("select")).toBe(false);
    expect(isCreatableTool("hand")).toBe(false);
    expect(isCreatableTool("path")).toBe(false);
  });

  describe("Box shapes (rect, ellipse, frame, polygon, text)", () => {
    const start = { x: 100, y: 100 };

    it("handles standard drag (SE quadrant)", () => {
      const bounds = computeShapeDraftBounds(
        "rect",
        start,
        { x: 250, y: 180 },
        { shiftKey: false, altKey: false }
      );
      expect(bounds).toEqual({
        kind: "box",
        tool: "rect",
        x: 100,
        y: 100,
        width: 150,
        height: 80
      });
    });

    it("handles standard drag (NW quadrant - dragging backwards)", () => {
      const bounds = computeShapeDraftBounds(
        "rect",
        start,
        { x: 40, y: 50 },
        { shiftKey: false, altKey: false }
      );
      expect(bounds).toEqual({
        kind: "box",
        tool: "rect",
        x: 40,
        y: 50,
        width: 60,
        height: 50
      });
    });

    it("handles Shift drag (1:1 aspect ratio constraint)", () => {
      const bounds = computeShapeDraftBounds(
        "ellipse",
        start,
        { x: 220, y: 160 }, // dx=120, dy=60 -> max size=120
        { shiftKey: true, altKey: false }
      );
      expect(bounds).toEqual({
        kind: "box",
        tool: "ellipse",
        x: 100,
        y: 100,
        width: 120,
        height: 120
      });

      // Dragging backwards with Shift
      const boundsNW = computeShapeDraftBounds(
        "ellipse",
        start,
        { x: 50, y: 70 }, // dx=-50, dy=-30 -> max size=50
        { shiftKey: true, altKey: false }
      );
      expect(boundsNW).toEqual({
        kind: "box",
        tool: "ellipse",
        x: 50,
        y: 50,
        width: 50,
        height: 50
      });
    });

    it("handles Alt drag (center outward expansion)", () => {
      const bounds = computeShapeDraftBounds(
        "rect",
        start,
        { x: 150, y: 130 }, // dx=50, dy=30 -> width=100, height=60, x=50, y=70
        { shiftKey: false, altKey: true }
      );
      expect(bounds).toEqual({
        kind: "box",
        tool: "rect",
        x: 50,
        y: 70,
        width: 100,
        height: 60
      });
    });

    it("handles Shift + Alt drag (center outward 1:1 square/circle)", () => {
      const bounds = computeShapeDraftBounds(
        "polygon",
        start,
        { x: 180, y: 140 }, // dx=80, dy=40 -> halfSize=80 -> size=160, x=20, y=20
        { shiftKey: true, altKey: true }
      );
      expect(bounds).toEqual({
        kind: "box",
        tool: "polygon",
        x: 20,
        y: 20,
        width: 160,
        height: 160
      });
    });
  });

  describe("Lines and Arrows", () => {
    const start = { x: 100, y: 100 };

    it("handles standard line drag", () => {
      const bounds = computeShapeDraftBounds(
        "line",
        start,
        { x: 200, y: 150 },
        { shiftKey: false, altKey: false }
      );
      expect(bounds).toEqual({
        kind: "line",
        tool: "line",
        x: 100,
        y: 100,
        x2: 200,
        y2: 150,
        width: 100,
        height: 50
      });
    });

    it("snaps to 45 degree angle when Shift is held", () => {
      // Horizontal snap: dx=100, dy=10 -> snaps to 0 deg
      const boundsH = computeShapeDraftBounds(
        "arrow",
        start,
        { x: 200, y: 110 },
        { shiftKey: true, altKey: false }
      );
      expect(boundsH.kind).toBe("line");
      if (boundsH.kind === "line") {
        expect(boundsH.x).toBe(100);
        expect(boundsH.y).toBe(100);
        expect(boundsH.y2).toBe(100);
        expect(boundsH.x2).toBe(200);
      }

      // Diagonal snap: dx=100, dy=90 -> snaps to 45 deg
      const boundsDiag = computeShapeDraftBounds(
        "line",
        start,
        { x: 200, y: 190 },
        { shiftKey: true, altKey: false }
      );
      if (boundsDiag.kind === "line") {
        expect(boundsDiag.x).toBe(100);
        expect(boundsDiag.y).toBe(100);
        expect(boundsDiag.x2 - boundsDiag.x).toBe(boundsDiag.y2 - boundsDiag.y);
      }
    });

    it("handles Alt line drag (center symmetric)", () => {
      const bounds = computeShapeDraftBounds(
        "line",
        start,
        { x: 150, y: 120 }, // dx=50, dy=20 -> x = 100 - 50 = 50, y = 100 - 20 = 80
        { shiftKey: false, altKey: true }
      );
      expect(bounds).toEqual({
        kind: "line",
        tool: "line",
        x: 50,
        y: 80,
        x2: 150,
        y2: 120,
        width: 100,
        height: 40
      });
    });
  });

  describe("Single click default shapes", () => {
    it("returns default dimensions for click fallback", () => {
      const rect = getDefaultShapeBounds("rect", { x: 50, y: 60 });
      expect(rect).toEqual({ kind: "box", tool: "rect", x: 50, y: 60, width: 200, height: 120 });

      const line = getDefaultShapeBounds("line", { x: 50, y: 60 });
      expect(line).toEqual({
        kind: "line",
        tool: "line",
        x: 50,
        y: 60,
        x2: 210,
        y2: 60,
        width: 160,
        height: 2
      });
    });
  });
});
