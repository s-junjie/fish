import { describe, expect, it } from "vitest";
import type { Paint } from "../src/core/dsl/types";
import type { GradientPaint } from "../src/ui/color-panel/kind-memory";
import { flipGradient, rotateGradient } from "../src/ui/color-panel/stop-edit";

const linear = (): GradientPaint => ({
  type: "linear-gradient",
  from: "#000000",
  to: "#FFFFFF",
  angle: 90,
  stops: [
    { color: "#000000", offset: 0 },
    { color: "#FF0000", offset: 0.2, tokenId: "tok_red" },
    { color: "#FFFFFF", offset: 1 }
  ]
} as GradientPaint);

describe("flipping a gradient", () => {
  it("mirrors every stop and keeps its token on its colour", () => {
    const flipped = flipGradient(linear());
    expect(flipped.stops).toEqual([
      { color: "#FFFFFF", offset: 0 },
      { color: "#FF0000", offset: 0.8, tokenId: "tok_red" },
      { color: "#000000", offset: 1 }
    ]);
  });

  it("keeps the endpoint pair in step with the ramp", () => {
    const flipped = flipGradient(linear());
    expect(flipped.from).toBe("#FFFFFF");
    expect(flipped.to).toBe("#000000");
    expect(flipped.fromOffset).toBe(0);
    expect(flipped.toOffset).toBe(1);
  });

  it("is its own inverse, and leaves the axis where it was", () => {
    const source = linear();
    const there = flipGradient(flipGradient(source));
    expect(there.stops).toEqual(source.stops);
    expect(there.angle).toBe(90);
  });
});

describe("rotating a gradient", () => {
  it("turns the angle a quarter at a time", () => {
    expect(rotateGradient(linear()).angle).toBe(180);
    expect(rotateGradient(rotateGradient(rotateGradient(rotateGradient(linear())))).angle).toBe(90);
  });

  it("turns the explicit endpoints about the axis midpoint, not about the box", () => {
    const paint: GradientPaint = {
      type: "linear-gradient",
      from: "#000000",
      to: "#FFFFFF",
      angle: 90,
      start: { x: 0, y: 0.5 },
      end: { x: 1, y: 0.5 }
    };
    const turned = rotateGradient(paint as GradientPaint) as Extract<GradientPaint, { type: "linear-gradient" }>;
    expect(turned.start).toEqual({ x: 0.5, y: 0 });
    expect(turned.end).toEqual({ x: 0.5, y: 1 });
    expect(turned.angle).toBe(180);
  });

  it("serves every dialect, because every dialect carries an angle", () => {
    const radial: Paint = {
      type: "radial-gradient",
      from: "#000000",
      to: "#FFFFFF",
      angle: 30,
      center: { x: 0.5, y: 0.5 }
    };
    expect(rotateGradient(radial as GradientPaint).angle).toBe(120);
  });
});
