import { describe, it, expect } from "vitest";
import { convertShapeToPathElement } from "../src/core/geometry/path-convert";
import { parsePathData, serializePathData, removeAnchor, normalizePathOrigin } from "../src/core/geometry/path-data";
import { RectElement, EllipseElement, LineElement } from "../src/core/dsl/types";

describe("Shape to Path Conversion", () => {
  it("converts rect to editable path", () => {
    const rect: RectElement = {
      id: "r1",
      type: "rect",
      x: 50,
      y: 60,
      width: 100,
      height: 80,
      fills: [{ type: "solid", color: "#FF0000" }]
    };
    const pathEl = convertShapeToPathElement(rect);
    expect(pathEl).not.toBeNull();
    expect(pathEl?.type).toBe("path");
    expect(pathEl?.x).toBe(50);
    expect(pathEl?.y).toBe(60);
    expect(pathEl?.d).toContain("M 0 0");
    expect(pathEl?.d).toContain("L 100 0");

    const parsed = parsePathData(pathEl!.d);
    expect(parsed).not.toBeNull();
    expect(parsed?.anchors.length).toBe(4);
    expect(parsed?.closed).toBe(true);
  });

  it("converts ellipse to an editable closed path", () => {
    const ellipse: EllipseElement = {
      id: "e1",
      type: "ellipse",
      x: 10,
      y: 20,
      width: 100,
      height: 100
    };
    const pathEl = convertShapeToPathElement(ellipse);
    expect(pathEl).not.toBeNull();
    expect(pathEl?.type).toBe("path");
    // Arcs are emitted as `A` and expanded into cubics by parsePathData below.
    expect(pathEl?.d).toContain("A");

    const parsed = parsePathData(pathEl!.d);
    expect(parsed).not.toBeNull();
    expect(parsed?.anchors.length).toBe(4);
    expect(parsed?.segments.length).toBe(4);
    expect(parsed?.segments[0].kind).toBe("cubic");
  });

  it("converts line to 2-point path", () => {
    const line: LineElement = {
      id: "l1",
      type: "line",
      x: 100,
      y: 100,
      dx: 150,
      dy: 100,
      width: 150,
      height: 100,
      strokes: [{ color: "#FFFFFF", width: 2 }]
    };
    const pathEl = convertShapeToPathElement(line);
    expect(pathEl).not.toBeNull();
    expect(pathEl?.d).toBe("M 0 0 L 150 100");
  });

  it("converts reverse line to 2-point path with non-negative local coordinates", () => {
    const reverseLine: LineElement = {
      id: "l2",
      type: "line",
      x: 250,
      y: 200,
      dx: -150,
      dy: -100,
      width: 150,
      height: 100,
      strokes: [{ color: "#FFFFFF", width: 2 }]
    };
    const pathEl = convertShapeToPathElement(reverseLine);
    expect(pathEl).not.toBeNull();
    expect(pathEl?.x).toBe(100);
    expect(pathEl?.y).toBe(100);
    expect(pathEl?.width).toBe(150);
    expect(pathEl?.height).toBe(100);
    expect(pathEl?.d).toBe("M 150 100 L 0 0");
  });
});

describe("Path Data Manipulation", () => {
  it("removes an anchor and stitches segments", () => {
    const d = "M 0 0 L 100 0 L 100 100 L 0 100 Z";
    const path = parsePathData(d);
    expect(path?.anchors.length).toBe(4);

    const updated = removeAnchor(path!, 1);
    expect(updated.anchors.length).toBe(3);
    const serialized = serializePathData(updated);
    expect(serialized).toContain("M 0 0");
    expect(serialized).toContain("L 100 100");
  });

  it("normalizes path origin to local coordinates", () => {
    const raw = parsePathData("M 50 80 L 150 80 L 150 180 Z");
    const { normalized, offsetX, offsetY, width, height } = normalizePathOrigin(raw!);
    expect(offsetX).toBe(50);
    expect(offsetY).toBe(80);
    expect(width).toBe(100);
    expect(height).toBe(100);
    expect(normalized.anchors[0]).toEqual({ x: 0, y: 0 });
  });
});
