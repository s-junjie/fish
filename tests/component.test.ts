import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import {
  DesignDocument,
  DesignElement,
  FrameElement,
  ComponentElement,
  InstanceElement,
  TextElement,
  RectElement
} from "../src/core/dsl/types";
import { createComponentFromElement, createInstanceFromComponent, detachInstance, removeInstanceOverrides, unlinkInstanceOverride, isInstancePropertyLinked, resetInstance, hasAnythingToReset } from "../src/core/interactions/component-ops";
import { canBecomeComponent, findMasterComponent, collectComponents, groupComponentSets, findVariantMember } from "../src/core/interactions/component-inventory";
import { resolveInstanceChildren, resolveInstanceSelection, commitInstanceOverrides } from "../src/core/interactions/instance-resolve";
import { swapInstanceComponent } from "../src/core/interactions/component-swap";
import { importComponentsFromDocument, parseFishDocument } from "../src/core/interactions/import-components";
import { insertClones } from "../src/core/interactions/clipboard";
import { findElementById } from "../src/core/geometry/tree-ops";
import { adoptTopLevelElements, getActivePage, updateActivePageElements } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

const baseCanvas = { width: 1200, height: 800, background: { type: "solid" as const, color: "#101010" }, unit: "px" as const };
const baseDoc: DesignDocument = {
  version: "0.1",
  id: "test_doc",
  name: "Component Test Doc",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  canvas: baseCanvas,
  pages: [{ id: "page_1", name: "Page 1", canvas: baseCanvas, children: [] }],
  activePageId: "page_1"
};

describe("Component and Instance Engine", () => {
  it("converts a Frame into a Component immutably", () => {
    const frame: FrameElement = {
      id: "f_btn",
      type: "frame",
      name: "Primary Button",
      x: 100,
      y: 100,
      width: 120,
      height: 40,
      children: [
        {
          id: "t_btn",
          type: "text",
          x: 20,
          y: 10,
          width: 80,
          height: 20,
          content: "Click me",
          style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" }
        } as TextElement
      ]
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [frame]);
    const { doc: nextDoc, component } = createComponentFromElement(doc, "f_btn");

    expect(component).toBeTruthy();
    expect(component?.type).toBe("component");
    expect(component?.id).toBe("f_btn");
    expect(component?.name).toBe("Primary Button");
    expect(getActivePage(nextDoc).children[0].type).toBe("component");
    // Ensure original frame is not mutated
    expect(frame.type).toBe("frame");
  });

  it("wraps a non-frame element in a same-named parent frame", () => {
    const parent: FrameElement = {
      id: "f_card",
      type: "frame",
      name: "Card",
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      children: [
        { id: "t_title", type: "text", x: 0, y: 0, width: 60, height: 20, content: "Hi" } as TextElement,
        {
          id: "r_fill",
          type: "rect",
          name: "Rectangle",
          x: 40,
          y: 30,
          width: 80,
          height: 40,
          fills: [{ type: "solid", color: "#3B82F6" }]
        } as RectElement
      ]
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [parent]);
    const { doc: nextDoc, component } = createComponentFromElement(doc, "r_fill");

    expect(component).toBeTruthy();
    expect(component!.type).toBe("component");
    expect(component!.name).toBe("Rectangle");
    expect(component!.id).not.toBe("r_fill");
    // The wrapper frame takes over the element's box, at the element's own position.
    expect(component!.x).toBe(40);
    expect(component!.y).toBe(30);
    expect(component!.width).toBe(80);
    expect(component!.height).toBe(40);
    expect(component!.clipContent).toBe(false);
    expect(component!.fills).toBeUndefined();

    // The element became its only child, re-based into the frame's local space.
    expect(component!.children).toHaveLength(1);
    const child = component!.children[0] as RectElement;
    expect(child.id).toBe("r_fill");
    expect(child.x).toBe(0);
    expect(child.y).toBe(0);
    expect(child.fills).toEqual([{ type: "solid", color: "#3B82F6" }]);

    // The component replaced the element in place, inside the same parent.
    const nextParent = getActivePage(nextDoc).children[0] as FrameElement;
    expect(nextParent.children.map((el) => el.id)).toEqual(["t_title", component!.id]);
    // World position of the drawing is unchanged: 100+40 = 100+40+0.
    expect(parent.x + component!.x + child.x).toBe(parent.x + 40);

    // The source element is untouched.
    const originalRect = (getActivePage(doc).children[0] as FrameElement).children[1] as RectElement;
    expect(originalRect.x).toBe(40);
    expect(child).not.toBe(originalRect);
  });

  it("wraps at the page root and keeps z-order for a top-level element", () => {
    const below: RectElement = { id: "r_below", type: "rect", x: 0, y: 0, width: 50, height: 50 };
    const target: RectElement = { id: "r_top", type: "rect", name: "Button", x: 300, y: 200, width: 120, height: 36 };
    const above: RectElement = { id: "r_above", type: "rect", x: 500, y: 0, width: 50, height: 50 };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [below, target, above]);
    const { doc: nextDoc, component } = createComponentFromElement(doc, "r_top");

    expect(getActivePage(nextDoc).children.map((el) => el.id)).toEqual(["r_below", component!.id, "r_above"]);
    expect(component!.name).toBe("Button");
    expect(getActivePage(nextDoc).children[1].type).toBe("component");
  });

  it("resolves an instance of a component built from a shape", () => {
    const rect: RectElement = { id: "r_sq", type: "rect", name: "Square", x: 300, y: 200, width: 64, height: 64 };
    const doc: DesignDocument = updateActivePageElements(baseDoc, [rect]);
    const { doc: withComponent, component } = createComponentFromElement(doc, "r_sq");
    const { doc: withInstance, instance } = createInstanceFromComponent(withComponent, component!.id, {
      x: 400,
      y: 200
    });

    const instances = getActivePage(withInstance).children.filter((el) => el.type === "instance");
    expect(instances).toHaveLength(1);
    const resolved = resolveInstanceChildren(instance!, component!);
    expect(resolved).toHaveLength(1);
    // Instance sits at (400,200) and its child at local (0,0) → the shape lands there.
    expect(instance!.x! + resolved[0].x).toBe(400);
    expect(instance!.y! + resolved[0].y).toBe(200);
    expect((resolved[0] as RectElement).width).toBe(64);
  });

  it("refuses to build a component from a component or a derived clone", () => {
    const comp: ComponentElement = { id: "c_card", type: "component", name: "Card", x: 0, y: 0, width: 10, height: 10, children: [] };
    const inst: InstanceElement = {
      id: "inst_1",
      type: "instance",
      componentId: "c_card",
      x: 0,
      y: 0,
      width: 10,
      height: 10
    };
    const doc: DesignDocument = updateActivePageElements(baseDoc, [comp, inst]);

    expect(canBecomeComponent(comp)).toBe(false);
    expect(createComponentFromElement(doc, "c_card").component).toBeNull();
    expect(createComponentFromElement(doc, "missing").component).toBeNull();
    expect(createComponentFromElement(doc, "inst_1_ghost").component).toBeNull();
    // An instance is a legitimate target: the component simply holds an instance.
    expect(createComponentFromElement(doc, "inst_1").component!.children[0].type).toBe("instance");
  });

  it("creates an Instance that inherits the master's bound layer", () => {
    const comp: ComponentElement = {
      id: "c_card",
      type: "component",
      name: "Card",
      x: 50,
      y: 50,
      width: 200,
      height: 150,
      children: [
        {
          id: "t_title",
          type: "text",
          x: 10,
          y: 10,
          width: 180,
          height: 24,
          content: "Master Title",
          style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
        } as TextElement
      ]
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [comp]);
    const { doc: nextDoc, instance } = createInstanceFromComponent(doc, "c_card", { x: 300, y: 100 });

    expect(instance).toBeTruthy();
    expect(instance?.type).toBe("instance");
    expect(instance?.componentId).toBe("c_card");
    expect(instance?.x).toBe(300);
    expect(instance?.y).toBe(100);
    // Sparse: a fresh instance stores nothing, so every value is the master's own
    // layer value and a later master edit reaches every instance.
    expect(instance?.overrides ?? []).toEqual([]);
    const resolved = resolveInstanceChildren(instance!, findMasterComponent(nextDoc, "c_card")!);
    expect((resolved[0] as TextElement).content).toBe("Master Title");
    expect(getActivePage(nextDoc).children).toHaveLength(2);
  });

  it("compiles an Instance with its overrides applied", () => {
    const comp: ComponentElement = {
      id: "c_btn",
      type: "component",
      name: "Button",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      children: [
        {
          id: "r_bg",
          type: "rect",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          fills: [{ type: "solid", color: "#3B82F6" }]
        } as RectElement,
        {
          id: "t_btn",
          type: "text",
          x: 10,
          y: 10,
          width: 80,
          height: 20,
          content: "Initial",
          style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" }
        } as TextElement
      ]
    };

    const inst: InstanceElement = {
      id: "inst_1",
      type: "instance",
      componentId: "c_btn",
      x: 200,
      y: 200,
      width: 100,
      height: 40,
      overrides: [
        { targetId: "r_bg", property: "fills", value: [{ type: "solid", color: "#10B981" }] },
        { targetId: "t_btn", property: "content", value: "Buy Now" }
      ]
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [comp, inst]);
    const master = findMasterComponent(doc, inst.componentId);
    expect(master).toBeDefined();

    const resolved = resolveInstanceChildren(inst, master!);
    expect(resolved).toHaveLength(2);

    const compiledBg = resolved[0] as any;
    const compiledText = resolved[1] as any;

    // Verify overrides applied to rect fill
    expect(compiledBg.fills?.[0]?.color).toBe("#10B981");

    // And a text change, which reaches the text layer as a plain `content`
    // override — the channel that replaced the named text property.
    expect(compiledText.content).toBe("Buy Now");

    // Verify deterministic derived IDs
    expect(compiledBg.id).toBe("inst_1_r_bg");
    expect(compiledText.id).toBe("inst_1_t_btn");
  });

  it("handles missing component gracefully", () => {
    const orphanInst: InstanceElement = {
      id: "inst_orphan",
      type: "instance",
      componentId: "c_non_existent",
      x: 50,
      y: 50,
      width: 100,
      height: 50
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [orphanInst]);
    const master = findMasterComponent(doc, orphanInst.componentId);
    expect(master).toBeNull();
  });

  it("handles nested instance references without circular recursion", () => {
    // Comp A contains Instance of Comp A
    const compA: ComponentElement = {
      id: "comp_a",
      type: "component",
      name: "Comp A",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [
        {
          id: "inst_a_nested",
          type: "instance",
          componentId: "comp_a",
          x: 10,
          y: 10,
          width: 80,
          height: 80
        } as InstanceElement
      ]
    };

    const instTop: InstanceElement = {
      id: "inst_top",
      type: "instance",
      componentId: "comp_a",
      x: 200,
      y: 200,
      width: 100,
      height: 100
    };

    const resolved = resolveInstanceChildren(instTop, compA);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe("inst_top_inst_a_nested");
    expect(resolved[0].type).toBe("instance");
  });

  it("detaches an instance into a materialized Frame with fresh IDs", () => {
    const comp: ComponentElement = {
      id: "c_item",
      type: "component",
      name: "Item",
      x: 0,
      y: 0,
      width: 150,
      height: 60,
      children: [
        {
          id: "t_name",
          type: "text",
          x: 10,
          y: 20,
          width: 100,
          height: 20,
          content: "Original Name",
          style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" }
        } as TextElement
      ]
    };

    const inst: InstanceElement = {
      id: "inst_detach",
      type: "instance",
      componentId: "c_item",
      x: 300,
      y: 300,
      width: 150,
      height: 60,
      overrides: [
        { targetId: "t_name", property: "content", value: "Overridden Name" }
      ]
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [comp, inst]);
    const { doc: nextDoc, frame } = detachInstance(doc, "inst_detach");

    expect(frame).toBeTruthy();
    expect(frame?.type).toBe("frame");
    expect((frame as any).componentId).toBeUndefined();
    expect((frame as any).overrides).toBeUndefined();
    expect(frame?.children).toHaveLength(1);

    const childText = frame?.children[0] as TextElement;
    expect(childText.content).toBe("Overridden Name");
    expect(childText.id).not.toBe("t_name"); // Fresh ID generated

    // Frame replaced the instance in doc
    expect(getActivePage(nextDoc).children[1].type).toBe("frame");
    expect(getActivePage(nextDoc).children[1].id).toBe("inst_detach");
  });

  it("runs the make -> instantiate -> set-prop chain the inspector drives", () => {
    const rawFrame: FrameElement = {
      id: "f_pill",
      type: "frame",
      name: "Pill",
      x: 10,
      y: 10,
      width: 80,
      height: 32,
      children: [
        {
          id: "t_pill",
          type: "text",
          x: 5,
          y: 5,
          width: 70,
          height: 20,
          content: "Tag",
          style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" }
        } as TextElement
      ]
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [rawFrame]);

    // 1. make-component
    const made = createComponentFromElement(doc, "f_pill");
    expect(made.component).not.toBeNull();

    // 2. instantiate
    const compId = made.component!.id;
    const inst = createInstanceFromComponent(made.doc, compId);
    expect(inst.instance).not.toBeNull();
    expect(getActivePage(inst.doc).children).toHaveLength(2);
    const newInst = inst.instance!;
    expect(newInst.type).toBe("instance");
    // An untouched instance owns nothing; the master's own layer supplies every
    // value. That is what makes "edit the master, every instance follows" true.
    expect(newInst.overrides).toEqual([]);
    const inherited = resolveInstanceChildren(newInst, findMasterComponent(inst.doc, compId)!);
    expect((inherited[0] as TextElement).content).toBe("Tag");

    // 3. edit a layer through the instance, which is an OVERRIDE — the only
    // channel an instance has now that the named property is gone.
    const selection = resolveInstanceSelection(inst.doc, `${newInst.id}_t_pill`);
    expect(selection?.overridable).toBe(true);
    const edited = commitInstanceOverrides(inst.doc, [selection!], (el) => ({
      ...el,
      content: "Updated Tag"
    }));
    const painted = resolveInstanceChildren(
      findElementById(getActivePage(edited!).children, newInst.id) as InstanceElement,
      findMasterComponent(edited!, compId)!
    );
    expect((painted[0] as TextElement).content).toBe("Updated Tag");
    // The master is untouched: the change is the instance's, not the definition's.
    const masterAfter = findMasterComponent(edited!, compId)!;
    expect((masterAfter.children[0] as TextElement).content).toBe("Tag");
  });

  it("copies and pastes a component into an instance referencing the master component", () => {
    const comp: ComponentElement = {
      id: "c_nav",
      type: "component",
      name: "NavBar",
      x: 100,
      y: 100,
      width: 400,
      height: 60,
      children: []
    };

    const doc: DesignDocument = updateActivePageElements(baseDoc, [comp]);
    const { elements, newIds } = insertClones(getActivePage(doc).children, [comp], { x: 20, y: 20 });

    expect(newIds).toHaveLength(1);
    expect(elements).toHaveLength(2);
    const pasted = elements[1] as InstanceElement;
    expect(pasted.type).toBe("instance");
    expect(pasted.componentId).toBe("c_nav");
    expect(pasted.x).toBe(120);
    expect(pasted.y).toBe(120);
    expect(pasted.width).toBe(400);
    expect(pasted.height).toBe(60);
  });

  it("resolves instance children translated to instance coordinates", () => {
    const master: ComponentElement = {
      id: "c_card",
      type: "component",
      name: "Card",
      x: 100,
      y: 100,
      width: 200,
      height: 150,
      children: [
        {
          id: "card_title",
          type: "text",
          content: "Original Title",
          x: 110,
          y: 120,
          width: 100,
          height: 20,
          style: { fontSize: 16 }
        } as TextElement
      ],
    };

    const inst: InstanceElement = {
      id: "inst_card",
      type: "instance",
      componentId: "c_card",
      x: 300,
      y: 400,
      width: 200,
      height: 150,
      overrides: [{ targetId: "card_title", property: "content", value: "Overridden Title" }]
    };

    const resolved = resolveInstanceChildren(inst, master);
    expect(resolved).toHaveLength(1);
    const child = resolved[0] as TextElement;
    // In v0.3 local coordinates, child retains its local coordinates relative to the component box.
    // SVG scene graph applies <g transform="translate(inst.x, inst.y)"> on the instance.
    expect(child.x).toBe(110);
    expect(child.y).toBe(120);
    // The instance's own override applied
    expect(child.content).toBe("Overridden Title");
  });
});

/**
 * The renderer paints an instance by resolving it, and CanvasDefs emits its
 * <defs> by resolving it again. Those are two independent calls that must agree
 * on every id a clone references — and the ids must survive a re-render, or the
 * whole subtree remounts and every gradient / filter / clip / mask lookup breaks.
 */
describe("resolveInstanceChildren ids are derived and stable", () => {
  const master = (): ComponentElement =>
    ({
      id: "c_card",
      type: "component",
      name: "Card",
      x: 100,
      y: 100,
      width: 200,
      height: 150,
      children: [
        {
          id: "card_title",
          type: "text",
          content: "Title",
          x: 110,
          y: 120,
          width: 100,
          height: 20,
          style: { fontSize: 16 }
        } as TextElement,
        {
          id: "card_body",
          type: "frame",
          x: 110,
          y: 150,
          width: 180,
          height: 80,
          clipContent: true,
          children: [
            {
              id: "card_body_text",
              type: "text",
              content: "Body",
              x: 110,
              y: 150,
              width: 180,
              height: 20,
              style: { fontSize: 14 }
            } as TextElement
          ]
        } as FrameElement
      ]
    }) as ComponentElement;

  const instance = (id: string, x = 300, y = 400): InstanceElement => ({
    id,
    type: "instance",
    componentId: "c_card",
    x,
    y,
    width: 200,
    height: 150
  });

  it("mints the same ids on every resolve, for the same instance", () => {
    const first = resolveInstanceChildren(instance("inst_a"), master());
    const second = resolveInstanceChildren(instance("inst_a"), master());
    const ids = (els: DesignElement[]) => els.map((e) => e.id);
    expect(ids(second)).toEqual(ids(first));
    const nested = (els: DesignElement[]) => (els[1] as FrameElement).children.map((c) => c.id);
    expect(nested(second)).toEqual(nested(first));
  });

  it("keeps two instances of one master apart", () => {
    const a = resolveInstanceChildren(instance("inst_a"), master());
    const b = resolveInstanceChildren(instance("inst_b", 600, 400), master());
    expect(a[0].id).not.toBe(b[0].id);
    expect(a[0].id.startsWith("inst_a")).toBe(true);
    expect(b[0].id.startsWith("inst_b")).toBe(true);
  });

  it("never reuses a master id, so defs can never collide with the master's own", () => {
    const resolved = resolveInstanceChildren(instance("inst_a"), master());
    expect(resolved[0].id).not.toBe("card_title");
    expect((resolved[1] as FrameElement).children[0].id).not.toBe("card_body_text");
  });

  it("leaves the master untouched", () => {
    const m = master();
    const before = JSON.stringify(m);
    resolveInstanceChildren(instance("inst_a"), m);
    expect(JSON.stringify(m)).toBe(before);
  });

  it("re-points text-on-path at the clone of its own path, not the master's", () => {
    const m = master();
    (m.children[0] as any).onPath = { pathId: "card_body", startOffset: 0 };
    const mBefore = JSON.stringify(m);
    const resolved = resolveInstanceChildren(instance("inst_a"), m);
    expect((resolved[0] as any).onPath.pathId).toBe((resolved[1] as DesignElement).id);
    expect((resolved[0] as any).onPath.pathId).not.toBe("card_body");
    // Shallow copies share `onPath`, so a relink must rebuild rather than assign.
    expect(JSON.stringify(m)).toBe(mBefore);
  });
});

describe("instances reflow a master's layout inside the stored instance box", () => {
  it("repositions and remeasures children after an override without changing the outer box", () => {
    const master: ComponentElement = {
      id: "comp_layout",
      type: "component",
      name: "Stacked Card",
      x: 0,
      y: 0,
      width: 300,
      height: 160,
      ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 16 }),
      children: [
        {
          id: "title",
          type: "text",
          x: 0,
          y: 0,
          width: 200,
          height: 22,
          content: "Short",
          sizing: { width: "fill", height: "fit-content" },
          style: { fontFamily: "Inter", fontSize: 16 }
        } as TextElement,
        { id: "body", type: "rect", x: 0, y: 0, width: 100, height: 40 }
      ],
    };
    const instance: InstanceElement = {
      id: "inst_layout",
      type: "instance",
      componentId: master.id,
      x: 400,
      y: 200,
      width: 180,
      height: 160,
    };

    const resolved = resolveInstanceChildren(instance, master);
    const title = resolved.find((el) => el.id === "inst_layout_title") as TextElement;
    const body = resolved.find((el) => el.id === "inst_layout_body") as RectElement;

    expect(title.x).toBe(16); // padding = 16, local to instance
    expect(title.width).toBe(148); // instance width - 2 * padding
    expect(title.height).toBeGreaterThan(22);
    expect(body.y).toBe(title.y + title.height + 8);
    expect(instance.width).toBe(180);
    expect(instance.height).toBe(160);
  });

  it("keeps a layout-less master on the old translate-only path", () => {
    const master: ComponentElement = {
      id: "comp_free",
      type: "component",
      name: "Freeform",
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      children: [{ id: "child", type: "rect", x: 120, y: 130, width: 40, height: 20 }]
    };
    const instance: InstanceElement = {
      id: "inst_free",
      type: "instance",
      componentId: master.id,
      x: 400,
      y: 500,
      width: 200,
      height: 100
    };
    const [child] = resolveInstanceChildren(instance, master);
    // In v0.3, child retains local coordinates (120, 130) inside the instance container
    expect(child.x).toBe(120);
    expect(child.y).toBe(130);
  });

  it("collectComponents lists every component across pages with instance counts", () => {
    const comp = (id: string, name: string): ComponentElement => ({
      id,
      type: "component",
      name,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      children: []
    });
    const inst = (id: string, componentId: string): InstanceElement => ({
      id,
      type: "instance",
      componentId,
      x: 0,
      y: 0,
      width: 100,
      height: 50
    });
    const doc: DesignDocument = {
      ...baseDoc,
      pages: [
        { ...baseDoc.pages[0], children: [comp("c_b", "Button"), inst("i1", "c_b"), inst("i2", "c_b")] },
        { ...baseDoc.pages[0], id: "page_2", name: "Page 2", children: [comp("c_c", "Card"), inst("i3", "c_b")] }
      ]
    };

    const entries = collectComponents(doc);
    expect(entries.map((e) => e.name)).toEqual(["Button", "Card"]);
    const button = entries[0];
    expect(button.pageId).toBe("page_1");
    expect(button.instanceCount).toBe(3);
    expect(entries[1].pageId).toBe("page_2");
    expect(entries[1].instanceCount).toBe(0);
  });

  it("adopts a top-level elements array into the first page when a document has none", () => {
    const legacy = {
      ...baseDoc,
      pages: [],
      elements: [
        { id: "c_solo", type: "component", name: "Solo", x: 0, y: 0, width: 10, height: 10, children: [] }
      ]
    } as unknown as DesignDocument;
    const entries = collectComponents(adoptTopLevelElements(legacy));
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("c_solo");
  });

  it("resolveInstanceSelection maps a derived clone id back to its master node", () => {
    const master: ComponentElement = {
      id: "c_btn",
      type: "component",
      name: "Button",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      children: [
        { id: "t_lbl", type: "text", x: 5, y: 5, width: 90, height: 20, content: "Ok", style: { fontFamily: "Inter", fontSize: 12, color: "#FFF" } } as TextElement
      ]
    };
    const instance: InstanceElement = {
      id: "inst_1",
      type: "instance",
      componentId: "c_btn",
      x: 300,
      y: 0,
      width: 100,
      height: 40
    };
    const els: DesignElement[] = [master, instance];
    const doc: DesignDocument = { ...baseDoc, pages: [{ ...baseDoc.pages[0], children: els }] };

    const sel = resolveInstanceSelection(doc, "inst_1_t_lbl");
    expect(sel?.instanceId).toBe("inst_1");
    expect(sel?.masterNodeId).toBe("t_lbl");
    expect(sel?.overridable).toBe(true);
    expect(resolveInstanceSelection(doc, "nope")).toBeNull();
  });

  it("commitInstanceOverrides writes the diff as overrides and leaves the master alone", () => {
    const master: ComponentElement = {
      id: "c_btn",
      type: "component",
      name: "Button",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      children: [
        { id: "t_lbl", type: "text", x: 5, y: 5, width: 90, height: 20, content: "Ok", style: { fontFamily: "Inter", fontSize: 12, color: "#FFF" } } as TextElement
      ]
    };
    const instance: InstanceElement = {
      id: "inst_1",
      type: "instance",
      componentId: "c_btn",
      x: 0,
      y: 0,
      width: 100,
      height: 40
    };
    const els: DesignElement[] = [master, instance];
    const doc: DesignDocument = { ...baseDoc, pages: [{ ...baseDoc.pages[0], children: els }] };
    const sel = resolveInstanceSelection(doc, "inst_1_t_lbl")!;

    const next = commitInstanceOverrides(doc, [sel], (el) => ({ ...el, content: "Go", x: 999 }));
    expect(next).not.toBeNull();
    const inst = (next!.pages![0].children.find((e) => e.id === "inst_1") as InstanceElement);
    expect(inst.overrides).toEqual([{ targetId: "t_lbl", property: "content", value: "Go" }]);
    // Geometry is master-owned: it must never become an override.
    expect(inst.overrides!.some((o) => o.property === "fills")).toBe(false);
    const masterAfter = next!.pages![0].children.find((e) => e.id === "c_btn") as ComponentElement;
    expect((masterAfter.children[0] as TextElement).content).toBe("Ok");

    // A no-op edit produces no history entry at all.
    expect(commitInstanceOverrides(doc, [sel], (el) => ({ ...el, x: 999 }))).toBeNull();

    const cleared = removeInstanceOverrides(next!, "inst_1", "t_lbl");
    expect((cleared!.pages![0].children.find((e) => e.id === "inst_1") as InstanceElement).overrides).toEqual([]);
  });

  // `strokes` is what renders, so an override written only to the `stroke`
  // shorthand never showed up on an element that already carried a stack.
  it("stroke overrides land on the stack that actually renders", () => {
    const master: ComponentElement = {
      id: "c_box",
      type: "component",
      name: "Box",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      children: [
        {
          id: "r_face",
          type: "rect",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          strokes: [
            { color: "#111111", width: 1 },
            { color: "#222222", width: 2 }
          ]
        } as RectElement
      ]
    };
    const instance: InstanceElement = {
      id: "inst_box",
      type: "instance",
      componentId: "c_box",
      x: 0,
      y: 0,
      width: 100,
      height: 40
    };
    const els: DesignElement[] = [master, instance];
    const doc: DesignDocument = { ...baseDoc, pages: [{ ...baseDoc.pages[0], children: els }] };
    const sel = resolveInstanceSelection(doc, "inst_box_r_face")!;

    const next = commitInstanceOverrides(doc, [sel], (el) => ({
      ...el,
      strokes: [
        { color: "#111111", width: 1 },
        { color: "#FF0000", width: 3 }
      ]
    }))!;

    const inst = next.pages![0].children.find((e) => e.id === "inst_box") as InstanceElement;
    expect(inst.overrides).toEqual([
      {
        targetId: "r_face",
        property: "strokes",
        value: [
          { color: "#111111", width: 1 },
          { color: "#FF0000", width: 3 }
        ]
      }
    ]);

    const resolved = resolveInstanceChildren(inst, master);
    const face = resolved[0] as RectElement;
    expect(face.strokes!.map((s) => s.color)).toEqual(["#111111", "#FF0000"]);
  });

  it("groupComponentSets derives variant properties and swaps between members", () => {
    const variant = (id: string, name: string, state: string): ComponentElement => ({
      id,
      type: "component",
      name,
      setId: "set_btn",
      variantProperties: { State: state },
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      children: [{ id: `t_${id}`, type: "text", x: 0, y: 0, width: 10, height: 10, content: state, style: { fontFamily: "Inter", fontSize: 12, color: "#FFF" } } as TextElement]
    });
    const instance: InstanceElement = {
      id: "inst_1",
      type: "instance",
      componentId: "c_default",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      overrides: [{ targetId: "t_c_default", property: "content", value: "Edited" }]
    };
    const els: DesignElement[] = [
      variant("c_default", "Button State=Default", "Default"),
      variant("c_hover", "Button State=Hover", "Hover"),
      instance
    ];
    const doc: DesignDocument = { ...baseDoc, pages: [{ ...baseDoc.pages[0], children: els }] };

    // A group no node backs: the two members share a `setId` and sit at the page
    // root, which is what a document written before the set became a node — and
    // what dissolving one still produces — looks like.
    const { sets, singles } = groupComponentSets(doc);
    expect(sets).toHaveLength(1);
    expect(singles).toHaveLength(0);
    expect(sets[0].setNodeId).toBeNull();
    expect(sets[0].name).toBe("Button");
    expect(sets[0].properties).toEqual([{ property: "State", values: ["Default", "Hover"] }]);
    expect(findVariantMember(sets[0], { State: "Hover" })?.id).toBe("c_hover");

    const swapped = swapInstanceComponent(doc, "inst_1", "c_hover")!;
    const inst = swapped.pages![0].children.find((e) => e.id === "inst_1") as InstanceElement;
    expect(inst.componentId).toBe("c_hover");
    // The override targeted a node the new master does not have.
    expect(inst.overrides).toEqual([]);
  });

  it("importComponentsFromDocument remints ids and carries referenced assets", () => {
    const source: DesignDocument = {
      ...baseDoc,
      assets: [{ id: "a1", name: "Photo", uri: "data:image/gif;base64,x", width: 1, height: 1 }],
      pages: [
        {
          ...baseDoc.pages[0],
          children: [
            {
              id: "src_card",
              type: "component",
              name: "Card",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              children: [
                {
                  id: "src_img",
                  type: "rect",
                  x: 0,
                  y: 0,
                  width: 10,
                  height: 10,
                  fills: [{ type: "image", assetId: "a1", fit: "cover" }]
                }
              ]
            } as ComponentElement
          ]
        }
      ]
    };
    const result = importComponentsFromDocument(updateActivePageElements(baseDoc, []), source);
    expect(result.names).toEqual(["Card"]);
    const els = getActivePage(result.doc).children;
    const imported = els.find((e) => e.type === "component") as ComponentElement;
    expect(imported.id).not.toBe("src_card");
    expect((imported.children[0] as any).id).not.toBe("src_img");
    expect((imported.children[0] as any).fills[0].assetId).toBe("a1");
    expect(result.doc.assets).toHaveLength(1);

    // A file without the embedded document block is not a FISH file.
    expect(parseFishDocument("<html><body>nope</body></html>")).toBeNull();
    const html = `<html><body><script id="design-doc" type="application/json">${JSON.stringify(source)}</script></body></html>`;
    expect(parseFishDocument(html)?.id).toBe(source.id);
  });

  it("tags resolved instance children with __instanceId", () => {
    const comp: ComponentElement = {
      id: "c_box",
      type: "component",
      name: "Box",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [
        { id: "r_1", type: "rect", x: 10, y: 10, width: 80, height: 80 } as RectElement
      ]
    };
    const inst: InstanceElement = {
      id: "i_box",
      type: "instance",
      componentId: "c_box",
      x: 200,
      y: 200,
      width: 100,
      height: 100
    };
    const children = resolveInstanceChildren(inst, comp);
    expect(children).toHaveLength(1);
    expect(children[0].__instanceId).toBe("i_box");
    expect(children[0].id).toBe("i_box_r_1");
  });
});

/**
 * Unlinking is the edit a user makes when one child of one instance should stop
 * following the main component — "my own colour here, the master's everything
 * else". The all-or-nothing reset could not express it, and a style detach was
 * worse than nothing: it deleted an id, `diffOverridable` saw no paint change, no
 * override was written, and the button reported success while changing nothing.
 */
describe("unlinking one property inside an instance", () => {
  const docWith = (child: DesignElement): DesignDocument => {
    const master: ComponentElement = {
      id: "c_btn",
      type: "component",
      name: "Button",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      children: [child]
    };
    const instance: InstanceElement = {
      id: "inst_1",
      type: "instance",
      componentId: "c_btn",
      x: 0,
      y: 0,
      width: 100,
      height: 40
    };
    const els: DesignElement[] = [master, instance];
    return { ...baseDoc, pages: [{ ...baseDoc.pages[0], children: els }] };
  };

  const instOf = (doc: DesignDocument) =>
    doc.pages![0].children.find((e) => e.id === "inst_1") as InstanceElement;
  const childOf = (doc: DesignDocument) =>
    (doc.pages![0].children.find((e) => e.id === "c_btn") as ComponentElement).children[0];

  const box = (extra: Partial<DesignElement> = {}): DesignElement =>
    ({
      id: "bg",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      fills: [{ type: "solid", color: "#3B82F6" }],
      borderRadius: 8,
      ...extra
    }) as DesignElement;

  it("freezes the master's current value as an override", () => {
    const doc = docWith(box());
    const resolved = resolveInstanceChildren(instOf(doc), (doc.pages![0].children.find((e) => e.id === "c_btn") as ComponentElement)) as DesignElement[];
    const next = unlinkInstanceOverride(doc, "inst_1", "bg", "fills", resolved[0].fills);
    expect(next).not.toBeNull();
    expect(instOf(next!).overrides).toEqual([
      { targetId: "bg", property: "fills", value: [{ type: "solid", color: "#3B82F6" }] }
    ]);
  });

  it("survives a later master edit, which is the whole point of freezing it", () => {
    let doc = docWith(box());
    const master = doc.pages![0].children.find((e) => e.id === "c_btn") as ComponentElement;
    doc = unlinkInstanceOverride(doc, "inst_1", "bg", "fills", [{ type: "solid", color: "#3B82F6" }]!)!;

    // The master changes its fill; the pinned child must not follow.
    const repainted: DesignElement[] = [
      { ...master, children: [{ ...childOf(doc), fills: [{ type: "solid", color: "#FF0000" }] }] },
      ...doc.pages![0].children.filter((e) => e.id !== "c_btn")
    ];
    const after: DesignDocument = {
      ...doc,
      pages: [{ ...doc.pages![0], children: repainted }]
    };
    const instance = after.pages![0].children.find((e) => e.id === "inst_1") as InstanceElement;
    const fresh = resolveInstanceChildren(instance, repainted[0] as ComponentElement) as DesignElement[];
    expect((fresh[0].fills as any)[0].color, "stays pinned").toBe("#3B82F6");
    expect((childOf(after).fills as any)[0].color, "master moved on").toBe("#FF0000");
  });

  it("detaches a bound style so the child can take a colour of its own", () => {
    const doc = docWith(box({ fillStyleId: "ps_blue" }));
    expect(unlinkInstanceOverride(doc, "inst_1", "bg", "fillStyleId", null)).not.toBeNull();
    const next = unlinkInstanceOverride(doc, "inst_1", "bg", "fillStyleId", null)!;
    expect(instOf(next).overrides).toEqual([{ targetId: "bg", property: "fillStyleId", value: null }]);
    const resolved = resolveInstanceChildren(
      instOf(next),
      next.pages![0].children.find((e) => e.id === "c_btn") as ComponentElement
    ) as DesignElement[];
    expect(resolved[0].fillStyleId, "no longer reports itself as bound").toBeUndefined();
  });

  it("keeps a style-binding override through a load", () => {
    // The half that made the drift invisible: writing the override is not enough,
    // because normalize re-reads every override and drops the ones it does not
    // recognise. Its list had 14 entries while this side wrote 18, so the four
    // style bindings were deleted on the next open — no repair, no error, the
    // detach simply undone itself.
    const doc = unlinkInstanceOverride(
      docWith(box({ fillStyleId: "ps_blue" })),
      "inst_1",
      "bg",
      "fillStyleId",
      null
    )!;
    const { document: reloaded } = normalizeDesignDocument(doc, { preserveUnknown: true });
    expect(instOf(reloaded).overrides).toEqual([
      { targetId: "bg", property: "fillStyleId", value: null }
    ]);
  });

  it("refuses a second unlink of the same property, which would be a silent no-op", () => {
    const doc = unlinkInstanceOverride(docWith(box()), "inst_1", "bg", "fills", [])!;
    expect(unlinkInstanceOverride(doc, "inst_1", "bg", "fills", [])).toBeNull();
  });

  it("leaves every other property on the same node still linked", () => {
    const doc = docWith(box({ fillStyleId: "ps_blue" }));
    const next = unlinkInstanceOverride(doc, "inst_1", "bg", "fillStyleId", null)!;
    // The all-or-nothing reset would have dropped both; one unlink must not.
    expect(isInstancePropertyLinked(next, "inst_1", "bg", "fillStyleId")).toBe(true);
    expect(isInstancePropertyLinked(next, "inst_1", "bg", "fills")).toBe(false);
    expect((childOf(next) as { borderRadius?: number }).borderRadius, "the master is untouched").toBe(8);
  });

  it("reports nothing linked for a property that was never overridden", () => {
    const doc = docWith(box());
    expect(isInstancePropertyLinked(doc, "inst_1", "bg", "fills")).toBe(false);
  });
});

/**
 * An instance nested inside another component only ever reached the NODE-level
 * reset: `ComponentSection` carries the instance-level control and is suppressed
 * for instance children, so a swapped icon, a changed label, or a hand-resized box
 * had no undo short of detaching — which is not reversible. The node-level button
 * also reads as "reset" and does nothing at all when the node carries no override,
 * which is the other half of why it looked broken.
 */
describe("resetInstance puts a whole instance back on its master", () => {
  const master: ComponentElement = {
    id: "btn",
    type: "component",
    name: "Button",
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    children: [
      { id: "icon", type: "instance", componentId: "icon/back", x: 0, y: 0, width: 20, height: 20 } as InstanceElement,
      { id: "label", type: "text", x: 24, y: 12, width: 80, height: 16, content: "Buy", style: { fontFamily: "Inter", fontSize: 12 } } as TextElement
    ],
  };
  const iconMaster: ComponentElement = {
    id: "icon/back",
    type: "component",
    name: "Back",
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    children: []
  };

  const docWith = (instance: Partial<InstanceElement>): DesignDocument =>
    ({
      version: "0.1",
      name: "reset",
      canvas: { width: 400, height: 400, unit: "px", background: { type: "solid", color: "#fff" } },
      pages: [
        {
          id: "p1",
          name: "P1",
          canvas: { width: 400, height: 400, unit: "px", background: { type: "solid", color: "#fff" } },
          children: [iconMaster, master, { id: "i", type: "instance", componentId: "btn", x: 0, y: 0, width: 200, height: 40, ...instance } as InstanceElement]
        }
      ],
      activePageId: "p1"
    }) as unknown as DesignDocument;

  const instanceOf = (doc: DesignDocument) =>
    findElementById(getActivePage(doc).children, "i") as InstanceElement;

  it("clears props, every override, and a hand-set size", () => {
    const doc = (
      docWith({
        overrides: [
          { targetId: "icon", property: "componentId", value: "icon/heart" },
          { targetId: "label", property: "content", value: "Reserve" }
        ],
        sizeOverride: true,
        width: 200,
        height: 40
      })
    );
    const next = resetInstance(doc, "i")!;
    const inst = instanceOf(next);
    expect(inst.overrides).toEqual([]);
    expect(inst.sizeOverride).toBeUndefined();
    expect(inst.width).toBe(master.width);
    expect(inst.height).toBe(master.height);
  });

  it("puts a swapped nested component back to the master's own", () => {
    const doc = (docWith({ overrides: [{ targetId: "icon", property: "componentId", value: "icon/heart" }] }));
    const before = resolveInstanceChildren(instanceOf(doc), master);
    expect(before.find((c) => c.id === "i_icon")?.type).toBe("instance");
    const after = resetInstance(doc, "i")!;
    const resolved = resolveInstanceChildren(instanceOf(after), master);
    // No override left, so the clone projects the master's own `icon/back`.
    expect((resolved.find((c) => c.id === "i_icon") as InstanceElement).componentId).toBe("icon/back");
  });

  it("reports nothing to do for an untouched instance", () => {
    const doc = (docWith({}));
    expect(hasAnythingToReset(instanceOf(doc))).toBe(false);
    expect(resetInstance(doc, "i")).toBeNull();
  });

  it("counts an explicit empty override on the instance's own paint as dirt", () => {
    // `effects: []` means "explicitly nothing" and suppresses the master's, so it
    // is a change to undo even though the array is empty.
    const doc = (docWith({ effects: [] }));
    expect(hasAnythingToReset(instanceOf(doc))).toBe(true);
    expect(instanceOf(resetInstance(doc, "i")!).effects).toBeUndefined();
  });

  it("leaves the node-level reset alone — it answers a different question", () => {
    const doc = (docWith({ overrides: [{ targetId: "icon", property: "componentId", value: "icon/heart" }] }));
    const nodeOnly = removeInstanceOverrides(doc, "i", "icon")!;
    expect(instanceOf(nodeOnly).overrides).toEqual([]);
    expect(instanceOf(nodeOnly).sizeOverride).toBeUndefined();
  });
});
