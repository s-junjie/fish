import { describe, expect, it } from "vitest";
import { filterAssets, filterComponentItems } from "../src/ui/assets/asset-filter";
import type { AssetRef, ComponentElement } from "../src/core/dsl/types";
import type { ComponentEntry, ComponentSet } from "../src/core/interactions/component-inventory";

function makeComponentEntry(
  id: string,
  name: string,
  opts?: { setId?: string; variantProperties?: Record<string, string> }
): ComponentEntry {
  const el: ComponentElement = {
    id,
    type: "component",
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    children: [],
    setId: opts?.setId,
    variantProperties: opts?.variantProperties
  };
  return {
    id,
    name,
    pageId: "page_1",
    pageName: "Page 1",
    width: 100,
    height: 40,
    instanceCount: 0,
    el,
    setId: opts?.setId,
    variantProperties: opts?.variantProperties
  };
}

describe("filterComponentItems", () => {
  const btnDefault = makeComponentEntry("c_btn_def", "Variant=Default", {
    setId: "set_btn",
    variantProperties: { Variant: "Default", Size: "Medium" }
  });
  const btnDestructive = makeComponentEntry("c_btn_dest", "Variant=Destructive", {
    setId: "set_btn",
    variantProperties: { Variant: "Destructive", Size: "Large" }
  });
  const buttonSet: ComponentSet = {
    setId: "set_btn",
    setNodeId: "set_btn",
    name: "Button",
    members: [btnDefault, btnDestructive],
    properties: [
      { property: "Variant", values: ["Default", "Destructive"] },
      { property: "Size", values: ["Medium", "Large"] }
    ],
    defaultMember: btnDefault
  };
  const chipSingle = makeComponentEntry("c_chip", "StatusChip");

  it("returns all sets and singles when query is empty", () => {
    const res = filterComponentItems([buttonSet], [chipSingle], "   ");
    expect(res).toHaveLength(2);
    expect(res[0].kind).toBe("set");
    expect(res[1].kind).toBe("single");
  });

  it("matches a component set by its own name even when members are Prop=Val", () => {
    const res = filterComponentItems([buttonSet], [chipSingle], "button");
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe("set");
    if (res[0].kind === "set") {
      expect(res[0].set.name).toBe("Button");
      expect(res[0].set.members).toHaveLength(2);
      expect(res[0].entry.id).toBe("c_btn_def");
    }
  });

  it("narrows a component set when searching by a variant value", () => {
    const res = filterComponentItems([buttonSet], [chipSingle], "destructive");
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe("set");
    if (res[0].kind === "set") {
      expect(res[0].set.members.map((m) => m.id)).toEqual(["c_btn_dest"]);
      expect(res[0].entry.id).toBe("c_btn_dest");
    }
  });

  it("matches combined set name + variant property tokens", () => {
    const res = filterComponentItems([buttonSet], [chipSingle], "button size=large");
    expect(res).toHaveLength(1);
    if (res[0].kind === "set") {
      expect(res[0].set.members.map((m) => m.id)).toEqual(["c_btn_dest"]);
    }
  });

  it("matches standalone components by name", () => {
    const res = filterComponentItems([buttonSet], [chipSingle], "chip");
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe("single");
    expect(res[0].entry.id).toBe("c_chip");
  });

  it("returns empty when nothing matches", () => {
    expect(filterComponentItems([buttonSet], [chipSingle], "accordion")).toEqual([]);
  });
});

describe("filterAssets", () => {
  const assets: AssetRef[] = [
    { id: "a1", name: "hero-banner-dark.png", uri: "data:image/png;base64,AA", width: 800, height: 600 },
    { id: "a2", name: "product-intro-clip.mp4", uri: "data:video/mp4;base64,AA", width: 1280, height: 720 }
  ];

  it("matches multi-token asset queries case-insensitively", () => {
    expect(filterAssets(assets, "hero dark").map((a) => a.id)).toEqual(["a1"]);
    expect(filterAssets(assets, "clip").map((a) => a.id)).toEqual(["a2"]);
    expect(filterAssets(assets, "").map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});
