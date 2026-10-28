import { describe, it, expect } from "vitest";
import { buildWrapFrame } from "../src/core/interactions/wrap";
import { DesignElement, RectElement } from "../src/core/dsl/types";
import { layoutOf } from "../src/core/dsl/layout-flat";

const rect = (id: string, x: number, y: number, w = 120, h = 100): RectElement =>
  ({ id, type: "rect", x, y, width: w, height: h } as RectElement);

const spread = (): DesignElement[] => [rect("c0", 100, 100), rect("c1", 230, 100), rect("c2", 360, 100)];

describe("buildWrapFrame", () => {
  it("has nothing to build from an empty selection", () => {
    expect(buildWrapFrame([], { mode: "flex" })).toBeNull();
  });

  it("sizes the wrapper from its content, not from the selection box", () => {
    const frame = buildWrapFrame(spread(), { mode: "flex", direction: "column", padding: 24, gap: 16 });
    expect(frame!.sizing).toEqual({ width: "fit-content", height: "fit-content" });
    expect(frame!.clipContent).toBe(false);
    // Anchored at the selection's top-left, then sized by the layout pass.
    expect([frame!.x, frame!.y]).toEqual([100, 100]);
  });

  it("orders children by reading order, whatever order they were given in", () => {
    const frame = buildWrapFrame([spread()[2], spread()[0], spread()[1]], { mode: "flex" });
    expect(frame!.children.map((c) => c.id)).toEqual(["c0", "c1", "c2"]);
  });

  it("carries only the fields the chosen mode reads", () => {
    const stack = buildWrapFrame(spread(), { mode: "flex" })!;
    expect(layoutOf(stack)?.mode).toBe("flex");
    expect(layoutOf(stack)?.columns).toBeUndefined();
    const grid = buildWrapFrame(spread(), { mode: "grid", columns: 3 })!;
    expect(layoutOf(grid)?.mode).toBe("grid");
    expect(layoutOf(grid)?.columns).toBe(3);
    expect(layoutOf(grid)?.direction).toBeUndefined();
  });
});
