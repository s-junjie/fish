import { describe, it, expect } from "vitest";
import {
  findElementById,
  findParentById,
  collectDescendantIds,
  flattenElements,
  mapElements,
  moveElementInTree,
  removeElementFromTree,
  getTopLevelAncestorFrame,
  findFrameAtPoint,
  findParentFrameForBox,
  insertElementIntoContainer,
  reparentOnCanvasDrop,
  dissolveFrame,
  computeParentOrigin,
  selectableSiblingIds
} from "../src/core/geometry/tree-ops";
import { DesignElement, FrameElement, RectElement } from "../src/core/dsl/types";

describe("Tree Operations", () => {
  const r1: RectElement = { id: "r1", type: "rect", x: 10, y: 10, width: 100, height: 100 };
  const r2: RectElement = { id: "r2", type: "rect", x: 20, y: 20, width: 50, height: 50 };
  const frame1: FrameElement = {
    id: "f1",
    type: "frame",
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    children: [r2]
  };
  const tree = [r1, frame1];

  it("finds elements and parents at arbitrary depth", () => {
    expect(findElementById(tree, "r2")?.id).toBe("r2");
    expect(findElementById(tree, "non-existent")).toBeNull();
    expect(findParentById(tree, "r2")?.id).toBe("f1");
    expect(findParentById(tree, "r1")).toBeNull();
  });

  it("collects descendants and flattens tree", () => {
    expect(collectDescendantIds(frame1)).toEqual(["r2"]);
    const flat = flattenElements(tree);
    expect(flat.map((e) => e.id)).toEqual(["r1", "f1", "r2"]);
  });

  it("maps elements recursively", () => {
    const updated = mapElements(tree, (el) => ({ ...el, x: el.x + 5 }));
    expect(findElementById(updated, "r1")?.x).toBe(15);
    expect(findElementById(updated, "r2")?.x).toBe(25);
  });

  it("moves element into a frame container", () => {
    const moved = moveElementInTree(tree, "r1", "f1", "inside");
    expect(moved.length).toBe(1);
    expect(moved[0].id).toBe("f1");
    const frame = moved[0] as FrameElement;
    expect(frame.children.map((c) => c.id)).toEqual(["r2", "r1"]);
  });

  it("reorders elements with before and after", () => {
    const moved = moveElementInTree(tree, "f1", "r1", "before");
    expect(moved.map((e) => e.id)).toEqual(["f1", "r1"]);
  });

  it("removes elements from inside containers cleanly", () => {
    const [withoutR2, removed] = removeElementFromTree(tree, "r2");
    expect(removed?.id).toBe("r2");
    expect(findElementById(withoutR2, "r2")).toBeNull();
    const frame = findElementById(withoutR2, "f1") as FrameElement;
    expect(frame.children.length).toBe(0);
  });

  it("moves element out of a frame to the root level", () => {
    const moved = moveElementInTree(tree, "r2", "r1", "before");
    expect(moved.map((e) => e.id)).toEqual(["r2", "r1", "f1"]);
    const frame = findElementById(moved, "f1") as FrameElement;
    expect(frame.children.length).toBe(0);
  });

  it("identifies top-level ancestor frame for deep-nested child", () => {
    expect(getTopLevelAncestorFrame(tree, "r2")?.id).toBe("f1");
    expect(getTopLevelAncestorFrame(tree, "f1")?.id).toBe("f1");
    expect(getTopLevelAncestorFrame(tree, "r1")).toBeNull();
  });

  it("finds frame at point taking into account hierarchy and exclusion", () => {
    expect(findFrameAtPoint(tree, 50, 50)?.id).toBe("f1");
    expect(findFrameAtPoint(tree, 500, 500)).toBeNull();
    expect(findFrameAtPoint(tree, 50, 50, "f1")).toBeNull();
  });

  it("inserts new element into container or root", () => {
    const r3: RectElement = { id: "r3", type: "rect", x: 30, y: 30, width: 40, height: 40 };
    const insertedInside = insertElementIntoContainer(tree, r3, "f1");
    const frame = findElementById(insertedInside, "f1") as FrameElement;
    expect(frame.children.map((c) => c.id)).toContain("r3");

    const insertedRoot = insertElementIntoContainer(tree, r3);
    expect(insertedRoot.map((e) => e.id)).toContain("r3");
  });

  it("reparents element on canvas drop into frame or out to root", () => {
    // r1 is at (10, 10, 100, 100), center is (60, 60), which falls inside f1 (0, 0, 200, 200)
    const res1 = reparentOnCanvasDrop(tree, "r1");
    expect(res1.reparented).toBe(true);
    expect(res1.affectedFrameIds).toEqual(["f1"]);
    const f1After = findElementById(res1.elements, "f1") as FrameElement;
    expect(f1After.children.map((c) => c.id)).toContain("r1");

    // Move r2 outside f1: update r2 pos to (500, 500)
    const treeWithR2Outside = mapElements(tree, (el) => (el.id === "r2" ? { ...el, x: 500, y: 500 } : el));
    const res2 = reparentOnCanvasDrop(treeWithR2Outside, "r2");
    expect(res2.reparented).toBe(true);
    expect(res2.affectedFrameIds).toEqual(["f1"]);
    expect(res2.elements.map((e) => e.id)).toContain("r2");
    const f1AfterRes2 = findElementById(res2.elements, "f1") as FrameElement;
    expect(f1AfterRes2.children.map((c) => c.id)).not.toContain("r2");
  });

  it("dissolves frame releasing children to root or parent preserving order", () => {
    // Top-level frame dissolve
    const resRoot = dissolveFrame(tree, "f1");
    expect(resRoot.releasedIds).toEqual(["r2"]);
    expect(resRoot.elements.map((e) => e.id)).toEqual(["r1", "r2"]);
    expect(findElementById(resRoot.elements, "r2")?.x).toBe(20);

    // Nested frame dissolve
    const innerFrame: FrameElement = {
      id: "f_inner",
      type: "frame",
      x: 10,
      y: 10,
      width: 80,
      height: 80,
      children: [{ id: "r_nested", type: "rect", x: 15, y: 15, width: 20, height: 20 }]
    };
    const outerFrame: FrameElement = {
      id: "f_outer",
      type: "frame",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [innerFrame]
    };
    const nestedTree = [outerFrame];
    const resNested = dissolveFrame(nestedTree, "f_inner");
    expect(resNested.releasedIds).toEqual(["r_nested"]);
    const outerAfter = resNested.elements[0] as FrameElement;
    expect(outerAfter.children.map((c) => c.id)).toEqual(["r_nested"]);
  });

  it("picks the enclosing frame as parent when drawing a frame AROUND it", () => {
    // oldFrame is top-level; a newly drawn frame fully encloses it.
    const oldFrame: FrameElement = {
      id: "old",
      type: "frame",
      x: 100,
      y: 100,
      width: 300,
      height: 300,
      children: []
    };
    const topLevel = [oldFrame];
    // New frame box (80,80) -> (420,420) fully contains oldFrame (100..400).
    const parent = findParentFrameForBox(topLevel, { x: 80, y: 80, width: 340, height: 340 });
    // No existing frame contains the new box, so the new frame is top-level.
    expect(parent).toBeNull();

    // The drawn frame should therefore be inserted at root, and the enclosed
    // oldFrame becomes its child (the desired nesting direction).
    const newFrame: FrameElement = {
      id: "new",
      type: "frame",
      x: 80,
      y: 80,
      width: 340,
      height: 340,
      children: [],
      fills: [{ type: "solid", color: "#FFFFFF" }]
    };
    const withNew = insertElementIntoContainer(topLevel, newFrame);
    const reparented = moveElementInTree(withNew, "old", "new", "inside");
    const newAfter = findElementById(reparented, "new") as FrameElement;
    expect(newAfter.children.map((c) => c.id)).toEqual(["old"]);
    expect(findParentById(reparented, "old")?.id).toBe("new");
  });

  it("still nests a small frame INSIDE its container", () => {
    const big: FrameElement = {
      id: "big",
      type: "frame",
      x: 0,
      y: 0,
      width: 500,
      height: 500,
      children: []
    };
    const parent = findParentFrameForBox([big], { x: 50, y: 50, width: 100, height: 100 });
    expect(parent?.id).toBe("big");
  });

  it("computes parent origin for virtual instance children", () => {
    const docWithInstance: DesignElement[] = [
      {
        id: "frame_root",
        type: "frame",
        x: 100,
        y: 50,
        width: 600,
        height: 400,
        children: [
          {
            id: "inst_1",
            type: "instance",
            componentId: "comp_1",
            x: 40,
            y: 30,
            width: 200,
            height: 100
          } as any
        ]
      }
    ];

    // Target is a virtual clone inside inst_1
    const origin = computeParentOrigin(docWithInstance, "inst_1_child_btn");
    // frame_root (100, 50) + inst_1 (40, 30) = (140, 80)
    expect(origin).toEqual({ x: 140, y: 80 });
  });
});

describe("selectableSiblingIds (⌘A)", () => {
  const page: DesignElement[] = [
    { id: "a", type: "rect", x: 0, y: 0, width: 10, height: 10 },
    { id: "b", type: "rect", x: 20, y: 0, width: 10, height: 10, visible: false },
    { id: "c", type: "rect", x: 40, y: 0, width: 10, height: 10, locked: true },
    {
      id: "f",
      type: "frame",
      x: 0,
      y: 100,
      width: 200,
      height: 200,
      children: [
        { id: "child", type: "rect", x: 0, y: 0, width: 10, height: 10 },
        { id: "child2", type: "rect", x: 20, y: 0, width: 10, height: 10 },
        { id: "child_hidden", type: "rect", x: 40, y: 0, width: 10, height: 10, visible: false },
        { id: "child_locked", type: "rect", x: 60, y: 0, width: 10, height: 10, locked: true }
      ]
    },
    {
      id: "ghost",
      type: "frame",
      x: 0,
      y: 400,
      width: 200,
      height: 200,
      visible: false,
      children: [{ id: "ghost_child", type: "rect", x: 0, y: 0, width: 10, height: 10 }]
    }
  ];

  const from = (selected: string[]) => selectableSiblingIds(page, new Set(selected));

  it("falls back to the page roots when nothing is selected", () => {
    expect(selectableSiblingIds(page, new Set())).toEqual(["a", "f"]);
  });

  it("takes the page roots for a page-root selection too", () => {
    expect(from(["a"])).toEqual(["a", "f"]);
  });

  it("takes the whole level a nested selection sits on", () => {
    expect(from(["child"])).toEqual(["child", "child2"]);
  });

  it("stays on that level rather than climbing out of it", () => {
    expect(from(["child", "child2"])).toEqual(["child", "child2"]);
  });

  it("skips a hidden or locked layer at the level it takes", () => {
    expect(from(["f"])).not.toContain("child_hidden");
    expect(from(["child"])).not.toContain("child_locked");
  });

  it("has nothing to offer inside a hidden frame, which paints no children", () => {
    expect(from(["ghost_child"])).toEqual([]);
  });

  it("falls back to the page roots for a selection spanning two parents", () => {
    expect(from(["a", "child"])).toEqual(["a", "f"]);
  });

  it("falls back to the page roots for a level with no stored parent", () => {
    // A layer an instance projects is painted but never stored, so no parent can
    // be read for it: the page root is the level that always exists.
    expect(from(["inst_1_child"])).toEqual(["a", "f"]);
  });

  it("counts visible: true as visible", () => {
    const shown: DesignElement[] = [{ id: "a", type: "rect", x: 0, y: 0, width: 10, height: 10, visible: true }];
    expect(selectableSiblingIds(shown, new Set())).toEqual(["a"]);
  });

  it("is empty for a page of nothing but hidden and locked layers", () => {
    expect(
      selectableSiblingIds(
        [
          { id: "h", type: "rect", x: 0, y: 0, width: 10, height: 10, visible: false },
          { id: "l", type: "rect", x: 0, y: 0, width: 10, height: 10, locked: true }
        ],
        new Set()
      )
    ).toEqual([]);
  });
});

describe("id lookups come from a per-tree index", () => {
  // The index replaced two recursive scans, so it has to answer exactly what
  // they answered: same element, same parent, first match in pre-order.
  const deep: DesignElement[] = [
    {
      id: "outer",
      type: "frame",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [
        { id: "leaf", type: "rect", x: 0, y: 0, width: 10, height: 10 },
        {
          id: "inner",
          type: "frame",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          children: [{ id: "deep_leaf", type: "rect", x: 1, y: 1, width: 2, height: 2 }]
        }
      ]
    },
    { id: "sibling", type: "rect", x: 0, y: 0, width: 5, height: 5 }
  ];

  function* allIds(list: DesignElement[]): Generator<string> {
    for (const el of list) {
      yield el.id;
      yield* allIds((el as { children?: DesignElement[] }).children ?? []);
    }
  }

  it("finds every element the walk finds, and no more", () => {
    for (const id of [...allIds(deep), "missing"]) {
      expect(findElementById(deep, id)?.id ?? null).toBe(id === "missing" ? null : id);
    }
  });

  it("names the direct parent, at any depth", () => {
    expect(findParentById(deep, "deep_leaf")?.id).toBe("inner");
    expect(findParentById(deep, "leaf")?.id).toBe("outer");
    expect(findParentById(deep, "outer")).toBeNull();
    expect(findParentById(deep, "sibling")).toBeNull();
  });

  it("keeps the first match for a duplicated id", () => {
    const dup: DesignElement[] = [
      { id: "a", type: "frame", x: 0, y: 0, width: 1, height: 1, children: [{ id: "dup", type: "rect", x: 0, y: 0, width: 1, height: 1 }] },
      { id: "b", type: "frame", x: 0, y: 0, width: 1, height: 1, children: [{ id: "dup", type: "rect", x: 0, y: 0, width: 1, height: 1 }] }
    ];
    expect(findParentById(dup, "dup")?.id).toBe("a");
  });

  it("returns null for a tree that does not contain the id", () => {
    expect(findElementById([], "anything")).toBeNull();
  });
});
