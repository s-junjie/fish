import { describe, expect, it } from "vitest";
import { elementPivot } from "../src/core/geometry/transforms";
import { placeChildAt } from "../src/core/geometry/element-bounds";
import type { DesignElement } from "../src/core/dsl/types";

const line = (extra: Partial<DesignElement> = {}): DesignElement =>
  ({ id: "l", type: "line", name: "Ruler", x: 200, y: 300, dx: 240, dy: 0, width: 240, height: 0, ...extra } as DesignElement);

/**
 * A line turns about its ORIGIN; everything else about its box centre.
 *
 * The origin is the only pivot under which dragging one end of a rotated line
 * leaves the other exactly where it was: the segment is `(x, y) → (x + dx, y +
 * dy)` turned about `(x, y)`, so writing `dx`/`dy` cannot move `x`/`y`.
 */
describe("elementPivot", () => {
  it("puts a line's pivot on its first endpoint, not its midpoint", () => {
    expect(elementPivot(line())).toEqual({ x: 200, y: 300 });
    expect(elementPivot(line({ rotation: 37 } as never))).toEqual({ x: 200, y: 300 });
  });

  it("is the midpoint of the segment, not of the stored box, when dx is negative", () => {
    // `width` is `|dx|`, so the box centre would be `x + |dx| / 2` while the
    // segment's true midpoint is `x - |dx| / 2` — a third of the line's length
    // away. `placeChildAt` preserves the sign of `dx`, so this is reachable.
    const back = line({ x: 400, dx: -240 });
    expect(elementPivot(back)).toEqual({ x: 400, y: 300 });
    expect(elementPivot(back)).not.toEqual({ x: 400 + 240 / 2, y: 300 });
  });

  it("keeps the box centre for every other type", () => {
    const rect = { id: "r", type: "rect", x: 0, y: 0, width: 100, height: 60 } as DesignElement;
    expect(elementPivot(rect)).toEqual({ x: 50, y: 30 });
    const arrow = line({ type: "arrow" } as never);
    expect(elementPivot(arrow)).toEqual({ x: 200, y: 300 });
  });

  it("takes the box the element is painted at, so a resized instance still pivots on its own origin", () => {
    expect(elementPivot(line(), 999, 999)).toEqual({ x: 200, y: 300 });
    const rect = { id: "r", type: "rect", x: 0, y: 0, width: 100, height: 60 } as DesignElement;
    expect(elementPivot(rect, 200, 120)).toEqual({ x: 100, y: 60 });
  });
});

/**
 * The pivot is a property of ROTATION only. An unrotated line paints the same
 * span either way, so the autolayout that lays lines out inside their slots does
 * not move — which is the claim that makes this change cheap, and it is checked
 * here rather than assumed.
 */
describe("placeChildAt with the origin pivot", () => {
  it("still centres an unrotated line in the slot it is given", () => {
    const placed = placeChildAt(line(), 500, 400, 240, 120) as any;
    // Painted span is [x, x + dx] regardless of pivot; the slot centre is 620.
    expect(placed.x).toBe(500);
    expect(placed.x + placed.width / 2).toBe(620);
    expect(placed.dx).toBe(240);
    expect(placed.dy).toBe(120);
  });

  it("preserves the direction of a line whose dx is negative", () => {
    const placed = placeChildAt(line({ dx: -240 } as never), 500, 400, 240, 0) as any;
    expect(placed.dx).toBe(-240);
    expect(elementPivot(placed)).toEqual({ x: placed.x, y: placed.y });
  });
});