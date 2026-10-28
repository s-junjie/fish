import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { alignElements, nudgeElements, reorderZIndex, reorderInAutoLayout } from "../src/core/interactions/alignment";
import { AutoLayout, DesignElement, RectElement, FrameElement } from "../src/core/dsl/types";
import { relayoutDocumentTree } from "../src/core/compile";

describe("FISH M1 Day-One Interactions: Align, Nudge, Z-Order", () => {
  const elements: RectElement[] = [
    { id: "r1", type: "rect", x: 100, y: 100, width: 50, height: 50 },
    { id: "r2", type: "rect", x: 200, y: 150, width: 50, height: 50 },
    { id: "r3", type: "rect", x: 300, y: 200, width: 50, height: 50 }
  ];

  it("aligns elements to the left edge of their bounding box", () => {
    const aligned = alignElements(elements, "left");
    expect(aligned.every((el) => el.x === 100)).toBe(true);
  });

  it("aligns elements to the center of their bounding box", () => {
    // bbox is x: 100, width: 250 (from 100 to 350)
    // center x = 100 + (250 - 50)/2 = 200
    const aligned = alignElements(elements, "center");
    expect(aligned.every((el) => el.x === 200)).toBe(true);
  });

  it("distributes elements horizontally with equal spacing", () => {
    // r1: 100, r2: 120 (crowded), r3: 300
    const input: RectElement[] = [
      { id: "r1", type: "rect", x: 100, y: 0, width: 50, height: 50 },
      { id: "r2", type: "rect", x: 120, y: 0, width: 50, height: 50 },
      { id: "r3", type: "rect", x: 300, y: 0, width: 50, height: 50 }
    ];
    const distributed = alignElements(input, "distribute-h");
    expect(distributed[0].x).toBe(100);
    expect(distributed[1].x).toBe(200);
    expect(distributed[2].x).toBe(300);
  });

  it("nudges elements with 1px and 8px (Shift multiplier)", () => {
    const sel = new Set(["r1"]);
    const nudged1 = nudgeElements(elements, sel, 1, 0, false);
    expect(nudged1.find((el) => el.id === "r1")?.x).toBe(101);

    const nudged8 = nudgeElements(elements, sel, 0, -1, true);
    expect(nudged8.find((el) => el.id === "r1")?.y).toBe(92);
  });

  it("nudging a frame preserves child local coordinates (v0.3)", () => {
    const frameWithChild: any[] = [
      {
        id: "f1",
        type: "frame",
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        children: [{ id: "c1", type: "rect", x: 20, y: 30, width: 40, height: 40 }]
      }
    ];
    const nudged = nudgeElements(frameWithChild, new Set(["f1"]), 10, 5, false);
    expect(nudged[0].x).toBe(110);
    expect(nudged[0].y).toBe(105);
    // In v0.3 local coordinates, child's local (x, y) are invariant when container moves
    expect((nudged[0] as FrameElement).children![0].x).toBe(20);
    expect((nudged[0] as FrameElement).children![0].y).toBe(30);
  });

  it("reorders z-index correctly (bringToFront, sendToBack, forward, backward)", () => {
    const sel = new Set(["r1"]);
    // r1 starts at index 0
    const broughtToFront = reorderZIndex(elements, sel, "front");
    expect(broughtToFront[2].id).toBe("r1");

    const sentToBack = reorderZIndex(broughtToFront, sel, "back");
    expect(sentToBack[0].id).toBe("r1");

    const movedForward = reorderZIndex(elements, sel, "forward");
    expect(movedForward[1].id).toBe("r1");
  });
});

describe("single selection aligns against its parent frame (Figma parity)", () => {
  const tree: DesignElement[] = [
    {
      id: "f",
      type: "frame",
      x: 100,
      y: 200,
      width: 300,
      height: 100,
      children: [{ id: "kid", type: "rect", x: 150, y: 230, width: 40, height: 40 }]
    } as FrameElement
  ];
  const ctx = { allElements: tree, canvasWidth: 800, canvasHeight: 600 };
  const kid = () => (tree[0] as FrameElement).children![0];

  it("aligns a nested child to its frame's left", () => {
    const [aligned] = alignElements([kid()], "left", ctx);
    // In v0.3, aligned against parent frame's local left (0)
    expect(aligned.x).toBe(0);
  });

  it("aligns a nested child to its frame's right edge", () => {
    const [aligned] = alignElements([kid()], "right", ctx);
    // In v0.3, aligned against parent frame's local right (width - child.width = 300 - 40 = 260)
    expect(aligned.x).toBe(260);
  });

  it("aligns a nested child to its frame's horizontal center", () => {
    const [aligned] = alignElements([kid()], "center", ctx);
    // In v0.3, (300 - 40) / 2 = 130
    expect(aligned.x).toBe(130);
  });

  it("aligns a nested child to its frame's top", () => {
    const [aligned] = alignElements([kid()], "top", ctx);
    // In v0.3, aligned against parent frame's local top (0)
    expect(aligned.y).toBe(0);
  });

  it("aligns a nested child to its frame's vertical center and bottom", () => {
    const [mid] = alignElements([kid()], "middle", ctx);
    // In v0.3, (100 - 40) / 2 = 30
    expect(mid.y).toBe(30);
    const [bottom] = alignElements([kid()], "bottom", ctx);
    // In v0.3, 100 - 40 = 60
    expect(bottom.y).toBe(60);
  });

  it("aligns a top-level single selection against the canvas", () => {
    const [el] = alignElements([{ id: "r1", type: "rect", x: 100, y: 100, width: 50, height: 50 }], "center", {
      allElements: [{ id: "r1", type: "rect", x: 100, y: 100, width: 50, height: 50 }],
      canvasWidth: 800,
      canvasHeight: 600
    });
    expect(el.x).toBe(375);
  });

  it("never re-aligns to a frame when multiple elements are selected", () => {
    const multi: DesignElement[] = [
      { id: "a", type: "rect", x: 100, y: 100, width: 50, height: 50 },
      { id: "b", type: "rect", x: 200, y: 100, width: 50, height: 50 }
    ];
    const aligned = alignElements(multi, "left", { allElements: multi });
    expect(aligned.every((el) => el.x === 100)).toBe(true);
  });

  it("aligns a child frame inside a parent frame and moves its inner children together", () => {
    const nestedTree: DesignElement[] = [
      {
        id: "parentFrame",
        type: "frame",
        x: 100,
        y: 100,
        width: 400,
        height: 400,
        children: [
          {
            id: "childFrame",
            type: "frame",
            x: 150,
            y: 150,
            width: 100,
            height: 100,
            children: [
              { id: "grandKid", type: "rect", x: 160, y: 170, width: 20, height: 20 }
            ]
          } as FrameElement
        ]
      } as FrameElement
    ];
    const childFrame = (nestedTree[0] as FrameElement).children![0] as FrameElement;
    const [alignedChildFrame] = alignElements([childFrame], "right", { allElements: nestedTree });
    // parent width is 400, childFrame width 100 -> new local x is 300 (400 - 100)
    expect(alignedChildFrame.x).toBe(300);
    // grandKid's local coordinates inside childFrame are invariant (v0.3)
    expect((alignedChildFrame as FrameElement).children![0].x).toBe(160);
  });
});

describe("arrow keys inside an auto-layout stack reorder instead of moving", () => {
  const stack = (direction: "row" | "column"): FrameElement => ({
    id: "f",
    type: "frame",
    x: 0,
    y: 0,
    width: direction === "row" ? 300 : 100,
    height: direction === "row" ? 100 : 300,
    ...flattenLayout({ mode: "flex", direction, gap: 0, padding: 0, justify: "start", align: "start" }),
    children: [
      { id: "a", type: "rect", x: 0, y: 0, width: 50, height: 50 },
      { id: "b", type: "rect", x: direction === "row" ? 50 : 0, y: direction === "row" ? 0 : 50, width: 50, height: 50 },
      { id: "c", type: "rect", x: direction === "row" ? 100 : 0, y: direction === "row" ? 0 : 100, width: 50, height: 50 }
    ]
  });

  const orderOf = (els: DesignElement[]) =>
    (els[0] as FrameElement).children!.map((c) => c.id).join(",");

  it("walks a row child along the main axis and reflows it", () => {
    const res = reorderInAutoLayout([stack("row")], new Set(["a"]), "right");
    expect(res?.moved).toBe(true);
    expect(orderOf(res!.elements)).toBe("b,a,c");
    expect((res!.elements[0] as FrameElement).children!.find((c) => c.id === "a")!.x).toBe(50);
  });

  it("walks a column child along its main axis", () => {
    const res = reorderInAutoLayout([stack("column")], new Set(["a"]), "down");
    expect(res?.moved).toBe(true);
    expect(orderOf(res!.elements)).toBe("b,a,c");
    expect((res!.elements[0] as FrameElement).children!.find((c) => c.id === "a")!.y).toBe(50);
  });

  it("never nudges: cross-axis arrows are consumed without changing the stack", () => {
    expect(reorderInAutoLayout([stack("row")], new Set(["b"]), "up")?.moved).toBe(false);
    expect(reorderInAutoLayout([stack("row")], new Set(["b"]), "down")?.moved).toBe(false);
    expect(reorderInAutoLayout([stack("column")], new Set(["b"]), "left")?.moved).toBe(false);
    expect(reorderInAutoLayout([stack("column")], new Set(["b"]), "right")?.moved).toBe(false);
  });

  it("reports no move at the stack boundary", () => {
    const res = reorderInAutoLayout([stack("row")], new Set(["a"]), "left");
    expect(res?.moved).toBe(false);
    expect(orderOf(res!.elements)).toBe("a,b,c");
  });

  it("moves a multi-selection as one block", () => {
    const res = reorderInAutoLayout([stack("row")], new Set(["a", "b"]), "right");
    expect(orderOf(res!.elements)).toBe("c,a,b");
  });

  it("does not reorder the stack for a layer inside a plain frame within it", () => {
    // The regression: the parent walk climbed past any number of non-layout
    // frames, so selecting r1 reordered g1 — the selected layer never moved and
    // could not be moved at all. A plain frame places its own children, so the
    // arrow has to reach the caller as a nudge.
    const nested: FrameElement = {
      ...stack("row"),
      children: [
        { id: "g1", type: "frame", x: 0, y: 0, width: 50, height: 50, children: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }] },
        { id: "g2", type: "frame", x: 50, y: 0, width: 50, height: 50, children: [] }
      ]
    };
    expect(reorderInAutoLayout([nested], new Set(["r1"]), "right")).toBeNull();

    // And what the caller then does with that null: r1 moves inside g1, and the
    // stack's own order is untouched.
    const nudged = nudgeElements([nested], new Set(["r1"]), 1, 0);
    const frame = (nudged[0] as FrameElement).children!.find((c) => c.id === "g1") as FrameElement;
    expect((frame.children![0] as RectElement).x).toBe(1);
    expect(orderOf(nudged)).toBe("g1,g2");
  });

  it("still reorders a frame that is itself a direct child of the stack", () => {
    const nested: FrameElement = {
      ...stack("row"),
      children: [
        { id: "g1", type: "frame", x: 0, y: 0, width: 50, height: 50, children: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }] },
        { id: "g2", type: "frame", x: 50, y: 0, width: 50, height: 50, children: [] }
      ]
    };
    const res = reorderInAutoLayout([nested], new Set(["g1"]), "right");
    expect(res?.moved).toBe(true);
    expect(orderOf(res!.elements)).toBe("g2,g1");
  });

  it("keeps a nested auto-layout reordering its own children, not its parent's", () => {
    const inner: FrameElement = {
      id: "g1",
      type: "frame",
      x: 0,
      y: 0,
      width: 50,
      height: 100,
      ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 0 }),
      children: [
        { id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 },
        { id: "r2", type: "rect", x: 0, y: 10, width: 10, height: 10 }
      ]
    };
    const outer: FrameElement = {
      ...stack("row"),
      children: [inner, { id: "g2", type: "frame", x: 50, y: 0, width: 50, height: 50, children: [] }]
    };
    const res = reorderInAutoLayout([outer], new Set(["r1"]), "down");
    expect(res?.moved).toBe(true);
    const g1 = (res!.elements[0] as FrameElement).children!.find((c) => c.id === "g1") as FrameElement;
    expect(g1.children!.map((c) => c.id)).toEqual(["r2", "r1"]);
    // The outer stack did not move.
    expect((res!.elements[0] as FrameElement).children!.map((c) => c.id)).toEqual(["g1", "g2"]);
  });

  it("returns null when a selection straddles the stack boundary, so everything nudges", () => {
    const nested: FrameElement = {
      ...stack("row"),
      children: [
        { id: "g1", type: "frame", x: 0, y: 0, width: 50, height: 50, children: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }] },
        { id: "g2", type: "frame", x: 50, y: 0, width: 50, height: 50, children: [] }
      ]
    };
    expect(reorderInAutoLayout([nested], new Set(["g1", "r1"]), "right")).toBeNull();
  });

  it("returns null outside auto layout so the caller falls back to nudging", () => {
    const free: DesignElement[] = [{ id: "r1", type: "rect", x: 0, y: 0, width: 50, height: 50 }];
    expect(reorderInAutoLayout(free, new Set(["r1"]), "right")).toBeNull();
  });
});

describe("arrow keys inside a grid stride over the columns the grid actually has", () => {
  const fiveRects = (): DesignElement[] =>
    ["a", "b", "c", "d", "e"].map((id, i) => ({
      id,
      type: "rect",
      x: (i % 4) * 100,
      y: Math.floor(i / 4) * 100,
      width: 100,
      height: 100
    })) as DesignElement[];

  const gridFrame = (layout: AutoLayout): FrameElement => ({
    id: "g",
    type: "frame",
    x: 0,
    y: 0,
    width: 400,
    height: 400,
    ...flattenLayout(layout),
    children: fiveRects()
  });

  const orderOf = (els: DesignElement[]) =>
    (els[0] as FrameElement).children!.map((c) => c.id).join(",");

  it("derives the stride from the width when columnsMode is auto", () => {
    const res = reorderInAutoLayout(
      [gridFrame({ mode: "grid", columnsMode: "auto", columnWidthMin: 100, gap: 0 })],
      new Set(["a"]),
      "down"
    );
    // 400px / 100px min = 4 columns, so one row down is four slots.
    expect(orderOf(res!.elements)).toBe("b,c,d,e,a");
  });

  it("falls back to a single step in masonry, which has no stride", () => {
    const res = reorderInAutoLayout(
      [gridFrame({ mode: "grid", columns: 2, masonry: true })],
      new Set(["a"]),
      "down"
    );
    expect(orderOf(res!.elements)).toBe("b,a,c,d,e");
  });

  it("still strides by the declared column count", () => {
    const res = reorderInAutoLayout([gridFrame({ mode: "grid", columns: 2 })], new Set(["a"]), "down");
    expect(orderOf(res!.elements)).toBe("b,c,a,d,e");
  });
});

describe("an arrow-key reorder reflows the ancestors too", () => {
  it("propagates the frame's new hug height upward", () => {
    const outer: FrameElement = {
      id: "outer",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 900,
      sizing: { height: "fit-content" },
      ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 0 }),
      children: [
        {
          id: "inner",
          type: "frame",
          x: 0,
          y: 0,
          width: 400,
          height: 900,
          sizing: { height: "fit-content" },
          ...flattenLayout({ mode: "grid", columns: 2, cellAlign: "start", rowGap: 0, padding: 0 }),
          children: [
            { id: "a", type: "rect", x: 0, y: 0, width: 100, height: 300 },
            { id: "b", type: "rect", x: 200, y: 0, width: 100, height: 20 },
            { id: "c", type: "rect", x: 0, y: 300, width: 100, height: 20 },
            { id: "d", type: "rect", x: 200, y: 300, width: 100, height: 300 }
          ]
        } as FrameElement
      ]
    };

    const before = relayoutDocumentTree([outer])[0] as FrameElement;
    expect(before.height).toBe(600);

    const res = reorderInAutoLayout([before], new Set(["a"]), "down");
    // Rows regroup from (300, 300) to (20, 300): the outer frame has to follow.
    expect((res!.elements[0] as FrameElement).height).toBe(320);
  });
});

describe("reorderZIndex works inside container sibling lists", () => {
  const nested = (): DesignElement[] => [
    {
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      children: [
        { id: "a", type: "rect", x: 0, y: 0, width: 40, height: 40 },
        { id: "b", type: "rect", x: 50, y: 0, width: 40, height: 40 },
        { id: "c", type: "rect", x: 100, y: 0, width: 40, height: 40 }
      ]
    } as FrameElement
  ];

  it("moves a nested child to front within its own parent", () => {
    const next = reorderZIndex(nested(), new Set(["a"]), "front");
    expect((next[0] as FrameElement).children.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("moves a nested child backward by one sibling without touching the root", () => {
    const next = reorderZIndex(nested(), new Set(["c"]), "backward");
    expect(next.map((e) => e.id)).toEqual(["f"]);
    expect((next[0] as FrameElement).children.map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  it("does not create a new array when the selected item is already at front", () => {
    const els = nested();
    const already = reorderZIndex(els, new Set(["c"]), "front");
    expect(already).toBe(els);
  });

  it("reorders selected siblings in each parent independently", () => {
    const els: DesignElement[] = [
      { ...nested()[0] as FrameElement, id: "f1" },
      { ...nested()[0] as FrameElement, id: "f2", children: (nested()[0] as FrameElement).children.map((c) => ({ ...c, id: `two_${c.id}` })) }
    ];
    const next = reorderZIndex(els, new Set(["a", "two_a"]), "front");
    expect((next[0] as FrameElement).children.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect((next[1] as FrameElement).children.map((c) => c.id)).toEqual(["two_b", "two_c", "two_a"]);
  });
});
