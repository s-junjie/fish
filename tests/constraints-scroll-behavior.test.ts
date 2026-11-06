import { describe, expect, it } from "vitest";
import type { ComponentElement, DesignDocument, DesignElement, InstanceElement } from "../src/core/dsl/types";
import {
  canConstrainChild,
  parentPlacesChildren,
  parentScrollOf,
  selectionParent
} from "../src/ui/inspector/selection-parent";

const canvas = { width: 1000, height: 1000, background: { type: "solid", color: "#FFFFFF" } } as never;

const child: DesignElement = {
  id: "label",
  type: "text",
  x: 0,
  y: 0,
  width: 40,
  height: 16,
  content: "Hi",
  style: {}
} as unknown as DesignElement;
const inner: DesignElement = {
  id: "inner",
  type: "frame",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  clipContent: true,
  children: [child]
} as unknown as DesignElement;

const master: ComponentElement = {
  id: "cmp",
  type: "component",
  name: "Card",
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  clipContent: true,
  scrollOverflow: "vertical",
  children: [inner]
};
const instance: InstanceElement = {
  id: "inst",
  type: "instance",
  componentId: "cmp",
  x: 400,
  y: 0,
  width: 200,
  height: 200
};
const frame: DesignElement = {
  id: "box",
  type: "frame",
  x: 0,
  y: 0,
  width: 300,
  height: 300,
  children: [instance]
} as unknown as DesignElement;

const doc = {
  pages: [{ id: "p1", name: "P1", children: [master, frame] }]
} as unknown as DesignDocument;

describe("the parent of a selection", () => {
  it("is the stored parent, for a stored node", () => {
    expect(selectionParent(doc, instance)?.id).toBe("box");
  });

  it("is the instance, for a layer the instance projects straight onto", () => {
    const clone = { ...inner, id: "inst_inner" } as DesignElement;
    expect(selectionParent(doc, clone)?.id).toBe("inst");
  });

  it("is the frame inside the master, for a layer nested one level deeper", () => {
    // Clone ids are flat — `<instance>_<master node>` at any depth — so the label
    // inside `inner` is `inst_label`, not `inst_inner_label`.
    const clone = { ...child, id: "inst_label" } as DesignElement;
    expect(selectionParent(doc, clone)?.id).toBe("inst_inner");
  });
});

describe("what the parent does with what it holds", () => {
  it("is inherited from the master, on an instance that never said otherwise", () => {
    expect(parentScrollOf(doc, instance)).toEqual({ clipContent: true, scrollOverflow: "vertical" });
  });

  it("is the instance's own answer where it has one", () => {
    const off = { ...instance, clipContent: false, scrollOverflow: "none" } as InstanceElement;
    expect(parentScrollOf(doc, off)).toEqual({ clipContent: false, scrollOverflow: "none" });
  });

  it("is read straight off a plain frame", () => {
    expect(parentScrollOf(doc, frame)).toEqual({ clipContent: false, scrollOverflow: "none" });
    const scroller = { ...frame, clipContent: true, scrollOverflow: "both" } as DesignElement;
    expect(parentScrollOf(doc, scroller)).toEqual({ clipContent: true, scrollOverflow: "both" });
  });
});

describe("whether a selection may be given constraints", () => {
  it("is never, inside an instance: that geometry is the master's", () => {
    const clone = { ...inner, id: "inst_inner", __instanceId: "inst" } as DesignElement;
    expect(canConstrainChild(clone, false), "even under a free-flowing parent").toBe(false);
    expect(canConstrainChild(clone, true)).toBe(false);
    expect(canConstrainChild({ ...clone, position: "absolute" } as DesignElement, true)).toBe(false);
  });

  it("is yes for a stored child, in the two branches the engine has", () => {
    const stored = { ...child, id: "label2" } as DesignElement;
    expect(canConstrainChild(stored, false), "a parent with no layout constrains every child").toBe(true);
    expect(canConstrainChild(stored, true), "one that places its children constrains only what left the flow").toBe(false);
    expect(canConstrainChild({ ...stored, position: "absolute" } as DesignElement, true)).toBe(true);
  });

  it("reads the layout off the master when the parent is an instance", () => {
    const flexMaster = { ...master, display: "flex" } as ComponentElement;
    const d = {
      pages: [{ id: "p1", name: "P1", children: [flexMaster, instance] }]
    } as unknown as DesignDocument;
    expect(parentPlacesChildren(d, instance), "an instance stores none of its own").toBe(true);
    expect(parentPlacesChildren(doc, instance), "a master with no layout places nothing").toBe(false);
  });
});
