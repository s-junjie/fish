import { describe, it, expect } from "vitest";
import {
  idsAvailable,
  insertClones,
  insertVerbatim,
  removeElementsWithRelayout
} from "../src/core/interactions/clipboard";
import { findElementById, flattenElements } from "../src/core/geometry/tree-ops";
import { resolveInstanceChildren } from "../src/core/interactions/instance-resolve";
import { ComponentElement, DesignElement, FrameElement, InstanceElement, RectElement } from "../src/core/dsl/types";

const rect = (id: string, x = 0, y = 0): RectElement => ({ id, type: "rect", x, y, width: 100, height: 50 });

const frame = (id: string, children: DesignElement[]): FrameElement => ({
  id,
  type: "frame",
  x: 0,
  y: 0,
  width: 400,
  height: 400,
  children
});

const master = (id: string): ComponentElement => ({
  id,
  type: "component",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  children: [rect(`${id}_label`, 10, 10)]
});

const instance = (id: string, componentId: string, x = 0, y = 0): InstanceElement => ({
  id,
  type: "instance",
  componentId,
  x,
  y,
  width: 200,
  height: 100
});

describe("a cut is a move: the sources come back under their own ids", () => {
  it("re-inserts at the page root with the ids intact", () => {
    const tree = [rect("a", 10, 10)];
    const cut = removeElementsWithRelayout(tree, new Set(["a"]));
    expect(findElementById(cut, "a")).toBeNull();

    // The caller owns the placement: a cut out of a frame is shifted by the
    // frame's own origin, because its local coordinates mean nothing at the root.
    const moved = { ...rect("a", 10, 10), x: 310, y: 50 };
    const pasted = insertVerbatim(cut, [moved], null);
    expect(pasted.ids).toEqual(["a"]);
    expect(findElementById(pasted.elements, "a")).toMatchObject({ id: "a", x: 310, y: 50 });
  });

  it("keeps a whole subtree's ids, so nothing inside it is renamed", () => {
    const f = frame("f1", [rect("a"), rect("b")]);
    const cut = removeElementsWithRelayout([f], new Set(["f1"]));
    const pasted = insertVerbatim(cut, [f], null);
    const ids = flattenElements(pasted.elements).map((el) => el.id);
    expect(ids).toEqual(["f1", "a", "b"]);
  });

  it("puts a cut into a selected container", () => {
    const tree = [frame("target", [])];
    const pasted = insertVerbatim(tree, [rect("a", 0, 0)], "target");
    const target = findElementById(pasted.elements, "target") as FrameElement;
    expect(target.children!.map((c) => c.id)).toEqual(["a"]);
  });

  it("falls back to the root when the destination is gone", () => {
    const pasted = insertVerbatim([rect("a")], [rect("b")], "missing");
    expect(flattenElements(pasted.elements).map((el) => el.id).sort()).toEqual(["a", "b"]);
  });

  it("reports which sources can no longer be re-inserted verbatim", () => {
    const tree = [rect("a")];
    expect(idsAvailable(tree, [rect("a")])).toBe(false);
    expect(idsAvailable(tree, [rect("b")])).toBe(true);
  });

  it("is the difference that keeps a main component's instances alive", () => {
    // The whole reason a cut cannot re-mint ids: an instance addresses its master
    // by id from anywhere in the file, so a renamed master orphans it for good.
    const m = master("comp1");
    const tree = [m, instance("inst1", "comp1", 400, 0)];
    const sources = [m];

    const cut = removeElementsWithRelayout(tree, new Set(["comp1"]));
    expect(findElementById(cut, "comp1")).toBeNull();

    const pasted = insertVerbatim(cut, sources, null);
    const restored = findElementById(pasted.elements, "comp1") as ComponentElement;
    const inst = findElementById(pasted.elements, "inst1") as InstanceElement;
    expect(restored.id).toBe("comp1");
    expect(resolveInstanceChildren(inst, restored)).toHaveLength(1);
  });

  it("a copy of the same master mints a new id, which orphans the instance", () => {
    // The counter-case that justifies the split: a COPY must not re-insert under
    // the source id, or two definitions would answer to the same name.
    const m = master("comp1");
    const tree = [m, instance("inst1", "comp1", 400, 0)];
    const { elements } = insertClones(tree, [m], { x: 0, y: 0 });
    const inst = findElementById(elements, "inst1") as InstanceElement;
    const stillThere = findElementById(elements, "comp1");
    // The clone path pastes a master as an INSTANCE of it (Figma parity), so the
    // document keeps exactly one definition and the pasted node is not one.
    expect(stillThere?.type).toBe("component");
    expect(inst.componentId).toBe("comp1");
    expect(resolveInstanceChildren(inst, stillThere as ComponentElement)).toHaveLength(1);
  });
});
