import { describe, it, expect } from "vitest";
import { computeMeasurement } from "../src/core/geometry/measure-guides";

describe("computeMeasurement", () => {
  it("calculates inner padding for contained/parent elements", () => {
    const parentBox = { x: 0, y: 0, width: 400, height: 300 };
    const childBox = { x: 50, y: 40, width: 100, height: 80 };

    const res = computeMeasurement(childBox, parentBox, true);
    expect(res.isParent).toBe(true);
    expect(res.lines).toHaveLength(4);

    const top = res.lines.find((l) => l.axis === "y" && l.y1 === 0);
    expect(top?.distance).toBe(40);

    const left = res.lines.find((l) => l.axis === "x" && l.x1 === 0);
    expect(left?.distance).toBe(50);

    const right = res.lines.find((l) => l.axis === "x" && l.x2 === 400);
    expect(right?.distance).toBe(250); // 400 - (50 + 100) = 250

    const bottom = res.lines.find((l) => l.axis === "y" && l.y2 === 300);
    expect(bottom?.distance).toBe(180); // 300 - (40 + 80) = 180
  });

  it("calculates horizontal and vertical distance between disjoint siblings", () => {
    const refBox = { x: 100, y: 100, width: 50, height: 50 };
    const targetBox = { x: 200, y: 100, width: 50, height: 50 };

    const res = computeMeasurement(refBox, targetBox);
    expect(res.isParent).toBe(false);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].axis).toBe("x");
    expect(res.lines[0].distance).toBe(50); // 200 - 150 = 50
  });

  it("calculates diagonal separation with both x and y distances", () => {
    const refBox = { x: 10, y: 10, width: 20, height: 20 };
    const targetBox = { x: 100, y: 80, width: 30, height: 30 };

    const res = computeMeasurement(refBox, targetBox);
    expect(res.lines).toHaveLength(2);
    const xLine = res.lines.find((l) => l.axis === "x");
    const yLine = res.lines.find((l) => l.axis === "y");
    expect(xLine?.distance).toBe(70); // 100 - 30 = 70
    expect(yLine?.distance).toBe(50); // 80 - 30 = 50
  });
});
