import { describe, expect, it } from "vitest";
import { ancestorChain } from "../src/core/interactions/component-swap";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * The layer trail along the bottom edge needs every ancestor of the selection,
 * in order, and it needs them from two different trees.
 *
 * A stored node hangs off its parents in the document. A child clicked inside an
 * instance does not exist there at all — it is a resolved clone, reachable only
 * through the instance that projects it — so a trail built from parents alone
 * stops dead at the instance and loses the deepest part of the path, which is
 * also the part a user clicks most. Walking the tree would also have been enough
 * for every document without components, which is exactly how such a gap stays
 * hidden until someone selects a layer inside an instance.
 */

const rect = (id: string): DesignElement =>
  ({ id, type: "rect", name: id, x: 0, y: 0, width: 10, height: 10 }) as DesignElement;

const frame = (id: string, children: DesignElement[]): DesignElement =>
  ({ id, type: "frame", name: id, x: 0, y: 0, width: 100, height: 100, children }) as DesignElement;

const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#FFFFFF" } };

const doc = (elements: DesignElement[]): DesignDocument =>
  ({
    id: "p1",
    name: "Page 1",
    canvas,
    pages: [{ id: "p1", name: "Page 1", canvas, children: elements }],
    activePageId: "p1"
  } as unknown as DesignDocument);

const names = (chain: DesignElement[]) => chain.map((el) => el.name || el.type);

describe("ancestorChain", () => {
  it("walks a stored node up to the page root, root first", () => {
    const d = doc([frame("outer", [frame("inner", [rect("leaf")])]), rect("top")]);
    expect(names(ancestorChain(d, "leaf"))).toEqual(["outer", "inner", "leaf"]);
    expect(names(ancestorChain(d, "top"))).toEqual(["top"]);
  });

  it("returns empty for an id nothing in the page answers to", () => {
    expect(ancestorChain(doc([rect("a")]), "nope")).toEqual([]);
  });

  it("crosses into an instance's projection, and back out to the tree above it", () => {
    // The master lives on the same page, which is where `findMasterComponent`
    // looks; the instance holds no children of its own.
    const card: DesignElement = {
      id: "card",
      type: "component",
      name: "Card",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [frame("body", [rect("label")])]
    } as unknown as DesignElement;
    const instance: DesignElement = {
      id: "cardinst",
      type: "instance",
      name: "CardInst",
      componentId: "card",
      x: 0,
      y: 0,
      width: 100,
      height: 100
    } as unknown as DesignElement;
    const d = doc([card, frame("page-frame", [instance])]);

    // The clone is the path below the instance; `page-frame` is above it, and
    // only the tree knows it.
    expect(names(ancestorChain(d, "cardinst_label"))).toEqual([
      "page-frame",
      "CardInst",
      "body",
      "label"
    ]);
    // The instance itself is stored, so it takes the ordinary route.
    expect(names(ancestorChain(d, "cardinst"))).toEqual(["page-frame", "CardInst"]);
  });
});
