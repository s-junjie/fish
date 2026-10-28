import { flattenLayout } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { ComponentElement, DesignDocument, DesignElement, InstanceElement } from "../src/core/dsl/types";
import { layerRowsOf, derivedRowPath } from "../src/ui/layers/instance-rows";
import { visibleLayerRowIds } from "../src/ui/layers/range-select";
import { rowOrderOf } from "../src/ui/layers/row-order";
import { resolveInstanceSelection } from "../src/core/interactions/instance-resolve";

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

function instanceOf(componentId = "cmp", id = "inst"): InstanceElement {
  return {
    id,
    type: "instance",
    name: "Card Instance",
    componentId,
    x: 400,
    y: 100,
    width: 200,
    height: 100
  };
}

/** `card` holds the instance; `cmp2` is a master the instance does NOT project. */
function doc(): DesignDocument {
  const card: DesignElement = {
    id: "card",
    type: "frame",
    name: "card",
    x: 300,
    y: 0,
    width: 400,
    height: 300,
    children: [instanceOf()]
  };
  const cmp2 = { ...master("cmp2"), name: "Other" };
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [
      { id: "page_design", name: "Design", canvas, children: [card, master(), cmp2] },
      { id: "page_comp", name: "Components", canvas, children: [master("cmp_far")] }
    ],
    activePageId: "page_design"
  };
}

describe("the rows an instance contributes to the layer tree", () => {
  it("lists the resolved clone the canvas paints, not nothing", () => {
    const rows = layerRowsOf(doc(), instanceOf());
    expect(rows.map((r) => r.id)).toEqual(["inst_LEAF", "inst_SUB"]);
  });

  it("lists the stored children of a master, which is a real container", () => {
    const rows = layerRowsOf(doc(), master());
    expect(rows.map((r) => r.id)).toEqual(["LEAF", "SUB"]);
  });

  it("resolves a master that lives on another page", () => {
    const rows = layerRowsOf(doc(), instanceOf("cmp_far", "far"));
    expect(rows.map((r) => r.id)).toEqual(["far_LEAF", "far_SUB"]);
  });

  // Derived ids are minted `<instanceId>_<masterNodeId>` at EVERY depth, so a
  // grandchild of the instance is a sibling in id space. Its nesting is carried
  // by the row tree, and that is what the panel must walk.
  it("descends into a derived frame, so nested children are reachable", () => {
    const rows = layerRowsOf(doc(), layerRowsOf(doc(), instanceOf())[1]);
    expect(rows.map((r) => r.id)).toEqual(["inst_DEEP"]);
  });

  it("contributes nothing when the master is missing", () => {
    expect(layerRowsOf(doc(), instanceOf("nope", "orphan"))).toEqual([]);
  });

  it("mints the ids the canvas resolved, so a row click selects the painted node", () => {
    const rows = layerRowsOf(doc(), instanceOf());
    expect(resolveInstanceSelection(doc(), rows[0].id)).toBeTruthy();
    expect(resolveInstanceSelection(doc(), "inst_DEEP")).toBeTruthy();
  });
});

describe("revealing a row selected on the canvas", () => {
  it("walks from the owning instance down to a nested derived child", () => {
    expect(derivedRowPath(doc(), "inst_DEEP")).toEqual(["inst", "inst_SUB", "inst_DEEP"]);
  });

  it("includes the instance row itself for a direct child", () => {
    expect(derivedRowPath(doc(), "inst_LEAF")).toEqual(["inst", "inst_LEAF"]);
  });

  it("returns nothing for an id that is not a resolved clone", () => {
    expect(derivedRowPath(doc(), "card")).toEqual([]);
    expect(derivedRowPath(doc(), "nope")).toEqual([]);
  });
});

describe("shift-range row order with resolved instance rows", () => {
  const rowsOf = (el: DesignElement) => layerRowsOf(doc(), el);
  // Depth-first, last sibling first. `cmp`/`cmp2` are masters, so their stored
  // children are rows too; only the instance's rows come from resolution.
  const EXPANDED = [
    "cmp2", "SUB", "DEEP", "LEAF",
    "cmp", "SUB", "DEEP", "LEAF",
    "card", "inst", "inst_SUB", "inst_DEEP", "inst_LEAF"
  ];

  it("includes the derived rows while the instance is expanded", () => {
    expect(visibleLayerRowIds(getActivePage(doc()).children, new Set(), rowsOf)).toEqual(EXPANDED);
  });

  it("hides the whole derived subtree while the instance is collapsed", () => {
    expect(visibleLayerRowIds(getActivePage(doc()).children, new Set(["inst"]), rowsOf)).toEqual(EXPANDED.slice(0, 10));
  });

  it("still hides everything under a collapsed parent frame", () => {
    expect(visibleLayerRowIds(getActivePage(doc()).children, new Set(["card"]), rowsOf)).toEqual(EXPANDED.slice(0, 9));
  });

  it("walks stored children only when no resolver is given", () => {
    expect(visibleLayerRowIds(getActivePage(doc()).children, new Set())).toEqual(EXPANDED.slice(0, 10));
  });

  // The instance carries no `layout` of its own, so the panel has to read the
  // master's to know the rows come out in flow order — the canvas places them
  // with the master's recipe, and the panel has to list them the way it placed
  // them. `cmp2` has no layout, so its rows stay front-first: the two masters in
  // one document come out in opposite orders.
  it("orders an instance's rows by the master's layout, not the instance's absence of one", () => {
    const laid = doc();
    const withLayout = (el: DesignElement): DesignElement =>
      el.id === "cmp"
        ? ({ ...el, ...flattenLayout({ mode: "flex", direction: "column" }) } as DesignElement)
        : el;
    const stackDoc = {
      ...laid,
      pages: laid.pages.map((p) => ({ ...p, children: p.children.map(withLayout) }))
    } as DesignDocument;

    const rows = visibleLayerRowIds(getActivePage(stackDoc).children, new Set(), rowsOf, (el) =>
      rowOrderOf(stackDoc, el)
    );
    // `cmp` is a stack now, so its own children are listed first-child-first...
    expect(rows.slice(rows.indexOf("cmp"), rows.indexOf("cmp") + 4)).toEqual([
      "cmp",
      "LEAF",
      "SUB",
      "DEEP"
    ]);
    // ...and so are the rows the instance resolves FROM it, even though the
    // instance element itself carries no layout.
    expect(rows.slice(rows.indexOf("inst"), rows.indexOf("inst") + 3)).toEqual([
      "inst",
      "inst_LEAF",
      "inst_SUB"
    ]);
    // `cmp2` is still layout-less, so it is untouched.
    expect(rows.slice(rows.indexOf("cmp2"), rows.indexOf("cmp2") + 4)).toEqual([
      "cmp2",
      "SUB",
      "DEEP",
      "LEAF"
    ]);
  });
});
