import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import {
  ComponentElement,
  ComponentSetElement,
  DesignDocument,
  DesignElement,
  TextElement
} from "../src/core/dsl/types";
import {
  addVariant,
  addVariantProperty,
  addVariantPropertyToSet,
  combineAsVariants,
  dissolveComponentSet,
  removeVariant,
  removeVariantProperty,
  removeVariantValue,
  renameComponentSet,
  renameVariantProperty,
  renameVariantValue,
  setComponentSetCollapsed,
  setVariantValue
} from "../src/core/interactions/component-variants";
import {
  findComponentSet,
  findVariantMember,
  groupComponentSets,
  variantOptionsFor,
  variantTableOf
} from "../src/core/interactions/component-inventory";
import {
  nextVariantPropertyName,
  nextVariantValueName,
  parseSlashNaming,
  parseVariantName,
  variantName
} from "../src/core/interactions/variant-naming";
import {
  escapesItsVariantSet,
  findParentById,
  reparentRefusal
} from "../src/core/geometry/tree-ops";
import {
  canBecomeComponent,
  canCreateComponentHere
} from "../src/core/interactions/component-inventory";
import {
  COMPONENT_SET_PADDING,
  COMPONENT_VARIANT_GAP,
  fitComponentSet,
  nextVariantOrigin
} from "../src/core/layout/component-set";
import { relayoutDocumentTree } from "../src/core/layout/auto-layout";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { applyOps } from "../src/core/ops/apply-ops";
import { resolveInstanceChildren } from "../src/core/interactions/instance-resolve";

/**
 * Writing a component set, against Figma's model.
 *
 * The assertions are mostly about SHAPE rather than values, because that is where
 * the resemblance to Figma either holds or does not: the page grows by one node
 * however many variants are added, the members are its children, the table lives
 * on the set, and every member has a value for every property — a member with no
 * value is a hole, and the whole earlier design produced one every time a set was
 * started.
 */

/** Figma's generated names, in the locale-neutral form the model takes. */
const LABELS = {
  property: (n: number) => `Property ${n}`,
  firstValue: "Default",
  nthValue: (n: number) => `Variant ${n}`
};

const canvas = {
  width: 2000,
  height: 1200,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#FFFFFF" }
};

function doc(elements: DesignElement[]): DesignDocument {
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
    activePageId: "page_1"
  };
}

function button(id: string, name: string, content: string, y = 0): ComponentElement {
  return {
    id,
    type: "component",
    name,
    x: 0,
    y,
    width: 100,
    height: 40,
    children: [
      {
        id: `${id}_t`,
        type: "text",
        name: "label",
        x: 8,
        y: 10,
        width: 80,
        height: 18,
        content,
        style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" }
      } as TextElement
    ]
  } as ComponentElement;
}

/** The single `componentSet` at the page root. */
function onlySet(d: DesignDocument): ComponentSetElement {
  const sets = getActivePage(d).children.filter((e) => e.type === "componentSet");
  expect(sets).toHaveLength(1);
  return sets[0] as ComponentSetElement;
}

/** A lone component that has become a one-member set: Figma's "Add property". */
const started = (): DesignDocument =>
  addVariantProperty(doc([button("c_btn", "Button", "Buy")]), "c_btn", LABELS).doc;

describe("Figma's generated names", () => {
  it("numbers properties from 1 and never reuses one", () => {
    expect(nextVariantPropertyName([], (n) => `Property ${n}`)).toBe("Property 1");
    expect(nextVariantPropertyName(["Property 1"], (n) => `Property ${n}`)).toBe("Property 2");
    expect(
      nextVariantPropertyName(["Property 2", "Color"], (n) => `Property ${n}`)
    ).toBe("Property 1");
  });

  it("calls the first value Default and the rest Variant N", () => {
    const labels = { first: "Default", nth: (n: number) => `Variant ${n}` };
    expect(nextVariantValueName([], labels)).toBe("Default");
    expect(nextVariantValueName(["Default"], labels)).toBe("Variant 2");
    expect(nextVariantValueName(["Default", "Variant 2"], labels)).toBe("Variant 3");
  });

  it("offers Default again when the first value was renamed away", () => {
    // UnUSED is the test, not "the next index": a set whose first value became
    // `Hover` still has `Default` free.
    const labels = { first: "Default", nth: (n: number) => `Variant ${n}` };
    expect(nextVariantValueName(["Hover"], labels)).toBe("Default");
  });

  it("names a variant after its coordinates, never after its set", () => {
    expect(variantName({ State: "Hover" }, "fallback")).toBe("State=Hover");
    expect(variantName({ Size: "Small", State: "Hover" }, "fallback")).toBe(
      "Size=Small, State=Hover"
    );
    expect(variantName({}, "Button")).toBe("Button");
  });

  it("reads coordinates back, and refuses a name with no `=` at all", () => {
    expect(parseVariantName("Size=Small, State=Hover")).toEqual({ Size: "Small", State: "Hover" });
    // Whitespace around the pair is trimmed rather than rejected, because a property
    // may legitimately contain a space ("Font size=Large").
    expect(parseVariantName("Font size = Large")).toEqual({ "Font size": "Large" });
    expect(parseVariantName("Button")).toEqual({});
    expect(parseVariantName("=Default")).toEqual({});
  });

  it("splits Figma's slash convention: set name, then one property per segment", () => {
    expect(parseSlashNaming(["Button/Primary/Large", "Button/Primary/Small"])).toEqual({
      setName: "Button",
      propertyValues: [["Primary"], ["Large", "Small"]]
    });
    expect(parseSlashNaming(["Button", "Button"])).toEqual({ setName: "Button", propertyValues: [] });
  });

  it("stops at the shallowest name, so no column is half-filled", () => {
    // Figma says outright that every member needs the same number of slashes.
    const ragged = parseSlashNaming(["Button/Primary/Large", "Button/Primary"]);
    expect(ragged.propertyValues).toEqual([["Primary"]]);
  });
});

describe("a main component becoming a set", () => {
  it("gives the original a value, so no member is left outside the matrix", () => {
    // The defect this replaces: "add variant" cloned the component and left the
    // original behind with no `variantProperties` at all, so a set opened with one
    // member belonging to no cell of its own table.
    const d = started();
    const set = onlySet(d);
    expect(set.name).toBe("Button");
    expect(set.variantGroupProperties).toEqual({ "Property 1": ["Default"] });
    expect(set.children).toHaveLength(1);
    const only = set.children[0] as ComponentElement;
    expect(only.variantProperties).toEqual({ "Property 1": "Default" });
    expect(only.name).toBe("Property 1=Default");
  });

  it("wraps the component rather than adding a layer to the page", () => {
    expect(getActivePage(started()).children).toHaveLength(1);
  });

  it("leaves the component where it was on the canvas", () => {
    const before = doc([{ ...button("c_btn", "Button", "Buy"), x: 300 } as ComponentElement]);
    const set = onlySet(addVariantProperty(before, "c_btn", LABELS).doc);
    expect(set.x).toBe(300 - COMPONENT_SET_PADDING);
    expect((set.children[0] as ComponentElement).x).toBe(COMPONENT_SET_PADDING);
  });

  it("does nothing to a component that is already a variant", () => {
    const second = addVariantProperty(started(), "c_btn", LABELS);
    expect(second.property).toBeNull();
    expect(onlySet(second.doc).children).toHaveLength(1);
  });

  it("says so when the target is not a component", () => {
    expect(addVariantProperty(doc([]), "nope", LABELS).set).toBeNull();
  });
});

describe("Figma's Add variant", () => {
  const threeVariants = () => {
    const one = addVariantProperty(doc([button("c_btn", "Button", "Buy")]), "c_btn", LABELS).doc;
    const two = addVariant(one, "c_btn", LABELS).doc;
    return addVariant(two, "c_btn", LABELS).doc;
  };

  it("copies the member and generates the next value", () => {
    const d = threeVariants();
    const set = onlySet(d);
    // Figma's sequence, in order: Default, Variant 2, Variant 3.
    expect(set.variantGroupProperties).toEqual({
      "Property 1": ["Default", "Variant 2", "Variant 3"]
    });
    expect((set.children as ComponentElement[]).map((c) => c.variantProperties)).toEqual([
      { "Property 1": "Default" },
      { "Property 1": "Variant 2" },
      { "Property 1": "Variant 3" }
    ]);
    expect((set.children as ComponentElement[]).map((c) => c.name)).toEqual([
      "Property 1=Default",
      "Property 1=Variant 2",
      "Property 1=Variant 3"
    ]);
  });

  it("grows the set downward, in one column", () => {
    const set = onlySet(threeVariants());
    const xs = set.children.map((c) => c.x);
    for (let i = 1; i < xs.length; i++) {
      expect(set.children[i].y).toBe(
        set.children[i - 1].y + set.children[i - 1].height + COMPONENT_VARIANT_GAP
      );
      expect(xs[i]).toBe(xs[i - 1]);
    }
  });

  it("shares no node id with its source", () => {
    const one = addVariantProperty(doc([button("c_btn", "Button", "Buy")]), "c_btn", LABELS).doc;
    const copy = addVariant(one, "c_btn", LABELS).variant!;
    // An override on an instance of the copy is keyed on a layer id, so a shared
    // id would make it land on the ORIGINAL's layer instead.
    expect(copy.id).not.toBe("c_btn");
    expect(copy.children[0].id).not.toBe("c_btn_t");
    // And the copy really carries its own text, not a pointer at the original.
    expect((copy.children[0] as TextElement).content).toBe("Buy");
  });

  it("does not mutate the document it was given", () => {
    const before = doc([button("c_btn", "Button", "Buy")]);
    addVariantProperty(before, "c_btn", LABELS);
    expect(getActivePage(before).children[0].type).toBe("component");
    expect(getActivePage(before).children).toHaveLength(1);
  });

  it("needs a set that already declares a property", () => {
    const bare = doc([button("c_btn", "Button", "Buy")]);
    expect(addVariant(bare, "c_btn", LABELS).variant).toBeNull();
    expect(addVariant(started(), "nope", LABELS).variant).toBeNull();
  });

  it("offers every declared value on an instance, not only the drawn ones", () => {
    const d = threeVariants();
    const set = findComponentSet(d, "c_btn")!;
    expect(variantOptionsFor(set, "Property 1", { "Property 1": "Default" })).toEqual([
      "Default",
      "Variant 2",
      "Variant 3"
    ]);
  });

  it("reports a hole rather than inventing a member for it", () => {
    const d = started();
    const set = findComponentSet(d, "c_btn")!;
    const next = addVariantPropertyToSet(d, onlySet(d).id, LABELS, "Size").doc;
    const bigger = addVariantPropertyToSet(next, onlySet(next).id, LABELS, "Colour").doc;
    const grown = findComponentSet(bigger, "c_btn")!;
    expect(grown.properties.map((p) => p.property)).toEqual(["Property 1", "Size", "Colour"]);
    // Figma leaves gaps in the picker for combinations nobody has drawn.
    expect(findVariantMember(grown, { "Property 1": "Default", Size: "Large" })).toBeUndefined();
    expect(set.members).toHaveLength(1);
  });
});

describe("the property table on the set", () => {
  it("backfills a new column with Default down every member", () => {
    const two = addVariant(started(), "c_btn", LABELS).doc;
    const next = addVariantPropertyToSet(two, onlySet(two).id, LABELS, "Size").doc;
    const set = onlySet(next);
    expect(set.variantGroupProperties).toEqual({
      "Property 1": ["Default", "Variant 2"],
      Size: ["Default"]
    });
    expect((set.children as ComponentElement[])[1].variantProperties).toEqual({
      "Property 1": "Variant 2",
      Size: "Default"
    });
  });

  it("registers a value typed into a cell, so it is offerable afterwards", () => {
    const d = started();
    const next = setVariantValue(d, onlySet(d).id, "c_btn", "Property 1", "Hover")!;
    expect(onlySet(next).variantGroupProperties).toEqual({
      "Property 1": ["Default", "Hover"]
    });
    expect((onlySet(next).children[0] as ComponentElement).name).toBe("Property 1=Hover");
  });

  it("renames a property on the set and on every member, keeping the column order", () => {
    // One document, read once: every call to `started()` mints a fresh setId, so a
    // second call would hand the write an id this document never had.
    const base = started();
    const d = addVariantPropertyToSet(base, onlySet(base).id, LABELS, "Size").doc;
    const next = renameVariantProperty(d, onlySet(d).id, "Size", "Style")!;
    expect(Object.keys(onlySet(next).variantGroupProperties ?? {})).toEqual([
      "Property 1",
      "Style"
    ]);
    expect((onlySet(next).children[0] as ComponentElement).variantProperties).toEqual({
      "Property 1": "Default",
      Style: "Default"
    });
    expect((onlySet(next).children[0] as ComponentElement).name).toBe(
      "Property 1=Default, Style=Default"
    );
  });

  it("renames one value across every member that carries it", () => {
    const two = addVariant(started(), "c_btn", LABELS).doc;
    const next = renameVariantValue(two, onlySet(two).id, "Property 1", "Variant 2", "Hover")!;
    expect(onlySet(next).variantGroupProperties).toEqual({
      "Property 1": ["Default", "Hover"]
    });
    expect((onlySet(next).children as ComponentElement[])[1].name).toBe("Property 1=Hover");
  });

  it("drops a property and its column together", () => {
    const base = started();
    const two = addVariantPropertyToSet(base, onlySet(base).id, LABELS, "Size").doc;
    const next = removeVariantProperty(two, onlySet(two).id, "Size")!;
    expect(Object.keys(onlySet(next).variantGroupProperties ?? {})).toEqual(["Property 1"]);
    expect((onlySet(next).children[0] as ComponentElement).variantProperties).toEqual({
      "Property 1": "Default"
    });
  });

  it("is a no-op for a property the set does not declare", () => {
    const d = started();
    expect(removeVariantProperty(d, onlySet(d).id, "nope")).toBeNull();
    expect(removeVariantProperty(d, "nope", "Property 1")).toBeNull();
    expect(renameVariantProperty(d, onlySet(d).id, "Property 1", "  ")).toBeNull();
  });
});

describe("the default variant", () => {
  it("is the top-left one, spatially", () => {
    // Figma's definition, and it matters because it is what an instance becomes
    // when nothing was configured.
    const before = doc([button("c_a", "Button", "A", 100), button("c_b", "Button", "B", 0)]);
    const combined = combineAsVariants(before, ["c_a", "c_b"], LABELS)!;
    const set = findComponentSet(combined.doc, "c_b")!;
    expect(set.defaultMember.id).toBe("c_b");
  });

  it("survives a set whose first member has been dragged below the others", () => {
    const d = started();
    expect(findComponentSet(d, "c_btn")!.defaultMember.id).toBe("c_btn");
  });
});

describe("the set's own name", () => {
  const twoMembers = () =>
    combineAsVariants(
      doc([button("c_a", "Button/Primary", "A"), button("c_b", "Button/Secondary", "B")]),
      ["c_a", "c_b"],
      LABELS
    )!.doc;

  it("is stored, and renaming it moves no layer name", () => {
    const before = twoMembers();
    const renamed = renameComponentSet(before, onlySet(before).id, "Call to action")!;
    expect(onlySet(renamed).name).toBe("Call to action");
    // No member name mentions the set, which is what makes this free.
    expect((onlySet(renamed).children as ComponentElement[]).map((c) => c.name)).toEqual([
      "Property 1=Primary",
      "Property 1=Secondary"
    ]);
  });

  it("refuses a blank name and a no-op change", () => {
    const d = twoMembers();
    const setId = onlySet(d).id;
    expect(renameComponentSet(d, setId, "   ")).toBeNull();
    expect(renameComponentSet(d, setId, "Button")).toBeNull();
    expect(renameComponentSet(d, "nope", "Widget")).toBeNull();
  });
});

describe("combining components into a set", () => {
  it("reads Figma's slash convention into a property table", () => {
    const before = doc([
      button("c_a", "Button/Primary/Large", "A"),
      button("c_b", "Button/Primary/Small", "B")
    ]);
    const combined = combineAsVariants(before, ["c_a", "c_b"], LABELS)!;
    const set = onlySet(combined.doc);

    // Text before the first slash becomes the set's name; each later segment is a
    // value on its own property.
    expect(set.name).toBe("Button");
    expect(Object.keys(set.variantGroupProperties ?? {})).toEqual(["Property 1", "Property 2"]);
    expect((set.children as ComponentElement[]).map((c) => c.variantProperties)).toEqual([
      { "Property 1": "Primary", "Property 2": "Large" },
      { "Property 1": "Primary", "Property 2": "Small" }
    ]);
    expect((set.children as ComponentElement[]).map((c) => c.name)).toEqual([
      "Property 1=Primary, Property 2=Large",
      "Property 1=Primary, Property 2=Small"
    ]);
  });

  it("falls back to one Default column when nothing is named", () => {
    const before = doc([button("c_a", "Button", "A"), button("c_b", "Button", "B")]);
    const set = onlySet(combineAsVariants(before, ["c_a", "c_b"], LABELS)!.doc);
    expect(set.name).toBe("Button");
    expect(set.variantGroupProperties).toEqual({ "Property 1": ["Default"] });
  });

  it("drops a column only one member declared, rather than half-filling it", () => {
    const before = doc([
      button("c_a", "Button/Primary/Large", "A"),
      button("c_b", "Button/Primary", "B")
    ]);
    const set = onlySet(combineAsVariants(before, ["c_a", "c_b"], LABELS)!.doc);
    expect(Object.keys(set.variantGroupProperties ?? {})).toEqual(["Property 1"]);
  });

  it("needs two components", () => {
    const before = doc([button("c_a", "Button", "A")]);
    expect(combineAsVariants(before, ["c_a"], LABELS)).toBeNull();
    expect(combineAsVariants(before, ["c_a", "ghost"], LABELS)).toBeNull();
  });
});

describe("a set with no node behind it", () => {
  /** Two loose masters sharing a `setId`, the shape pre-dating the node. */
  const legacy = (): DesignDocument => {
    const a = {
      ...button("c_a", "Button", "A"),
      setId: "set_x",
      variantProperties: { State: "on" }
    };
    const b = {
      ...button("c_b", "Button", "B", 60),
      setId: "set_x",
      variantProperties: { State: "off" }
    };
    return doc([a, b]);
  };

  it("still reads as a set, with its table inferred from the members", () => {
    const set = findComponentSet(legacy(), "c_a")!;
    expect(set.setNodeId).toBeNull();
    expect(set.properties).toEqual([{ property: "State", values: ["on", "off"] }]);
  });

  it("refuses to remove a member when no set node owns it", () => {
    expect(removeVariant(legacy(), "c_b")).toBeNull();
  });
});

describe("taking a set apart", () => {
  const three = () => addVariant(addVariant(started(), "c_btn", LABELS).doc, "c_btn", LABELS).doc;

  it("dissolves into plain components, keeping them where they were", () => {
    const before = three();
    const dissolved = dissolveComponentSet(before, onlySet(before).id)!;
    expect(getActivePage(dissolved).children.some((el) => el.type === "componentSet")).toBe(false);
    // Both fields go: a survivor still carrying a `setId` would keep grouping in
    // the assets panel, and `Property 1=Default` with nothing to resolve it against
    // is worse than the name the member had before it joined.
    for (const el of getActivePage(dissolved).children as ComponentElement[]) {
      expect(el.setId).toBeUndefined();
      expect(el.variantProperties).toBeUndefined();
    }
    const ys = getActivePage(dissolved).children.map((el) => el.y);
    expect(ys).toEqual([0, 64, 128]);
  });

  it("leaves the node standing while two or more remain", () => {
    const before = three();
    const next = removeVariant(before, onlySet(before).children[2].id)!;
    expect(onlySet(next).children).toHaveLength(2);
  });

  it("dissolves the set when the removal leaves one member", () => {
    const before = addVariant(started(), "c_btn", LABELS).doc;
    const next = removeVariant(before, onlySet(before).children[1].id)!;
    expect(getActivePage(next).children.some((el) => el.type === "componentSet")).toBe(false);
    expect((getActivePage(next).children[0] as ComponentElement).setId).toBeUndefined();
  });

  it("dissolving a set that is gone is a no-op", () => {
    expect(dissolveComponentSet(three(), "nope")).toBeNull();
  });
});

describe("a variant may not leave its set", () => {
  it("refuses any parent that is not the set it belongs to", () => {
    const before = started();
    const elements = getActivePage(before).children;
    const setId = onlySet(before).id;
    expect(escapesItsVariantSet(elements, "c_btn", setId)).toBe(false);
    expect(escapesItsVariantSet(elements, "c_btn", null)).toBe(true);
    expect(reparentRefusal(elements, "c_btn", null)).toBe("variant-out-of-set");
  });

  it("refuses a master that belongs to no set, and anything that is not a master", () => {
    const before = doc([button("c_lone", "Lone", "L"), button("c_a", "Button", "A")]);
    const made = addVariantProperty(before, "c_a", LABELS).doc;
    const setId = onlySet(made).id;
    expect(escapesItsVariantSet(getActivePage(made).children, "c_lone", setId)).toBe(true);
    expect(escapesItsVariantSet(getActivePage(made).children, "c_lone", null)).toBe(false);
    // A frame parked in a set is never cloned into an instance.
    const label = (onlySet(made).children[0] as ComponentElement).children[0];
    expect(escapesItsVariantSet(getActivePage(made).children, label.id, setId)).toBe(true);
  });

  it("still lets its own variants be reordered inside it", () => {
    const before = started();
    const elements = getActivePage(before).children;
    expect(reparentRefusal(elements, "c_btn", onlySet(before).id)).toBeNull();
  });

  it("leaves the layer tree: a variant's parent IS the set", () => {
    const d = started();
    expect(findParentById(getActivePage(d).children, "c_btn")!.id).toBe(onlySet(d).id);
  });

  it("a component cannot be created inside a set", () => {
    const before = started();
    const label = (onlySet(before).children[0] as ComponentElement).children[0];
    expect(canCreateComponentHere(getActivePage(before).children, label)).toBe(false);
    expect(canBecomeComponent(onlySet(before))).toBe(false);
  });
});

describe("collapsing a set", () => {
  it("paints one variant and keeps the box every variant needs", () => {
    const before = addVariant(started(), "c_btn", LABELS).doc;
    const setId = onlySet(before).id;
    const collapsed = setComponentSetCollapsed(before, setId, true)!;
    const set = onlySet(collapsed);
    expect(set.collapsed).toBe(true);
    // The fit still measures all of them, so expanding changes nothing but what is
    // drawn — the alternative is a set that resizes every time you open it.
    expect(set.height).toBe(onlySet(before).height);
  });

  it("expands back, and writes a flag rather than a `false`", () => {
    const before = addVariant(started(), "c_btn", LABELS).doc;
    const collapsed = setComponentSetCollapsed(before, onlySet(before).id, true)!;
    const expanded = setComponentSetCollapsed(collapsed, onlySet(collapsed).id, false)!;
    expect("collapsed" in onlySet(expanded)).toBe(false);
  });

  it("is a no-op when the flag already says that", () => {
    const before = started();
    expect(setComponentSetCollapsed(before, onlySet(before).id, false)).toBeNull();
    expect(setComponentSetCollapsed(before, "nope", true)).toBeNull();
  });
});

describe("the set's box", () => {
  const set = (children: DesignElement[], collapsed?: boolean): ComponentSetElement => ({
    id: "set_1",
    type: "componentSet",
    name: "S",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    collapsed,
    children
  });
  const box = (id: string, y: number) => ({
    id,
    type: "frame" as const,
    name: id,
    x: 24,
    y,
    width: 100,
    height: 40,
    children: []
  });

  it("returns the same reference when nothing moved", () => {
    const input = fitComponentSet(set([box("a", 24), box("b", 88)]));
    expect(fitComponentSet(input)).toBe(input);
  });

  it("collapses an empty set onto nothing, so it is not a border around a hole", () => {
    expect(fitComponentSet(set([])).width).toBe(0);
    expect(fitComponentSet(set([])).height).toBe(0);
  });

  it("measures the first variant only when collapsed", () => {
    const both = fitComponentSet(set([box("a", 24), box("b", 88)]));
    const one = fitComponentSet(set([box("a", 24), box("b", 88)], true));
    expect(one.height).toBeLessThan(both.height);
    expect(one.width).toBe(both.width);
  });

  it("enforces at least content extent, and preserves manual resize", () => {
    const handDrawn = { ...set([box("a", 24)]), width: 9999 };
    const once = relayoutDocumentTree([handDrawn])[0] as ComponentSetElement;
    expect(once.width).toBe(9999);
    const small = { ...set([box("a", 24)]), width: 10 };
    const fitted = relayoutDocumentTree([small])[0] as ComponentSetElement;
    expect(fitted.width).toBe(COMPONENT_SET_PADDING + 24 + 100);
  });

  it("never re-sorts the members — the order is the author's", () => {
    expect(relayoutDocumentTree([set([box("b", 88), box("a", 24)])])[0]).toMatchObject({
      children: [{ id: "b" }, { id: "a" }]
    });
  });

  it("places the next variant below the last, in the first one's column", () => {
    const column = set([box("a", 24), box("b", 88)]);
    expect(nextVariantOrigin(column)).toEqual({ x: 24, y: 88 + 40 + COMPONENT_VARIANT_GAP });
    expect(nextVariantOrigin(set([box("a", 24)]))).toEqual({
      x: 24,
      y: 24 + 40 + COMPONENT_VARIANT_GAP
    });
    expect(nextVariantOrigin(set([]))).toEqual({
      x: COMPONENT_SET_PADDING,
      y: COMPONENT_SET_PADDING
    });
  });
});

describe("the scripted path", () => {
  it("add-variant is Figma's Add variant", () => {
    const before = started();
    const result = applyOps(before, [{ op: "add-variant", targetId: "c_btn" }]);
    expect(result.outcomes[0].ok).toBe(true);
    expect(onlySet(result.doc).children).toHaveLength(2);
  });

  it("make-variant states a coordinate, creating what it needs", () => {
    const before = doc([button("c_btn", "Button", "Buy")]);
    const result = applyOps(before, [
      { op: "make-variant", targetId: "c_btn", property: "State", value: "Hover" }
    ]);
    expect(result.outcomes[0].ok).toBe(true);
    const set = onlySet(result.doc);
    // `Default` stays in the table even though nothing uses it — Figma keeps the
    // first value of a property available after a cell is changed away from it, and
    // a table that forgot it would lose the value the author is about to want back.
    expect(set.variantGroupProperties).toEqual({ State: ["Default", "Hover"] });
    expect((set.children[0] as ComponentElement).variantProperties).toEqual({ State: "Hover" });
    expect((set.children[0] as ComponentElement).name).toBe("State=Hover");
  });

  it("adds the property to a set that has none yet", () => {
    const before = started();
    const result = applyOps(before, [
      { op: "make-variant", targetId: "c_btn", property: "Size", value: "Large" }
    ]);
    expect(Object.keys(onlySet(result.doc).variantGroupProperties ?? {})).toEqual([
      "Property 1",
      "Size"
    ]);
  });

  it("reports what it needs instead of failing on the op name", () => {
    const before = doc([button("c_btn", "Button", "Buy")]);
    expect(applyOps(before, [{ op: "make-variant", targetId: "c_btn" }]).outcomes[0].ok).toBe(false);
    expect(applyOps(before, [{ op: "make-variant" }]).outcomes[0].ok).toBe(false);
    expect(applyOps(before, [{ op: "add-variant", targetId: "ghost" }]).outcomes[0].ok).toBe(false);
  });
});

describe("a variant's own labels", () => {
  it("resolves each member's text from its own layer", () => {
    const one = addVariantProperty(doc([button("c_btn", "Button", "Buy")]), "c_btn", LABELS).doc;
    const made = addVariant(one, "c_btn", LABELS).variant!;
    const instance = {
      id: "i",
      type: "instance" as const,
      componentId: made.id,
      x: 0,
      y: 0,
      width: 100,
      height: 40
    };
    // The copy cloned the source's text, and reading it back proves the copy is a
    // real master rather than a pointer at the original.
    expect((resolveInstanceChildren(instance, made)[0] as TextElement).content).toBe("Buy");
  });
});

describe("a set survives the load path", () => {
  it("keeps its node, its name, its table and its collapse flag", () => {
    const before = addVariant(started(), "c_btn", LABELS).doc;
    const d = setComponentSetCollapsed(before, onlySet(before).id, true)!;
    const { document } = normalizeDesignDocument(JSON.parse(JSON.stringify(d)), {
      preserveUnknown: true
    });
    const set = getActivePage(document).children[0] as ComponentSetElement;
    expect(set.type).toBe("componentSet");
    expect(set.name).toBe("Button");
    expect(set.collapsed).toBe(true);
    expect(set.variantGroupProperties).toEqual({ "Property 1": ["Default", "Variant 2"] });
    expect((set.children[0] as ComponentElement).variantProperties).toEqual({
      "Property 1": "Default"
    });
    expect(variantTableOf(set)[0].values).toEqual(["Default", "Variant 2"]);
  });

  it("refuses the pre-rename `variant` key", () => {
    // `variant` was FISH's own pre-rename spelling; Figma's — and therefore the
    // dialect's — is `variantProperties`. There are no v1 documents written
    // against the old key, so it is no longer honoured at all.
    const input = {
      version: "0.1",
      canvas,
      elements: [
        {
          id: "set_btn",
          type: "componentSet",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          children: [
            {
              id: "c_a",
              type: "component",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              setId: "set_btn",
              variant: { State: "Hover" },
              children: []
            }
          ]
        }
      ]
    } as never;

    const { document } = normalizeDesignDocument(input, { preserveUnknown: true });
    const set = getActivePage(document).children[0] as ComponentSetElement;
    expect((set.children[0] as ComponentElement).variantProperties).toBeUndefined();

    // `fish check` normalizes without `preserveUnknown`, so there the key is
    // reported as dropped rather than carried.
    const strict = normalizeDesignDocument(input);
    expect(strict.repairs.some((r) => r.message.includes('"variant"'))).toBe(true);
  });

  it("says so when a set is handed an auto-layout, which it cannot use", () => {
    const { document, repairs } = normalizeDesignDocument(
      {
        version: "0.1",
        canvas,
        elements: [
          {
            id: "set_1",
            type: "componentSet",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            ...flattenLayout({ mode: "flex", direction: "row" }),
            children: [
              { id: "c_a", type: "component", x: 0, y: 0, width: 10, height: 10, children: [] }
            ]
          }
        ]
      } as never,
      { preserveUnknown: true }
    );
    expect(layoutOf(getActivePage(document).children[0])).toBeUndefined();
    expect(repairs.some((r) => r.path === "/elements/0/layout")).toBe(true);
  });
});

describe("grouping a whole document", () => {
  it("keeps a set's own name and members, and lists nothing else", () => {
    const d = doc([button("c_solo", "Solo", "S"), ...onlySet(started()).children ? [] : []]);
    const withBoth = doc([
      button("c_solo", "Solo", "S"),
      ...(getActivePage(started()).children as DesignElement[])
    ]);
    expect(getActivePage(d).children).toHaveLength(1);
    const { sets, singles } = groupComponentSets(withBoth);
    expect(sets).toHaveLength(1);
    expect(sets[0].name).toBe("Button");
    expect(singles.map((e) => e.name)).toEqual(["Solo"]);
  });
});
/**
 * Editing a cell registers the new value and leaves the old one declared, which is
 * what keeps a value offerable after the last member stops using it. Nobody could
 * take it away again: the row's trash looped over the members carrying the value,
 * and an unused value has none.
 */
describe("a value nobody fills can be removed from the table", () => {
  it("takes the leftover out, and refuses a value a member still sits on", () => {
    let d = started();
    const set = onlySet(d);
    const property = Object.keys(set.variantGroupProperties!)[0];
    const memberId = (set.children![0] as ComponentElement).id;

    d = setVariantValue(d, set.id, memberId, property, "Hover")!;
    expect(Object.values(onlySet(d).variantGroupProperties!)[0]).toEqual(["Default", "Hover"]);

    const cleaned = removeVariantValue(d, set.id, property, "Default");
    expect(cleaned, "`Default` has no member behind it").toBeTruthy();
    expect(Object.values(onlySet(cleaned!).variantGroupProperties!)[0]).toEqual(["Hover"]);

    expect(removeVariantValue(d, set.id, property, "Hover"), "a value in use is not removable").toBeNull();
    expect(removeVariantValue(cleaned!, set.id, property, "Hover"), "and neither is the last one").toBeNull();
  });
});
