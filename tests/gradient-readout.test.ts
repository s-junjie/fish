import { describe, expect, it } from "vitest";
import type { Paint } from "../src/core/dsl/types";
import { gradientReadout } from "../src/ui/canvas/gradient-readout";

const linear = (angle: number): Paint => ({
  type: "linear-gradient",
  from: "#000000",
  to: "#FFFFFF",
  angle
});

describe("the drag readout", () => {
  it("names the angle a linear axis is aiming at", () => {
    expect(gradientReadout(linear(135), "start")).toBe("∠ 135°");
    expect(gradientReadout(linear(0), "end")).toBe("∠ 0°");
  });

  it("reports the centre in the percentages the panel shows", () => {
    const paint: Paint = {
      type: "radial-gradient",
      from: "#000000",
      to: "#FFFFFF",
      center: { x: 0.2, y: 0.8 },
      radius: 0.4
    };
    expect(gradientReadout(paint, "center")).toBe("cx 20% · cy 80%");
  });

  it("reports both the aim and the stretch when one grip does both", () => {
    const paint: Paint = {
      type: "radial-gradient",
      from: "#000000",
      to: "#FFFFFF",
      angle: 30,
      rx: 0.4,
      ry: 0.2
    };
    expect(gradientReadout(paint, "rimX")).toBe("∠ 30° · rx 40%");
  });

  it("falls back to the shorthand radius when an axis was never split", () => {
    const paint: Paint = {
      type: "diamond-gradient",
      from: "#000000",
      to: "#FFFFFF",
      angle: 0,
      radius: 0.26
    };
    expect(gradientReadout(paint, "rimY")).toBe("ry 26%");
  });

  it("reports the sweep's start angle, not a radius it does not have", () => {
    const paint: Paint = {
      type: "angular-gradient",
      from: "#000000",
      to: "#FFFFFF",
      angle: 90,
      center: { x: 0.5, y: 0.5 }
    };
    expect(gradientReadout(paint, "sweep")).toBe("∠ 90°");
  });

  it("says nothing rather than a placeholder for a paint with no lever", () => {
    expect(gradientReadout({ type: "solid", color: "#FFFFFF" }, "center")).toBeNull();
  });
});
