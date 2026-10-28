import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { detectSmartSelection } from "../src/core/geometry/smart-selection";
import { tidySpacing } from "../src/core/geometry/smart-spacing";
import { elementAABB } from "../src/core/geometry/element-bounds";
import { Rect } from "../src/core/geometry/bounds";
import { DesignElement, RectElement } from "../src/core/dsl/types";

const rect = (id: string, x: number, y: number, width = 100, height = 100): RectElement => ({
  id,
  type: "rect",
  x,
  y,
  width,
  height
});

/** The same box the detector measures: a canvas-space AABB of the element. */
const boxOf = (el: DesignElement): Rect => elementAABB(el);

/** Apply the deltas the way the gesture does, and report the resulting gaps. */
function tidied(els: DesignElement[]) {
  const info = detectSmartSelection(els)!;
  const deltas = tidySpacing(info, boxOf)!;
  const moved = els.map((el) => {
    const d = deltas.get(el.id);
    return d ? { ...el, x: el.x + d.dx, y: el.y + d.dy } : el;
  });
  return { moved, gaps: gapsOf(moved, info.axis as "x" | "y") };
}

function gapsOf(els: DesignElement[], axis: "x" | "y"): number[] {
  const sorted = [...els].sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y));
  const out: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    out.push(axis === "x" ? b.x - (a.x + a.width) : b.y - (a.y + a.height));
  }
  return out;
}

describe("tidySpacing", () => {
  it("equalises the gaps of a row", () => {
    const els = [rect("a", 0, 0), rect("b", 120, 0), rect("c", 300, 0)];
    const { gaps } = tidied(els);
    // 20 and 80 average to 50; the head and the trailing edge do not move.
    expect(gaps).toEqual([50, 50]);
  });

  it("pins the head and the union's far edge — tidying never resizes the row", () => {
    const els = [rect("a", 0, 0, 100, 40), rect("b", 120, 0, 60, 40), rect("c", 300, 0, 140, 40)];
    const { moved } = tidied(els);
    // Gaps of 20 and 120 average to 70.
    expect(moved.map((el) => el.x)).toEqual([0, 170, 300]);
    expect(Math.max(...moved.map((el) => el.x + el.width))).toBe(440);
  });

  it("leaves the cross axis alone", () => {
    const els = [rect("a", 0, 0), rect("b", 120, 10), rect("c", 300, 70)];
    const { moved } = tidied(els);
    expect(moved.map((el) => el.y)).toEqual([0, 10, 70]);
  });

  it("lands back on `gapsEven` — a fractional mean gap must not drift a pixel a step", () => {
    // 101 and 102 average to 101.5, which cannot be drawn on both seams exactly.
    const els = [rect("a", 0, 0), rect("b", 201, 0), rect("c", 403, 0)];
    const { moved, gaps } = tidied(els);
    expect(gaps[1] - gaps[0]).toBeLessThanOrEqual(1);
    expect(detectSmartSelection(moved)?.gapsEven).toBe(true);
  });

  it("equalises a column", () => {
    const els = [rect("a", 0, 0), rect("b", 0, 110), rect("c", 0, 400)];
    const { gaps } = tidied(els);
    // 10 and 190 average to 100.
    expect(gaps).toEqual([100, 100]);
  });

  it("aligns each column of a grid without touching the rows", () => {
    // Two rows whose second column sits 20px apart: the gutter HANDLE reports the
    // average, which is a gap that exists on neither row.
    const els = [
      rect("00", 0, 0, 50, 50),
      rect("01", 100, 0, 50, 50),
      rect("10", 0, 80, 50, 50),
      rect("11", 120, 80, 50, 50)
    ];
    const info = detectSmartSelection(els)!;
    expect(info.unevenAxes).toEqual(["x"]);

    const deltas = tidySpacing(info, boxOf, "x")!;
    expect(deltas.get("11")).toEqual({ dx: -20, dy: 0 });
    // Row 1's cell 0 is already on the column line, and y is another axis's job.
    expect(deltas.get("10")).toBeUndefined();

    const moved = els.map((el) => {
      const d = deltas.get(el.id);
      return d ? { ...el, x: el.x + d.dx, y: el.y + d.dy } : el;
    });
    // Both rows were already on one y, so the columns are all it took.
    expect(detectSmartSelection(moved)?.unevenAxes).toEqual([]);
    expect(detectSmartSelection(moved)?.gapsEven).toBe(true);
  });

  it("aligns a two-column grid, where there is no gap to spread", () => {
    // The 1D path needs three elements; a grid row of two has nothing to spread
    // and everything to align, which is why the grid aligns rather than spreads.
    const els = [
      rect("00", 0, 0, 50, 50),
      rect("01", 100, 0, 50, 50),
      rect("10", 20, 80, 50, 50),
      rect("11", 120, 80, 50, 50)
    ];
    const deltas = tidySpacing(detectSmartSelection(els)!, boxOf, "x")!;
    expect(deltas.get("10")).toEqual({ dx: -20, dy: 0 });
    expect(deltas.get("11")).toEqual({ dx: -20, dy: 0 });
  });

  it("refuses a selection with nothing to distribute", () => {
    // Two elements: one gap, and nothing to make it equal to.
    expect(tidySpacing(detectSmartSelection([rect("a", 0, 0), rect("b", 300, 0)])!, boxOf)).toBeNull();

    // An auto-layout frame's gap is one number the container owns.
    const frame = {
      id: "f1",
      type: "frame" as const,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ...flattenLayout({ mode: "flex" as const, direction: "row" as const, gap: 20 }),
      children: [rect("c1", 10, 10, 60, 40), rect("c2", 90, 10, 60, 40)]
    };
    expect(tidySpacing(detectSmartSelection([frame as any])!, boxOf)).toBeNull();
  });
});