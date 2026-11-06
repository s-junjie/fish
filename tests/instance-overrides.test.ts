import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import type {
  ComponentElement,
  DesignDocument,
  DesignElement,
  FrameElement,
  InstanceElement
} from "../src/core/dsl/types";
import { createInstanceFromComponent } from "../src/core/interactions/component-ops";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import { applyPropertyToSubtree, commitInstanceOverrides, resolveInstanceChildren, resolveInstanceSelection } from "../src/core/interactions/instance-resolve";
import { insertClones } from "../src/core/interactions/clipboard";
import { resetInstance } from "../src/core/interactions/component-ops";
import { swapInstanceComponent } from "../src/core/interactions/component-swap";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { validateDocument } from "../src/core/validate";

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

/**
 * Both renderers gate the scroll offset AND the clip path on `clipContent`, and
 * `ScrollOverflowControl` writes the pair together for that reason. An override
 * that names only the mode — written by an AI op, a paste, or the override API —
 * landed on a frame that still had clipping off, so it painted nothing at all.
 */
describe("an overflow override brings the clipping it needs", () => {
  const docWith = (value: unknown): DesignDocument => {
    const master: ComponentElement = {
      id: "panelCmp",
      type: "component",
      name: "PANEL",
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      children: [
        {
          id: "body",
          type: "frame",
          name: "body",
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          clipContent: false,
          children: []
        } as DesignElement
      ]
    };
    const instance: InstanceElement = {
      id: "panelInst",
      type: "instance",
      name: "PANEL",
      componentId: "panelCmp",
      x: 300,
      y: 0,
      width: 200,
      height: 120,
      overrides: [{ targetId: "body", property: "scrollOverflow", value }]
    };
    const elements = [master, instance] as DesignElement[];
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
  };

  const body = (doc: DesignDocument) =>
    resolveInstanceChildren(instOf(doc, "panelInst"), findMasterComponent(doc, "panelCmp")!)[0] as FrameElement;

  it("turns clipping on, and does it on the clone rather than the master", () => {
    const doc = docWith("vertical");
    const resolved = body(doc);
    expect(resolved.scrollOverflow).toBe("vertical");
    expect(resolved.clipContent, "the offset would move nothing without it").toBe(true);
    const master = findMasterComponent(doc, "panelCmp")!;
    expect((master.children[0] as any).clipContent, "the master is a definition, not this instance's").toBe(false);
  });

  it("says nothing about clipping when the override turns overflow off", () => {
    expect(body(docWith("none")).clipContent).toBe(false);
  });
});

/**
 * A master can lose a layer, and an instance can outlive it: the override names a
 * node that is no longer there. Keeping it is a deliberate choice — the layer may
 * come back, and a silent prune would make the file's own text disappear on the
 * next save with nothing to point at. What it earns instead is a warning, and a
 * swap or a reset clears it.
 */
describe("an override whose node the master no longer has", () => {
  const ORPHAN = { targetId: "label", property: "content" as const, value: "Gone" };

  const orphaned = (): DesignDocument => {
    const doc = fixture();
    const card = findMasterComponent(doc, "card")!;
    const withoutLabel: ComponentElement = {
      ...card,
      children: (card.children || []).filter((el) => el.id !== "label")
    };
    const elements = doc.pages![0].children.map((el) =>
      el.id === "card" ? (withoutLabel as DesignElement) : el.id === "cardInst" ? { ...el, overrides: [ORPHAN] } : el
    );
    return { ...doc, elements, pages: [{ ...doc.pages![0], children: elements }] };
  };

  it("is kept by normalization, so the warning has something to name", () => {
    const { document } = normalizeDesignDocument(orphaned());
    expect(instOf(document as DesignDocument).overrides).toEqual([ORPHAN]);
  });

  it("is reported as a warning rather than dropped in silence", () => {
    const issues = validateDocument(orphaned());
    const found = issues.filter((issue) => issue.elementId === "cardInst");
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("warning");
    expect(found[0].message).toMatch(/can never apply/);
  });

  it("is dropped when the instance is switched to another master", () => {
    const start = orphaned();
    const other: ComponentElement = {
      id: "card2",
      type: "component",
      name: "CARD2",
      x: 0,
      y: 100,
      width: 200,
      height: 80,
      children: [{ id: "caption", type: "text", name: "caption", x: 0, y: 0, width: 80, height: 20, content: "Other", style: {} as any }]
    };
    const withOther: DesignDocument = {
      ...start,
      elements: [...start.pages![0].children, other],
      pages: [{ ...start.pages![0], children: [...start.pages![0].children, other] }]
    };
    const swapped = swapInstanceComponent(withOther, "cardInst", "card2")!;
    expect(instOf(swapped).overrides ?? []).toEqual([]);
  });

  it("is dropped by a reset, which is the same promise as the UI's", () => {
    const reset = resetInstance(orphaned(), "cardInst")!;
    expect(instOf(reset).overrides ?? []).toEqual([]);
  });
});
