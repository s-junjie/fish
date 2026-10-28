import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import {
  buildClipboardPayload,
  collectReferencedMasters,
  parseClipboardPayload,
  FISH_CLIPBOARD_TAG
} from "../src/core/interactions/clipboard-payload";
import {
  pasteFragmentIntoDoc,
  remintFragment
} from "../src/core/interactions/clipboard-fragment";
import {
  AssetRef,
  ComponentElement,
  ComponentSetElement,
  DesignDocument,
  DesignElement,
  DesignStyle,
  FrameElement,
  InstanceElement,
  getActivePage
} from "../src/core/dsl/types";
import { findElementById, flattenElements } from "../src/core/geometry/tree-ops";
import { findMasterComponent } from "../src/core/interactions/component-inventory";

const baseCanvas = {
  width: 1200,
  height: 800,
  background: { type: "solid" as const, color: "#101010" },
  unit: "px" as const
};

const makeDoc = (elements: DesignElement[] = [], assets: AssetRef[] = [], styles: DesignStyle[] = []): DesignDocument => ({
  version: "0.1",
  id: "doc",
  name: "Doc",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  canvas: baseCanvas,
  pages: [{ id: "page_1", name: "Page 1", canvas: baseCanvas, children: elements }],
  activePageId: "page_1",
  assets,
  styles
});

const imageAsset: AssetRef = {
  id: "a1",
  name: "Photo",
  uri: "data:image/gif;base64,x",
  width: 10,
  height: 10
};

const brandPaint: DesignStyle = {
  id: "s_brand",
  name: "Brand",
  styleType: "paint",
  paints: [{ type: "solid", color: "#3B82F6" }]
};

const unusedStyle: DesignStyle = {
  id: "s_unused",
  name: "Unused",
  styleType: "paint",
  paints: [{ type: "solid", color: "#000000" }]
};

/** A master carrying every field the old hand-written field list dropped. */
const richMaster = (id: string, child: DesignElement): ComponentElement => ({
  id,
  type: "component",
  name: "Button",
  x: 0,
  y: 0,
  width: 120,
  height: 40,
  fills: [{ type: "solid", color: "#3B82F6" }],
  fillStyleId: "s_brand",
  borderRadius: 8,
  clipContent: true,
  effects: [{ type: "drop-shadow", color: "#000000", offset: { x: 0, y: 2 }, blur: 4, spread: 0 }],
  ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 12 }),
  sizing: { width: "fit-content", height: "fixed" },
  children: [child]
});

const labelIn = (masterId: string): DesignElement => ({
  id: `${masterId}_label`,
  type: "text",
  x: 0,
  y: 0,
  width: 80,
  height: 16,
  content: "Buy",
  style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" }
});

const instanceOf = (componentId: string, over: Partial<InstanceElement> = {}): InstanceElement => ({
  id: "inst1",
  type: "instance",
  name: "Button",
  componentId,
  x: 200,
  y: 100,
  width: 120,
  height: 40,
  rotation: 0,
  opacity: 1,
  visible: true,
  overrides: [],
  ...over
});

const paste = (
  target: DesignDocument,
  sourceDoc: DesignDocument,
  sources: readonly DesignElement[],
  selectedIds: string[] = [],
  viewport = { x: 0, y: 0, width: 800, height: 600 }
) => {
  const payload = parseClipboardPayload(buildClipboardPayload(sourceDoc, sources, "clip1"))!;
  const fragment = remintFragment(target, payload);
  return pasteFragmentIntoDoc(target, fragment, selectedIds, { viewport });
};

describe("cross-file clipboard payload", () => {
  it("writes the current tag and keeps the copied subtree verbatim", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1"))]);
    const payload = parseClipboardPayload(buildClipboardPayload(source, [getActivePage(source).children[0]], "clip1"))!;

    expect(payload.tag).toBe(FISH_CLIPBOARD_TAG);
    expect(payload.elements[0].type).toBe("component");
  });

  it("leaves a plain subtree as-is in the payload", () => {
    const rect: DesignElement = { id: "r1", type: "rect", x: 5, y: 6, width: 100, height: 50 };
    const payload = parseClipboardPayload(buildClipboardPayload(makeDoc([rect]), [rect], "clip3"))!;
    expect(payload.elements[0]).toMatchObject({ type: "rect", x: 5, y: 6 });
    expect(payload.assets).toEqual([]);
    expect(payload.masters).toEqual([]);
  });

  it("rejects foreign clipboard text", () => {
    expect(parseClipboardPayload("")).toBeNull();
    expect(parseClipboardPayload("hello world")).toBeNull();
    expect(parseClipboardPayload(JSON.stringify({ foo: 1 }))).toBeNull();
  });

  it("carries the master a copied instance depends on", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")]);
    const payload = parseClipboardPayload(buildClipboardPayload(source, [getActivePage(source).children[1]], "clip1"))!;

    expect(payload.masters.map((m) => m.id)).toEqual(["cmp1"]);
    // The instance travels as an instance, not as a picture of one.
    expect(payload.elements[0].type).toBe("instance");
  });

  it("carries masters transitively, so a composite's own instance does not dangle", () => {
    // cmp/outer contains an instance of cmp/inner; copying the outer's instance
    // must bring both definitions or the inner instance points at nothing.
    const inner = richMaster("cmp_inner", labelIn("cmp_inner"));
    const outer: ComponentElement = {
      ...richMaster("cmp_outer", { ...instanceOf("cmp_inner"), id: "outer_child" }),
      children: [{ ...instanceOf("cmp_inner"), id: "outer_child" }]
    };
    const source = makeDoc([inner, outer, instanceOf("cmp_outer")]);
    const masters = collectReferencedMasters(source, [getActivePage(source).children[2]]);

    expect(masters.map((m) => m.id).sort()).toEqual(["cmp_inner", "cmp_outer"]);
  });

  it("carries a component set whole, and does not park its members twice", () => {
    // A set's variants are its own content, not references it points at: they
    // travel inside it. Listing one as a master as well would park a SECOND node
    // under the id `remintFragment` already gave the copy inside the set.
    const variant = (id: string, label: string): ComponentElement => ({
      ...richMaster(id, labelIn(id)),
      setId: "set_btn",
      variantProperties: { State: label }
    });
    const set: ComponentSetElement = {
      id: "set_btn",
      type: "componentSet",
      name: "Button",
      x: 0,
      y: 0,
      width: 300,
      height: 100,
      children: [variant("cmp_on", "on"), variant("cmp_off", "off")]
    };
    const source = makeDoc([set]);

    expect(collectReferencedMasters(source, [set])).toEqual([]);

    const fragment = remintFragment(
      makeDoc([richMaster("cmp_local", labelIn("cmp_local"))]),
      parseClipboardPayload(buildClipboardPayload(source, [set], "clip-1"))!
    );
    const pasted = fragment.sources[0] as ComponentSetElement;
    expect(pasted.type).toBe("componentSet");
    expect(pasted.name).toBe("Button");
    // Every member's `setId` moved with the set, so the pasted variants still
    // group under a node this document actually has.
    expect(pasted.id).not.toBe("set_btn");
    for (const child of pasted.children as ComponentElement[]) {
      expect(child.setId).toBe(pasted.id);
    }
    // One node per id: the definitions live inside the set and nowhere else.
    const ids = flattenElements([pasted]).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still carries the masters a variant's own nested instance needs", () => {
    const inner = richMaster("cmp_icon", labelIn("cmp_icon"));
    const outer: ComponentElement = {
      ...richMaster("cmp_button", labelIn("cmp_button")),
      setId: "set_btn",
      variantProperties: { State: "on" },
      children: [
        {
          id: "inst_icon",
          type: "instance" as const,
          componentId: inner.id,
          x: 0,
          y: 0,
          width: inner.width,
          height: inner.height,
          overrides: []
        }
      ]
    };
    const set: ComponentSetElement = {
      id: "set_btn",
      type: "componentSet",
      name: "Button",
      x: 0,
      y: 0,
      width: 200,
      height: 60,
      children: [outer]
    };
    const source = makeDoc([inner, set]);

    // The variant travels inside the set; the instance it holds points outward.
    expect(collectReferencedMasters(source, [set]).map((m) => m.id)).toEqual([inner.id]);
  });

  it("carries a copied master in both arrays, so its definition has a home", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1"))]);
    const payload = parseClipboardPayload(buildClipboardPayload(source, [getActivePage(source).children[0]], "clip1"))!;

    // The insert primitives turn a copied component into an instance, so the
    // definition has to travel separately or the pasted instance points at
    // nothing. Both entries share one id, which is what makes it resolve.
    expect(payload.masters.map((m) => m.id)).toEqual(["cmp1"]);
    expect(payload.elements.map((e) => e.id)).toEqual(["cmp1"]);
  });

  it("collects assets from the master as well as the copied subtree", () => {
    const imageRect: DesignElement = {
      id: "m_img",
      type: "rect",
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      fills: [{ type: "image", assetId: "a1", fit: "cover" }]
    };
    const source = makeDoc([richMaster("cmp1", imageRect), instanceOf("cmp1")], [imageAsset]);
    const payload = parseClipboardPayload(buildClipboardPayload(source, [getActivePage(source).children[1]], "clip1"))!;

    expect(payload.assets.map((a) => a.id)).toEqual(["a1"]);
  });

  it("carries only the styles the fragment is bound to", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")], [], [
      brandPaint,
      unusedStyle
    ]);
    const payload = parseClipboardPayload(buildClipboardPayload(source, [getActivePage(source).children[1]], "clip1"))!;

    expect(payload.styles.map((s) => s.id)).toEqual(["s_brand"]);
  });

  it("carries styles referenced inside instance overrides", () => {
    const inst = instanceOf("cmp1", {
      overrides: [{ targetId: "cmp1_label", property: "fillStyleId", value: "s_brand" }]
    });
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), inst], [], [
      brandPaint,
      unusedStyle
    ]);
    const payload = parseClipboardPayload(buildClipboardPayload(source, [inst], "clip_ov"))!;
    expect(payload.styles.map((s) => s.id)).toEqual(["s_brand"]);
  });
});

describe("pasting a fragment into a foreign document", () => {
  it("lands a live instance whose master arrived and resolves", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")]);
    const { doc, newIds } = paste(makeDoc([]), source, [getActivePage(source).children[1]]);

    const pasted = findElementById(getActivePage(next(doc)).children, newIds[0]);
    expect(pasted?.type).toBe("instance");
    const componentId = (pasted as InstanceElement).componentId;
    expect(componentId).not.toBe("cmp1");
    // The whole point: the master is findable, so the instance is not a
    // placeholder and the copy can be reused in this file.
    expect(findMasterComponent(doc, componentId)).not.toBeNull();
  });

  it("keeps every field the old hand-written flatten dropped", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")]);
    const { doc, newIds } = paste(makeDoc([]), source, [getActivePage(source).children[1]]);
    const element = next(doc);
    const master = findMasterComponent(doc, (findElementById(getActivePage(element).children, newIds[0]) as InstanceElement).componentId)!;
    const label = flattenElements([master]).find((e) => e.type === "text")!;

    expect(master.fills).toEqual([{ type: "solid", color: "#3B82F6" }]);
    expect(master.borderRadius).toBe(8);
    expect(master.clipContent).toBe(true);
    expect(master.effects).toHaveLength(1);
    expect(layoutOf(master)).toMatchObject({ mode: "flex", direction: "row" });
    expect(master.sizing).toMatchObject({ width: "fit-content" });
    // The master's own layers came through with reminted ids, so the label the
    // document names is the copy's — which is what an override on it would target.
    expect(master.children?.[0]?.id).toBe(label.id);
    // The misspelled key the old flatten wrote, which nothing reads.
    expect((master as unknown as Record<string, unknown>).clipsContent).toBeUndefined();
  });

  it("remints an override target so it still binds in the destination", () => {
    const instance = instanceOf("cmp1", {
      overrides: [{ targetId: "cmp1_label", property: "content", value: "Rent" }]
    });
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instance]);
    const { doc, newIds } = paste(makeDoc([]), source, [instance]);

    const pasted = findElementById(getActivePage(next(doc)).children, newIds[0]) as InstanceElement;
    const master = findMasterComponent(doc, pasted.componentId)!;
    const label = flattenElements([master]).find((e) => e.type === "text")!;
    // The target has to be the reminted label, or the override is inert.
    expect(pasted.overrides?.[0].targetId).toBe(label.id);
    expect(pasted.overrides?.[0].targetId).not.toBe("cmp1_label");
    expect(findElementById(flattenElements([master]), pasted.overrides![0].targetId)).toBeTruthy();
  });


  it("remints a carried style whose id the destination already holds", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")], [], [brandPaint]);
    // A DIFFERENT style that happens to share the id: ids are unique per
    // document, so a same-id style in two documents is a coincidence.
    const impostor: DesignStyle = { ...brandPaint, name: "Impostor", paints: [{ type: "solid", color: "#FF0000" }] };
    const target = makeDoc([], [], [impostor]);

    const { doc } = paste(target, source, [getActivePage(source).children[1]]);
    const imported = next(doc);
    const carried = findMasterComponent(imported, "cmp1") ?? findMasterComponent(imported, (findElementById(getActivePage(imported).children, flattenElements(getActivePage(imported).children).find((e) => e.type === "instance")!.id) as InstanceElement).componentId)!;

    expect(imported.styles).toHaveLength(2);
    // The binding must point at the style that CAME WITH the paste, not the one
    // that was already there under a colliding id.
    expect(carried.fillStyleId).toBe(imported.styles![1].id);
    expect(imported.styles![0]).toMatchObject({ id: "s_brand", name: "Impostor" });
  });

  it("synchronizes dual storage for elements and instance overrides with bound styles", () => {
    const staleRect: DesignElement = {
      id: "r_stale",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fillStyleId: "s_brand",
      fills: [{ type: "solid", color: "#000000" }]
    };
    const inst = instanceOf("cmp1", {
      overrides: [{ targetId: "cmp1_label", property: "fillStyleId", value: "s_brand" }]
    });
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), staleRect, inst], [], [brandPaint]);
    const { doc, newIds } = paste(makeDoc([]), source, [staleRect, inst]);
    const active = getActivePage(next(doc)).children;

    const pastedRect = findElementById(active, newIds[0])!;
    expect(pastedRect.fills).toEqual(brandPaint.paints);

    const pastedInst = findElementById(active, newIds[1]) as InstanceElement;
    const remappedStyleId = doc.styles?.find((s) => s.name === "Brand")?.id;
    expect(pastedInst.overrides?.some((o) => o.property === "fillStyleId" && o.value === remappedStyleId)).toBe(true);
    expect(pastedInst.overrides?.some((o) => o.property === "fills" && JSON.stringify(o.value) === JSON.stringify(brandPaint.paints))).toBe(true);
  });

  it("never mints two fragment members onto the same id", () => {
    const a = richMaster("cmp_a", labelIn("cmp_a"));
    const b = richMaster("cmp_b", labelIn("cmp_b"));
    const source = makeDoc([a, b]);
    const { doc } = paste(makeDoc([]), source, [a, b]);

    const ids = flattenElements(getActivePage(next(doc)).children).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mints a fresh id rather than colliding with one the destination already uses", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1"))]);
    const target = makeDoc([{ id: "cmp1", type: "rect", x: 0, y: 0, width: 10, height: 10 }]);
    const { doc, newIds } = paste(target, source, [getActivePage(source).children[0]]);

    // The destination's own `cmp1` is a rect, not a master, so the carried
    // definition cannot land on it without shadowing every instance of nothing.
    expect(newIds).not.toContain("cmp1");
    const imported = next(doc);
    const carried = getActivePage(imported).children.find((e) => e.type === "component")!;
    expect(carried.id).not.toBe("cmp1");
    expect(findElementById(flattenElements(getActivePage(imported).children), "cmp1")?.type).toBe("rect");
  });

  it("centres in the viewport rather than at the source's page coordinates", () => {
    const rect: DesignElement = { id: "r1", type: "rect", x: 30, y: 70, width: 200, height: 150 };
    const viewport = { x: 0, y: 0, width: 800, height: 600 };
    const { doc, newIds } = paste(makeDoc([]), makeDoc([rect]), [rect], [], viewport);
    const pasted = findElementById(getActivePage(next(doc)).children, newIds[0])!;

    expect(pasted.x).toBe(300);
    expect(pasted.y).toBe(225);
  });

  it("centres in the target frame when one is selected", () => {
    const rect: DesignElement = { id: "r1", type: "rect", x: 30, y: 70, width: 200, height: 150 };
    const frame: FrameElement = {
      id: "f1",
      type: "frame",
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      children: []
    };
    const target = makeDoc([frame]);
    const { doc, newIds } = paste(target, makeDoc([rect]), [rect], ["f1"]);

    const pasted = findElementById(getActivePage(next(doc)).children, newIds[0])!;
    expect(frame.children).toHaveLength(0);
    expect(pasted.x).toBe(200);
    expect(pasted.y).toBe(125);
  });

  it("parks carried masters behind the content and above it on the canvas", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")]);
    const { doc } = paste(makeDoc([]), source, [getActivePage(source).children[1]]);
    const roots = getActivePage(next(doc)).children;

    const masterAt = roots.findIndex((e) => e.type === "component");
    const instanceAt = roots.findIndex((e) => e.type === "instance");
    // Masters are definitions, not content: behind in z-order, and above the
    // drop point so the paste itself is what the user sees.
    expect(masterAt).toBeGreaterThanOrEqual(0);
    expect(masterAt).toBeLessThan(instanceAt);
    const master = roots[masterAt];
    const instance = roots[instanceAt];
    expect(master.y + master.height).toBeLessThanOrEqual(instance.y);
  });

  it("keeps carried masters out of the frame the content went into", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")]);
    const frame: FrameElement = { id: "f1", type: "frame", x: 0, y: 0, width: 600, height: 400, children: [] };
    const { doc } = paste(makeDoc([frame]), source, [getActivePage(source).children[1]], ["f1"]);
    const elements = getActivePage(next(doc)).children;

    // The instance is inside the frame; the definition is not, and resolution
    // does not care because `findMasterComponent` scans every page.
    const pasted = findElementById(elements, "f1") as FrameElement;
    expect(pasted.children.some((c) => c.type === "instance")).toBe(true);
    expect(elements.some((e) => e.type === "component")).toBe(true);
    expect(findMasterComponent(doc, (pasted.children[0] as InstanceElement).componentId)).not.toBeNull();
  });

  it("reports how many definitions it carried", () => {
    const source = makeDoc([richMaster("cmp1", labelIn("cmp1")), instanceOf("cmp1")]);
    expect(paste(makeDoc([]), source, [getActivePage(source).children[1]]).carriedMasters).toBe(1);
  });
});

/** The committed document, which is what the paste returned. */
const next = (result: { doc: DesignDocument } | DesignDocument): DesignDocument =>
  "doc" in result ? (result.doc as DesignDocument) : (result as DesignDocument);
