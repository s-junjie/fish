import { describe, it, expect } from "vitest";
import { DesignDocument, FrameElement, ComponentElement, InstanceElement, getActivePage, updateActivePageElements } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { validateDocument } from "../src/core/validate";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import { resolveInstanceChildren } from "../src/core/interactions/instance-resolve";

describe("Multi-Page Document Engine", () => {
  const canvas1 = { width: 1440, height: 900, background: { type: "solid" as const, color: "#141414" }, unit: "px" as const };
  const canvas2 = { width: 1920, height: 1080, background: { type: "solid" as const, color: "#222222" }, unit: "px" as const };

  const masterComp: ComponentElement = {
    id: "comp_btn",
    type: "component",
    name: "Master Button",
    x: 10,
    y: 10,
    width: 100,
    height: 40,
    children: [
      {
        id: "t_btn_text",
        type: "text",
        x: 10,
        y: 10,
        width: 80,
        height: 20,
        content: "Click me",
        style: { fontFamily: "Inter", fontSize: 14, color: "#ffffff" }
      }
    ]
  };

  const instanceOnPage1: InstanceElement = {
    id: "inst_1",
    type: "instance",
    name: "Button Instance",
    componentId: "comp_btn",
    x: 100,
    y: 100,
    width: 100,
    height: 40,
    overrides: []
  };

  const createTestDoc = (): DesignDocument => ({
    version: "0.1",
    id: "doc_multipage",
    name: "Multi-page Test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: canvas1,
    pages: [
      {
        id: "page_main",
        name: "Main Canvas",
        canvas: canvas1,
        children: [instanceOnPage1],
        metadata: { viewport: { x: 50, y: 50, zoom: 1 } }
      },
      {
        id: "page_components",
        name: "❖ Components",
        canvas: canvas2,
        children: [masterComp],
        metadata: { viewport: { x: 0, y: 0, zoom: 0.8 } }
      }
    ],
    activePageId: "page_main"
  });

  it("retrieves the active page correctly and switches pages", () => {
    const doc = createTestDoc();
    expect(getActivePage(doc).id).toBe("page_main");
    expect(getActivePage(doc).name).toBe("Main Canvas");

    const switchedDoc: DesignDocument = {
      ...doc,
      activePageId: "page_components"
    };
    expect(getActivePage(switchedDoc).id).toBe("page_components");
    expect(getActivePage(switchedDoc).children[0].id).toBe("comp_btn");
  });

  it("resolves cross-page master components seamlessly", () => {
    const doc = createTestDoc();
    // masterComp is in page_components, while active page is page_main
    const master = findMasterComponent(doc, "comp_btn");
    expect(master).not.toBeNull();
    expect(master?.id).toBe("comp_btn");
    expect(master?.name).toBe("Master Button");
  });

  it("resolves active page instance from component masters across all pages", () => {
    const doc = createTestDoc();
    const activePage = getActivePage(doc);
    const inst = activePage.children[0] as InstanceElement;
    expect(inst.type).toBe("instance");

    const master = findMasterComponent(doc, inst.componentId);
    expect(master).toBeDefined();

    const resolved = resolveInstanceChildren(inst, master!);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe("inst_1_t_btn_text");
  });

  it("normalizes a document without pages into a single-page document", () => {
    const singlePageDoc = {
      version: "0.1",
      id: "single_page",
      name: "Single Page Doc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      canvas: canvas1,
      elements: [
        { id: "box", type: "rect" as const, x: 0, y: 0, width: 50, height: 50 }
      ]
    };

    const normalized = normalizeDesignDocument(singlePageDoc as any);
    expect(normalized.document.pages).toHaveLength(1);
    expect(normalized.document.pages[0].children).toHaveLength(1);
    expect(normalized.document.activePageId).toBe(normalized.document.pages[0].id);
  });

  it("passes validation with zero errors for valid multi-page document", () => {
    const doc = createTestDoc();
    const diags = validateDocument(doc);
    const errors = diags.filter((d) => d.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("mutates active page elements via updateActivePageElements", () => {
    const doc = createTestDoc();
    const newFrame: FrameElement = {
      id: "frame_hero",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      children: []
    };
    const updated = updateActivePageElements(doc, [newFrame]);

    expect(getActivePage(updated).children).toHaveLength(1);
    expect(getActivePage(updated).children[0].id).toBe("frame_hero");
    expect(updated.pages[0].children[0].id).toBe("frame_hero");
    // Ensure second page is untouched
    expect(updated.pages[1].children[0].id).toBe("comp_btn");
  });
});
