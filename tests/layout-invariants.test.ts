import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { applyAutoLayout, isLaidOut, relayoutDocumentTree } from "../src/core/compile";
import { resolveDynamicLineHeight } from "../src/core/layout/text-sizing";
import { moveElementInTree, findElementById } from "../src/core/geometry/tree-ops";
import { DesignElement, FrameElement, RectElement } from "../src/core/dsl/types";

/**
 * Invariants the whole editor depends on, stated independently of any single
 * layout feature: a hug box must not depend on the size it is replacing, and one
 * full pass must be enough — every edit runs exactly one.
 */

const txt = (id: string, content: string, sizing?: any): any => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 20,
  content,
  style: { fontFamily: "Inter", fontSize: 16 },
  sizing: sizing ?? { width: "fit-content", height: "fit-content" }
});

const rects = (n: number, w = 60, h = 40): RectElement[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, type: "rect", x: 0, y: 0, width: w, height: h }));

const geoSig = (els: DesignElement[]): string[] =>
  els.map((e) => {
    const box = `${e.id}:${e.x},${e.y},${e.width},${e.height}`;
    const kids = (e as FrameElement).children;
    return kids && kids.length ? `${box}[${geoSig(kids).join(";")}]` : box;
  });

describe("hug resolves independently of the authored box", () => {
  const build = (authoredWidth: number): FrameElement =>
    ({
      id: "hug",
      type: "frame",
      x: 0,
      y: 0,
      width: authoredWidth,
      height: 100,
      sizing: { width: "fit-content" },
      ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 16 }),
      children: [txt("t", "Adaptive card title that should hug")]
    }) as FrameElement;

  it("reaches the same width from a wide, a narrow and a collapsed box", () => {
    const [wide, narrow, collapsed] = [600, 200, 40].map((w) => applyAutoLayout(build(w)));
    expect(narrow.width).toBe(wide.width);
    expect(collapsed.width).toBe(wide.width);
    expect(collapsed.children[0].width).toBe(wide.children[0].width);
  });
});

describe("one full pass is enough", () => {
  it("a wrapped hug stack settles on the first pass", () => {
    const doc: DesignElement[] = [
      {
        id: "wrap",
        type: "frame",
        x: 0,
        y: 0,
        width: 300,
        height: 20,
        sizing: { height: "fit-content" },
        ...flattenLayout({ mode: "flex", direction: "row", gap: 8, wrap: "wrap" }),
        children: [txt("t1", "First item with a fairly long label"), txt("t2", "Second item also fairly long")]
      } as FrameElement
    ];

    const first = relayoutDocumentTree(doc);
    const second = relayoutDocumentTree(first);
    const third = relayoutDocumentTree(second);
    expect(geoSig(second)).toEqual(geoSig(first));
    expect(geoSig(third)).toEqual(geoSig(first));
    expect((first[0] as FrameElement).height).toBeGreaterThan(0);
  });

  it("a nested hug tree settles on the first pass", () => {
    const doc: DesignElement[] = [
      {
        id: "root",
        type: "frame",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        sizing: { height: "fit-content" },
        ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 16 }),
        children: [
          {
            id: "card",
            type: "frame",
            x: 0,
            y: 0,
            width: 300,
            height: 60,
            sizing: { width: "fit-content", height: "fit-content" },
            ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 12 }),
            children: [txt("t", "Hello world hello"), { id: "badge", type: "rect", x: 0, y: 0, width: 24, height: 24 }]
          } as FrameElement,
          { id: "footer", type: "rect", x: 0, y: 0, width: 200, height: 40 }
        ]
      } as FrameElement
    ];

    const first = relayoutDocumentTree(doc);
    expect(geoSig(relayoutDocumentTree(first))).toEqual(geoSig(first));
    expect(geoSig(relayoutDocumentTree(relayoutDocumentTree(first)))).toEqual(geoSig(first));
  });
});

/**
 * Convergence is asserted per TRIGGER, not on one document, because the two
 * passes only differ when a parent writes a width its own child then needs.
 * A fixture without these structures passes trivially and proves nothing:
 *
 *   1. `fill` — the parent assigns the leftover, and the child lays its own
 *      children out against that number, which only the second pass can see.
 *   2. hug-in-hug — the parent's hug extent is derived from the child's, and
 *      the child is measured against a box the same pass is replacing.
 *   3. a hug chain deeper than the two passes — the only case where a fixed
 *      iteration count can be the wrong answer rather than merely early.
 */
describe("convergence per trigger", () => {
  const settled = (doc: DesignElement[]) => {
    const first = relayoutDocumentTree(doc);
    const sig = geoSig(first);
    expect(geoSig(relayoutDocumentTree(first))).toEqual(sig);
    expect(geoSig(relayoutDocumentTree(relayoutDocumentTree(first)))).toEqual(sig);
    return first;
  };

  it("a `fill` child settles on the second pass", () => {
    const doc: DesignElement[] = [
      {
        id: "shell",
        type: "frame",
        x: 0,
        y: 0,
        width: 500,
        height: 300,
        ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 0 }),
        children: [
          { id: "side", type: "rect", x: 0, y: 0, width: 100, height: 300 } as RectElement,
          {
            id: "body",
            type: "frame",
            x: 0,
            y: 0,
            width: 400,
            height: 300,
            sizing: { width: "fill", height: "fill" },
            ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 16 }),
            children: [txt("t", "A label that wraps at whatever width it is finally given")]
          } as FrameElement
        ]
      } as FrameElement
    ];
    const laid = settled(doc);
    const body = (laid[0] as FrameElement).children[1] as FrameElement;
    // The whole point: `body` is measured at the width pass 1 assigned it.
    expect(body.width).toBe(400);
    expect(body.children[0].width).toBeLessThanOrEqual(body.width);
  });

  it("a hug-in-hug chain settles", () => {
    const doc: DesignElement[] = [
      {
        id: "outer",
        type: "frame",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        sizing: { width: "fit-content", height: "fit-content" },
        ...flattenLayout({ mode: "flex", direction: "column", gap: 6, padding: 10 }),
        children: [
          {
            id: "inner",
            type: "frame",
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            sizing: { width: "fit-content", height: "fit-content" },
            ...flattenLayout({ mode: "flex", direction: "row", gap: 4, padding: 8 }),
            children: [rects(2, 70, 30)[0], rects(2, 70, 30)[1]]
          } as FrameElement
        ]
      } as FrameElement
    ];
    const laid = settled(doc);
    // `inner` row: 8 + 70 + 4 + 70 + 8 = 160 wide, 8 + 30 + 8 = 46 tall.
    // `outer` column wraps it in its own 10 of padding on each side.
    expect((laid[0] as FrameElement).width).toBe(10 + 160 + 10);
    expect((laid[0] as FrameElement).height).toBe(10 + 46 + 10);
  });

  it("a six-deep hug chain settles", () => {
    // One level of hug per pass is the strongest claim the two-pass pipeline
    // makes; a chain this long is where a hard-coded iteration count would
    // show up as a depth-dependent answer.
    let node: any = rects(1, 50, 24)[0];
    for (let d = 6; d >= 1; d--) {
      node = {
        id: `h${d}`,
        type: "frame",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        sizing: { width: "fit-content", height: "fit-content" },
        ...flattenLayout({ mode: "flex", direction: "column", gap: 2, padding: 5 }),
        children: [node]
      };
    }
    const laid = settled([node as FrameElement]);
    // Each level adds its own 5 + 5 of padding. The declared `gap: 2` adds
    // nothing: a gap is the space BETWEEN children, and there is one child.
    expect((laid[0] as FrameElement).width).toBe(50 + 6 * 10);
    expect((laid[0] as FrameElement).height).toBe(24 + 6 * 10);
  });
});

describe("grid column-major", () => {
  it("fills every column instead of collapsing into one", () => {
    const frame: FrameElement = {
      id: "g",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      ...flattenLayout({ mode: "grid", columns: 2, placement: "column", gap: 8 }),
      children: rects(6)
    };
    const xs = new Set(applyAutoLayout(frame).children.map((c) => Math.round(c.x)));
    expect(xs.size).toBe(2);
  });

  it("never spills past `columns` when `rows` is also given", () => {
    const frame: FrameElement = {
      id: "g",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      ...flattenLayout({ mode: "grid", columns: 2, rows: 3, placement: "column", gap: 8 }),
      children: rects(7)
    };
    const res = applyAutoLayout(frame);
    expect(Math.max(...res.children.map((c) => c.x + c.width))).toBeLessThanOrEqual(frame.width + 0.5);
  });
});

describe("reordering children only lands once the tree is reflowed", () => {
  it("the move alone leaves the old slots in place (layer panel path)", () => {
    const frame: FrameElement = {
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 120,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 0 }),
      children: [rects(1, 80, 40)[0], { ...rects(1, 80, 40)[0], id: "b" }]
    };
    const laid = relayoutDocumentTree([frame]);

    const moved = moveElementInTree(laid, "b", "c0", "before");
    // Reordering only writes `children`; whoever moves a child inside an
    // auto-layout container owes the tree a reflow or nothing visibly changes.
    expect((findElementById(moved, "c0") as DesignElement).x).toBe(0);
    expect((findElementById(moved, "b") as DesignElement).x).toBe(88);

    const reflowed = relayoutDocumentTree(moved);
    expect((findElementById(reflowed, "b") as DesignElement).x).toBe(0);
    expect((findElementById(reflowed, "c0") as DesignElement).x).toBe(88);
  });
});

describe("a hugging axis never places children against the box it is replacing", () => {
  const hugRow = (justify: any): FrameElement =>
    ({
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 600,
      height: 40,
      sizing: { width: "fit-content" },
      ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 10, justify }),
      children: [rects(1, 80, 40)[0], { ...rects(1, 80, 40)[0], id: "b" }]
    }) as FrameElement;

  for (const justify of ["center", "end", "space-between", "space-around"] as const) {
    it(`justify:${justify} keeps the line inside the hugged box`, () => {
      const res = applyAutoLayout(hugRow(justify));
      const left = Math.min(...res.children.map((c) => c.x));
      const right = Math.max(...res.children.map((c) => c.x + c.width));
      // 2 x 80 + gap 8 + padding 10 = 188, whichever way the line is distributed.
      expect(res.width).toBe(188);
      expect(left).toBeGreaterThanOrEqual(res.x);
      expect(right).toBeLessThanOrEqual(res.x + res.width);
    });
  }

  it("is idempotent for every justify value", () => {
    for (const justify of ["start", "center", "end", "space-between", "space-around"] as const) {
      const once = applyAutoLayout(hugRow(justify));
      expect(geoSig([applyAutoLayout(once)])).toEqual(geoSig([once]));
    }
  });
});

describe("an empty container hugs its padding", () => {
  const emptyStack: FrameElement = {
    id: "f",
    type: "frame",
    x: 0,
    y: 0,
    width: 300,
    height: 999,
    sizing: { width: "fit-content", height: "fit-content" },
    ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 24 }),
    children: []
  };

  it("collapses to padding on both axes instead of keeping the stale box", () => {
    const res = applyAutoLayout(emptyStack);
    expect(res.width).toBe(48);
    expect(res.height).toBe(48);
  });

  it("leaves a non-hugging axis alone", () => {
    const res = applyAutoLayout({ ...emptyStack, sizing: { height: "fit-content" } });
    expect(res.width).toBe(300);
    expect(res.height).toBe(48);
  });

  it("collapses a grid with reserved rows to padding too", () => {
    const res = applyAutoLayout({
      ...emptyStack,
      width: 600,
      sizing: { height: "fit-content" },
      ...flattenLayout({ mode: "grid", columns: 3, rows: 3, rowGap: 20, padding: 10 })
    } as FrameElement);
    expect(res.height).toBe(20);
  });

  it("shrinks a stack after its last child is deleted", () => {
    const withChild: FrameElement = {
      ...emptyStack,
      sizing: { height: "fit-content" },
      children: [rects(1, 100, 40)[0]]
    };
    const laid = relayoutDocumentTree([withChild])[0] as FrameElement;
    expect(laid.height).toBe(88);
    const emptied = relayoutDocumentTree([{ ...laid, children: [] } as FrameElement])[0] as FrameElement;
    expect(emptied.height).toBe(48);
  });
});

describe("a column stack measures text against the width it will get", () => {
  const longText = "The quick brown fox jumps over the lazy dog and keeps on running through the field";
  // Named rather than written out, because the resolved line height is a product of the
  // font size and the tier multiplier: spelling out 22 here pinned a rounding decision
  // that has nothing to do with what these tests are about.
  const lineHeight = resolveDynamicLineHeight(16);
  const columnStack = (sizing: any, authoredWidth: number): FrameElement =>
    ({
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 900,
      height: 400,
      sizing: { height: "fit-content" },
      ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 0 }),
      children: [
        {
          id: "t",
          type: "text",
          x: 0,
          y: 0,
          width: authoredWidth,
          height: 22,
          content: longText,
          style: { fontFamily: "Inter", fontSize: 16 },
          sizing
        }
      ]
    }) as FrameElement;

  it("converges on the first pass for width:fit-content (82 chars, one line)", () => {
    const res = applyAutoLayout(columnStack({ width: "fit-content", height: "fit-content" }, 200));
    expect(res.children[0].width).toBeGreaterThan(700);
    expect(res.children[0].height).toBe(lineHeight);
    expect(res.height).toBe(lineHeight);
    // The stale authored width used to wrap it into three lines first.
    expect(geoSig(relayoutDocumentTree([res]))).toEqual(geoSig([res]));
  });

  it("keeps the same answer whichever width the box was authored at", () => {
    const widths = [40, 200, 900].map(
      (w) => applyAutoLayout(columnStack({ width: "fit-content", height: "fit-content" }, w)).height
    );
    expect(widths).toEqual([lineHeight, lineHeight, lineHeight]);
  });

  it("still wraps against its own width when the cross axis is fixed", () => {
    // `width: "fixed"` is now the only way to say "wrap at MY number": an axis
    // left unsaid is CSS's `auto`, which a stack stretches by default.
    const res = applyAutoLayout(columnStack({ width: "fixed", height: "fit-content" }, 200));
    expect(res.children[0].width).toBe(200);
    expect(res.children[0].height).toBe(4 * lineHeight);
  });

  it("does not wrap a max-content child against the container", () => {
    const res = applyAutoLayout(columnStack({ width: "max-content", height: "fit-content" }, 200));
    expect(res.children[0].width).toBeGreaterThan(700);
    expect(res.children[0].height).toBe(lineHeight);
  });
});

describe("a layout pass is not repeated on a tree that already had one", () => {
  const stack = (): DesignElement =>
    ({
      id: "stack",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      layout: { mode: "vertical", gap: 8, padding: 0 },
      children: [txt("child", "hello")]
    }) as unknown as DesignElement;

  it("marks what it produced and nothing else", () => {
    const tree: DesignElement[] = [stack()];
    // The array a page switch arrives with has never been through the pass.
    expect(isLaidOut(tree)).toBe(false);
    const once = relayoutDocumentTree(tree);
    expect(isLaidOut(once)).toBe(true);
    // An edit hands over a new array, which must not inherit the mark.
    expect(isLaidOut([...once])).toBe(false);
  });

  it("marks an unchanged tree it hands straight back", () => {
    const settled = relayoutDocumentTree([stack()]);
    const again = relayoutDocumentTree(settled);
    expect(again).toBe(settled);
    expect(isLaidOut(again)).toBe(true);
  });
});
