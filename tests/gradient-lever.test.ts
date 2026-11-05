import { describe, expect, it } from "vitest";
import { mirrorEndpoint, snapEndpointAngle, snapGradientAngle } from "../src/core/geometry/gradient-lever";

describe("the lever's Shift constraint", () => {
  it("turns an angle to the nearest 15° step, keeping it inside one turn", () => {
    expect(snapGradientAngle(7)).toBe(0);
    expect(snapGradientAngle(8)).toBe(15);
    expect(snapGradientAngle(359)).toBe(0);
    expect(snapGradientAngle(-5)).toBe(0);
    expect(snapGradientAngle(97)).toBe(90);
  });

  it("lands an endpoint on the snapped ray without changing the axis' length", () => {
    const box = { width: 200, height: 100 };
    const start = { x: 0, y: 0.5 };
    const end = { x: 1, y: 1 };
    const snapped = snapEndpointAngle(start, end, box);
    const before = Math.hypot((end.x - start.x) * box.width, (end.y - start.y) * box.height);
    const after = Math.hypot((snapped.x - start.x) * box.width, (snapped.y - start.y) * box.height);
    // The endpoint is stored at 4 decimals of a box fraction, so the length is
    // preserved to a rounding step (a fraction of a px), not bit-exactly.
    expect(Math.abs(after - before)).toBeLessThan(0.05);
    // 104.04° measured in px snaps to 105: the snapped point sits a hair past
    // the box's right edge and further down than the pointer was.
    const angle = ((Math.atan2((snapped.x - start.x) * box.width, -(snapped.y - start.y) * box.height) * 180) / Math.PI + 360) % 360;
    expect(angle).toBeCloseTo(105, 2);
  });

  it("leaves a degenerate axis alone rather than dividing by zero", () => {
    const box = { width: 200, height: 100 };
    expect(snapEndpointAngle({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, box)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("the lever's Alt mirror", () => {
  it("holds the far end symmetric about the midpoint the drag began at", () => {
    expect(mirrorEndpoint({ x: 0.5, y: 0.5 }, { x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
    expect(mirrorEndpoint({ x: 0.3, y: 0.4 }, { x: 0.5, y: 0.2 })).toEqual({ x: 0.1, y: 0.6 });
  });
});
