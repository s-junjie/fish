import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { applyAutoLayout, gridCellRects, gridRowCount, sortChildrenByLayoutOrder } from "../src/core/compile";
import { resolveDynamicLineHeight } from "../src/core/layout/text-sizing";
import { validateDocument } from "../src/core/validate";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { normalizeAutoLayout } from "../src/core/dsl/normalize/auto-layout";
import { elementRotatedAABB } from "../src/core/geometry/element-bounds";
import { ContainerElement, DesignDocument, DesignElement, FrameElement, RectElement, TextElement } from "../src/core/dsl/types";

const rect = (id: string, w: number, h: number, sizing?: any): RectElement =>
  ({ id, type: "rect", x: 0, y: 0, width: w, height: h, sizing } as RectElement);

const text = (id: string, content: string, sizing?: any): TextElement => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 20,
  content,
  style: { fontFamily: "Inter", fontSize: 16, color: "#ffffff" },
  sizing: sizing ?? { width: "fit-content", height: "fit-content" }
});

const grid = (
  frame: Partial<FrameElement> & { children: any[] }
): FrameElement =>
  ({
    id: "g",
    type: "frame",
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    ...frame
  }) as FrameElement;

describe("grid honours a child's declared sizing", () => {
  it("stretches a child that declared nothing and leaves one that did", () => {
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 2 }),
        children: [text("t", "Hi"), rect("r", 50, 40)]
      })
    );
    // cellW is 300; the label asked to hug, the rect asked for nothing.
    expect(res.children[0].width).toBeLessThan(300);
    expect(res.children[1].width).toBe(300);
  });

  it("is the declared mode that decides, not the cell align", () => {
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 2, cellAlign: "center" }),
        children: [text("t", "Hi"), rect("r", 50, 40)]
      })
    );
    expect(res.children[0].width).toBeLessThan(300);
    expect(res.children[1].width).toBe(50);
  });

  it("keeps the size of a child that pinned the axis, which is what makes Fixed a mode", () => {
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 2 }),
        children: [
          rect("pinned", 50, 40, { width: "fixed", height: "fixed" }),
          rect("open", 50, 40)
        ]
      })
    );
    // Same cell, same pass: the one that said `fixed` keeps 50x40, and the one
    // that said nothing is still stretched — an unsaid axis is `auto`, and the
    // cell decides what `auto` means.
    expect({ w: res.children[0].width, h: res.children[0].height }).toEqual({ w: 50, h: 40 });
    expect({ w: res.children[1].width, h: res.children[1].height }).toEqual({ w: 300, h: 400 });
  });

  it("honours the pin on one axis only", () => {
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 2 }),
        children: [rect("r", 50, 40, { width: "fixed" })]
      })
    );
    expect(res.children[0].width).toBe(50);
    expect(res.children[0].height).toBe(400);
  });

  it("hugs its width from the widest child", () => {
    const res = applyAutoLayout(
      grid({
        width: 0,
        sizing: { width: "fit-content" },
        ...flattenLayout({ mode: "grid", columns: 3, columnGap: 8, padding: 10 }),
        children: [rect("a", 60, 40), rect("b", 120, 40), rect("c", 40, 40)]
      })
    );
    // 3 columns of the widest child (120), 2 gaps and the padding.
    expect(res.width).toBe(3 * 120 + 2 * 8 + 20);
    expect(res.children.map((c) => c.width)).toEqual([120, 120, 120]);
    // Whatever the author wrote, a hug axis resolves to the same answer.
    const again = applyAutoLayout({ ...res } as FrameElement);
    expect(again.width).toBe(res.width);
  });

  it("never gives a cell zero width", () => {
    const res = applyAutoLayout(
      grid({
        width: 40,
        ...flattenLayout({ mode: "grid", columns: 3, gap: 20, padding: 10 }),
        children: [rect("a", 20, 20), rect("b", 20, 20), rect("c", 20, 20)]
      })
    );
    for (const child of res.children) expect(child.width).toBeGreaterThan(0);
  });

  it("warns instead of silently painting an empty grid", () => {
    const doc = {
      canvas: { width: 400, height: 400, unit: "px", background: { type: "solid", color: "#000" } },
      elements: [
        grid({
          id: "nowidth",
          width: 0,
          ...flattenLayout({ mode: "grid", columns: 3 }),
          children: [rect("a", 20, 20)]
        }),
        grid({
          id: "cramped",
          width: 40,
          ...flattenLayout({ mode: "grid", columns: 3, gap: 20, padding: 10 }),
          children: [rect("b", 20, 20)]
        })
      ]
    } as unknown as DesignDocument;
    const warnings = validateDocument(doc).filter((d) => d.level === "warning");
    expect(warnings.some((w) => w.elementId === "nowidth" && /width/.test(w.message))).toBe(true);
    expect(warnings.some((w) => w.elementId === "cramped" && /no room/.test(w.message))).toBe(true);
    // A grid that hugs its width is not the mistake the warning is about.
    const ok = {
      ...doc,
      elements: [
        grid({
          width: 0,
          sizing: { width: "fit-content" },
          ...flattenLayout({ mode: "grid", columns: 2 }),
          children: [rect("c", 80, 40)]
        })
      ]
    } as unknown as DesignDocument;
    expect(validateDocument(ok).some((d) => /no width/.test(d.message))).toBe(false);
  });

  it("does not call a fill-width grid widthless inside a layout parent", () => {
    const doc = {
      canvas: { width: 1440, height: 800, unit: "px", background: { type: "solid", color: "#000" } },
      elements: [
        {
          id: "row",
          type: "frame",
          x: 0,
          y: 0,
          width: 1440,
          height: 800,
          ...flattenLayout({ mode: "flex", direction: "row" }),
          children: [
            grid({
              id: "fillgrid",
              width: 0,
              sizing: { width: "fill" },
              ...flattenLayout({ mode: "grid", columns: 4 }),
              children: [rect("a", 100, 40)]
            })
          ]
        }
      ]
    } as unknown as DesignDocument;
    const warnings = validateDocument(doc).filter((d) => d.level === "warning");
    expect(warnings.some((w) => w.elementId === "fillgrid" && /no width/.test(w.message))).toBe(false);
  });

  it("reports a top-level fill width that has no parent to fill", () => {
    const doc = {
      canvas: { width: 1440, height: 800, unit: "px", background: { type: "solid", color: "#000" } },
      elements: [
        grid({
          id: "topfill",
          width: 0,
          sizing: { width: "fill" },
          ...flattenLayout({ mode: "grid", columns: 2 }),
          children: [rect("a", 100, 40)]
        })
      ]
    } as unknown as DesignDocument;
    const warnings = validateDocument(doc).filter((d) => d.level === "warning");
    expect(
      warnings.some(
        (w) => w.elementId === "topfill" && /sizing\.width "fill"/.test(w.message) && /not inside a parent/.test(w.message)
      )
    ).toBe(true);
  });
});

describe("grid fills a child that asks to fill its cell", () => {
  it("stretches a fill child even when cells do not stretch", () => {
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 2, cellAlign: "start" }),
        children: [rect("r", 50, 40, { width: "fill", height: "fill" })]
      })
    );
    expect(res.children[0].width).toBe(300);
    expect(res.children[0].height).toBe(400);
  });

  it("still leaves a hugged child alone beside a filled one", () => {
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 2 }),
        children: [rect("a", 50, 40, { width: "fill" }), text("t", "Hi")]
      })
    );
    expect(res.children[0].width).toBe(300);
    expect(res.children[1].width).toBeLessThan(300);
  });

  it("downgrades fill back to hug when the grid itself hugs that axis", () => {
    const res = applyAutoLayout(
      grid({
        width: 0,
        sizing: { width: "fit-content" },
        ...flattenLayout({ mode: "grid", columns: 2 }),
        children: [rect("a", 50, 40, { width: "fill" })]
      })
    );
    // Both metrics come from the child: no hangover from the "fill" request.
    expect(res.width).toBe(100);
    expect(res.children[0].width).toBe(50);
  });
});

describe("grid rows are a minimum, and say so", () => {
  it("reports both the rendered and the filled row count", () => {
    expect(gridRowCount({ mode: "grid", columns: 3 }, 600, 4)).toEqual({ rows: 2, used: 2 });
    expect(gridRowCount({ mode: "grid", columns: 3, rows: 3 }, 600, 4)).toEqual({ rows: 3, used: 2 });
    expect(gridRowCount({ mode: "grid", columns: 3, rows: 3 }, 600, 9)).toEqual({ rows: 3, used: 3 });
  });

  it("does not bill a hugging frame for rows nothing landed in", () => {
    const res = applyAutoLayout(
      grid({
        height: 0,
        sizing: { height: "fit-content" },
        ...flattenLayout({ mode: "grid", columns: 3, rows: 3, rowGap: 20 }),
        children: [rect("a", 100, 40), rect("b", 100, 40), rect("c", 100, 40), rect("d", 100, 40)]
      })
    );
    // Two rows of 40 and one row gap — the reserved third row costs nothing.
    expect(res.height).toBe(100);
  });

  it("keeps the reserved row when the frame owns its own height", () => {
    const res = applyAutoLayout(
      grid({
        height: 300,
        ...flattenLayout({ mode: "grid", columns: 3, rows: 3 }),
        children: [rect("a", 100, 40), rect("b", 100, 40)]
      })
    );
    expect(gridRowCount(layoutOf(res)!, 600, 2).rows).toBe(3);
    expect(res.children[0].y).toBe(0);
  });

  it("warns about rows that stay empty", () => {
    const doc = {
      canvas: { width: 600, height: 600, unit: "px", background: { type: "solid", color: "#000" } },
      elements: [
        grid({
          id: "partial",
          ...flattenLayout({ mode: "grid", columns: 3, rows: 3 }),
          children: [rect("a", 100, 40), rect("b", 100, 40), rect("c", 100, 40), rect("d", 100, 40)]
        })
      ]
    } as unknown as DesignDocument;
    const rows = validateDocument(doc).filter((d) => d.elementId === "partial");
    expect(rows.some((d) => /rows 3/.test(d.message) && /empty/.test(d.message))).toBe(true);

    const full = {
      ...doc,
      elements: [
        grid({
          id: "full",
          ...flattenLayout({ mode: "grid", columns: 3, rows: 3 }),
          children: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => rect(`r${n}`, 100, 40))
        })
      ]
    } as unknown as DesignDocument;
    expect(validateDocument(full).some((d) => /empty/.test(d.message))).toBe(false);
  });
});

describe("a layout carries only what its mode reads", () => {
  it("drops stack-only fields from a grid layout", () => {
    const repairs: any[] = [];
    const layout = normalizeAutoLayout(
      { mode: "grid", columns: 2, direction: "row", justify: "center", align: "start", wrap: "wrap" },
      "/elements/0/layout",
      repairs
    );
    expect(layout).toEqual({ mode: "grid", columns: 2 });
    expect(repairs.filter((r) => r.kind === "layout").map((r) => r.path)).toEqual([
      "/elements/0/layout/direction",
      "/elements/0/layout/justify",
      "/elements/0/layout/align",
      "/elements/0/layout/wrap"
    ]);
  });

  it("drops grid-only fields from a stack layout", () => {
    const repairs: any[] = [];
    const layout = normalizeAutoLayout(
      { mode: "flex", columns: 2, rows: 3, cellAlign: "center", masonry: true },
      "/elements/0/layout",
      repairs
    );
    expect(layout).toEqual({ mode: "flex", direction: "row" });
    expect(repairs.some((r) => /masonry/.test(r.message))).toBe(true);
  });

  it("refuses rows alongside masonry instead of ignoring it silently", () => {
    const repairs: any[] = [];
    const layout = normalizeAutoLayout(
      { mode: "grid", columns: 2, rows: 3, masonry: true },
      "/elements/0/layout",
      repairs
    );
    expect(layout).toEqual({ mode: "grid", columns: 2, masonry: true });
    expect(repairs.some((r) => /rows/.test(r.message) && /masonry/.test(r.message))).toBe(true);
  });
});

describe("grid order comes from the boxes on screen", () => {
  it("does not mis-sort a row of mixed heights", () => {
    const frame = grid({
      width: 400,
      ...flattenLayout({ mode: "grid", columns: 2, rowGap: 10, columnGap: 10, padding: 0 }),
      children: [rect("a", 100, 200), rect("b", 100, 20), rect("c", 100, 20), rect("d", 100, 200)]
    });
    const laid = applyAutoLayout(frame);
    // a and b share row 0 even though one is ten times taller than the other.
    const moved = laid.children.map((c) =>
      c.id === "d" ? { ...c, x: laid.children[1].x - 1, y: laid.children[1].y } : c
    );
    const sorted = sortChildrenByLayoutOrder({ ...laid, children: moved } as ContainerElement);
    expect(sorted.map((c) => c.id)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("flex distribution", () => {
  it("spreads the fill remainder instead of dropping it", () => {
    const res = applyAutoLayout({
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 101,
      height: 40,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 0 }),
      children: [rect("fillA", 10, 40, { width: "fill" }), rect("fillB", 10, 40, { width: "fill" }), rect("fixed", 30, 40)]
    } as FrameElement);
    // Evenly, at the document's own precision: 71 left over two `fill` children is
    // 35.5 each, and the stack still has to reach the container's far edge.
    expect(res.children.map((c) => c.width)).toEqual([35.5, 35.5, 30]);
    // The stack must still reach the container's far edge.
    const right = Math.max(...res.children.map((c) => c.x + c.width));
    expect(right).toBe(101);
  });

  it("does not let a fill child force a line break in a wrapping stack", () => {
    const res = applyAutoLayout({
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 0, wrap: "wrap" }),
      children: [rect("a", 200, 40), rect("fill", 300, 40, { width: "fill" }), rect("b", 200, 40)]
    } as FrameElement);
    // The fill takes the 100px left on line 1 rather than breaking on a size
    // it was about to give up anyway.
    expect(res.children[0].y).toBe(res.children[1].y);
    expect(res.children[1].width).toBe(100);
    expect(res.children[2].y).toBeGreaterThan(res.children[0].y);
  });
});

describe("a stretched cell measures text at the width it paints it", () => {
  const LONG = "The quick brown fox jumps over the lazy dog and keeps on running through the field";
  // The resolved line height, not a number copied out of a previous run: it is a
  // product of the font size and the tier multiplier, and pinning it here would make
  // these tests about a rounding decision instead of about where text is measured.
  const lineHeight = resolveDynamicLineHeight(16);
  const fixedWidthText = (id: string, w: number): TextElement => ({
    id,
    type: "text",
    x: 0,
    y: 0,
    width: w,
    height: 22,
    content: LONG,
    style: { fontFamily: "Inter", fontSize: 16, color: "#ffffff" },
    sizing: { height: "fit-content" }
  });

  it("wraps a fixed-width child at the cell width it is stretched to", () => {
    const res = applyAutoLayout(
      grid({ ...flattenLayout({ mode: "grid", columns: 2 }), children: [fixedWidthText("t", 120)] })
    );
    // cellW is 300; 788px of text needs 3 lines there, not the 7 it needs at 120.
    expect(res.children[0].width).toBe(300);
    expect(res.children[0].height).toBe(3 * lineHeight);
  });

  it("keeps the authored wrap when the cell does not stretch", () => {
    for (const cellAlign of ["start", "center", "end"] as const) {
      const res = applyAutoLayout(
        grid({ ...flattenLayout({ mode: "grid", columns: 2, cellAlign }), children: [fixedWidthText("t", 120)] })
      );
      expect(res.children[0].width).toBe(120);
      expect(res.children[0].height).toBe(7 * lineHeight);
    }
  });

  it("measures a fill child at the cell width too", () => {
    const fillText: TextElement = { ...fixedWidthText("t", 120), sizing: { width: "fill", height: "fit-content" } };
    const res = applyAutoLayout(grid({ ...flattenLayout({ mode: "grid", columns: 2 }), children: [fillText] }));
    expect(res.children[0].width).toBe(300);
    expect(res.children[0].height).toBe(3 * lineHeight);
  });

  it("measures a pinned child at the width it was given, not at the cell it ignores", () => {
    const pinnedText: TextElement = { ...fixedWidthText("t", 120), sizing: { width: "fixed", height: "fit-content" } };
    const res = applyAutoLayout(grid({ ...flattenLayout({ mode: "grid", columns: 2 }), children: [pinnedText] }));
    expect(res.children[0].width).toBe(120);
    expect(res.children[0].height).toBe(7 * lineHeight);
  });
});

describe("a wrapped stack sorts by line, then along the line", () => {
  const wrapped = (): FrameElement =>
    grid({
      id: "f",
      width: 300,
      height: 200,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 8, wrap: "wrap", padding: 0 }),
      children: [rect("a", 140, 40), rect("b", 140, 40), rect("c", 140, 40)]
    });

  it("keeps a second-line child on its own line when it is dragged right", () => {
    const laid = applyAutoLayout(wrapped());
    expect(laid.children.map((c) => [c.id, c.x, c.y])).toEqual([
      ["a", 0, 0],
      ["b", 148, 0],
      ["c", 0, 48]
    ]);
    // A single-axis sort would slot `c` in between `a` and `b`.
    const moved = laid.children.map((c) => (c.id === "c" ? { ...c, x: 100 } : c));
    const sorted = sortChildrenByLayoutOrder({ ...laid, children: moved } as ContainerElement);
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("still sorts an unwrapped stack by its main axis alone", () => {
    const plain = grid({
      id: "f",
      width: 400,
      height: 60,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 0 }),
      children: [rect("a", 80, 40), rect("b", 80, 40), rect("c", 80, 40)]
    });
    const laid = applyAutoLayout(plain);
    const shuffled = [laid.children[2], laid.children[0], laid.children[1]];
    const sorted = sortChildrenByLayoutOrder({ ...laid, children: shuffled } as ContainerElement);
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

/**
 * `columnSizes` / `rowSizes` — unequal tracks, which no column count can say.
 *
 * The shapes below are the ones a measured page actually produces: a chrome bar
 * of `280px 1fr 288px`, a three-row shell of `48px 1fr 26px`.
 */
describe("grid explicit tracks", () => {
  it("places children at the widths the tracks name, not at an equal division", () => {
    const res = applyAutoLayout(
      grid({
        width: 600,
        height: 100,
        ...flattenLayout({ mode: "grid", columns: 3, columnSizes: [280, 32, 288], gap: 0, padding: 0 }),
        children: [rect("a", 10, 10), rect("b", 10, 10), rect("c", 10, 10)]
      })
    );
    // A `columns: 3` grid would put these at 0 / 200 / 400.
    expect(res.children.map((c) => Math.round(c.x))).toEqual([0, 280, 312]);
    expect(res.children.map((c) => Math.round(c.width))).toEqual([280, 32, 288]);
  });

  it("counts the gap between the tracks it was given", () => {
    const res = applyAutoLayout(
      grid({
        width: 400,
        height: 60,
        ...flattenLayout({ mode: "grid", columns: 2, columnSizes: [100, 200], columnGap: 20, rowGap: 0, padding: 0 }),
        children: [rect("a", 10, 10), rect("b", 10, 10)]
      })
    );
    expect(Math.round(res.children[0].x)).toBe(0);
    expect(Math.round(res.children[1].x)).toBe(120);
  });

  it("uses row sizes as the row heights, so a 48/1fr/26 shell stays three different rows", () => {
    const res = applyAutoLayout(
      grid({
        width: 300,
        height: 300,
        ...flattenLayout({ mode: "grid", columns: 1, rowSizes: [48, 226, 26], gap: 0, padding: 0 }),
        children: [rect("a", 10, 10), rect("b", 10, 10), rect("c", 10, 10)]
      })
    );
    expect(res.children.map((c) => Math.round(c.y))).toEqual([0, 48, 274]);
    expect(res.children.map((c) => Math.round(c.height))).toEqual([48, 226, 26]);
  });

  it("reports its column count as the number of tracks", () => {
    const laid = applyAutoLayout(
      grid({
        width: 300,
        height: 100,
        ...flattenLayout({ mode: "grid", columns: 9, columnSizes: [100, 200], gap: 0, padding: 0 }),
        children: [rect("a", 10, 10), rect("b", 10, 10)]
      })
    );
    expect(gridRowCount(layoutOf(laid)!, 300, 2)).toEqual({ rows: 1, used: 1 });
  });

  /**
   * A px track is a measurement and an `fr` track is a ratio, and the difference
   * only shows up when the frame changes size — which is the whole reason the
   * ratio is stored instead of the pixels it happened to resolve to.
   */
  it("grows an fr track when the frame grows, and leaves the px ones alone", () => {
    const at = (width: number) =>
      applyAutoLayout(
        grid({
          width,
          height: 100,
          ...flattenLayout({ mode: "grid", columns: 3, columnSizes: [280, { fr: 1 }, 288], gap: 0, padding: 0 }),
          children: [rect("a", 10, 10), rect("b", 10, 10), rect("c", 10, 10)]
        })
      );
    expect(at(600).children.map((c) => Math.round(c.width))).toEqual([280, 32, 288]);
    // The 200 extra pixels went to the only track that asked for them.
    expect(at(800).children.map((c) => Math.round(c.width))).toEqual([280, 232, 288]);
    expect(Math.round(at(800).children[2].x)).toBe(512);
  });

  it("splits the leftover by weight", () => {
    const res = applyAutoLayout(
      grid({
        width: 300,
        height: 100,
        ...flattenLayout({ mode: "grid", columns: 2, columnSizes: [{ fr: 1 }, { fr: 2 }], gap: 0, padding: 0 }),
        children: [rect("a", 10, 10), rect("b", 10, 10)]
      })
    );
    expect(res.children.map((c) => Math.round(c.width))).toEqual([100, 200]);
  });

  it("does not redistribute a px list — that is what a measurement means", () => {
    const at = (width: number) =>
      applyAutoLayout(
        grid({
          width,
          height: 100,
          ...flattenLayout({ mode: "grid", columns: 2, columnSizes: [100, 100], gap: 0, padding: 0 }),
          children: [rect("a", 10, 10), rect("b", 10, 10)]
        })
      );
    expect(at(200).children.map((c) => Math.round(c.width))).toEqual([100, 100]);
    expect(at(400).children.map((c) => Math.round(c.width))).toEqual([100, 100]);
  });

  it("keeps an authored row that nothing landed in", () => {
    const res = applyAutoLayout(
      grid({
        width: 300,
        height: 300,
        ...flattenLayout({ mode: "grid", columns: 1, rows: 3, gap: 0, padding: 0 }),
        children: [rect("a", 10, 10)]
      })
    );
    expect(gridRowCount(layoutOf(res)!, 300, 1).rows).toBe(3);
  });
});

/**
 * `layoutCell` — CSS `grid-column` / `grid-row`, 1-based like CSS line numbers.
 */
describe("grid cell placement", () => {
  const span = (id: string, cell: any) => ({ ...rect(id, 10, 10), "grid-area": cell });

  it("spans a child across the tracks it asks for, and flows the next one past it", () => {
    const res = applyAutoLayout(
      grid({
        width: 300,
        height: 100,
        ...flattenLayout({ mode: "grid", columns: 3, gap: 10, padding: 0 }),
        children: [span("a", { columnSpan: 2 }), rect("b", 10, 10)]
      })
    );
    // cellW is (300 − 2×10) / 3 = 93.33, so two tracks plus the gap between them.
    expect(res.children[0].width).toBeCloseTo(93.333 * 2 + 10, 1);
    // `b` is flowed into column 3 rather than on top of `a`.
    expect(res.children[1].x).toBeCloseTo(2 * (93.333 + 10), 1);
  });

  it("pins a child to a row and column, and flows the rest around it", () => {
    const res = applyAutoLayout(
      grid({
        width: 300,
        height: 200,
        ...flattenLayout({ mode: "grid", columns: 2, rowSizes: [50, 50], gap: 0, padding: 0 }),
        children: [span("a", { column: 2, row: 1 }), span("b", { column: 1, row: 2 }), rect("c", 10, 10)]
      })
    );
    expect(Math.round(res.children[0].x)).toBe(150);
    expect(Math.round(res.children[0].y)).toBe(0);
    expect(Math.round(res.children[1].x)).toBe(0);
    expect(Math.round(res.children[1].y)).toBe(50);
    // `c` takes the first cell the explicit two left free.
    expect(Math.round(res.children[2].x)).toBe(0);
    expect(Math.round(res.children[2].y)).toBe(0);
  });

  it("makes a spanning child as tall as the rows it covers", () => {
    const res = applyAutoLayout(
      grid({
        width: 100,
        height: 200,
        ...flattenLayout({ mode: "grid", columns: 1, rowSizes: [40, 60], gap: 0, padding: 0 }),
        children: [span("a", { rowSpan: 2 })]
      })
    );
    expect(Math.round(res.children[0].height)).toBe(100);
  });

  it("treats a 1-based index literally, so column 1 is the first track", () => {
    const res = applyAutoLayout(
      grid({
        width: 300,
        height: 100,
        ...flattenLayout({ mode: "grid", columns: 3, gap: 0, padding: 0 }),
        children: [span("a", { column: 1, row: 1 }), span("b", { column: 3, row: 1 })]
      })
    );
    expect(Math.round(res.children[0].x)).toBe(0);
    expect(Math.round(res.children[1].x)).toBe(200);
  });

  it("clamps a span past the last track rather than painting outside the grid", () => {
    const res = applyAutoLayout(
      grid({
        width: 300,
        height: 100,
        ...flattenLayout({ mode: "grid", columns: 2, gap: 0, padding: 0 }),
        children: [span("a", { columnSpan: 9 })]
      })
    );
    expect(Math.round(res.children[0].width)).toBe(300);
  });

  it("survives a document load, and drops a placement that names no track", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "1.0",
      canvas: { width: 100, height: 100, unit: "px" },
      elements: [
        { id: "a", type: "rect", width: 10, height: 10, fills: [], "grid-area": { column: 2, columnSpan: 2 } },
        { id: "b", type: "rect", width: 10, height: 10, fills: [], "grid-area": { column: 0 } }
      ]
    } as never);
    expect(getActivePage(document).children[0]["grid-area"]).toEqual({ column: 2, columnSpan: 2 });
    expect(getActivePage(document).children[1]["grid-area"]).toBeUndefined();
    expect(repairs.some((r) => r.path.endsWith("/grid-area"))).toBe(true);
  });

  it("drops the track lists when masonry is on, which has no tracks to size", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "1.0",
      canvas: { width: 100, height: 100, unit: "px" },
      elements: [
        { id: "g", type: "frame", width: 100, height: 100, children: [], ...flattenLayout({ mode: "grid", masonry: true, columnSizes: [10, 20] }) }
      ]
    } as never);
    expect(layoutOf(getActivePage(document).children[0] as FrameElement)?.columnSizes).toBeUndefined();
    expect(repairs.some((r) => r.path.endsWith("/columnSizes"))).toBe(true);
  });
});

describe("the cell rects a grid would place into", () => {
  const cell = (cells: { column: number; row: number; x: number; y: number; width: number; height: number }[]) =>
    cells.map((c) => [c.column, c.row, Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)]);

  it("reads the tracks the pass places into, padding included", () => {
    const frame = applyAutoLayout(
      grid({
        width: 300,
        height: 120,
        ...flattenLayout({ mode: "grid", columns: 2, columnGap: 20, rowGap: 10, padding: 10 }),
        children: [rect("a", 50, 40)]
      })
    );
    // Content box 280 wide: two columns of 130 and a 20 gap. One row of 100,
    // and the content box starts at 10.
    expect(cell(gridCellRects(frame))).toEqual([
      [0, 0, 10, 10, 130, 100],
      [1, 0, 160, 10, 130, 100]
    ]);
  });

  it("shows a reserved row the children never reach", () => {
    const frame = applyAutoLayout(
      grid({ ...flattenLayout({ mode: "grid", columns: 2, rows: 3 }), children: [rect("a", 50, 40)] })
    );
    expect(gridCellRects(frame)).toHaveLength(6);
    expect(cell(gridCellRects(frame))[4]).toEqual([0, 2, 0, 267, 300, 133]);
  });

  it("resolves `fr` rows the way the pass does", () => {
    const frame = applyAutoLayout(
      grid({
        height: 200,
        ...flattenLayout({ mode: "grid", columns: 1, rowSizes: [50, { fr: 1 }] }),
        children: [rect("a", 50, 40), rect("b", 50, 40)]
      })
    );
    expect(cell(gridCellRects(frame))).toEqual([
      [0, 0, 0, 0, 600, 50],
      [0, 1, 0, 50, 600, 150]
    ]);
  });

  it("follows a hugging frame's rows to the children in them", () => {
    const frame = applyAutoLayout(
      grid({
        height: 0,
        sizing: { height: "fit-content" },
        ...flattenLayout({ mode: "grid", columns: 1, rowGap: 8 }),
        children: [rect("a", 50, 40), rect("b", 50, 90)]
      })
    );
    expect(cell(gridCellRects(frame))).toEqual([
      [0, 0, 0, 0, 600, 40],
      [0, 1, 0, 48, 600, 90]
    ]);
  });

  it("answers nothing for masonry, which has no fixed grid to show", () => {
    const frame = grid({
      ...flattenLayout({ mode: "grid", columns: 2, masonry: true }),
      children: [rect("a", 50, 40)]
    });
    expect(gridCellRects(frame)).toEqual([]);
  });

  it("answers nothing for a frame that is not a grid", () => {
    expect(
      gridCellRects({ id: "f", type: "frame", x: 0, y: 0, width: 10, height: 10, children: [], ...flattenLayout({ mode: "flex" }) })
    ).toEqual([]);
  });
});

describe("a turned child in a grid", () => {
  // `fixed` on both axes so the cell cannot resize it: what is under test is the
  // room it is given, not the size it ends up with.
  const turned = (id: string, w: number, h: number, rotation: number): RectElement =>
    ({ id, type: "rect", x: 0, y: 0, width: w, height: h, rotation, sizing: { width: "fixed", height: "fixed" } } as RectElement);

  const painted = (el: DesignElement) => {
    const p = elementRotatedAABB(el);
    return [p.x, p.y, p.width, p.height].map((v) => Math.round(v * 100) / 100);
  };

  it("makes the columns as wide as the envelope the child covers", () => {
    // The 40x160 child turned 90 covers 160 across, so both columns are 160 and
    // not the 80 a 1-up reading of the stored boxes would give.
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 2, gap: 10, padding: 10 }),
        sizing: { width: "fit-content", height: "fit-content" },
        children: [turned("a", 80, 40, 0), turned("b", 40, 160, 90)]
      })
    );
    expect(res.width).toBe(350);
    expect(res.height).toBe(60);
  });

  it("puts the envelope in the cell, not the box", () => {
    const res = applyAutoLayout(
      grid({
        ...flattenLayout({ mode: "grid", columns: 1, gap: 10, padding: 10, cellAlign: "start" }),
        children: [turned("b", 40, 160, 90)]
      })
    );
    // The stored box hangs 60px above the cell and 60 to its left, which is
    // exactly what puts the 160x40 envelope on it.
    expect(painted(res.children[0])).toEqual([10, 10, 160, 40]);
    expect([res.children[0].x, res.children[0].y]).toEqual([70, -50]);
  });
});
