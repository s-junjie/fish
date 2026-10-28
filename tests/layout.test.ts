import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { applyAutoLayout, relayoutDocumentTree, resolveDynamicLineHeight, resolveLetterSpacing, sortChildrenByLayoutOrder } from "../src/core/compile";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { removeElementsWithRelayout } from "../src/core/interactions/clipboard";
import { AutoLayout, DesignElement, FrameElement, RectElement, TextElement } from "../src/core/dsl/types";
import { findElementById, mapElements } from "../src/core/geometry/tree-ops";
import { elementRotatedAABB } from "../src/core/geometry/element-bounds";
import { flexCrossAlignReason } from "../src/core/layout/flex-layout";

describe("applyAutoLayout", () => {
  it("leaves frame unchanged if layout mode is not flex", () => {
    const frame: FrameElement = {
      id: "f1",
      type: "frame",
      x: 50,
      y: 50,
      width: 400,
      height: 300,
      children: [{ id: "r1", type: "rect", x: 10, y: 10, width: 100, height: 50 }]
    };
    const res = applyAutoLayout(frame);
    expect(res.children[0].x).toBe(10);
    expect(res.children[0].y).toBe(10);
  });

  it("calculates horizontal row flex positions with padding and gap", () => {
    const r1: RectElement = { id: "r1", type: "rect", x: 0, y: 0, width: 80, height: 40 };
    const r2: RectElement = { id: "r2", type: "rect", x: 0, y: 0, width: 100, height: 40 };
    const frame: FrameElement = {
      id: "f_row",
      type: "frame",
      x: 100,
      y: 200,
      width: 500,
      height: 300,
      ...flattenLayout({
        mode: "flex",
        direction: "row",
        gap: 20,
        padding: 10,
        justify: "start",
        align: "center"
      }),
      children: [r1, r2]
    };

    const res = applyAutoLayout(frame);
    // Origin is pl (10) = 10
    expect(res.children[0].x).toBe(10);
    // Next child is 10 + 80 + 20 = 110
    expect(res.children[1].x).toBe(110);

    // Cross axis alignment (center in available height: 300 - 20 = 280)
    // crossOffset = (280 - 40) / 2 = 120; Y = pt (10) + 120 = 130
    expect(res.children[0].y).toBe(130);
    expect(res.children[1].y).toBe(130);
  });

  it("calculates vertical column flex positions with padding and gap", () => {
    const r1: RectElement = { id: "r1", type: "rect", x: 0, y: 0, width: 120, height: 50 };
    const r2: RectElement = { id: "r2", type: "rect", x: 0, y: 0, width: 120, height: 60 };
    const frame: FrameElement = {
      id: "f_col",
      type: "frame",
      x: 50,
      y: 50,
      width: 300,
      height: 400,
      ...flattenLayout({
        mode: "flex",
        direction: "column",
        gap: 15,
        padding: 20,
        justify: "start",
        align: "start"
      }),
      children: [r1, r2]
    };

    const res = applyAutoLayout(frame);
    // Origin is pt (20) = 20
    expect(res.children[0].y).toBe(20);
    // Next child is 20 + 50 + 15 = 85
    expect(res.children[1].y).toBe(85);

    // X axis: pl (20) = 20
    expect(res.children[0].x).toBe(20);
    expect(res.children[1].x).toBe(20);
  });

  it("distributes remaining space equally among fill elements", () => {
    // Width 400, pl=10, pr=10 -> availableMain = 380.
    // r1: fixed 80. gap: 20. r2: fill, r3: fill.
    // freeMain = 380 - 80 - 2*20 = 260.
    // Each fill item gets 130!
    const r1: RectElement = { id: "r1", type: "rect", x: 0, y: 0, width: 80, height: 40 };
    const r2: RectElement = {
      id: "r2",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 40,
      sizing: { width: "fill" }
    };
    const r3: RectElement = {
      id: "r3",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 40,
      sizing: { width: "fill" }
    };
    const frame: FrameElement = {
      id: "f_fill",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 20, padding: 10 }),
      children: [r1, r2, r3]
    };

    const res = applyAutoLayout(frame);
    expect(res.children[0].width).toBe(80);
    expect(res.children[0].x).toBe(10);
    expect(res.children[1].width).toBe(130);
    expect(res.children[1].x).toBe(110);
    expect(res.children[2].width).toBe(130);
    expect(res.children[2].x).toBe(260);
  });

  it("supports width: fill stretching across the cross axis in column layout", () => {
    // Frame width 300, padding 20 -> availableCross = 260
    const r1: RectElement = {
      id: "r1",
      type: "rect",
      x: 0,
      y: 0,
      width: 50,
      height: 60,
      sizing: { width: "fill" }
    };
    const frame: FrameElement = {
      id: "f_cross",
      type: "frame",
      x: 100,
      y: 50,
      width: 300,
      height: 400,
      ...flattenLayout({ mode: "flex", direction: "column", padding: 20, gap: 10 }),
      children: [r1]
    };

    const res = applyAutoLayout(frame);
    expect(res.children[0].width).toBe(260);
    expect(res.children[0].x).toBe(20);
    expect(res.children[0].height).toBe(60);
    expect(res.children[0].y).toBe(20);
  });

  it("handles multi-line wrap when wrap is enabled", () => {
    // Frame width 210, padding 10 -> availableMain = 190. Gap = 10.
    // Three items of width 90:
    // Item 1 (90) + gap (10) + Item 2 (90) = 190 -> fits on line 1.
    // Item 3 (90) -> wraps to line 2.
    const r1: RectElement = { id: "r1", type: "rect", x: 0, y: 0, width: 90, height: 40 };
    const r2: RectElement = { id: "r2", type: "rect", x: 0, y: 0, width: 90, height: 40 };
    const r3: RectElement = { id: "r3", type: "rect", x: 0, y: 0, width: 90, height: 50 };

    const frame: FrameElement = {
      id: "f_wrap",
      type: "frame",
      x: 0,
      y: 0,
      width: 210,
      height: 300,
      ...flattenLayout({ mode: "flex", direction: "row", padding: 10, gap: 10, wrap: "wrap" }),
      children: [r1, r2, r3]
    };

    const res = applyAutoLayout(frame);
    // Line 1: r1 and r2
    expect(res.children[0].x).toBe(10);
    expect(res.children[0].y).toBe(10);
    expect(res.children[1].x).toBe(110);
    expect(res.children[1].y).toBe(10);
    // Line 2: r3 starts below line 1 (line1 crossSize is 40 + gap 10 = 50)
    expect(res.children[2].x).toBe(10);
    expect(res.children[2].y).toBe(60);
  });
});

describe("applyAutoLayout — grid mode", () => {
  const rect = (id: string, w = 50, h = 40): RectElement =>
    ({ id, type: "rect", x: 0, y: 0, width: w, height: h });

  it("places children into equal cells row-major with padding and gaps", () => {
    const frame: FrameElement = {
      id: "g1",
      type: "frame",
      x: 0,
      y: 0,
      width: 320,
      height: 300,
      ...flattenLayout({ mode: "grid", columns: 3, columnGap: 10, rowGap: 20, padding: 10 }),
      children: [rect("a"), rect("b"), rect("c"), rect("d")]
    };
    const res = applyAutoLayout(frame);
    // content width 300; cell = (300 - 2*10) / 3 ≈ 93.33
    // content height 280; 2 rows; cell height = (280 - 20) / 2 = 130
    expect(res.children[0].x).toBe(10);
    // Grid positions are kept at the document's own precision rather than snapped to
    // whole pixels, so a third of a cell is a third of a cell.
    expect(res.children[1].x).toBe(113.33);
    expect(res.children[3].x).toBe(10); // wraps to row 2, col 1
    expect(res.children[3].y).toBe(160);
    // stretch is the default cell align
    expect(res.children[0].width).toBe(93.33);
    expect(res.children[0].height).toBe(130);
  });

  it("column-major placement fills down each column first", () => {
    const frame: FrameElement = {
      id: "g2",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      ...flattenLayout({ mode: "grid", columns: 2, rows: 2, placement: "column", padding: 0 }),
      children: [rect("a"), rect("b"), rect("c")]
    };
    const res = applyAutoLayout(frame);
    // a -> (row0,col0), b -> (row1,col0), c -> (row0,col1)
    expect(res.children[0].x).toBe(0);
    expect(res.children[1].x).toBe(0);
    expect(res.children[2].x).toBe(150);
    expect(res.children[1].y).toBe(150);
    expect(res.children[2].y).toBe(0);
  });

  it("cell align center keeps child size and centers it in the cell", () => {
    const frame: FrameElement = {
      id: "g3",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      ...flattenLayout({ mode: "grid", columns: 2, cellAlign: "center", padding: 0 }),
      children: [rect("a", 40, 30)]
    };
    const res = applyAutoLayout(frame);
    // cell = 100 x 200; centered child offset = (100-40)/2 = 30, (200-30)/2 = 85
    expect(res.children[0].x).toBe(30);
    expect(res.children[0].y).toBe(85);
    expect(res.children[0].width).toBe(40);
    expect(res.children[0].height).toBe(30);
  });

  it("hug frame collapses height to fit rows sized by tallest child", () => {
    const frame: FrameElement = {
      id: "g4",
      type: "frame",
      x: 0,
      y: 0,
      width: 210,
      height: 500,
      sizing: { height: "fit-content" },
      ...flattenLayout({ mode: "grid", columns: 2, rowGap: 10, padding: 5, cellAlign: "start" }),
      children: [rect("a", 50, 30), rect("b", 50, 60), rect("c", 50, 20)]
    };
    const res = applyAutoLayout(frame);
    // rows: [a,b] -> max 60; [c] -> 20; height = 5 + 60 + 10 + 20 + 5 = 100
    expect(res.height).toBe(100);
    // cell align start keeps child heights, y of row 2 = 5 + 60 + 10 = 75
    expect(res.children[2].y).toBe(75);
    expect(res.children[2].height).toBe(20);
  });
});

describe("applyAutoLayout — grid advanced (masonry / auto columns)", () => {
  const rect = (id: string, w = 50, h = 40): RectElement =>
    ({ id, type: "rect", x: 0, y: 0, width: w, height: h });

  it("masonry places each child in the currently shortest column", () => {
    const frame: FrameElement = {
      id: "m1",
      type: "frame",
      x: 0,
      y: 0,
      width: 210,
      height: 600,
      ...flattenLayout({ mode: "grid", columns: 2, columnGap: 10, rowGap: 10, padding: 0, masonry: true }),
      children: [rect("a", 100, 100), rect("b", 100, 30), rect("c", 100, 50)]
    };
    const res = applyAutoLayout(frame);
    // a -> col0 (y0), b -> col1 (y0), c -> col1 (shortest: 30 < 100)
    expect(res.children[0].x).toBe(0);
    expect(res.children[0].y).toBe(0);
    expect(res.children[1].x).toBe(110);
    expect(res.children[1].y).toBe(0);
    expect(res.children[2].x).toBe(110);
    expect(res.children[2].y).toBe(40); // 30 + gap 10
    // child keeps its own height in masonry
    expect(res.children[2].height).toBe(50);
  });

  it("masonry hug collapses frame height to the tallest column", () => {
    const frame: FrameElement = {
      id: "m2",
      type: "frame",
      x: 0,
      y: 0,
      width: 210,
      height: 600,
      sizing: { height: "fit-content" },
      ...flattenLayout({ mode: "grid", columns: 2, columnGap: 10, rowGap: 10, padding: 5, masonry: true }),
      children: [rect("a", 100, 100), rect("b", 100, 30)]
    };
    const res = applyAutoLayout(frame);
    // col0: 100; col1: 30 -> tallest 100; height = 5 + 100 + 5 = 110
    expect(res.height).toBe(110);
  });

  it("auto columns derives count from columnWidthMin", () => {
    const frame: FrameElement = {
      id: "a1",
      type: "frame",
      x: 0,
      y: 0,
      width: 330,
      height: 200,
      ...flattenLayout({ mode: "grid", columns: 8, columnsMode: "auto", columnWidthMin: 100, columnGap: 10, padding: 0, cellAlign: "stretch" }),
      children: [rect("a"), rect("b"), rect("c")]
    };
    const res = applyAutoLayout(frame);
    // (330 + 10) / (100 + 10) = 3 columns; cell = (330 - 20) / 3 ≈ 103.3
    expect(res.children[0].width).toBe(103.33);
    expect(res.children[2].x).toBe(226.67);
    // 3 children exactly fill 3 columns in row 1; no wrap
    expect(res.children[1].y).toBe(0);
  });
});

describe("hidden children leave the flow", () => {
  const box = (id: string, h: number, extra: Partial<RectElement> = {}): RectElement =>
    ({ id, type: "rect", x: 0, y: 0, width: 100, height: h, ...extra } as RectElement);

  const column = (children: DesignElement[], extra: Partial<FrameElement> = {}): FrameElement => ({
    id: "stack",
    type: "frame",
    x: 0,
    y: 0,
    width: 200,
    height: 300,
    ...flattenLayout({ mode: "flex", direction: "column", gap: 10, padding: 0 }),
    children,
    ...extra
  });

  it("closes the gap a hidden child left behind", () => {
    const laid = applyAutoLayout(column([box("a", 40), box("b", 40, { visible: false }), box("c", 40)]));
    expect(laid.children[0].y).toBe(0);
    // b is not placed at all, so c takes its slot: 40 + 10
    expect(laid.children[2].y).toBe(50);
    // and b keeps the box it had — nothing moved it
    expect(laid.children[1].y).toBe(0);
  });

  it("hides a child exactly like removing it does", () => {
    const hidden = applyAutoLayout(column([box("a", 40), box("b", 40, { visible: false }), box("c", 40)]));
    const removed = applyAutoLayout(column([box("a", 40), box("c", 40)]));
    expect([hidden.children[0].y, hidden.children[2].y]).toEqual([removed.children[0].y, removed.children[1].y]);
  });

  it("measures a hugging frame without the hidden children", () => {
    const frame = column([box("a", 40), box("b", 40, { visible: false }), box("c", 40)], {
      height: 300,
      sizing: { height: "fit-content" }
    });
    expect(applyAutoLayout(frame).height).toBe(90);
  });

  it("hugs onto its padding when every child is hidden", () => {
    const frame = column([box("a", 40, { visible: false }), box("b", 40, { visible: false })], {
      width: 200,
      height: 300,
      sizing: { width: "fit-content", height: "fit-content" },
      ...flattenLayout({ mode: "flex", direction: "column", gap: 10, padding: 12 })
    });
    const laid = applyAutoLayout(frame);
    expect([laid.width, laid.height]).toEqual([24, 24]);
    expect(laid.children.length).toBe(2);
  });

  it("keeps both hidden and out-of-flow children out of the count", () => {
    const laid = applyAutoLayout(
      column([box("a", 40), box("abs", 40, { position: "absolute" }), box("b", 40, { visible: false }), box("c", 40)])
    );
    expect(laid.children[3].y).toBe(50);
  });

  it("gives up the cell of a hidden child to the next visible one", () => {
    const frame = column([box("a", 40), box("b", 40, { visible: false }), box("c", 40)], {
      ...flattenLayout({ mode: "grid", columns: 2, gap: 10, padding: 0, cellAlign: "start" })
    });
    const laid = applyAutoLayout(frame);
    // a sits in row 0 col 0; c takes the cell b would have had
    expect([laid.children[0].x, laid.children[0].y]).toEqual([0, 0]);
    expect([laid.children[2].x, laid.children[2].y]).toEqual([105, 0]);
  });

  it("puts a child back in the flow when it is shown again", () => {
    const hidden = applyAutoLayout(column([box("a", 40), box("b", 40, { visible: false }), box("c", 40)]));
    const shown = applyAutoLayout({ ...hidden, children: hidden.children.map((c) => ({ ...c, visible: true })) });
    expect(shown.children[1].y).toBe(50);
    expect(shown.children[2].y).toBe(100);
  });

  it("keeps a hidden sibling in its layer slot when the stack is re-sorted", () => {
    // `h` sat at y=300 and was hidden, so its box is a leftover: the stack closed
    // up over it. Sorting by that box would move the layer to the bottom of the
    // array, and the array is the layer order the user arranged — nothing on
    // screen describes where the hidden layer belongs.
    const laid = applyAutoLayout(column([box("a", 40), box("h", 200, { visible: false, y: 300 }), box("c", 40)]));
    expect(laid.children[2].y).toBe(50);
    const sorted = sortChildrenByLayoutOrder(laid);
    expect(sorted.map((c) => c.id)).toEqual(["a", "h", "c"]);
  });
});

describe("removeElementsWithRelayout", () => {
  it("reflows remaining children after deleting one from a flex frame", () => {
    const r1: RectElement = { id: "r1", type: "rect", x: 0, y: 0, width: 80, height: 40 };
    const r2: RectElement = { id: "r2", type: "rect", x: 0, y: 0, width: 100, height: 40 };
    const r3: RectElement = { id: "r3", type: "rect", x: 0, y: 0, width: 60, height: 40 };
    const frame: FrameElement = {
      id: "f_row",
      type: "frame",
      x: 100,
      y: 200,
      width: 500,
      height: 300,
      ...flattenLayout({
        mode: "flex",
        direction: "row",
        gap: 20,
        padding: 10,
        justify: "start",
        align: "center"
      }),
      children: [r1, r2, r3]
    };
    // Sanity: initial layout reflows already (10/110/230).
    let laid = applyAutoLayout(frame);
    expect(laid.children[2].x).toBe(10 + 80 + 20 + 100 + 20);
    // Delete the middle child r2 -> remaining r1, r3 must close the gap.
    const next = removeElementsWithRelayout([frame], new Set(["r2"]));
    const childAfter = (next[0] as FrameElement).children;
    expect(childAfter.map((c) => c.id)).toEqual(["r1", "r3"]);
    expect(childAfter[1].x).toBe(10 + 80 + 20);
    // Old non-reflowing position (230) must not survive.
    expect(childAfter[1].x).not.toBe(230);
  });
});

describe("relayoutDocumentTree (2-pass layout)", () => {
  it("propagates canvas-absolute coordinates to nested grandchildren authored at (0, 0)", () => {
    const textChild: TextElement = {
      id: "text_grandchild",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hello",
      sizing: { width: "max-content", height: "fit-content" },
      style: { fontSize: 16, fontFamily: "Inter, sans-serif", color: "#FFFFFF" }
    };
    const childFrame: FrameElement = {
      id: "child_frame",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ...flattenLayout({ mode: "flex", direction: "column", padding: 10, gap: 5 }),
      children: [textChild]
    };
    const parentFrame: FrameElement = {
      id: "parent_frame",
      type: "frame",
      x: 100,
      y: 200,
      width: 500,
      height: 400,
      ...flattenLayout({ mode: "flex", direction: "column", padding: 20, gap: 15 }),
      children: [childFrame]
    };

    const laidOut = relayoutDocumentTree([parentFrame]);
    const resParent = laidOut[0] as FrameElement;
    const resChild = resParent.children[0] as FrameElement;
    const resGrandchild = resChild.children[0] as TextElement;

    // Parent at (100, 200), padding 20
    // Child frame placed at local x: 20, y: 20
    expect(resChild.x).toBe(20);
    expect(resChild.y).toBe(20);

    // Grandchild text placed at childFrame padding 10
    expect(resGrandchild.x).toBe(10);
    expect(resGrandchild.y).toBe(10);
  });

  it("handles mode: none by stripping layout so elements keep absolute positioning", () => {
    const raw = {
      version: "0.1",
      name: "Test",
      canvas: { width: 1000, height: 1000 },
      elements: [
        {
          id: "abs_frame",
          type: "frame",
          x: 50,
          y: 50,
          width: 200,
          height: 200,
          display: "none",
          children: [
            { id: "r1", type: "rect", x: 10, y: 20, width: 30, height: 40 },
            { id: "r2", type: "rect", x: 50, y: 60, width: 30, height: 40 }
          ]
        }
      ]
    };

    const { document: normalized } = normalizeDesignDocument(raw);
    const frame = getActivePage(normalized).children[0] as FrameElement;
    expect(layoutOf(frame)).toBeUndefined();

    const laidOut = relayoutDocumentTree(getActivePage(normalized).children);
    const resFrame = laidOut[0] as FrameElement;
    expect(resFrame.children[0].x).toBe(10);
    expect(resFrame.children[0].y).toBe(20);
    expect(resFrame.children[1].x).toBe(50);
    expect(resFrame.children[1].y).toBe(60);
  });

  it("measures max-content text on cross axis in column layout without wrapping at 200px", () => {
    const longText: TextElement = {
      id: "long_title",
      type: "text",
      x: 0,
      y: 0,
      width: 200, // Author default
      height: 24,
      content: "This is a very long title that would wrap if capped at 200px",
      sizing: { width: "max-content", height: "fit-content" },
      style: { fontSize: 20, fontFamily: "Inter, sans-serif", color: "#FFFFFF" }
    };
    const frame: FrameElement = {
      id: "col_frame",
      type: "frame",
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      ...flattenLayout({ mode: "flex", direction: "column", padding: 20, gap: 10 }),
      children: [longText]
    };

    const laidOut = applyAutoLayout(frame);
    const laidOutText = laidOut.children[0] as TextElement;

    // Width must be expanded to fit single-line max-content text, well over 200px
    expect(laidOutText.width).toBeGreaterThan(300);
  });

  it("keeps an absolute line height exact and scales a multiplier by the font size", () => {
    // fontSize 16: `"10px"` is an absolute length now, not a ratio that would have
    // been floored up to the 1.38 default.
    expect(resolveDynamicLineHeight(16, "10px")).toBe(10);
    expect(resolveDynamicLineHeight(16, "24px")).toBe(24);

    const lhMultiplier = resolveDynamicLineHeight(16, 1.5);
    expect(lhMultiplier).toBe(24); // 16 * 1.5
  });

  it("resolves letter spacing: a bare number is px, an em follows the font size", () => {
    expect(resolveLetterSpacing(16, 2)).toBe(2);
    // A tight, negative tracking is a real value, not a floor of zero.
    expect(resolveLetterSpacing(16, -1)).toBe(-1);
    expect(resolveLetterSpacing(16, "2px")).toBe(2);
    expect(resolveLetterSpacing(16, "0.05em")).toBe(0.8); // 16 * 0.05
    expect(resolveLetterSpacing(40, "0.05em")).toBe(2);
    // Absent is CSS's initial tracking of none.
    expect(resolveLetterSpacing(16, undefined)).toBe(0);
  });
});

/**
 * Regression: an auto-layout frame holding a *nested* frame. `placeChildAt` used
 * to skip cascading the move when the child carries its own `layout`, on the
 * assumption that the child's own pass would follow. The canvas drop path lays
 * out a single frame, so no such pass ran and the grandchildren stayed at their
 * dragged coordinates — outside the frame.
 */
describe("nested container inside an auto-layout frame", () => {
  const boxOf = (elements: DesignElement[], id: string) => {
    const el = findElementById(elements, id)!;
    return { x: el.x, y: el.y, width: el.width, height: el.height };
  };

  const contains = (
    outer: { x: number; y: number; width: number; height: number },
    inner: { x: number; y: number; width: number; height: number }
  ) =>
    inner.x >= -0.5 &&
    inner.y >= -0.5 &&
    inner.x + inner.width <= outer.width + 0.5 &&
    inner.y + inner.height <= outer.height + 0.5;

  const nestedDoc = (nestedSizing?: DesignElement["sizing"]): DesignElement[] => [
    {
      id: "P",
      type: "frame",
      x: 0,
      y: 0,
      width: 600,
      height: 200,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 20, padding: 20, justify: "start", align: "start" }),
      children: [
        {
          id: "F",
          type: "frame",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          sizing: nestedSizing,
          ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 10, justify: "start", align: "center" }),
          children: [{ id: "g1", type: "rect", x: 0, y: 0, width: 40, height: 20 }]
        },
        { id: "R", type: "rect", x: 0, y: 0, width: 60, height: 60 }
      ]
    }
  ];

  const dragBy = (elements: DesignElement[], ids: string[], dx: number, dy: number) =>
    mapElements(elements, (el) => (ids.includes(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el));

  it("the 2-pass pipeline keeps the grandchild inside the nested frame", () => {
    const out = relayoutDocumentTree(nestedDoc());
    expect(contains(boxOf(out, "F"), boxOf(out, "g1"))).toBe(true);
  });

  it("keeps the grandchild inside after the nested frame is dragged and the parent is laid out alone", () => {
    const laid = relayoutDocumentTree(nestedDoc());
    // In local coordinates, dragging a container moves only the container.
    const dragged = dragBy(laid, ["F"], 120, 90);
    const parent = findElementById(dragged, "P") as FrameElement;
    const laidOut = applyAutoLayout(parent);
    const out = mapElements(dragged, (e) => (e.id === laidOut.id ? laidOut : e));

    const F = boxOf(out, "F");
    const G = boxOf(out, "g1");
    expect(F).toEqual({ x: 20, y: 20, width: 200, height: 100 });
    // The nested frame's own layout: padding 10 down the column, centred across.
    expect(G.y).toBe(10);
    expect(G.x).toBeCloseTo((F.width - G.width) / 2, 1);
    expect(contains(F, G)).toBe(true);
  });

  it("keeps the grandchild inside after a sibling is dragged past the nested frame", () => {
    const laid = relayoutDocumentTree(nestedDoc());
    const dragged = dragBy(laid, ["R"], -400, 0);
    const parent = findElementById(dragged, "P") as FrameElement;
    const sorted = sortChildrenByLayoutOrder(parent);
    expect(sorted.map((c) => c.id)).toEqual(["R", "F"]);

    const laidOut = applyAutoLayout({ ...parent, children: sorted });
    const out = mapElements(dragged, (e) => (e.id === laidOut.id ? laidOut : e));

    const F = boxOf(out, "F");
    const G = boxOf(out, "g1");
    expect(F.x).toBe(100);
    expect(G.x).toBeCloseTo((F.width - G.width) / 2, 1);
    expect(contains(F, G)).toBe(true);
  });

  it("re-runs the nested frame's own layout when a `fill` frame grows", () => {
    const laid = relayoutDocumentTree(nestedDoc({ width: "fill", height: "fixed" }));
    expect(boxOf(laid, "F").width).toBe(480);

    // Dragging the sibling out of the parent widens the nested frame.
    const parent = findElementById(laid, "P") as FrameElement;
    const withoutR = mapElements(laid, (e) =>
      e.id === "P"
        ? ({ ...parent, children: (parent.children || []).filter((c) => c.id !== "R") } as DesignElement)
        : e
    );

    // The canvas drop path converges through the full pipeline, not a single frame.
    const out = relayoutDocumentTree(withoutR);
    const F = boxOf(out, "F");
    const G = boxOf(out, "g1");
    expect(F.width).toBe(560);
    // align:center => the grandchild must re-centre against the new width.
    expect(G.x).toBeCloseTo((F.width - G.width) / 2, 1);
    expect(contains(F, G)).toBe(true);
  });
});


/**
 * `layoutAlignSelf` — one child overriding the container's cross-axis alignment.
 *
 * The three cases are the three things the field can do: move a child that the
 * container would have placed elsewhere, size a child the container would have
 * left alone, and leave a child alone that the container would have moved. The
 * last one is why `"start"` is a value rather than the absence of the key.
 */
describe("layoutAlignSelf", () => {
  const row = (align: "start" | "center" | "end" | "stretch", children: DesignElement[]): FrameElement => ({
    id: "row",
    type: "frame",
    x: 0,
    y: 0,
    width: 300,
    height: 100,
    ...flattenLayout({ mode: "flex", direction: "row", gap: 0, align }),
    children
  });

  const box = (id: string, height: number): RectElement => ({ id, type: "rect", x: 0, y: 0, width: 50, height });

  it("overrides the container's align for one child only", () => {
    const res = applyAutoLayout(
      row("start", [box("a", 20), { ...box("b", 20), "align-self": "center" }, box("c", 20)])
    );
    expect(res.children[0].y).toBe(0);
    // (100 - 20) / 2
    expect(res.children[1].y).toBe(40);
    expect(res.children[2].y).toBe(0);
  });

  it("overrides the other way too, from a container that centres", () => {
    const res = applyAutoLayout(
      row("center", [box("a", 20), { ...box("b", 20), "align-self": "flex-start" }])
    );
    expect(res.children[0].y).toBe(40);
    expect(res.children[1].y).toBe(0);
  });

  it("stretches a child the container would have left at its own size", () => {
    const res = applyAutoLayout(
      row("start", [box("a", 20), { ...box("b", 20), "align-self": "stretch" }])
    );
    expect(res.children[0].height).toBe(20);
    expect(res.children[1].height).toBe(100);
  });

  it("stretches every child when the CONTAINER asks for stretch (P1.1)", () => {
    const res = applyAutoLayout(row("stretch", [box("a", 20), box("b", 30)]));
    expect(res.children[0].height).toBe(100);
    expect(res.children[1].height).toBe(100);
  });

  it("does not stretch a child that pinned the axis, grid-cell rules included", () => {
    const res = applyAutoLayout(
      row("start", [
        box("a", 20),
        { ...box("b", 20), "align-self": "stretch", sizing: { height: "fixed" } }
      ])
    );
    expect(res.children[1].height).toBe(20);
  });

  it("reads the same override in a grid cell", () => {
    const frame: FrameElement = {
      id: "grid",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ...flattenLayout({ mode: "grid", columns: 2, columnGap: 0, rowGap: 0, cellAlign: "stretch" }),
      children: [
        { ...box("a", 20), "align-self": "flex-end" },
        { ...box("b", 20), "align-self": "center" }
      ]
    };
    const res = applyAutoLayout(frame);
    expect(res.children[0].y).toBe(80);
    expect(res.children[1].y).toBe(40);
  });

  it("is dropped, not defaulted, when it names something else", () => {
    const { document, repairs } = normalizeDesignDocument({
      elements: [{ type: "rect", width: 10, height: 10, "align-self": "baseline" }]
    });
    expect(getActivePage(document).children[0]["align-self"]).toBeUndefined();
    expect(repairs.some((r) => r.path.endsWith("/align-self"))).toBe(true);
  });

  it("survives a load, including the value that means 'the start'", () => {
    const { document, repairs } = normalizeDesignDocument({
      canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
      elements: [{ type: "rect", width: 10, height: 10, fills: [], "align-self": "flex-start" }]
    });
    expect(getActivePage(document).children[0]["align-self"]).toBe("flex-start");
    expect(repairs).toEqual([]);
  });
});

/**
 * `layoutMargin` — space a child reserves around itself inside a layout parent.
 *
 * The cases are the four places a margin has to reach: the child's own position,
 * the free space a `fill` sibling is handed, the parent's hug extent, and the
 * grid cell. The fifth is that it is SIGNED — a negative margin is the only
 * spelling the dialect has for a deliberate overlap between siblings in a stack.
 */
describe("layoutMargin", () => {
  const row = (width: number, children: DesignElement[]): FrameElement => ({
    id: "row",
    type: "frame",
    x: 0,
    y: 0,
    width,
    height: 100,
    ...flattenLayout({ mode: "flex", direction: "row", gap: 0 }),
    children
  });

  const box = (id: string, width: number): RectElement => ({ id, type: "rect", x: 0, y: 0, width, height: 20 });

  it("offsets the child and pushes the next one along", () => {
    const res = applyAutoLayout(
      row(300, [{ ...box("a", 50), margin: 10 }, box("b", 50)])
    );
    expect(res.children[0].x).toBe(10);
    // 10 (a's left) + 50 + 10 (a's right); b has no margin of its own
    expect(res.children[1].x).toBe(70);
  });

  it("reads the four sides in CSS order", () => {
    const res = applyAutoLayout(
      row(300, [{ ...box("a", 50), margin: [1, 2, 3, 4] }, box("b", 50)])
    );
    expect(res.children[0].x).toBe(4);
    expect(res.children[0].y).toBe(1);
    // 4 (a's left) + 50 + 2 (a's right)
    expect(res.children[1].x).toBe(56);
  });

  it("takes the margin out of the free space a fill child is handed", () => {
    const res = applyAutoLayout(
      row(300, [
        { ...box("a", 50), margin: 10, sizing: { width: "fill" } },
        { ...box("b", 50), margin: 10, sizing: { width: "fill" } }
      ])
    );
    // 300 - 40 of margin, split two ways
    expect(res.children[0].width).toBe(130);
    expect(res.children[1].width).toBe(130);
    expect(res.children[0].x).toBe(10);
    expect(res.children[1].x).toBe(160);
  });

  it("counts the margin in a hugging parent's extent", () => {
    const frame: FrameElement = {
      ...row(300, [{ ...box("a", 50), margin: 10 }, { ...box("b", 50), margin: [0, 0, 0, 6] }]),
      sizing: { width: "fit-content" }
    };
    const res = applyAutoLayout(frame);
    // 10 + 50 + 10 + 6 + 50 + 0
    expect(res.width).toBe(126);
  });

  it("is signed, so a negative margin pulls a child back over its neighbour", () => {
    const res = applyAutoLayout(
      row(300, [{ ...box("a", 50), margin: [0, 0, 0, -8] }, box("b", 50)])
    );
    expect(res.children[0].x).toBe(-8);
    expect(res.children[1].x).toBe(42);
  });

  it("reserves the margin inside a grid cell too", () => {
    const frame: FrameElement = {
      id: "grid",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ...flattenLayout({ mode: "grid", columns: 2, columnGap: 0, rowGap: 0, cellAlign: "stretch" }),
      children: [{ ...box("a", 20), margin: 10 }, { ...box("b", 20), margin: [0, 0, 0, 6] }]
    };
    const res = applyAutoLayout(frame);
    expect(res.children[0].x).toBe(10);
    expect(res.children[0].width).toBe(80);
    expect(res.children[1].x).toBe(106);
  });

  it("keeps a negative margin through a load", () => {
    const { document, repairs } = normalizeDesignDocument({
      canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
      elements: [{ type: "rect", width: 10, height: 10, fills: [], margin: [0, 0, 0, -3] }]
    });
    expect(getActivePage(document).children[0].margin).toEqual([0, 0, 0, -3]);
    expect(repairs).toEqual([]);
  });
});

/**
 * The three flex capabilities added beside the original single `gap` / equal
 * split: a per-axis gap pair, `align-content` for the wrapped lines, and a
 * `flexGrow` weight on a fill child.
 */
describe("flex double gap, align-content and flex-grow", () => {
  const frame = (
    width: number,
    height: number,
    layout: Partial<AutoLayout>,
    children: DesignElement[]
  ): FrameElement => ({
    id: "f",
    type: "frame",
    x: 0,
    y: 0,
    width,
    height,
    ...flattenLayout({ mode: "flex", direction: "row", ...layout }) as AutoLayout,
    children
  });

  const box = (id: string, width: number, height = 40, extra: Partial<RectElement> = {}): RectElement => ({
    id,
    type: "rect",
    x: 0,
    y: 0,
    width,
    height,
    ...extra
  });

  it("uses columnGap between items and rowGap between wrapped lines", () => {
    // 210 wide: 90 + columnGap 30 + 90 fills line 1 exactly, so r3 wraps.
    const res = applyAutoLayout(
      frame(210, 300, { wrap: "wrap", columnGap: 30, rowGap: 12 }, [box("r1", 90), box("r2", 90), box("r3", 90)])
    );
    expect(res.children[0].x).toBe(0);
    expect(res.children[1].x).toBe(120);
    expect(res.children[2].x).toBe(0);
    // A 40-tall line 1, then the ROW gap (12) — not the column gap.
    expect(res.children[2].y).toBe(52);
  });

  it("reads a column's per-axis gap with the axes swapped", () => {
    const res = applyAutoLayout(
      frame(300, 210, { direction: "column", wrap: "wrap", columnGap: 12, rowGap: 30 }, [
        box("r1", 90, 90),
        box("r2", 90, 90),
        box("r3", 90, 90)
      ])
    );
    // In a column the main-axis gap is the ROW gap (30) and the between-lines
    // gap is the COLUMN gap (12): 90-tall line 1, then 12 across.
    expect(res.children[1].y).toBe(120);
    expect(res.children[2].x).toBe(102);
  });

  it("places the wrapped lines with alignContent", () => {
    // Two 40-tall lines, gap 10 → 90 of lines in a 300 cross axis, 210 free.
    const lines = (alignContent: NonNullable<AutoLayout["alignContent"]>) =>
      applyAutoLayout(
        frame(210, 300, { wrap: "wrap", gap: 10, alignContent }, [box("r1", 90), box("r2", 90), box("r3", 90)])
      );
    expect(lines("start").children[2].y).toBe(50);
    // center: 210 free → 105 of outer offset
    expect(lines("center").children[2].y).toBe(155);
    // end: the whole 210 above the lines
    expect(lines("end").children[0].y).toBe(210);
    // space-between with two lines pushes the second to the far edge, like end
    expect(lines("space-between").children[2].y).toBe(260);
    // space-evenly gives three equal 70 gaps: one above, one between, one below
    expect(lines("space-evenly").children[0].y).toBe(70);
    expect(lines("space-evenly").children[2].y).toBe(190);
  });

  it("grows every line equally for alignContent: stretch", () => {
    // Three 40-tall lines (40×3 + 10×2 = 140) in a 400 cross axis: 260 free, so
    // each line grows by 260/3 and the last line starts past where center/end
    // (which only offset the block) would put it.
    const lines = (alignContent: NonNullable<AutoLayout["alignContent"]>) =>
      applyAutoLayout(
        frame(90, 400, { wrap: "wrap", gap: 10, alignContent }, [box("r1", 90), box("r2", 90), box("r3", 90)])
      );
    expect(lines("center").children[2].y).toBe(230);
    const grow = 260 / 3;
    const lineHeight = 40 + grow;
    expect(lines("stretch").children[0].y).toBe(0);
    expect(lines("stretch").children[1].y).toBeCloseTo(lineHeight + 10, 2);
    expect(lines("stretch").children[2].y).toBeCloseTo(2 * lineHeight + 20, 2);
  });

  /**
   * The inspector disables the `align-content` menu from this answer, so it has
   * to come from the SAME pass that would move the lines. Each case is asserted
   * against what `applyAutoLayout` then does with the control: a reason means
   * the lines do not move, and no reason means they do.
   */
  describe("flexCrossAlignReason — what the inspector greys out", () => {
    const laidOut = (width: number, height: number, layout: Partial<AutoLayout>) =>
      applyAutoLayout(
        frame(width, height, { wrap: "wrap", gap: 10, ...layout }, [box("r1", 90), box("r2", 90), box("r3", 90)])
      );
    // A pass has placed the children, so the grouping the query reads is the one
    // the engine just produced rather than whatever the caller typed.
    const reasonFor = (width: number, height: number, layout: Partial<AutoLayout> = {}) =>
      flexCrossAlignReason(laidOut(width, height, layout));

    it("reports `hug` when the cross axis has no fixed extent", () => {
      // A `fit-content` cross axis is sized by its own lines, so there is no
      // slack to hand out and the menu says so rather than accepting a choice
      // nothing can show.
      const hugging = frame(210, 300, { wrap: "wrap", gap: 10 } as Partial<AutoLayout>, [
        box("r1", 90),
        box("r2", 90),
        box("r3", 90)
      ]);
      hugging.sizing = { height: "fit-content" };
      expect(flexCrossAlignReason(hugging)).toBe("hug");
      // The engine agrees: the pass leaves `freeCross` at 0, so `end` moves nothing.
      const placed = applyAutoLayout({ ...hugging, ...(flattenLayout({ mode: "flex", direction: "row", wrap: "wrap", gap: 10, alignContent: "end" }) as AutoLayout) });
      expect(placed.children[0].y).toBe(0);
    });

    it("reports `one-line` when nothing wrapped, and no two lines can be moved apart", () => {
      expect(reasonFor(300, 300)).toBe("one-line");
      // A single line is the whole cross axis, so `alignContent` assigns it the
      // ENTIRE free space — the quirk the query exists to stop the menu offering.
      // What it can never do is separate one line from another.
      const res = laidOut(300, 300, { alignContent: "space-between" });
      expect(new Set(res.children.map((c) => c.y)).size).toBe(1);
    });

    it("reports `no-room` when the lines fill the cross axis, and alignContent cannot move them", () => {
      // Two 40-tall lines + one 10 gap = 90 of lines in a 90 cross axis.
      expect(reasonFor(210, 90)).toBe("no-room");
      const res = laidOut(210, 90, { alignContent: "center" });
      expect(res.children[0].y).toBe(0);
      expect(res.children[2].y).toBe(50);
    });

    it("reports nothing when there is slack, and alignContent then moves the lines", () => {
      expect(reasonFor(210, 300)).toBeNull();
      const res = laidOut(210, 300, { alignContent: "center" });
      expect(res.children[2].y).toBe(155);
    });

    it("reads a column frame's cross axis with the axes swapped", () => {
      const column = (width: number, height: number) =>
        applyAutoLayout(
          frame(width, height, { direction: "column", wrap: "wrap", gap: 10 }, [
            box("r1", 90, 90),
            box("r2", 90, 90),
            box("r3", 90, 90)
          ])
        );
      // 90-wide lines + 10 gap = 190 across a 300-wide cross axis: slack exists.
      expect(flexCrossAlignReason(column(300, 210))).toBeNull();
      // …and none when the cross axis is exactly the lines' own extent.
      expect(flexCrossAlignReason(column(190, 210))).toBe("no-room");
    });

    it("agrees with the pass on a TURNED child, which is why it lives in the engine", () => {
      // The old inspector derivation added up stored boxes: a child turned 90°
      // stores a 90x40 box but covers a 40x90 envelope, so the two answers part.
      const turned = frame(210, 300, { wrap: "wrap", gap: 10 } as Partial<AutoLayout>, [
        { ...box("r1", 90), rotation: 90 } as RectElement,
        box("r2", 90),
        box("r3", 90)
      ]);
      const placed = applyAutoLayout(turned);
      expect(flexCrossAlignReason(placed)).toBeNull();
      // With alignContent set the lines must actually move — i.e. the control
      // the inspector leaves ENABLED must not be inert.
      const moved = applyAutoLayout({ ...turned, ...(flattenLayout({ mode: "flex", direction: "row", wrap: "wrap", gap: 10, alignContent: "end" }) as AutoLayout) });
      expect(moved.children.filter((c) => c.id === "r3")[0].y).toBeGreaterThan(50);
    });
  });

  it("ignores alignContent when nothing wrapped", () => {
    const res = applyAutoLayout(
      frame(300, 300, { alignContent: "center" }, [box("r1", 90), box("r2", 90)])
    );
    expect(res.children[0].y).toBe(0);
    expect(res.children[1].y).toBe(0);
  });

  it("weights the fill split by flexGrow, and stays equal when it is absent", () => {
    const weighted = applyAutoLayout(
      frame(300, 100, { gap: 0 }, [
        box("a", 10, 20, { sizing: { width: "fill" }, "flex-grow": 2 }),
        box("b", 10, 20, { sizing: { width: "fill" } })
      ])
    );
    expect(weighted.children[0].width).toBe(200);
    expect(weighted.children[1].width).toBe(100);

    const equal = applyAutoLayout(
      frame(300, 100, { gap: 0 }, [
        box("a", 10, 20, { sizing: { width: "fill" } }),
        box("b", 10, 20, { sizing: { width: "fill" } }),
        box("c", 10, 20, { sizing: { width: "fill" } })
      ])
    );
    expect(equal.children.map((c) => c.width)).toEqual([100, 100, 100]);
  });

  it("weights along the parent's main axis — a column's height", () => {
    const res = applyAutoLayout(
      frame(100, 300, { direction: "column", gap: 0 }, [
        box("a", 50, 10, { sizing: { height: "fill" }, "flex-grow": 3 }),
        box("b", 50, 10, { sizing: { height: "fill" }, "flex-grow": 1 })
      ])
    );
    expect(res.children[0].height).toBe(225);
    expect(res.children[1].height).toBe(75);
  });
});

describe("a turned child inside auto layout", () => {
  // Where the element PAINTS, read by turning its four corners — a second
  // derivation of the envelope, so a pass that reserved the stored box rather
  // than the envelope it covers shows up as a slot that does not line up.
  const of = (el: DesignElement) => {
    const p = elementRotatedAABB(el);
    // Rounded to the document's precision, which is what the pass writes.
    return [p.x, p.y, p.width, p.height].map((v) => Math.round(v * 100) / 100);
  };

  const stack = (children: DesignElement[], extra: Partial<FrameElement> = {}) =>
    ({
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 20, padding: 10, align: "start" }),
      ...extra,
      children
    } as FrameElement);

  const box = (id: string, w: number, h: number, rotation?: number): RectElement =>
    ({ id, type: "rect", x: 0, y: 0, width: w, height: h, ...(rotation ? { rotation } : {}) } as RectElement);

  it("advances the line by the envelope it covers, not by the box it stores", () => {
    // A 100x40 box turned 90 covers 40x100, so the third child sits 60px earlier
    // than an unturned one would put it.
    const res = applyAutoLayout(stack([box("a", 100, 40), box("b", 100, 40, 90), box("c", 100, 40)]));
    expect(of(res.children[0])).toEqual([10, 10, 100, 40]);
    expect(of(res.children[1])).toEqual([130, 10, 40, 100]);
    expect(of(res.children[2])).toEqual([190, 10, 100, 40]);
  });

  it("puts the envelope on the slot and not the box", () => {
    // The pass computes a position for the ENVELOPE, and the stored box's own
    // corner sits half the difference back from it — so this is the assertion
    // that fails if the pass ever writes the slot straight onto the element.
    const res = applyAutoLayout(stack([box("a", 40, 160, 90)]));
    expect(of(res.children[0])).toEqual([10, 10, 160, 40]);
    expect([res.children[0].x, res.children[0].y]).toEqual([70, -50]);
  });

  it("swaps the axes in a column the same way", () => {
    const res = applyAutoLayout(
      stack([box("a", 100, 40), box("b", 100, 40, 90), box("c", 100, 40)], {
        ...flattenLayout({ mode: "flex", direction: "column", gap: 20, padding: 10, align: "start" })
      })
    );
    expect(of(res.children[0])).toEqual([10, 10, 100, 40]);
    expect(of(res.children[1])).toEqual([10, 70, 40, 100]);
    expect(of(res.children[2])).toEqual([10, 190, 100, 40]);
  });

  it("grows a hugging parent to the envelope rather than to the box", () => {
    const hug = { width: "fit-content", height: "fit-content" } as const;
    const plain = applyAutoLayout(stack([box("a", 100, 100), box("b", 100, 100)], { sizing: hug }));
    const turned = applyAutoLayout(stack([box("a", 100, 100), box("b", 100, 100, 45)], { sizing: hug }));
    // 20 + 100 + 20 + 141.42 across, 20 + 141.42 down.
    expect([plain.width, plain.height]).toEqual([240, 120]);
    expect([turned.width, turned.height]).toEqual([281.42, 161.42]);
  });

  it("gives a turned fill child the size that covers its share", () => {
    // The share is a share of the ENVELOPE: to cover 290 of the line at 45 the
    // child has to be 370.14 wide, not 290.
    const res = applyAutoLayout(
      ({
        id: "f",
        type: "frame",
        x: 0,
        y: 0,
        width: 320,
        height: 400,
        ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 10, align: "start" }),
        children: [box("a", 10, 40), { ...box("b", 10, 40, 45), sizing: { width: "fill" } }]
      } as FrameElement)
    );
    expect(res.children[1].width).toBe(370.12);
    expect(of(res.children[1])).toEqual([20, 10, 290, 290]);
  });

  it("holds a quarter-turned fill child at the size it was measured at", () => {
    // At a right angle the child's own size cannot change what it covers on the
    // main axis at all, so there is nothing to solve for: it keeps the 10 it was
    // measured at and the envelope it covers is its 40 height.
    const res = applyAutoLayout(
      ({
        id: "f",
        type: "frame",
        x: 0,
        y: 0,
        width: 320,
        height: 400,
        ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 10, align: "start" }),
        children: [box("a", 10, 40), { ...box("b", 10, 40, 90), sizing: { width: "fill" } }]
      } as FrameElement)
    );
    expect(res.children[1].width).toBe(10);
    expect(of(res.children[1])).toEqual([20, 10, 40, 10]);
  });

  it("leaves an unturned child exactly where it was", () => {
    // The pass has to be a no-op at 0 degrees, or every existing document moves.
    const res = applyAutoLayout(stack([box("a", 100, 40), box("b", 100, 40), box("c", 100, 40)]));
    expect(res.children.map((c) => [c.x, c.y, c.width, c.height])).toEqual([
      [10, 10, 100, 40],
      [130, 10, 100, 40],
      [250, 10, 100, 40]
    ]);
  });

  it("reserves a line the segment it paints, and puts that on the slot", () => {
    // A line turns about its ORIGIN, so its envelope is the turned SEGMENT and not
    // a rectangle centred on the stored box: this one covers 70.71x70.71, and the
    // anchor sits where the turned segment starts rather than half the overhang in.
    const line = { id: "l", type: "line", x: 0, y: 0, width: 0, height: 100, dx: 0, dy: 100, rotation: 45 } as DesignElement;
    const res = applyAutoLayout(stack([line], { sizing: { width: "fit-content", height: "fit-content" } as const }));
    // The hug frame is sized by the envelope: 70.71 + 20 padding, not 100 + 20.
    expect(Math.round(res.width * 100) / 100).toBe(90.71);
    expect(Math.round(res.height * 100) / 100).toBe(90.71);
    // The envelope lands on the slot...
    expect(of(res.children[0])).toEqual([10, 10, 70.71, 70.71]);
    // ...which puts the stored anchor 70.71 to the right of it.
    expect(res.children[0].x).toBeCloseTo(80.71, 2);
    expect(res.children[0].y).toBeCloseTo(10, 6);
  });
});
