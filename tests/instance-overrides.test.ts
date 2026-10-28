import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import type {
  ComponentElement,
  DesignDocument,
  DesignElement,
  InstanceElement
} from "../src/core/dsl/types";
import { createInstanceFromComponent } from "../src/core/interactions/component-ops";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import { applyPropertyToSubtree, commitInstanceOverrides, resolveInstanceChildren, resolveInstanceSelection } from "../src/core/interactions/instance-resolve";
import { insertClones } from "../src/core/interactions/clipboard";

const canvas = {
  width: 2000,
  height: 1200,
  background: { type: "solid" as const, color: "#101010" },
  unit: "px" as const
};

const solid = (color: string) => [{ type: "solid" as const, color }];

/** icon (a dot) → card (an icon instance + a label) → an instance of card. */
function fixture(): DesignDocument {
  const icon: ComponentElement = {
    id: "icon",
    type: "component",
    name: "ICON",
    x: 0,
    y: 400,
    width: 24,
    height: 24,
    children: [
      { id: "dot", type: "rect", name: "dot", x: 0, y: 0, width: 24, height: 24, fills: solid("#EF4444") }
    ]
  };
  const card: ComponentElement = {
    id: "card",
    type: "component",
    name: "CARD",
    x: 0,
    y: 100,
    width: 200,
    height: 80,
    fills: solid("#1F2937"),
    clipContent: false,
    children: [
      { id: "slot", type: "instance", name: "ICON", componentId: "icon", x: 10, y: 10, width: 24, height: 24 },
      { id: "label", type: "text", name: "label", x: 60, y: 30, width: 100, height: 20, content: "Card", style: { fontSize: 14 } }
    ] as DesignElement[]
  };
  const cardInst: InstanceElement = {
    id: "cardInst",
    type: "instance",
    name: "CARD",
    componentId: "card",
    x: 400,
    y: 100,
    width: 200,
    height: 80
  };
  const elements: DesignElement[] = [icon, card, cardInst];
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
    activePageId: "page_1",
    elements
  };
}

const instOf = (doc: DesignDocument, id = "cardInst") =>
  doc.pages![0].children.find((el) => el.id === id) as InstanceElement;

/** Resolve `cardInst` all the way down to the dot inside its nested instance. */
const resolveDot = (doc: DesignDocument) => {
  const card = findMasterComponent(doc, "card")!;
  const slot = resolveInstanceChildren(instOf(doc), card).find((el) => el.id === "cardInst_slot")!;
  const icon = findMasterComponent(doc, "icon")!;
  const dot = resolveInstanceChildren(slot as InstanceElement, icon).find(
    (el) => el.id === "cardInst_slot_dot"
  )!;
  return { slot, dot };
};

describe("an instance is named after its master", () => {
  it("names a new instance after the master, with no suffix", () => {
    const { instance } = createInstanceFromComponent(fixture(), "icon");
    expect(instance?.name).toBe("ICON");
  });

  it("names a pasted copy of a component after it too", () => {
    const doc = fixture();
    const icon = getActivePage(doc).children[0];
    const { elements, newIds } = insertClones(getActivePage(doc).children, [icon], { x: 40, y: 40 });
    const pasted = elements.find((el) => el.id === newIds[0]) as InstanceElement;
    expect(pasted.type).toBe("instance");
    expect(pasted.name).toBe("ICON");
  });

  it("keeps the name when the instance itself is duplicated", () => {
    const doc = fixture();
    const { elements, newIds } = insertClones(getActivePage(doc).children, [instOf(doc)], { x: 40, y: 40 });
    expect((elements.find((el) => el.id === newIds[0]) as InstanceElement).name).toBe("CARD");
  });
});

describe("a node inside a nested instance is addressable by path", () => {
  it("names the path of instance crossings, not of frames", () => {
    const doc = fixture();
    expect(resolveInstanceSelection(doc, "cardInst_slot")?.masterNodeId).toBe("slot");
    expect(resolveInstanceSelection(doc, "cardInst_slot_dot")?.masterNodeId).toBe("slot/dot");
    expect(resolveInstanceSelection(doc, "cardInst_slot_dot")?.overridable).toBe(true);
  });

  it("hides the deep node: the outer instance hands the tail to the nested one", () => {
    const doc = fixture();
    const sel = resolveInstanceSelection(doc, "cardInst_slot_dot")!;
    const next = commitInstanceOverrides(doc, [sel], (el) => ({ ...el, visible: false }))!;
    expect(instOf(next).overrides).toEqual([
      { targetId: "slot/dot", property: "visible", value: false }
    ]);
    expect(resolveDot(next).dot.visible).toBe(false);
    // …and only that node: the nested instance still paints its own box.
    expect(resolveDot(next).slot.visible).not.toBe(false);
  });

  it("clips and locks a node inside an instance", () => {
    const doc = fixture();
    for (const property of ["clipContent", "locked"] as const) {
      const sel = resolveInstanceSelection(doc, "cardInst_slot")!;
      const next = commitInstanceOverrides(doc, [sel], (el) => ({ ...el, [property]: true }))!;
      expect(instOf(next).overrides).toEqual([{ targetId: "slot", property, value: true }]);
      const resolved = resolveInstanceChildren(
        instOf(next),
        findMasterComponent(next, "card")!
      ).find((el) => el.id === "cardInst_slot")!;
      expect((resolved as any)[property]).toBe(true);
    }
  });

  /**
   * `fillEnabled` is the one property whose DEFAULT is not "absent": an absent
   * flag means the stack paints, so both directions of the switch are changes and
   * both have to be written. Nothing in the app produces `false` (the inspector's
   * fill eye uses a per-layer `enabled`), but `dsl.md` teaches external authors
   * to use it, so a document that arrives with one has to stay editable.
   */
  it("switches off the fill of a node two instance levels down", () => {
    const doc = fixture();
    const sel = resolveInstanceSelection(doc, "cardInst_slot_dot")!;
    const next = commitInstanceOverrides(doc, [sel], (el) => ({ ...el, fillEnabled: false }))!;
    expect(instOf(next).overrides).toEqual([
      { targetId: "slot/dot", property: "fillEnabled", value: false }
    ]);
    expect(resolveDot(next).dot.fillEnabled).toBe(false);
  });

  it("and switching it back on is a change too, not a dropped field", () => {
    const doc = fixture();
    const dot = (getActivePage(doc).children[0] as ComponentElement).children[0] as DesignElement;
    dot.fillEnabled = false;
    const sel = resolveInstanceSelection(doc, "cardInst_slot_dot")!;
    const next = commitInstanceOverrides(doc, [sel], (el) => ({ ...el, fillEnabled: true }))!;
    expect(instOf(next).overrides).toEqual([
      { targetId: "slot/dot", property: "fillEnabled", value: true }
    ]);
    expect(resolveDot(next).dot.fillEnabled).toBe(true);
  });
});


describe("an assetId override changes the painted asset", () => {
  const node = (fills: any[]) =>
    ({ id: "node", type: "rect", name: "node", x: 0, y: 0, width: 100, height: 100, fills } as DesignElement);

  it("re-points every image layer and leaves the other paints alone", () => {
    const elements = [node([{ type: "solid", color: "#000" }, { type: "image", assetId: "old", fit: "cover" }])];
    expect(applyPropertyToSubtree(elements, "node", "assetId", "new")).toBe(true);
    expect(elements[0].fills).toEqual([
      { type: "solid", color: "#000" },
      { type: "image", assetId: "new", fit: "cover" }
    ]);
  });

  it("adds an image layer instead of silently doing nothing when the target has no image paint", () => {
    const elements = [node([{ type: "solid", color: "#111" }])];
    expect(applyPropertyToSubtree(elements, "node", "assetId", "new")).toBe(true);
    expect(elements[0].fills).toEqual([
      { type: "solid", color: "#111" },
      { type: "image", assetId: "new", fit: "cover" }
    ]);
  });

  it("writes a video's own assetId rather than a fill layer", () => {
    const video = { id: "v", type: "video", x: 0, y: 0, width: 100, height: 100, assetId: "old" } as DesignElement;
    const elements = [video];
    expect(applyPropertyToSubtree(elements, "v", "assetId", "new")).toBe(true);
    expect((elements[0] as any).assetId).toBe("new");
    expect(elements[0].fills).toBeUndefined();
  });
});
