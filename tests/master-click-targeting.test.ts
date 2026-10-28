import { describe, it, expect } from "vitest";
import type { ComponentElement, DesignDocument, DesignElement } from "../src/core/dsl/types";
import { resolveSingleClickTarget, enclosingMasterComponent, hasSelectedDescendant } from "../src/ui/hooks/canvas-gestures/targeting";
import { flattenElements } from "../src/core/geometry/tree-ops";

/**
 * A main component is a definition, so a single click on it selects the master
 * rather than its guts — that barrier is what makes a definition hard to edit by
 * accident. But a barrier that never lifts is a trap: once you are inside, every
 * further click bounced back to the master, so no sibling was reachable and only
 * the one node you drilled into could be moved. The selection IS the "inside"
 * state, which is why these cases are all about what is already selected.
 */
const master = (): ComponentElement => ({
  id: "M",
  type: "component",
  name: "M",
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  children: [
    {
      id: "f1",
      type: "frame",
      name: "f1",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [{ id: "a", type: "rect", name: "a", x: 4, y: 4, width: 10, height: 10 }]
    },
    {
      id: "f2",
      type: "frame",
      name: "f2",
      x: 100,
      y: 0,
      width: 100,
      height: 100,
      children: [
        { id: "b", type: "rect", name: "b", x: 4, y: 4, width: 10, height: 10 },
        {
          id: "f3",
          type: "frame",
          name: "f3",
          x: 40,
          y: 40,
          width: 40,
          height: 40,
          children: [{ id: "c", type: "rect", name: "c", x: 2, y: 2, width: 8, height: 8 }]
        }
      ]
    }
  ]
});

const elements = (): DesignElement[] => [master() as DesignElement];
const byId = (id: string) => flattenElements(elements()).find((e) => e.id === id)!;
/** Only the active page matters: `resolveSingleClickTarget` reads the document
 * to walk instances, and these cases are all plain frames. */
const docOf = (els: DesignElement[]): DesignDocument => ({
  version: "0.1",
  id: "doc",
  name: "doc",
  createdAt: "",
  updatedAt: "",
  canvas: { unit: "px", background: { type: "solid", color: "#000000" } },
  pages: [{ id: "p", name: "p", canvas: { unit: "px", background: { type: "solid", color: "#000000" } }, children: els }],
  activePageId: "p"
});
const target = (id: string, selected: string[]) =>
  resolveSingleClickTarget(docOf(elements()), elements(), byId(id), new Set(selected));

describe("a main component is opaque only from the outside", () => {
  it("the nearest enclosing master is the barrier", () => {
    expect(enclosingMasterComponent(elements(), byId("b"))?.id).toBe("M");
    expect(enclosingMasterComponent(elements(), byId("c"))?.id).toBe("M");
    expect(enclosingMasterComponent(elements(), byId("M"))).toBeNull();
  });

  it("from outside, every click lands on the master", () => {
    expect(target("a", [])).toBe("M");
    expect(target("b", [])).toBe("M");
    expect(target("f2", [])).toBe("M");
    // Deep too — the barrier is the nearest master, not the outermost one.
    expect(target("c", [])).toBe("M");
  });

  it("the master being selected keeps the barrier, so a click moves it", () => {
    // Selecting the master is looking at it from outside, not being inside it.
    expect(target("b", ["M"])).toBe("M");
    expect(target("c", ["M"])).toBe("M");
  });

  it("once a child is selected, a sibling becomes reachable", () => {
    expect(hasSelectedDescendant(elements(), new Set(["a"]), "M")).toBe(true);
    expect(hasSelectedDescendant(elements(), new Set(["M"]), "M")).toBe(false);
    // A leaf still defers to its own frame — that is the ordinary frame rule and
    // the master is not what changed it.
    expect(target("f2", ["a"])).toBe("f2");
    expect(target("b", ["a"])).toBe("f2");
  });

  it("a deep selection still counts as being inside", () => {
    // `c` sits two frames below the master, so the one-level-up scope test would
    // miss it and the barrier would slam shut again.
    expect(hasSelectedDescendant(elements(), new Set(["c"]), "M")).toBe(true);
    expect(target("f2", ["c"])).toBe("f2");
  });

  it("inside the master the ordinary frame rules govern, with no master in sight", () => {
    // Every one of these previews a FRAME, which is what a single click would act
    // on: a leaf whose own frame is selected previews that frame (a click moves
    // it, a double click reaches the leaf). What matters is that the master is no
    // longer the answer — before the barrier lifted all three returned "M".
    expect(target("b", ["f2"])).toBe("f2");
    expect(target("c", ["f3"])).toBe("f3");
    expect(target("b", ["a"])).toBe("f2");
  });

  it("a selection outside the master leaves it closed", () => {
    const els: DesignElement[] = [
      { id: "outside", type: "rect", name: "outside", x: 400, y: 0, width: 10, height: 10 },
      master() as DesignElement
    ];
    expect(
      resolveSingleClickTarget(docOf(els), els, byId("b"), new Set(["outside"]))
    ).toBe("M");
  });
});
