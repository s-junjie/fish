import { describe, it, expect } from "vitest";
import { contentBounds } from "../src/core/geometry/element-bounds";
import type { DesignElement } from "../src/core/dsl/types";

/**
 * What "zoom to fit" frames. The three ways this is easy to get wrong — a child
 * measured in its own local space, a hidden layer left in the box, a line
 * measured as `(x, y, width, height)` — are all silent: the viewport just ends
 * up framing the wrong rectangle.
 */

const rect = (id: string, x: number, y: number, width: number, height: number, extra = {}): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width, height, ...extra }) as DesignElement;

const frame = (id: string, x: number, y: number, width: number, height: number, children: DesignElement[]): DesignElement =>
  ({ id, type: "frame", name: id, x, y, width, height, children }) as DesignElement;

describe("contentBounds", () => {
  it("unions two top-level layers", () => {
    expect(contentBounds([rect("a", 0, 0, 100, 50), rect("b", 200, 100, 100, 50)])).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 150
    });
  });

  it("adds the ancestor origin chain to a nested child", () => {
    // The child's x/y are relative to the frame, so the box has to start at the
    // frame, not at the child's own origin.
    const bounds = contentBounds([frame("f", 500, 400, 200, 200, [rect("c", 10, 20, 30, 40)])]);
    expect(bounds).toEqual({ x: 500, y: 400, width: 200, height: 200 });
  });

  it("counts a child that paints outside its unclipped frame", () => {
    const bounds = contentBounds([frame("f", 0, 0, 100, 100, [rect("c", 300, 300, 50, 50)])]);
    expect(bounds).toEqual({ x: 0, y: 0, width: 350, height: 350 });
  });

  it("leaves out a hidden layer, and a hidden child with it", () => {
    const bounds = contentBounds([
      rect("a", 0, 0, 100, 100),
      rect("hidden", 1000, 1000, 500, 500, { visible: false }),
      frame("f", -800, -800, 100, 100, [rect("c", 0, 0, 100, 100), rect("hc", 900, 0, 900, 100, { visible: false })])
    ]);
    expect(bounds).toEqual({ x: -800, y: -800, width: 900, height: 900 });
  });

  it("measures a line by its endpoints, not by its box", () => {
    // (x, y) is the first endpoint and the second is (x + dx, y + dy); the stored
    // width/height are the magnitudes, so a line drawn up-and-right paints into
    // negative y.
    const line = { id: "l", type: "line", name: "l", x: 100, y: 100, dx: 50, dy: -80, width: 50, height: 80 } as DesignElement;
    expect(contentBounds([line])).toEqual({ x: 100, y: 20, width: 50, height: 80 });
  });

  it("grows the box of a rotated layer to what it paints", () => {
    const bounds = contentBounds([rect("r", 0, 0, 100, 100, { rotation: 45 })]);
    expect(bounds!.width).toBeCloseTo(141.42, 1);
    expect(bounds!.x).toBeCloseTo(-20.71, 1);
  });

  it("has no box when every layer is hidden", () => {
    expect(contentBounds([rect("a", 0, 0, 10, 10, { visible: false })])).toBeNull();
    expect(contentBounds([])).toBeNull();
  });
});
