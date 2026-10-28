import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { detectSmartSelection } from "../src/core/geometry/smart-selection";
import { RectElement } from "../src/core/dsl/types";

describe("detectSmartSelection", () => {
  it("detects horizontally distributed row elements", () => {
    const el1: RectElement = { id: "1", type: "rect", x: 0, y: 50, width: 100, height: 100 };
    const el2: RectElement = { id: "2", type: "rect", x: 120, y: 50, width: 100, height: 100 };
    const el3: RectElement = { id: "3", type: "rect", x: 240, y: 50, width: 100, height: 100 };

    const res = detectSmartSelection([el1, el2, el3]);
    expect(res).not.toBeNull();
    expect(res?.axis).toBe("x");
    expect(res?.gap).toBe(20);
    expect(res?.handles).toHaveLength(2);
    expect(res?.handles[0].x).toBe(110); // 100 + 10
    // The band is the empty gutter itself, spanning both elements' full height.
    expect(res?.handles[0].box).toEqual({ x: 100, y: 50, width: 20, height: 100 });
  });

  it("gap bands span the union of the two adjacent elements on the cross axis", () => {
    const el1: RectElement = { id: "1", type: "rect", x: 0, y: 50, width: 100, height: 60 };
    const el2: RectElement = { id: "2", type: "rect", x: 140, y: 20, width: 100, height: 160 };

    const res = detectSmartSelection([el1, el2]);
    expect(res?.handles[0].box).toEqual({ x: 100, y: 20, width: 40, height: 160 });
  });

  it("detects vertically distributed column elements", () => {
    const el1: RectElement = { id: "1", type: "rect", x: 50, y: 0, width: 100, height: 100 };
    const el2: RectElement = { id: "2", type: "rect", x: 50, y: 150, width: 100, height: 100 };
    const el3: RectElement = { id: "3", type: "rect", x: 50, y: 300, width: 100, height: 100 };

    const res = detectSmartSelection([el1, el2, el3]);
    expect(res).not.toBeNull();
    expect(res?.axis).toBe("y");
    expect(res?.gap).toBe(50);
    expect(res?.handles).toHaveLength(2);
    expect(res?.handles[0].box).toEqual({ x: 50, y: 100, width: 100, height: 50 });
  });

  it("detects single Auto-Layout Frame and its gap handles and dots", () => {
    const child1: RectElement = { id: "c1", type: "rect", x: 10, y: 10, width: 60, height: 40 };
    const child2: RectElement = { id: "c2", type: "rect", x: 90, y: 10, width: 60, height: 40 };
    const frame = {
      id: "f1",
      type: "frame" as const,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ...flattenLayout({ mode: "flex" as const, direction: "row" as const, gap: 20 }),
      children: [child1, child2]
    };

    const res = detectSmartSelection([frame as any]);
    expect(res).not.toBeNull();
    expect(res?.axis).toBe("x");
    expect(res?.gap).toBe(20);
    expect(res?.parentFrame?.id).toBe("f1");
    expect(res?.handles).toHaveLength(1);
    expect(res?.dots).toHaveLength(2);
    expect(res?.handles[0].box).toEqual({ x: 70, y: 10, width: 20, height: 40 });
  });

  it("keeps a wrapped frame's pills inside their own line", () => {
    // Three children over two lines. Sorting the whole list by x puts `c2` (end
    // of line 1) next to `c3` (start of line 2), and the pill between them lands
    // in the middle of the frame, on a seam that does not exist.
    const frame = {
      id: "w1",
      type: "frame" as const,
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      ...flattenLayout({ mode: "flex" as const, direction: "row" as const, wrap: "wrap" as const, gap: 20, rowGap: 10 }),
      children: [
        { id: "c1", type: "rect" as const, x: 0, y: 0, width: 80, height: 40 },
        { id: "c2", type: "rect" as const, x: 100, y: 0, width: 80, height: 40 },
        { id: "c3", type: "rect" as const, x: 0, y: 50, width: 80, height: 40 }
      ]
    };

    const res = detectSmartSelection([frame as any]);
    expect(res?.handles).toHaveLength(1);
    expect(res?.handles[0].box).toEqual({ x: 80, y: 0, width: 20, height: 40 });
    expect(res?.dots).toHaveLength(3);
  });

  it("returns null for non-aligned random elements", () => {    const el1: RectElement = { id: "1", type: "rect", x: 0, y: 0, width: 100, height: 100 };
    const el2: RectElement = { id: "2", type: "rect", x: 300, y: 400, width: 100, height: 100 };

    const res = detectSmartSelection([el1, el2]);
    expect(res).toBeNull();
  });

  // The gap pill scrubs by `delta × index`, which is "the spacing" only when every
  // gap already agrees — so the pills are withheld until the row is even. These
  // are the facts that withholding rests on.
  describe("gapsEven", () => {
    const row = (...xs: number[]) =>
      xs.map((x, i) => ({ id: `${i}`, type: "rect", x, y: 0, width: 100, height: 100 } as RectElement));

    it("is true for a row whose gaps agree", () => {
      expect(detectSmartSelection(row(0, 120, 240))?.gapsEven).toBe(true);
      expect(detectSmartSelection(row(0, 130, 260))?.gapsEven).toBe(true);
      expect(detectSmartSelection(row(0, 120, 240))?.unevenAxes).toEqual([]);
    });

    it("is false for a row whose gaps do not", () => {
      expect(detectSmartSelection(row(0, 120, 300))?.gapsEven).toBe(false);
      expect(detectSmartSelection(row(0, 120, 300))?.unevenAxes).toEqual(["x"]);
    });

    it("absorbs a one-pixel difference — a gap is measured, not authored", () => {
      expect(detectSmartSelection(row(0, 120, 241))?.gapsEven).toBe(true);
    });

    it("is true for two elements: one gap has nothing to distribute", () => {
      expect(detectSmartSelection(row(0, 300))?.gapsEven).toBe(true);
    });

    it("is always true for an auto-layout frame, whose gap is one number", () => {
      const frame = {
        id: "f1",
        type: "frame" as const,
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        ...flattenLayout({ mode: "flex" as const, direction: "row" as const, gap: 20 }),
        children: [
          { id: "c1", type: "rect" as const, x: 10, y: 10, width: 60, height: 40 },
          { id: "c2", type: "rect" as const, x: 90, y: 10, width: 60, height: 40 }
        ]
      };
      expect(detectSmartSelection([frame as any])?.gapsEven).toBe(true);
      expect(detectSmartSelection([frame as any])?.unevenAxes).toEqual([]);
    });

    it("names the ragged direction of a grid — columns and rows are separate questions", () => {
      const rect = (id: string, x: number, y: number): RectElement =>
        ({ id, type: "rect", x, y, width: 50, height: 50 } as RectElement);
      // A 2x2 whose rows each have a 20px gutter: the col-gap HANDLE reports the
      // average, which is a gap that exists on neither row.
      const ragged = detectSmartSelection([rect("00", 0, 0), rect("01", 70, 0), rect("10", 0, 80), rect("11", 90, 80)]);
      expect(ragged?.axis).toBe("grid");
      expect(ragged?.handles.find((h) => h.id === "grid_gap_col_0")?.gap).toBe(30);
      expect(ragged?.unevenAxes).toEqual(["x"]);
      expect(ragged?.gapsEven).toBe(false);

      // Aligned columns, but the second row's second cell was dropped 20px.
      const dropped = detectSmartSelection([rect("00", 0, 0), rect("01", 70, 0), rect("10", 0, 80), rect("11", 70, 100)]);
      expect(dropped?.unevenAxes).toEqual(["y"]);

      const aligned = detectSmartSelection([rect("00", 0, 0), rect("01", 70, 0), rect("10", 0, 80), rect("11", 70, 80)]);
      expect(aligned?.gapsEven).toBe(true);
      expect(aligned?.unevenAxes).toEqual([]);
    });
  });

  it("reports the union of the boxes, for the tidy-up button to hang off", () => {
    const el1: RectElement = { id: "1", type: "rect", x: 10, y: 20, width: 100, height: 100 };
    const el2: RectElement = { id: "2", type: "rect", x: 200, y: 60, width: 100, height: 100 };
    const el3: RectElement = { id: "3", type: "rect", x: 400, y: 10, width: 100, height: 100 };

    expect(detectSmartSelection([el1, el2, el3])?.bounds)
      .toEqual({ x: 10, y: 10, width: 490, height: 150 });
  });

  it("detects 2D grid elements with row and col gap handles and reorder dots", () => {
    // 2x2 grid of 50x50 squares, colGap = 20, rowGap = 30
    const r0c0: RectElement = { id: "00", type: "rect", x: 0, y: 0, width: 50, height: 50 };
    const r0c1: RectElement = { id: "01", type: "rect", x: 70, y: 0, width: 50, height: 50 };
    const r1c0: RectElement = { id: "10", type: "rect", x: 0, y: 80, width: 50, height: 50 };
    const r1c1: RectElement = { id: "11", type: "rect", x: 70, y: 80, width: 50, height: 50 };

    const res = detectSmartSelection([r0c0, r0c1, r1c0, r1c1]);
    expect(res).not.toBeNull();
    expect(res?.axis).toBe("grid");
    expect(res?.grid).toBeDefined();
    expect(res?.grid?.rows).toBe(2);
    expect(res?.grid?.cols).toBe(2);
    expect(res?.colGap).toBe(20);
    expect(res?.rowGap).toBe(30);
    expect(res?.dots).toHaveLength(4);
    // 1 column gap handle + 1 row gap handle
    expect(res?.handles).toHaveLength(2);
    const colBand = res?.handles.find((h) => h.id === "grid_gap_col_0");
    const rowBand = res?.handles.find((h) => h.id === "grid_gap_row_0");
    // A column gutter runs the full grid height; a row gutter the full width.
    expect(colBand?.box).toEqual({ x: 50, y: 0, width: 20, height: 130 });
    expect(rowBand?.box).toEqual({ x: 0, y: 50, width: 120, height: 30 });
  });

  // The controls are drawn on the canvas next to the frame, so a stack that does
  // not sit at the origin used to report its whole row of dots and pills at
  // (0,0)-relative positions — the frame's own corner instead of its children.
  describe("canvas-space reporting", () => {
    const stackAt = (x: number, y: number) => ({
      id: "f1",
      type: "frame" as const,
      x,
      y,
      width: 200,
      height: 100,
      ...flattenLayout({ mode: "flex" as const, direction: "row" as const, gap: 20 }),
      children: [
        { id: "c1", type: "rect" as const, x: 10, y: 10, width: 60, height: 40 },
        { id: "c2", type: "rect" as const, x: 90, y: 10, width: 60, height: 40 }
      ]
    });

    it("offsets a stack's dots and gap pills by the frame origin", () => {
      const frame = stackAt(300, 220);
      const res = detectSmartSelection([frame as any], { originOf: () => ({ x: 300, y: 220 }) });
      expect(res?.dots.map((d) => [d.x, d.y])).toEqual([
        [340, 250],
        [420, 250]
      ]);
      expect(res?.handles[0].x).toBe(380);
      expect(res?.handles[0].y).toBe(250);
      expect(res?.handles[0].box).toEqual({ x: 370, y: 230, width: 20, height: 40 });
    });

    it("keeps the child boxes untouched — only the reported geometry moves", () => {
      const frame = stackAt(300, 220);
      const res = detectSmartSelection([frame as any], { originOf: () => ({ x: 300, y: 220 }) });
      // The gesture rewrites `x` / `y` on the elements themselves, so the info
      // must not leak an offset back into the tree it reports.
      expect(res?.sortedElements.map((el) => [el.x, el.y])).toEqual([
        [10, 10],
        [90, 10]
      ]);
    });

    it("resolves each element's own origin, so a mixed-parent selection lines up", () => {
      const inside: RectElement = { id: "in", type: "rect", x: 10, y: 10, width: 50, height: 50 };
      const outside: RectElement = { id: "out", type: "rect", x: 200, y: 10, width: 50, height: 50 };
      // Both land on the same canvas line, but through different parents: the
      // canvas gap is 300+10 .. 200+50, not 200 .. 90.
      const origins: Record<string, { x: number; y: number }> = {
        in: { x: 300, y: 40 },
        out: { x: 0, y: 40 }
      };
      const res = detectSmartSelection([inside, outside], { originOf: (el) => origins[el.id] });
      expect(res?.axis).toBe("x");
      // Sorted along the canvas: `out` (200..250) precedes `in` (310..360).
      expect(res?.dots.map((d) => [d.x, d.y])).toEqual([
        [225, 75],
        [335, 75]
      ]);
      expect(res?.handles[0].gap).toBe(60);
      expect(res?.handles[0].box).toEqual({ x: 250, y: 50, width: 60, height: 50 });
    });
  });
});

