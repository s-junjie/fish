import { describe, expect, it } from "vitest";
import type { DesignElement, Paint } from "../src/core/dsl/types";
import { stopAxisOf } from "../src/ui/canvas/gradient-stop-axis";

const BOX = { width: 200, height: 100 } as DesignElement;
const ORIGIN = { x: 0, y: 0 };

const at = (paint: Paint, el: DesignElement = BOX) => {
  const axis = stopAxisOf(el, paint, ORIGIN);
  if (!axis) throw new Error("no axis");
  return axis;
};

describe("where a gradient's stops live", () => {
  it("runs a linear gradient along the line it paints", () => {
    const axis = at({ type: "linear-gradient", from: "#000", to: "#fff", angle: 90 });
    const start = axis.pointAt(0);
    const end = axis.pointAt(1);
    expect(start.x).toBeCloseTo(0, 6);
    expect(start.y).toBeCloseTo(50, 6);
    expect(end.x).toBeCloseTo(200, 6);
    expect(end.y).toBeCloseTo(50, 6);
    expect(axis.paramAt(axis.pointAt(0.37))).toBeCloseTo(0.37, 6);
  });

  it("keeps an explicit off-axis linear gradient on its own endpoints", () => {
    const axis = at({
      type: "linear-gradient",
      from: "#000",
      to: "#fff",
      angle: 45,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 }
    });
    expect(axis.pointAt(0.5)).toEqual({ x: 100, y: 50 });
    expect(axis.paramAt({ x: 50, y: 25 })).toBeCloseTo(0.25, 6);
  });

  it("runs a radial along its first semi-axis, stretched by the box", () => {
    const axis = at({
      type: "radial-gradient",
      from: "#000",
      to: "#fff",
      center: { x: 0.5, y: 0.5 },
      rx: 0.5,
      ry: 0.5,
      angle: 0
    });
    expect(axis.pointAt(0)).toEqual({ x: 100, y: 50 });
    expect(axis.pointAt(1)).toEqual({ x: 200, y: 50 });
    expect(axis.paramAt({ x: 150, y: 50 })).toBeCloseTo(0.5, 6);
  });

  it("runs a diamond along the vertex its angle points at", () => {
    const axis = at({
      type: "diamond-gradient",
      from: "#000",
      to: "#fff",
      center: { x: 0.5, y: 0.5 },
      rx: 0.5,
      angle: 90
    });
    expect(axis.pointAt(1)).toEqual({ x: 100, y: 150 });
    expect(axis.paramAt({ x: 100, y: 100 })).toBeCloseTo(0.5, 6);
  });

  it("runs an angular gradient around its sweep circle, and wraps", () => {
    const axis = at({
      type: "angular-gradient",
      from: "#000",
      to: "#fff",
      center: { x: 0.5, y: 0.5 },
      angle: 0
    });
    expect(axis.pointAt(0).x).toBeCloseTo(100, 6);
    expect(axis.pointAt(0).y).toBeCloseTo(0, 6);
    expect(axis.pointAt(0.25).x).toBeCloseTo(150, 6);
    expect(axis.paramAt({ x: 150, y: 50 })).toBeCloseTo(0.25, 6);
    // Just before the start of the turn is t ≈ 1, not a negative number.
    expect(axis.paramAt({ x: 94, y: 10 })).toBeGreaterThan(0.95);
  });

  it("says nothing for a paint that has no stops", () => {
    expect(stopAxisOf(BOX, { type: "solid", color: "#fff" }, ORIGIN)).toBeNull();
  });
});
