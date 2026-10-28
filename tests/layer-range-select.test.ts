import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { layerRangeSelection, visibleLayerRowIds } from "../src/ui/layers/range-select";
import type { DesignElement } from "../src/core/dsl/types";

const rect = (id: string): DesignElement => ({ id, type: "rect", name: id } as DesignElement);
const frame = (id: string, children: DesignElement[]): DesignElement =>
  ({ id, type: "frame", name: id, children } as unknown as DesignElement);
const stack = (id: string, children: DesignElement[]): DesignElement =>
  ({ id, type: "frame", name: id, children, ...flattenLayout({ mode: "flex", direction: "column" }) } as unknown as DesignElement);

// The panel paints the last sibling first, and nests children under their parent.
const TREE = [rect("a"), frame("f", [rect("f1"), rect("f2")]), rect("b")];

describe("visibleLayerRowIds", () => {
  it("walks the tree in paint order, top row first", () => {
    expect(visibleLayerRowIds(TREE, new Set())).toEqual(["b", "f", "f2", "f1", "a"]);
  });

  it("omits the subtree a collapsed frame hides", () => {
    expect(visibleLayerRowIds(TREE, new Set(["f"]))).toEqual(["b", "f", "a"]);
  });

  it("expands a frame nested inside a collapsed one only when the outer is open", () => {
    const nested = [frame("outer", [frame("inner", [rect("leaf")])])];
    expect(visibleLayerRowIds(nested, new Set())).toEqual(["outer", "inner", "leaf"]);
    expect(visibleLayerRowIds(nested, new Set(["outer"]))).toEqual(["outer"]);
    expect(visibleLayerRowIds(nested, new Set(["inner"]))).toEqual(["outer", "inner"]);
  });

  // A stack's children are listed first-child-first, so a shift-range over them
  // has to be measured in that order or it selects the mirror of what the user
  // highlighted. The root stays front-first whatever the children do.
  it("walks a stack's children in flow order while the root stays front-first", () => {
    const tree = [rect("a"), stack("s", [rect("s1"), rect("s2")]), rect("b")];
    expect(visibleLayerRowIds(tree, new Set(), undefined, () => "flow")).toEqual([
      "b",
      "s",
      "s1",
      "s2",
      "a"
    ]);
  });

  it("applies the order per parent, so a free frame under a stack is still front-first", () => {
    const tree = [stack("s", [rect("s1"), frame("f", [rect("f1"), rect("f2")])])];
    const rowOrderOf = (el: DesignElement) => (el.id === "s" ? "flow" : "z") as "flow" | "z";
    expect(visibleLayerRowIds(tree, new Set(), undefined, rowOrderOf)).toEqual([
      "s",
      "s1",
      "f",
      "f2",
      "f1"
    ]);
  });
});

describe("layerRangeSelection", () => {
  const rows = visibleLayerRowIds(TREE, new Set());

  it("takes the inclusive span from the anchor to the target", () => {
    const sel = layerRangeSelection(rows, "b", "f1", new Set(["b"]));
    expect(Array.from(sel!)).toEqual(["b", "f", "f2", "f1"]);
  });

  it("is direction-agnostic", () => {
    expect(Array.from(layerRangeSelection(rows, "f1", "b", new Set(["f1"]))!)).toEqual(
      ["b", "f", "f2", "f1"]
    );
  });

  it("collapses to a single row when the anchor is the target", () => {
    expect(Array.from(layerRangeSelection(rows, "f", "f", new Set(["f"]))!)).toEqual(["f"]);
  });

  it("refuses when the anchor is no longer selected (selection changed elsewhere)", () => {
    expect(layerRangeSelection(rows, "b", "a", new Set(["f"]))).toBeNull();
  });

  it("refuses without an anchor, so the caller can fall back to a plain select", () => {
    expect(layerRangeSelection(rows, null, "a", new Set())).toBeNull();
  });

  it("refuses when either endpoint is not a visible row", () => {
    // "f2" is hidden while "f" is collapsed: a range measured against it is meaningless.
    const collapsed = visibleLayerRowIds(TREE, new Set(["f"]));
    expect(layerRangeSelection(collapsed, "f", "f2", new Set(["f"]))).toBeNull();
  });
});
