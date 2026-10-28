import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { DesignElement, InstanceElement, RectElement } from "../src/core/dsl/types";
import { applyLayerDrop, layerDragBlock } from "../src/ui/layers/layer-reorder";
import { stackDepthFor } from "../src/ui/layers/LayerDragGhost";
import { childrenOf, findElementById, flattenElements } from "../src/core/geometry/tree-ops";

const rect = (id: string, x = 0): RectElement => ({
  id,
  type: "rect",
  name: id,
  x,
  y: 0,
  width: 40,
  height: 20
});

/**
 * `cmp` is the master the instance projects; `cmp_sub` is a frame inside it.
 * `other` is an unrelated master, `loose` a second instance that projects it.
 */
function scene(): DesignElement[] {
  const instance: InstanceElement = {
    id: "inst",
    type: "instance",
    name: "inst",
    componentId: "cmp",
    x: 0,
    y: 0,
    width: 40,
    height: 20
  };
  const loose: InstanceElement = { ...instance, id: "loose", componentId: "other" };
  return [
    {
      id: "cmp",
      type: "component",
      name: "cmp",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [
        { id: "cmp_sub", type: "frame", name: "cmp_sub", x: 10, y: 10, width: 50, height: 50, children: [] },
        rect("cmp_kid", 20)
      ]
    },
    { id: "other", type: "component", name: "other", x: 200, y: 0, width: 100, height: 100, children: [] },
    { id: "locked", type: "frame", name: "locked", x: 400, y: 0, width: 100, height: 100, locked: true, children: [] },
    { id: "box", type: "frame", name: "box", x: 600, y: 0, width: 200, height: 200, children: [rect("inner")] },
    instance,
    loose,
    rect("free")
  ];
}

/** A horizontal stack of three, plus a loose layer outside it. */
function stackScene(): DesignElement[] {
  return [
    {
      id: "stack",
      type: "frame",
      name: "stack",
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 20, padding: 10, justify: "start", align: "start" }),
      children: [
        { ...rect("a"), width: 80 },
        { ...rect("b"), width: 80 },
        { ...rect("c"), width: 80 }
      ]
    },
    rect("free")
  ];
}

describe("applyLayerDrop", () => {
  it("refuses a drop into a locked frame but not next to it", () => {
    const elements = scene();
    expect(applyLayerDrop(elements, ["free"], "locked", "inside")).toEqual({ refused: "locked-target" });
    // The lock protects the frame's own subtree; landing in front of the row does
    // not touch it.
    const before = applyLayerDrop(elements, ["free"], "locked", "before");
    expect("elements" in before).toBe(true);
  });

  it("refuses an instance anywhere inside its own master", () => {
    const elements = scene();
    expect(applyLayerDrop(elements, ["inst"], "cmp", "inside")).toEqual({ refused: "instance-in-own-master" });
    expect(applyLayerDrop(elements, ["inst"], "cmp_sub", "inside")).toEqual({ refused: "instance-in-own-master" });
  });

  it("treats before/after a master's child as a drop inside the master", () => {
    const elements = scene();
    expect(applyLayerDrop(elements, ["inst"], "cmp_kid", "before")).toEqual({ refused: "instance-in-own-master" });
    expect(applyLayerDrop(elements, ["inst"], "cmp_kid", "after")).toEqual({ refused: "instance-in-own-master" });
  });

  it("still lets another master's instance in", () => {
    const result = applyLayerDrop(scene(), ["loose"], "cmp", "inside");
    expect("elements" in result).toBe(true);
    const parent = findElementById((result as { elements: DesignElement[] }).elements, "cmp");
    expect((parent as { children: DesignElement[] }).children.map((c) => c.id)).toContain("loose");
  });

  it("returns a new tree with the layer nested", () => {
    const elements = scene();
    const result = applyLayerDrop(elements, ["free"], "box", "inside");
    expect("elements" in result).toBe(true);
    const box = findElementById((result as { elements: DesignElement[] }).elements, "box");
    expect((box as { children: DesignElement[] }).children.map((c) => c.id)).toEqual(["inner", "free"]);
    expect(elements.some((el) => el.id === "free")).toBe(true);
  });

  it("reflows an auto-layout parent to the new order", () => {
    // Without the reflow the stack keeps the old slots: `b` would still sit at
    // x=110 even though it now paints first.
    const elements: DesignElement[] = [
      {
        id: "stack",
        type: "frame",
        name: "stack",
        x: 0,
        y: 0,
        width: 400,
        height: 100,
        ...flattenLayout({ mode: "flex", direction: "row", gap: 20, padding: 10, justify: "start", align: "start" }),
        children: [
          { ...rect("a"), width: 80 },
          { ...rect("b"), width: 100 }
        ]
      }
    ];
    const moved = applyLayerDrop(elements, ["b"], "a", "before");
    const stack = findElementById((moved as { elements: DesignElement[] }).elements, "stack");
    const kids = (stack as { children: DesignElement[] }).children;
    expect(kids.map((c) => c.id)).toEqual(["b", "a"]);
    expect(kids.map((c) => c.x)).toEqual([10, 130]);
  });

  // A stack lists its rows first-child-first, so the row above `a` is `before` in
  // the array — the mirror of the free-frame mapping. This is the pair of facts
  // the panel's drag handler converts between; a drop that lands on the mirror
  // index still reflows cleanly, which is why it needs a test to be caught.
  it("puts a layer dropped above a stack row into the flow slot before it", () => {
    const elements = stackScene();
    const moved = applyLayerDrop(elements, ["c"], "b", "before");
    const kids = childrenOf(findElementById((moved as { elements: DesignElement[] }).elements, "stack")!);
    expect(kids.map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  it("puts a layer dropped below a stack row into the flow slot after it", () => {
    const elements = stackScene();
    const moved = applyLayerDrop(elements, ["a"], "b", "after");
    const kids = childrenOf(findElementById((moved as { elements: DesignElement[] }).elements, "stack")!);
    expect(kids.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("appends to the end of the flow when dropped inside a stack", () => {
    const elements = stackScene();
    const moved = applyLayerDrop(elements, ["free"], "stack", "inside");
    const kids = childrenOf(findElementById((moved as { elements: DesignElement[] }).elements, "stack")!);
    expect(kids.map((c) => c.id)).toEqual(["a", "b", "c", "free"]);
  });
});

/** A flat page of three siblings, plus a frame holding two children. */
function flatScene(): DesignElement[] {
  return [
    rect("p"),
    rect("q"),
    rect("r"),
    { id: "box", type: "frame", name: "box", x: 0, y: 0, width: 200, height: 200, children: [rect("inner1"), rect("inner2")] }
  ];
}

const idsOf = (elements: DesignElement[]) => elements.map((el) => el.id);
const kidsOf = (elements: DesignElement[], id: string) =>
  childrenOf(findElementById(elements, id)!);

describe("applyLayerDrop — a multi-selection moves as one block", () => {
  it("moves every selected row, not only the pressed one", () => {
    // The bug this pins: the drag carried one id, so `q` landed on `p` and `r`
    // stayed where it was, leaving a selection the user never asked for.
    const moved = applyLayerDrop(flatScene(), ["q", "r"], "p", "before");
    expect(idsOf((moved as { elements: DesignElement[] }).elements)).toEqual(["q", "r", "p", "box"]);
  });

  it("keeps the block in document order however the selection was made", () => {
    // Shift-clicking upward hands over `r, q`; the tree is what knows they sit the
    // other way round, and a block that reversed here would silently restack.
    const moved = applyLayerDrop(flatScene(), ["r", "q"], "p", "before");
    expect(idsOf((moved as { elements: DesignElement[] }).elements)).toEqual(["q", "r", "p", "box"]);
  });

  it("reads the destination among the siblings that stay", () => {
    // `a` and `b` leave the stack first, so "after c" is the end of what is left —
    // the same index arithmetic the canvas drop slot does for a multi-select.
    const elements: DesignElement[] = [
      {
        id: "stack",
        type: "frame",
        name: "stack",
        x: 0,
        y: 0,
        width: 400,
        height: 100,
        ...flattenLayout({ mode: "flex", direction: "row", gap: 20, padding: 10, justify: "start", align: "start" }),
        children: [{ ...rect("a"), width: 80 }, { ...rect("b"), width: 80 }, { ...rect("c"), width: 80 }]
      }
    ];
    const moved = applyLayerDrop(elements, ["a", "b"], "c", "after");
    const kids = kidsOf((moved as { elements: DesignElement[] }).elements, "stack");
    expect(kids.map((c) => c.id)).toEqual(["c", "a", "b"]);
    // And the flow reflows the whole stack, so the block is placed, not stacked
    // on top of the row it was dropped after.
    expect(kids.map((c) => c.x)).toEqual([10, 110, 210]);
  });

  it("appends the whole block inside a frame", () => {
    const moved = applyLayerDrop(flatScene(), ["p", "inner1"], "box", "inside");
    const kids = kidsOf((moved as { elements: DesignElement[] }).elements, "box");
    expect(kids.map((c) => c.id)).toEqual(["inner2", "p", "inner1"]);
  });

  it("carries a selected frame's own child with it, once", () => {
    // Selecting a frame and a child of it is legal; moving both as separate rows
    // would put `inner1` in the tree twice.
    const moved = applyLayerDrop(flatScene(), ["box", "inner1"], "p", "before");
    const elements = (moved as { elements: DesignElement[] }).elements;
    expect(idsOf(elements)).toEqual(["box", "p", "q", "r"]);
    expect(idsOf(kidsOf(elements, "box"))).toEqual(["inner1", "inner2"]);
    const every = flattenElements(elements).map((el) => el.id);
    expect(new Set(every).size).toBe(every.length);
  });

  it("refuses the whole block when one member cannot land there", () => {
    const elements = scene();
    // `inst` is an instance of `cmp`: dropping it inside its own master is
    // refused, and `free` must not be left behind in a half-applied move.
    const result = applyLayerDrop(elements, ["free", "inst"], "cmp", "inside");
    expect(result).toEqual({ refused: "instance-in-own-master" });
  });

  it("does nothing when the drop lands on a row that travels with the block", () => {
    const elements = flatScene();
    expect(applyLayerDrop(elements, ["q", "r"], "q", "before")).toEqual({ elements });
  });

  it("leaves the tree alone when no id is in it", () => {
    const elements = flatScene();
    expect(applyLayerDrop(elements, ["ghost"], "p", "before")).toEqual({ elements });
  });
});

describe("layerDragBlock", () => {
  it("drags the whole selection when the pressed row is part of it", () => {
    expect(layerDragBlock(new Set(["a", "b", "c"]), "b")).toEqual(["a", "b", "c"]);
  });

  it("drags only the pressed row when it is not selected", () => {
    expect(layerDragBlock(new Set(["a", "b"]), "c")).toEqual(["c"]);
  });

  it("drags the pressed row when it is the whole selection", () => {
    expect(layerDragBlock(new Set(["a"]), "a")).toEqual(["a"]);
  });
});

describe("stackDepthFor", () => {
  it("stacks nothing for a single row, which the browser's own image already says", () => {
    expect(stackDepthFor(1)).toBe(0);
  });

  it("stacks one card behind per row that is not the one in front", () => {
    expect(stackDepthFor(2)).toBe(1);
    expect(stackDepthFor(3)).toBe(2);
  });

  it("stops stacking at three cards, however big the selection is", () => {
    // Forty cards behind a row is a blob, not a count; the drop line and the
    // panel's own highlight carry the exact number.
    expect(stackDepthFor(4)).toBe(3);
    expect(stackDepthFor(40)).toBe(3);
  });
});
