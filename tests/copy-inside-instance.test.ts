import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { ComponentElement, DesignDocument, DesignElement, InstanceElement } from "../src/core/dsl/types";
import {
  collectCopySources,
  collectTopMostSelected,
  insertClones
} from "../src/core/interactions/clipboard";
import {
  hasStoredSelection,
  isStoredNode,
  resolveInstanceChildren,
  resolveInstanceSelection
} from "../src/core/interactions/instance-resolve";
import { overrideDerivedNodes } from "../src/core/interactions/instance-overrides";
import { applyCopiedStyle, copyStyleFrom } from "../src/core/interactions/style-clipboard";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import { findElementById } from "../src/core/geometry/tree-ops";

const canvas = {
  width: 1200,
  height: 800,
  background: { type: "solid" as const, color: "#101010" },
  unit: "px" as const
};

const leaf = (id: string, x = 0, y = 0): DesignElement => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: 40,
  height: 20,
  fills: [{ type: "solid", color: "#3B82F6" }]
});

/** Master with a leaf and a nested frame holding another leaf. */
function master(id = "cmp"): ComponentElement {
  return {
    id,
    type: "component",
    name: "Card",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    children: [
      leaf("LEAF", 10, 10),
      {
        id: "SUB",
        type: "frame",
        name: "SUB",
        x: 60,
        y: 50,
        width: 120,
        height: 40,
        children: [leaf("DEEP", 5, 5)]
      } as DesignElement
    ]
  };
}

const instance = (): InstanceElement => ({
  id: "inst",
  type: "instance",
  name: "Card Instance",
  componentId: "cmp",
  x: 400,
  y: 100,
  width: 200,
  height: 100
});

function doc(): DesignDocument {
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    elements: [instance(), master()],
    pages: [{ id: "page_design", name: "Design", canvas, children: [instance(), master()] }],
    activePageId: "page_design"
  };
}

describe("a copy taken inside an instance", () => {
  it("is the one selection Copy used to collect nothing from", () => {
    const d = doc();
    // The defect, stated as the tree walk's own answer: a resolved clone is
    // painted but never stored, so the walk finds no source and Copy closed the
    // menu having done nothing.
    expect(collectTopMostSelected(getActivePage(d).children, new Set(["inst_LEAF"]))).toEqual([]);
    expect(collectCopySources(d, getActivePage(d).children, new Set(["inst_LEAF"]))).toHaveLength(1);
  });

  it("hands back a real node, not a clone carrying its derived markers", () => {
    const d = doc();
    const [unit] = collectCopySources(d, getActivePage(d).children, new Set(["inst_LEAF"]));
    expect(unit.id).toBe("inst_LEAF");
    expect((unit as { __instanceId?: string }).__instanceId).toBeUndefined();
    expect((unit as { __masterNodeId?: string }).__masterNodeId).toBeUndefined();
  });

  it("moves it to the canvas position it is painted at", () => {
    const d = doc();
    // The instance sits at (400, 100) and LEAF at (10, 10) inside the master, so
    // the pasted copy belongs at (410, 110) — its own x/y are relative to a parent
    // that exists only inside the resolution.
    const [unit] = collectCopySources(d, getActivePage(d).children, new Set(["inst_LEAF"]));
    expect([unit.x, unit.y]).toEqual([410, 110]);
  });

  it("adds every step the nest contributes, not just the instance's own origin", () => {
    const d = doc();
    // DEEP sits at (5, 5) inside SUB, which sits at (60, 50) inside the master.
    const [unit] = collectCopySources(d, getActivePage(d).children, new Set(["inst_DEEP"]));
    expect([unit.x, unit.y]).toEqual([465, 155]);
  });

  it("pastes the unit where the layer was painted, not at the page origin", () => {
    const d = doc();
    const units = collectCopySources(d, getActivePage(d).children, new Set(["inst_LEAF"]));
    const { elements, newIds } = insertClones(getActivePage(d).children, units, { x: 0, y: 0 });

    // The instance has no stored child to sit beside, so the clone falls to the
    // page root — at the coordinates the unit carries.
    const pasted = findElementById(elements, newIds[0])!;
    expect([pasted.x, pasted.y]).toEqual([410, 110]);
    expect(pasted.id).not.toBe("inst_LEAF");
  });

  it("strips the markers all the way down a copied container", () => {
    const d = doc();
    const [unit] = collectCopySources(d, getActivePage(d).children, new Set(["inst_SUB"]));
    const sub = unit as { children?: DesignElement[] };
    const children = sub.children ?? [];
    expect(children).toHaveLength(1);
    expect((children[0] as { __instanceId?: string }).__instanceId).toBeUndefined();
  });

  it("is not a second unit when the instance projecting it is already one", () => {
    const d = doc();
    const units = collectCopySources(d, getActivePage(d).children, new Set(["inst", "inst_LEAF"]));
    expect(units.map((u) => u.id)).toEqual(["inst"]);
  });

  it("carries a stored node untouched", () => {
    const d = doc();
    const units = collectCopySources(d, getActivePage(d).children, new Set(["cmp"]));
    expect(units[0]).toBe(findElementById(getActivePage(d).children, "cmp"));
  });

  it("carries nothing for an id that resolves to nothing", () => {
    const d = doc();
    expect(collectCopySources(d, getActivePage(d).children, new Set(["ghost"]))).toEqual([]);
  });
});

/**
 * The predicate the commands ask instead of `editableIds`, which keeps an id with
 * no element behind it on purpose — a resolved clone is still draggable through
 * its override path. A command that writes back BY id needs to know whether the
 * tree has anywhere to put the write.
 */
describe("telling a stored node from a resolved clone", () => {
  it("answers for a stored node", () => {
    const d = doc();
    expect(isStoredNode(d, "inst")).toBe(true);
    expect(hasStoredSelection(d, ["inst"])).toBe(true);
  });

  it("answers the other way for a layer inside an instance", () => {
    const d = doc();
    expect(isStoredNode(d, "inst_LEAF")).toBe(false);
    expect(hasStoredSelection(d, ["inst_LEAF", "inst_DEEP"])).toBe(false);
  });

  it("is satisfied by one stored node in a mixed selection", () => {
    const d = doc();
    expect(hasStoredSelection(d, ["inst_LEAF", "cmp"])).toBe(true);
  });

  it("is not satisfied by nothing", () => {
    expect(hasStoredSelection(doc(), [])).toBe(false);
  });
});

/**
 * Paste properties onto a layer the instance projects. The write has no tree to
 * land in, so the payload can only become overrides on the instance — and the
 * question is whether every field it carries has an override to become.
 *
 * The one that did not was `fillEnabled`: an earlier property list advertised it
 * as overridable while the union the engine reads never carried it, so a layer
 * whose whole fill stack was switched off came back with its colours and without
 * the switch, and painted.
 */
describe("pasting a copied style onto a layer inside an instance", () => {
  const source = (): DesignElement => ({
    id: "src",
    type: "rect",
    name: "src",
    x: 900,
    y: 0,
    width: 40,
    height: 20,
    fills: [{ type: "solid", color: "#EF4444" }],
    borderRadius: 12,
    opacity: 0.5,
    blendMode: "multiply",
    fillEnabled: false
  });

  const instOf = (d: DesignDocument) => findElementById(getActivePage(d).children, "inst") as InstanceElement;

  const resolvedLeaf = (d: DesignDocument) =>
    resolveInstanceChildren(instOf(d), findMasterComponent(d, "cmp")!).find(
      (el) => el.id === "inst_LEAF"
    )!;

  it("lands every field it carries, `fillEnabled` included", () => {
    const d = doc();
    const copied = copyStyleFrom(source())!;
    const next = overrideDerivedNodes(d, ["inst_LEAF"], (el) => applyCopiedStyle(el, copied))!;
    expect(instOf(next.doc).overrides).toEqual([
      { targetId: "LEAF", property: "fills", value: [{ type: "solid", color: "#EF4444" }] },
      { targetId: "LEAF", property: "borderRadius", value: 12 },
      { targetId: "LEAF", property: "blendMode", value: "multiply" },
      { targetId: "LEAF", property: "opacity", value: 0.5 },
      { targetId: "LEAF", property: "fillEnabled", value: false }
    ]);
  });

  it("and the layer reads back with its fill switched off", () => {
    const d = doc();
    const next = overrideDerivedNodes(d, ["inst_LEAF"], (el) =>
      applyCopiedStyle(el, copyStyleFrom(source())!)
    )!;
    const leaf = resolvedLeaf(next.doc);
    expect(leaf.fillEnabled).toBe(false);
    expect(leaf.fills).toEqual([{ type: "solid", color: "#EF4444" }]);
    // Only the instance: the definition it resolves against keeps its own paint.
    expect(((findElementById(getActivePage(next.doc).children, "cmp") as ComponentElement).children[0] as any).fillEnabled)
      .toBeUndefined();
  });

  it("can read a style off a clone, so the pair works in both directions", () => {
    const d = doc();
    const copied = copyStyleFrom(resolvedLeaf(d));
    expect(copied?.fills).toEqual([{ type: "solid", color: "#3B82F6" }]);
  });

  it("stores nothing when the payload already matches what the instance paints", () => {
    const d = doc();
    // Copying the layer's own properties and pasting them back is the case that
    // would otherwise leave an undo step behind that changes nothing.
    const copied = copyStyleFrom(resolvedLeaf(d))!;
    expect(overrideDerivedNodes(d, ["inst_LEAF"], (el) => applyCopiedStyle(el, copied))).toBeNull();
  });

  it("names a node behind a frame by its bare id, not by a path", () => {
    const d = doc();
    // SUB is a frame of the SAME master, and the resolution walks frames
    // recursively, so the bare id already reaches it. A path segment starts only
    // where the walk crosses into another instance.
    expect(resolveInstanceSelection(d, "inst_DEEP")?.masterNodeId).toBe("DEEP");
    const next = overrideDerivedNodes(d, ["inst_DEEP"], (el) =>
      applyCopiedStyle(el, copyStyleFrom(source())!)
    )!;
    expect((findElementById(getActivePage(next.doc).children, "inst") as InstanceElement).overrides?.[0]).toEqual({
      targetId: "DEEP",
      property: "fills",
      value: [{ type: "solid", color: "#EF4444" }]
    });
  });
});
