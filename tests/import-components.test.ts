import { describe, expect, it } from "vitest";
import {
  parseFishDocument,
  importComponentsFromDocument
} from "../src/core/interactions/import-components";
import { groupComponentSets } from "../src/core/interactions/component-inventory";
import { getActivePage } from "../src/core/dsl/document-ops";
import type {
  ComponentElement,
  ComponentSetElement,
  DesignDocument,
  InstanceElement,
  PaintStyle
} from "../src/core/dsl/types";

const baseDoc: DesignDocument = {
  id: "doc_target",
  name: "Target",
  version: "0.1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  canvas: { width: 800, height: 600, background: { type: "solid", color: "#ffffff" }, unit: "px" },
  activePageId: "page_1",
  assets: [],
  styles: [],
  pages: [
    {
      id: "page_1",
      name: "Page 1",
      canvas: { width: 800, height: 600, background: { type: "solid", color: "#ffffff" }, unit: "px" },
      children: []
    }
  ]
};

describe("importComponentsFromDocument & parseFishDocument", () => {
  it("parses lenient JSON from .fish.html and imports components without copying source assets", () => {
    const html = `<!doctype html><html><head>
      <script id="design-doc" type="application/json">
      {
        "id": "doc_src",
        "name": "Src",
        "version": "0.1",
        "assets": [{ "id": "a_lifted", "name": "hero.png", "uri": "", "width": 100, "height": 50, }],
        "pages": [{
          "id": "p1",
          "name": "Page 1",
          "children": [{
            "id": "c1",
            "type": "component",
            "name": "Hero",
            "x": 0, "y": 0, "width": 100, "height": 50,
            "fills": [{ "type": "image", "assetId": "a_lifted", "fit": "cover" }],
            "children": []
          }]
        }]
      }
      </script>
      <script id="fish-assets" type="application/json">
      { "a_lifted": "data:image/png;base64,AAAA" }
      </script>
    </head><body></body></html>`;

    const parsed = parseFishDocument(html);
    expect(parsed).not.toBeNull();

    const target: DesignDocument = {
      ...baseDoc,
      assets: [{ id: "existing_1", name: "keep.png", uri: "data:image/png;base64,KEEP", width: 10, height: 10 }]
    };
    const res = importComponentsFromDocument(target, parsed!);
    expect(res.names).toEqual(["Hero"]);
    expect(res.doc.assets).toEqual(target.assets);
  });

  it("preserves componentSet nodes, variantGroupProperties, and remints setId", () => {
    const source: DesignDocument = {
      ...baseDoc,
      id: "doc_src",
      pages: [
        {
          ...baseDoc.pages[0],
          children: [
            {
              id: "set_btn",
              type: "componentSet",
              name: "Button",
              x: 0,
              y: 0,
              width: 200,
              height: 120,
              variantGroupProperties: { Variant: ["Default", "Ghost"] },
              children: [
                {
                  id: "c_btn_1",
                  type: "component",
                  name: "Variant=Default",
                  x: 10,
                  y: 10,
                  width: 80,
                  height: 36,
                  setId: "set_btn",
                  variantProperties: { Variant: "Default" },
                  children: []
                },
                {
                  id: "c_btn_2",
                  type: "component",
                  name: "Variant=Ghost",
                  x: 100,
                  y: 10,
                  width: 80,
                  height: 36,
                  setId: "set_btn",
                  variantProperties: { Variant: "Ghost" },
                  children: []
                }
              ]
            } as ComponentSetElement
          ]
        }
      ]
    };

    const res = importComponentsFromDocument(baseDoc, source);
    expect(res.names).toEqual(["Button"]);
    const els = getActivePage(res.doc).children;
    expect(els).toHaveLength(1);
    const importedSet = els[0] as ComponentSetElement;
    expect(importedSet.type).toBe("componentSet");
    expect(importedSet.id).not.toBe("set_btn");
    expect(importedSet.variantGroupProperties).toEqual({ Variant: ["Default", "Ghost"] });
    expect(importedSet.children).toHaveLength(2);
    for (const child of importedSet.children as ComponentElement[]) {
      expect(child.setId).toBe(importedSet.id);
      expect(child.id).not.toBe("c_btn_1");
      expect(child.id).not.toBe("c_btn_2");
    }

    const grouped = groupComponentSets(res.doc);
    expect(grouped.sets).toHaveLength(1);
    expect(grouped.sets[0].name).toBe("Button");
    expect(grouped.sets[0].setNodeId).toBe(importedSet.id);
    expect(grouped.singles).toHaveLength(0);
  });

  it("remaps nested instance componentId, override targetId paths, and referenced styles", () => {
    const brandStyle: PaintStyle = {
      id: "st_brand",
      styleType: "paint",
      name: "Brand",
      paints: [{ type: "solid", color: "#E8A33D" }]
    };
    const source: DesignDocument = {
      ...baseDoc,
      id: "doc_src",
      styles: [brandStyle],
      pages: [
        {
          ...baseDoc.pages[0],
          children: [
            {
              id: "c_icon",
              type: "component",
              name: "Icon",
              x: 0,
              y: 0,
              width: 16,
              height: 16,
              children: [
                {
                  id: "icon_shape",
                  type: "rect",
                  x: 0,
                  y: 0,
                  width: 16,
                  height: 16,
                  fillStyleId: "st_brand",
                  fills: [{ type: "solid", color: "#E8A33D" }]
                }
              ]
            } as ComponentElement,
            {
              id: "c_badge",
              type: "component",
              name: "Badge",
              x: 40,
              y: 0,
              width: 80,
              height: 24,
              children: [
                {
                  id: "nested_inst",
                  type: "instance",
                  componentId: "c_icon",
                  x: 4,
                  y: 4,
                  width: 16,
                  height: 16,
                  overrides: [{ targetId: "icon_shape", property: "fillStyleId", value: "st_brand" }]
                } as InstanceElement
              ]
            } as ComponentElement
          ]
        }
      ]
    };

    const res = importComponentsFromDocument(baseDoc, source);
    const [importedIcon, importedBadge] = getActivePage(res.doc).children as ComponentElement[];
    const remintedShapeId = importedIcon.children[0].id;
    const nestedInst = importedBadge.children[0] as InstanceElement;
    expect(nestedInst.componentId).toBe(importedIcon.id);
    expect(nestedInst.overrides?.[0].targetId).toBe(remintedShapeId);
    expect(res.doc.styles).toHaveLength(1);
    const remintedStyleId = res.doc.styles![0].id;
    expect(remintedStyleId).not.toBe("st_brand");
    expect((importedIcon.children[0] as any).fillStyleId).toBe(remintedStyleId);
    expect(nestedInst.overrides?.[0].value).toBe(remintedStyleId);
  });
});
