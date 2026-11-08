import { describe, expect, it } from "vitest";
import { matrixToSvg, transformPoint } from "../src/core/geometry/matrix";
import { transformBoundsToAABB } from "../src/core/geometry/bounds";
import {
  elementPivot,
  elementTransform,
  elementTransformMatrix,
  toElementLocal
} from "../src/core/geometry/transforms";
import type { DesignElement } from "../src/core/dsl/types";

/**
 * A shear is affine, so it belongs to the same machinery rotation does — and it
 * has to reach every reader through it. The half of this file that matters is
 * the inverse: a canvas gesture lands in world space and writes back in local
 * space, and a hand-derived inverse that knows only about `rotation` is right
 * until the box is sheared.
 */

const box = (extra: object = {}): DesignElement =>
  ({ id: "s", type: "rect", x: 0, y: 0, width: 100, height: 100, ...extra }) as DesignElement;

const matrixOf = (el: DesignElement) => {
  const pivot = elementPivot(el);
  return elementTransformMatrix(el, pivot.x, pivot.y);
};

describe("a skewed box", () => {
  it("shears about its centre: the centre holds, the corners do not", () => {
    const el = box({ skewX: 45 });
    const m = matrixOf(el);

    const centre = transformPoint(m, { x: 50, y: 50 });
    expect(centre.x).toBeCloseTo(50);
    expect(centre.y).toBeCloseTo(50);

    // tan(45) = 1, so each corner moves by its own offset from the centre row.
    const corners = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 }
    ].map((p) => transformPoint(m, p));
    expect(corners[0]).toMatchObject({ x: -50, y: 0 });
    expect(corners[2]).toMatchObject({ x: 150, y: 100 });
  });

  it("keeps its painted box a parallelogram, twice as wide at 45°", () => {
    const el = box({ skewX: 45 });
    const aabb = transformBoundsToAABB({ x: 0, y: 0, width: 100, height: 100 }, matrixOf(el))!;
    // `skewX` moves x with y and leaves every y alone, so the height is the
    // box's own and the width gains `height·tan(45)` on each side.
    expect(aabb).toMatchObject({ x: -50, y: 0, width: 200, height: 100 });
  });

  it("has ONE spelling: the matrix, which the string form defers to", () => {
    const el = box({ rotation: 30, skewX: 15, skewY: -5 });
    // `skewX(a) skewY(b)` composes to a matrix that is not the CSS `skew(a, b)`
    // the fields mean, so the list form is not offered for a sheared box.
    expect(elementTransform(el, 50, 50)).toBe(matrixToSvg(matrixOf(el)));
    expect(elementTransform(el, 50, 50)!.startsWith("matrix(")).toBe(true);
  });

  it("keeps the readable string for every box without a shear", () => {
    expect(elementTransform(box({ rotation: 45 }), 50, 50)).toBe("rotate(45 50 50)");
    expect(
      elementTransform(box({ rotation: 45, flipX: true }), 50, 50)
    ).toBe("translate(50, 50) rotate(45) scale(-1, 1) translate(-50, -50)");
    expect(elementTransform(box(), 50, 50)).toBeUndefined();
  });
});

describe("the inverse of a transform", () => {
  it("turns a sheared world point back into the box's own space", () => {
    const el = box({ rotation: 20, skewX: 25, skewY: -10 });
    const m = matrixOf(el);
    for (const local of [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 37, y: 12 }
    ]) {
      const world = transformPoint(m, local);
      const back = toElementLocal(world.x, world.y, el, 50, 50);
      expect(back.x).toBeCloseTo(local.x);
      expect(back.y).toBeCloseTo(local.y);
    }
  });

  it("follows the flip as well as the turn", () => {
    // The renderer composes mirror-then-turn, so the inverse has to undo them
    // in the opposite order. Deriving it by hand turned them back in the same
    // order, which is a different point whenever both are present.
    const el = box({ rotation: 30, flipX: true });
    const world = transformPoint(matrixOf(el), { x: 10, y: 20 });
    const back = toElementLocal(world.x, world.y, el, 50, 50);
    expect(back.x).toBeCloseTo(10);
    expect(back.y).toBeCloseTo(20);
  });
});
