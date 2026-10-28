import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { FrameElement, RectElement } from "../src/core/dsl/types";
import { marginBands, paddingBands, spacingBands } from "../src/core/geometry/spacing-bands";

const flat = () => ({ x: 0, y: 0 });

function flexFrame(children: RectElement[], gap = 20): FrameElement {
  return {
    id: "f1",
    type: "frame",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    ...flattenLayout({ mode: "flex", direction: "row", gap }),
    children
  } as FrameElement;
}

describe("paddingBands", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };

  it("draws the four bands between the frame's edge and its content box", () => {
    const bands = paddingBands(box, [10, 20, 30, 40], [0, 1, 2, 3]);
    expect(bands.map((b) => [b.x, b.y, b.width, b.height])).toEqual([
      [0, 0, 100, 10], // top — full width, above the content box
      [80, 10, 20, 60], // right — content height only
      [40, 70, 40, 30], // bottom
      [0, 10, 40, 60] // left
    ]);
    expect(bands.map((b) => b.label)).toEqual(["10", "20", "30", "40"]);
  });

  it("draws only the sides the held field writes", () => {
    // PadMode "2", vertical half.
    expect(paddingBands(box, [10, 20, 30, 40], [0, 2])).toHaveLength(2);
    // PadMode "4", the top cell.
    const top = paddingBands(box, [10, 20, 30, 40], [0]);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 10, label: "10" });
  });

  it("still reports a side the user has scrubbed down to zero", () => {
    // The overlay floors a 0-thickness band to a hairline; dropping it here
    // would leave the most-set value with no readout at all.
    expect(paddingBands(box, [0, 0, 0, 0], [0])).toHaveLength(1);
  });

  it("reports padding in the container's geometry accent", () => {
    expect(paddingBands(box, [10, 10, 10, 10], [0])[0].tone).toBe("coral");
  });
});

describe("marginBands", () => {
  const box = { x: 100, y: 100, width: 50, height: 50 };

  it("sits outside the child on every side it is given", () => {
    const bands = marginBands(box, [10, 20, 30, 40], [0, 1, 2, 3]);
    expect(bands.map((b) => [b.x, b.y, b.width, b.height])).toEqual([
      [100, 90, 50, 10],
      [150, 100, 20, 50],
      [100, 150, 50, 30],
      [60, 100, 40, 50]
    ]);
    expect(bands.map((b) => b.label)).toEqual(["10", "20", "30", "40"]);
  });

  it("carries the sign of a negative margin and draws the overlap it causes", () => {
    const bands = marginBands(box, [-8, 0, 0, 0], [0]);
    expect(bands[0].label).toBe("-8");
    // Pulled back over its neighbour: the band lands inside the child's own top.
    expect(bands[0]).toMatchObject({ y: 108, height: 8 });
  });

  it("wears the margin accent, which padding does not", () => {
    expect(marginBands(box, [10, 0, 0, 0], [0])[0].tone).toBe("margin");
  });
});

describe("spacingBands", () => {
  it("reports padding in canvas space, not in the frame's own space", () => {
    const frame: FrameElement = {
      id: "f1",
      type: "frame",
      x: 10,
      y: 20,
      width: 100,
      height: 100,
      ...flattenLayout({ mode: "flex", direction: "row", padding: [10, 10, 10, 10] })
    } as FrameElement;

    // Nested 400/300 down and to the right — the failure docs/LESSONS_LEARNED.md
    // §34 records, where reading `x`/`y` raw put the bands at the page origin.
    const bands = spacingBands(
      { elementId: "f1", kind: "padding", sides: [0] },
      frame,
      () => ({ x: 400, y: 300 })
    );
    expect(bands[0]).toMatchObject({ x: 410, y: 320, width: 100, height: 10 });
  });

  it("reuses the canvas gap detector for a flex frame, so both drags agree", () => {
    const frame = flexFrame([
      { id: "c1", type: "rect", x: 10, y: 10, width: 60, height: 40 },
      { id: "c2", type: "rect", x: 90, y: 10, width: 60, height: 40 }
    ]);

    const bands = spacingBands({ elementId: "f1", kind: "gap", sides: [], axis: "x" }, frame, flat);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ x: 70, y: 10, width: 20, height: 40, label: "20" });
  });

  it("labels the field's own gap, not the measured gutter", () => {
    // A child carrying a margin widens the empty space between two children
    // without touching `layout.gap`: 70 → 110 is 40px of space, of which 20 is
    // the gap. The band is still that space; the label is still the number the
    // field shows, or the two would disagree on screen.
    const frame = flexFrame([
      { id: "c1", type: "rect", x: 10, y: 10, width: 60, height: 40, margin: [0, 10, 0, 0] },
      { id: "c2", type: "rect", x: 110, y: 10, width: 60, height: 40, margin: [0, 0, 0, 10] }
    ]);
    const bands = spacingBands({ elementId: "f1", kind: "gap", sides: [], axis: "x" }, frame, flat);
    expect(bands[0].width).toBe(40);
    expect(bands[0].label).toBe("20");
  });

  it("bands a wrapped stack line by line, not across the whole child list", () => {
    // Two lines of a row-direction wrap. Sorting every child by x (what the pill
    // detector does) pairs `c2` — the end of line 1 — with `c3`, the start of
    // line 2, and reports a seam through the middle of the frame.
    const frame: FrameElement = {
      id: "w1",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ...flattenLayout({ mode: "flex", direction: "row", wrap: "wrap", gap: 20, rowGap: 10 }),
      children: [
        { id: "c1", type: "rect", x: 0, y: 0, width: 80, height: 40 },
        { id: "c2", type: "rect", x: 100, y: 0, width: 80, height: 40 },
        { id: "c3", type: "rect", x: 0, y: 50, width: 80, height: 40 }
      ]
    } as FrameElement;

    const cols = spacingBands({ elementId: "w1", kind: "gap", sides: [], axis: "x" }, frame, flat);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ x: 80, y: 0, width: 20, height: 40, label: "20" });

    // Between the lines, spanning both — the cross-axis field's own number.
    const rows = spacingBands({ elementId: "w1", kind: "gap", sides: [], axis: "y" }, frame, flat);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ x: 0, y: 40, width: 180, height: 10, label: "10" });
  });

  it("seams a grid on the axis being scrubbed", () => {
    const frame: FrameElement = {
      id: "g1",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      ...flattenLayout({ mode: "grid", columns: 2, columnGap: 20, rowGap: 8, cellAlign: "stretch" }),
      children: [
        { id: "c1", type: "rect", x: 0, y: 0, width: 140, height: 96 },
        { id: "c2", type: "rect", x: 160, y: 0, width: 140, height: 96 },
        { id: "c3", type: "rect", x: 0, y: 104, width: 140, height: 96 },
        { id: "c4", type: "rect", x: 160, y: 104, width: 140, height: 96 }
      ]
    } as FrameElement;

    const cols = spacingBands({ elementId: "g1", kind: "gap", sides: [], axis: "x" }, frame, flat);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ x: 140, width: 20, label: "20" });
    // The seam spans both tracks' full height — it is the grid's divider.
    expect(cols[0].height).toBe(200);

    const rows = spacingBands({ elementId: "g1", kind: "gap", sides: [], axis: "y" }, frame, flat);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ y: 96, height: 8, label: "8" });
    expect(rows[0].width).toBe(300);
  });

  it("says nothing for an element that is neither a frame nor in a frame", () => {
    const rect: RectElement = { id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 };
    expect(spacingBands({ elementId: "r1", kind: "padding", sides: [0] }, rect, flat)).toEqual([]);
  });

  it("reads margin off the child, signed", () => {
    const child: RectElement = {
      id: "r1",
      type: "rect",
      x: 20,
      y: 20,
      width: 10,
      height: 10,
      margin: [5, 0, 0, -5]
    };
    const bands = spacingBands({ elementId: "r1", kind: "margin", sides: [0, 3] }, child, flat);
    expect(bands[0]).toMatchObject({ y: 15, height: 5, label: "5" });
    expect(bands[1]).toMatchObject({ x: 25, width: 5, label: "-5" });
  });
});