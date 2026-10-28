import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { assetUsageCounts, unusedAssetIds } from "../src/core/dsl/asset-usage";

const doc = (extra: Record<string, unknown>) =>
  normalizeDesignDocument({
    version: "0.1",
    name: "t",
    canvas: { width: 100, height: 100 },
    elements: [],
    assets: [{ id: "a_orphan", name: "orphan", uri: "data:image/png;base64,x" }],
    ...extra
  }).document;

const imageFill = (assetId: string) => ({ type: "image", assetId, fit: "cover" });

describe("unusedAssetIds", () => {
  it("reports an asset nothing names", () => {
    expect(unusedAssetIds(doc({}))).toEqual(["a_orphan"]);
  });

  it("keeps an asset a frame's child paints", () => {
    const document = doc({
      assets: [
        { id: "a_orphan", name: "orphan", uri: "u" },
        { id: "a_nested", name: "nested", uri: "u" }
      ],
      elements: [
        {
          id: "frame_1",
          type: "frame",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          children: [
            { id: "rect_1", type: "rect", x: 0, y: 0, width: 4, height: 4, fills: [imageFill("a_nested")] }
          ]
        }
      ]
    });
    expect(unusedAssetIds(document)).toEqual(["a_orphan"]);
  });

  it("keeps an asset named only by an instance override", () => {
    const document = doc({
      assets: [
        { id: "a_orphan", name: "orphan", uri: "u" },
        { id: "a_override", name: "override", uri: "u" }
      ],
      elements: [
        {
          id: "inst_1",
          type: "instance",
          componentId: "comp_1",
          x: 0,
          y: 0,
          width: 4,
          height: 4,
          overrides: [{ targetId: "rect_1", property: "assetId", value: "a_override" }]
        }
      ]
    });
    expect(unusedAssetIds(document)).toEqual(["a_orphan"]);
  });

  it("keeps an asset named only by a page background", () => {
    const document = doc({
      assets: [
        { id: "a_orphan", name: "orphan", uri: "u" },
        { id: "a_bg", name: "bg", uri: "u" }
      ],
      pages: [
        {
          id: "page_1",
          name: "Page 1",
          canvas: { width: 100, height: 100, background: imageFill("a_bg") },
          children: []
        }
      ]
    });
    expect(unusedAssetIds(document)).toEqual(["a_orphan"]);
  });

  it("keeps an asset named only by a video poster", () => {
    const document = doc({
      assets: [
        { id: "a_orphan", name: "orphan", uri: "u" },
        { id: "a_poster", name: "poster", uri: "u" }
      ],
      elements: [
        { id: "video_1", type: "video", x: 0, y: 0, width: 4, height: 4, posterAssetId: "a_poster" }
      ]
    });
    expect(unusedAssetIds(document)).toEqual(["a_orphan"]);
  });

  it("keeps an asset named only by a paint style", () => {
    const document = doc({
      assets: [
        { id: "a_orphan", name: "orphan", uri: "u" },
        { id: "a_style", name: "style", uri: "u" }
      ],
      styles: [{ id: "style_1", styleType: "paint", name: "Hero", paints: [imageFill("a_style")] }]
    });
    expect(unusedAssetIds(document)).toEqual(["a_orphan"]);
  });

  it("reports nothing on a document with no assets", () => {
    expect(unusedAssetIds(doc({ assets: [] }))).toEqual([]);
  });
});

describe("assetUsageCounts", () => {
  it("counts every place that paints one asset", () => {
    const document = doc({
      assets: [{ id: "a_shared", name: "shared", uri: "u" }],
      elements: [
        { id: "rect_1", type: "rect", x: 0, y: 0, width: 4, height: 4, fills: [imageFill("a_shared")] },
        { id: "rect_2", type: "rect", x: 0, y: 0, width: 4, height: 4, fills: [imageFill("a_shared")] }
      ]
    });
    expect(assetUsageCounts(document).get("a_shared")).toBe(2);
  });

  it("counts an override and a paint naming the same asset separately", () => {
    const document = doc({
      assets: [{ id: "a_shared", name: "shared", uri: "u" }],
      elements: [
        { id: "rect_1", type: "rect", x: 0, y: 0, width: 4, height: 4, fills: [imageFill("a_shared")] },
        {
          id: "inst_1",
          type: "instance",
          componentId: "comp_1",
          x: 0,
          y: 0,
          width: 4,
          height: 4,
          overrides: [{ targetId: "rect_2", property: "assetId", value: "a_shared" }]
        }
      ]
    });
    expect(assetUsageCounts(document).get("a_shared")).toBe(2);
  });

  it("leaves an unreferenced asset out of the map", () => {
    expect(assetUsageCounts(doc({})).has("a_orphan")).toBe(false);
  });
});
