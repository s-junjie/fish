import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import {
  cloneWithNewIds,
  collectTopMostSelected,
  insertClones,
  insertClonesAtRoot,
  insertClonesIntoContainer,
  offsetCenteringSourcesIn,
  removeElements,
  removeElementsWithRelayout,
  resolvePastePlacement
} from "../src/core/interactions/clipboard";
import { relayoutDocumentTree } from "../src/core/compile";
import { findElementById, flattenElements } from "../src/core/geometry/tree-ops";
import { FrameElement, RectElement, TextElement, LineElement, DesignElement, ComponentElement, ComponentSetElement, InstanceElement } from "../src/core/dsl/types";

const rect = (id: string, x = 0, y = 0): RectElement => ({
  id,
  type: "rect",
  x,
  y,
  width: 100,
  height: 50
});

const frame = (id: string, children: DesignElement[]): FrameElement => ({
  id,
  type: "frame",
  x: 0,
  y: 0,
  width: 400,
  height: 400,
  children
});

describe("Copy / paste / duplicate plumbing", () => {
  it("clones a subtree with fresh ids everywhere", () => {
    const src = frame("f1", [rect("r1"), rect("r2")]);
    const { clone, idMap } = cloneWithNewIds(src);

    expect(clone.id).not.toBe("f1");
    const ids = flattenElements([clone]).map((el) => el.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain("f1");
    expect(ids).not.toContain("r1");
    expect(idMap.get("r1")).toBeTruthy();
    expect((clone as FrameElement).children).toHaveLength(2);
  });

  it("remaps a text-on-path reference that was copied together with its path", () => {
    const path: DesignElement = {
      id: "p1",
      type: "path",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      d: "M 0 0 L 100 100",
      fills: []
    };
    const text: TextElement = {
      id: "t1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      content: "hi",
      style: { fontFamily: "Inter", fontSize: 16, color: "#fff" },
      onPath: { pathId: "p1", startOffset: 0 }
    };
    const group = frame("f1", [path, text]);
    const { clone, idMap } = cloneWithNewIds(group);
    const clonedText = flattenElements([clone]).find((el) => el.type === "text") as TextElement;
    expect(clonedText.onPath?.pathId).toBe(idMap.get("p1"));
    expect(clonedText.onPath?.pathId).not.toBe("p1");
  });

  it("re-points a cloned set's members at the clone, not the original", () => {
    const variant = (id: string, state: string): ComponentElement => ({
      id,
      type: "component",
      name: `Button ${state}`,
      setId: "set_btn",
      variantProperties: { State: state },
      x: 24,
      y: 24,
      width: 100,
      height: 40,
      children: []
    });
    const set: ComponentSetElement = {
      id: "set_btn",
      type: "componentSet",
      name: "Button",
      x: 0,
      y: 0,
      width: 260,
      height: 90,
      children: [variant("c_on", "on"), variant("c_off", "off")]
    };
    const { clone, idMap } = cloneWithNewIds(set);
    const copied = clone as ComponentSetElement;
    expect(copied.id).toBe(idMap.get("set_btn"));
    expect(copied.id).not.toBe("set_btn");
    // A copy whose members still name the original would show up as one more
    // member of somebody else's set, with no border of its own on screen.
    for (const child of copied.children as ComponentElement[]) {
      expect(child.setId).toBe(copied.id);
    }
  });

  it("keeps line endpoints intact through a clone", () => {
    const src: LineElement = {
      id: "l1",
      type: "line",
      x: 10,
      y: 20,
      dx: 100,
      dy: 0,
      width: 100,
      height: 0,
      strokes: [{ color: "#fff", width: 2 }]
    };
    const { clone } = cloneWithNewIds(src) as { clone: LineElement };
    expect(clone.dx).toBe(100);
    expect(clone.dy).toBe(0);
  });

  it("collects only top-most selected elements", () => {
    const tree = [rect("r1"), frame("f1", [rect("r2"), rect("r3")])];

    expect(collectTopMostSelected(tree, new Set(["r1", "r2"])).map((e) => e.id)).toEqual(["r1", "r2"]);
    expect(collectTopMostSelected(tree, new Set(["f1", "r2"])).map((e) => e.id)).toEqual(["f1"]);
    expect(collectTopMostSelected(tree, new Set()).map((e) => e.id)).toEqual([]);
  });

  it("pastes each clone directly above its original inside the same parent", () => {
    const tree = [rect("r1"), frame("f1", [rect("r2")])];
    const sources = [tree[1]];
    const { elements, newIds } = insertClones(tree, sources);

    expect(elements).toHaveLength(3);
    const pastedFrame = findElementById(elements, newIds[0]) as FrameElement;
    expect(pastedFrame).toBeTruthy();
    expect(pastedFrame.children).toHaveLength(1);
    expect(pastedFrame.children[0].id).not.toBe("r2");

    const f1 = elements.find((el) => el.id === "f1") as FrameElement;
    const pasted = elements.find((el) => el.id === newIds[0]) as FrameElement;
    // original z-order preserved, clone sits immediately above it
    expect(elements.indexOf(pasted)).toBe(elements.indexOf(f1) + 1);
  });

  it("pastes a nested source next to that child, not at the root", () => {
    const tree = [frame("f1", [rect("r2")])];
    const sources = [(tree[0] as FrameElement).children[0]];
    const { elements, newIds } = insertClones(tree, sources);

    const f1 = elements[0] as FrameElement;
    expect(f1.children.map((c) => c.id)).toEqual(["r2", newIds[0]]);
    expect(elements).toHaveLength(1);
  });

  it("appends clones whose original was deleted", () => {
    const tree = [rect("r1")];
    const sources = [rect("gone", 5, 5)];
    const { elements, newIds } = insertClones(tree, sources);
    expect(elements).toHaveLength(2);
    expect(elements[1].id).toBe(newIds[0]);
    expect(elements[1].x).toBe(5);
  });

  it("applies an offset to the whole pasted subtree (v0.3 preserves local child coords)", () => {
    const tree = [frame("f1", [rect("r2", 10, 10)])];
    const { elements, newIds } = insertClones(tree, tree, { x: 40, y: 30 });
    const pasted = findElementById(elements, newIds[0]) as FrameElement;
    expect(pasted.x).toBe(40);
    expect(pasted.y).toBe(30);
    // In v0.3 local coordinates, child retains its local coordinates (10, 10) relative to parent frame
    expect(pasted.children[0].x).toBe(10);
    expect(pasted.children[0].y).toBe(10);
  });

  it("maps each source id to its clone root, not to any descendant", () => {
    const tree = [frame("f1", [rect("r2", 10, 10)]), rect("r3")];
    const sources = [tree[0], tree[1]];
    const { elements, newIds, rootIdBySource } = insertClones(tree, sources);

    // newIds lists the frame root AND its re-minted child, so it cannot address
    // the copies as whole units on its own.
    expect(newIds).toHaveLength(3);
    const frameCloneId = rootIdBySource.get("f1")!;
    const rectCloneId = rootIdBySource.get("r3")!;
    expect(rootIdBySource.size).toBe(2);
    expect(newIds).toContain(frameCloneId);
    expect(newIds).toContain(rectCloneId);

    const frameClone = findElementById(elements, frameCloneId) as FrameElement;
    expect(frameClone.type).toBe("frame");
    expect(frameClone.children[0].id).not.toBe(rootIdBySource.get("f1"));
  });

  it("maps a component master to the instance it was cloned into", () => {
    const master: ComponentElement = { id: "c1", type: "component", x: 0, y: 0, width: 50, height: 50, children: [] };
    const { elements, rootIdBySource } = insertClones([master], [master]);
    const instance = findElementById(elements, rootIdBySource.get("c1")!) as InstanceElement;
    expect(instance.type).toBe("instance");
    expect(instance.componentId).toBe("c1");
  });

  it("pastes into a selected container, keeping the source's relative position", () => {
    const targetFrame: FrameElement = {
      id: "f1",
      type: "frame",
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      children: []
    };
    const externalRect = rect("r1", 30, 70); // 100x50, sitting 30/70 inside its own parent
    const tree = [targetFrame, externalRect];

    const { elements, newIds } = insertClonesIntoContainer(tree, [externalRect], "f1");
    const updatedFrame = findElementById(elements, "f1") as FrameElement;
    expect(updatedFrame.children).toHaveLength(1);

    const pastedRect = updatedFrame.children[0] as RectElement;
    expect(pastedRect.id).toBe(newIds[0]);
    // Coordinates are parent-local, so the source's own x/y is already its
    // position relative to the frame it is going into. Recentring it on the
    // target would throw that away — the copy belongs where the content sat,
    // not in the middle of whatever frame it was pasted into.
    expect(pastedRect.x).toBe(30);
    expect(pastedRect.y).toBe(70);
  });

  it("a paste into another frame is not recentred on the target if it fits within bounds", () => {
    // 400x300 target, source 100x50 at (0, 0): fits within [0, 400] x [0, 300], keeps (0, 0)
    const targetFrame: FrameElement = { id: "f1", type: "frame", x: 0, y: 0, width: 400, height: 300, children: [] };
    const source = rect("r1", 0, 0);

    const { elements } = insertClonesIntoContainer([targetFrame, source], [source], "f1");
    const pasted = (findElementById(elements, "f1") as FrameElement).children[0] as RectElement;
    expect([pasted.x, pasted.y]).toEqual([0, 0]);
  });

  it("centers pasted element in target frame if source coordinates fall completely outside target frame bounds", () => {
    // Target 400x300, source 100x50 at (800, 600) — completely outside target frame!
    const targetFrame: FrameElement = { id: "f1", type: "frame", x: 0, y: 0, width: 400, height: 300, children: [] };
    const source = rect("r1", 800, 600);

    const { elements } = insertClonesIntoContainer([targetFrame, source], [source], "f1");
    const pasted = (findElementById(elements, "f1") as FrameElement).children[0] as RectElement;
    // Centred in 400x300: x = 400/2 - 100/2 = 150, y = 300/2 - 50/2 = 125
    expect([pasted.x, pasted.y]).toEqual([150, 125]);
  });

  it("keeps relative coordinates if pasted element only partially exceeds frame bounds", () => {
    // Target 400x300, source 100x50 at (-50, 100) — partially exceeds left boundary, but overlaps [0, 50] horizontally
    const targetFrame: FrameElement = { id: "f1", type: "frame", x: 0, y: 0, width: 400, height: 300, children: [] };
    const source = rect("r1", -50, 100);

    const { elements } = insertClonesIntoContainer([targetFrame, source], [source], "f1");
    const pasted = (findElementById(elements, "f1") as FrameElement).children[0] as RectElement;
    // Keeps relative coordinates (-50, 100)
    expect([pasted.x, pasted.y]).toEqual([-50, 100]);
  });

  it("centers pasted element in visible area of target frame when viewport is provided", () => {
    // Target at canvas (0, 0), 400x300.
    // Viewport only sees [200, 0, 400, 300], so visible portion of frame is [200, 0, 200, 300].
    const targetFrame: FrameElement = { id: "f1", type: "frame", x: 0, y: 0, width: 400, height: 300, children: [] };
    const source = rect("r1", 800, 600); // 100x50

    const { elements } = insertClonesIntoContainer([targetFrame, source], [source], "f1", {
      viewport: { x: 200, y: 0, width: 400, height: 300 }
    });
    const pasted = (findElementById(elements, "f1") as FrameElement).children[0] as RectElement;
    // Visible target in local space is x in [200, 400], y in [0, 300]:
    // center x = 200 + 200/2 - 100/2 = 250, center y = 0 + 300/2 - 50/2 = 125
    expect([pasted.x, pasted.y]).toEqual([250, 125]);
  });

  it("pastes into a selected container with offset when source was already in container", () => {
    const childRect = rect("r_inside", 120, 120);
    const targetFrame: FrameElement = {
      id: "f1",
      type: "frame",
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      children: [childRect]
    };
    const tree = [targetFrame];

    const { elements, newIds } = insertClonesIntoContainer(tree, [childRect], "f1");
    const updatedFrame = findElementById(elements, "f1") as FrameElement;
    expect(updatedFrame.children).toHaveLength(2);

    const pastedRect = updatedFrame.children[1] as RectElement;
    expect(pastedRect.id).toBe(newIds[0]);
    expect(pastedRect.x).toBe(140);
    expect(pastedRect.y).toBe(140);
  });

  it("removes elements from anywhere in the tree", () => {
    const tree = [rect("r1"), frame("f1", [rect("r2")])];
    const next = removeElements(tree, new Set(["r2"]));
    expect(next).toHaveLength(2);
    expect((next[1] as FrameElement).children).toHaveLength(0);
    expect(removeElements(tree, new Set(["r1"]))[0].id).toBe("f1");
    expect((removeElements(tree, new Set(["r1"]))[0] as FrameElement).children).toHaveLength(1);
  });
});

/**
 * Deleting a child is a structural change, so the whole tree owes itself a
 * reflow: a hug frame that lost its last child has to collapse, and that size
 * change has to reach its ancestors.
 */
describe("removing elements reflows the whole tree", () => {
  const nested = (): DesignElement[] => [
    {
      id: "outer",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 500,
      sizing: { height: "fit-content" },
      ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 0 }),
      children: [
        {
          id: "inner",
          type: "frame",
          x: 0,
          y: 0,
          width: 300,
          height: 500,
          sizing: { height: "fit-content" },
          ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 10 }),
          children: [rect("leaf", 0, 0)]
        } as FrameElement
      ]
    } as FrameElement
  ];

  it("collapses the emptied frame and every ancestor above it", () => {
    const laid = relayoutDocumentTree(nested());
    expect((laid[0] as FrameElement).height).toBe(70); // leaf 50 + inner padding 20
    const next = removeElementsWithRelayout(laid, new Set(["leaf"]));
    const outer = next[0] as FrameElement;
    expect((outer.children[0] as FrameElement).height).toBe(20); // padding only
    expect(outer.height).toBe(20);
  });
});

describe("Where a paste lands", () => {
  const nested = () => [frame("f1", [rect("r2", 30, 40)])];

  // The regression: with nothing selected, `insertClones` files the copy beside
  // its original — so a layer copied out of a frame came straight back into that
  // frame, and a page-root source pasted after a scroll landed at a coordinate
  // the current view does not show.
  it("a nested source with an empty selection goes onto the canvas", () => {
    const tree = nested();
    const sources = [(tree[0] as FrameElement).children[0]];

    expect(resolvePastePlacement(tree, sources, [])).toEqual({ kind: "onto-canvas" });

    const { elements, newIds } = insertClonesAtRoot(tree, sources, { x: 0, y: 0 });
    expect(elements).toHaveLength(2);
    expect(elements[1].id).toBe(newIds[0]);
    expect((elements[0] as FrameElement).children).toHaveLength(1);
  });

  it("a page-root source with an empty selection is centred too, not nudged in place", () => {
    const tree = [rect("r1", 5000, 5000)];
    expect(resolvePastePlacement(tree, tree, [])).toEqual({ kind: "onto-canvas" });
  });

  it("an id the tree does not hold is not a selection either", () => {
    const tree = [rect("r1", 5000, 5000)];
    expect(resolvePastePlacement(tree, tree, ["gone"])).toEqual({ kind: "onto-canvas" });
  });

  it("a page-root source pasted beside a non-container selection keeps the paste-in-place nudge", () => {
    const tree = [rect("r1"), rect("other", 300, 300)];
    expect(resolvePastePlacement(tree, [tree[0]], ["other"])).toEqual({ kind: "beside-original" });
  });

  it("a selected container takes the paste", () => {
    const tree = [frame("f1", [rect("r2")]), frame("f2", [])];
    const sources = [(tree[0] as FrameElement).children[0]];
    expect(resolvePastePlacement(tree, sources, ["f2"])).toEqual({ kind: "into", containerIds: ["f2"] });
  });

  it("a locked container is not a destination", () => {
    const tree = [{ ...frame("f1", [rect("r2")]), locked: true }];
    const sources = [(tree[0] as FrameElement).children[0]];
    expect(resolvePastePlacement(tree, sources, ["f1"])).toEqual({ kind: "onto-canvas" });
  });

  it("a container that is itself in the clipboard never receives its own clone", () => {
    const tree = [frame("f1", [rect("r2")])];
    expect(resolvePastePlacement(tree, tree, ["f1"])).toEqual({ kind: "beside-original" });
  });

  it("centres the cloned group in the target rect", () => {
    // r2 is 100x50 at (30, 40) inside a frame at (0, 0), so the rect's centre
    // (1050, 1050) needs a (970, 985) move.
    const tree = nested();
    const sources = [(tree[0] as FrameElement).children[0]];
    const target = { x: 1000, y: 1000, width: 100, height: 100 };
    expect(offsetCenteringSourcesIn(sources, target)).toEqual({ x: 970, y: 985 });

    const { elements, newIds } = insertClonesAtRoot(tree, sources, offsetCenteringSourcesIn(sources, target));
    const pasted = elements[1];
    expect(pasted.id).toBe(newIds[0]);
    // A page-root child is positioned in canvas coordinates, so after the
    // translate its centre is the rect's centre — not its parent-relative spot.
    expect(pasted.x + 50).toBe(1050);
    expect(pasted.y + 25).toBe(1050);
  });

  it("the frame's own origin does not drag the paste off target", () => {
    // A clone appended to the root is placed at `src.x + offset`, so measuring the
    // source in canvas space would cancel the translate and land the paste short
    // by the parent frame's origin.
    const tree = [{ ...frame("f1", [rect("r2", 30, 40)]), x: 200, y: 300 }];
    const sources = [(tree[0] as FrameElement).children[0]];
    const target = { x: 0, y: 0, width: 800, height: 600 };

    const { elements, newIds } = insertClonesAtRoot(tree, sources, offsetCenteringSourcesIn(sources, target));
    const pasted = elements[1];
    expect(pasted.id).toBe(newIds[0]);
    expect(pasted.x + 50).toBe(400);
    expect(pasted.y + 25).toBe(300);
  });
});
