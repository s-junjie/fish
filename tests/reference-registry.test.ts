import { describe, it, expect } from "vitest";
import {
  buildReferenceRegistry,
  findMasterComponentFast
} from "../src/ui/canvas/reference-registry";
import { DesignDocument, ComponentElement, InstanceElement, RectElement } from "../src/core/dsl/types";

describe("Reference Registry", () => {
  const masterComponent: ComponentElement = {
    id: "comp_button",
    name: "Primary Button",
    type: "component",
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    children: []
  };

  const instance1: InstanceElement = {
    id: "inst_1",
    name: "Button Instance 1",
    type: "instance",
    componentId: "comp_button",
    x: 50,
    y: 50,
    width: 120,
    height: 40
  };

  const instance2: InstanceElement = {
    id: "inst_2",
    name: "Button Instance 2",
    type: "instance",
    componentId: "comp_button",
    x: 50,
    y: 100,
    width: 120,
    height: 40
  };

  const imageEl: RectElement = {
    id: "img_avatar",
    name: "Avatar",
    type: "rect",
    fills: [{ type: "image", assetId: "asset_logo", fit: "cover" }],
    x: 10,
    y: 10,
    width: 32,
    height: 32
  };

  const doc: DesignDocument = {
    version: "0.2",
    id: "doc_ref_test",
    name: "Reference Test Doc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas: { width: 800, height: 600, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    pages: [
      {
        id: "p1",
        name: "Page 1",
        canvas: { width: 800, height: 600, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
        children: [masterComponent, instance1, instance2, imageEl]
      }
    ],
    activePageId: "p1",
    elements: [masterComponent, instance1, instance2, imageEl],
    assets: [
      {
        id: "asset_logo",
        name: "App Logo",
        uri: "data:image/svg+xml;base64,..."
      }
    ]
  };

  it("indexes components and assets for O(1) resolution", () => {
    const registry = buildReferenceRegistry(doc);

    expect(registry.getComponent("comp_button")).toBe(masterComponent);
    expect(registry.getComponent("unknown")).toBeUndefined();

    expect(registry.getAsset("asset_logo")?.name).toBe("App Logo");
  });

  it("builds reverse reference maps for components and assets", () => {
    const registry = buildReferenceRegistry(doc);

    const compUsers = registry.getDependents("comp_button");
    expect(compUsers.has("inst_1")).toBe(true);
    expect(compUsers.has("inst_2")).toBe(true);
    expect(compUsers.size).toBe(2);

    const assetUsers = registry.getDependents("asset_logo");
    expect(assetUsers.has("img_avatar")).toBe(true);
    expect(assetUsers.size).toBe(1);
  });

  it("findMasterComponentFast resolves via registry with fallback", () => {
    const registry = buildReferenceRegistry(doc);

    const fast = findMasterComponentFast(doc, "comp_button", registry);
    expect(fast?.id).toBe("comp_button");

    const fallback = findMasterComponentFast(doc, "comp_button");
    expect(fallback?.id).toBe("comp_button");
  });
});
