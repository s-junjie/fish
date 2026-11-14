import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { danglingAssetRefs } from "../src/core/dsl/asset-usage";

const baseDoc = {
  version: "0.1",
  name: "t",
  canvas: { width: 100, height: 100 },
  elements: [],
  assets: [
    {
      id: "asset_1",
      name: "hero",
      uri: "data:image/png;base64,xxx",
      width: 800,
      height: 600,
      credit: { name: "Photo Author", url: "https://example.com/photo/abc" }
    }
  ]
};

const assetRepairs = (repairs: { path: string; message: string }[]) =>
  repairs.filter((r) => r.path.startsWith("/assets/"));

describe("normalizeAssetRefs keeps what the engine uses", () => {
  it("keeps identity, size and credit through normalization", () => {
    const { document } = normalizeDesignDocument(baseDoc);
    const asset = document.assets![0];
    expect(asset.id).toBe("asset_1");
    expect(asset.width).toBe(800);
    expect(asset.height).toBe(600);
    expect(asset.credit).toEqual({ name: "Photo Author", url: "https://example.com/photo/abc" });
  });

  it("still accepts `src` as an alias for `uri`", () => {
    const { document } = normalizeDesignDocument({
      ...baseDoc,
      assets: [{ id: "a", name: "x", src: "https://example.test/i.png" }]
    });
    expect(document.assets![0].uri).toBe("https://example.test/i.png");
  });

  it("drops a credit of the wrong shape rather than storing it", () => {
    const { document } = normalizeDesignDocument({
      ...baseDoc,
      assets: [{ id: "a3", name: "x", uri: "u", credit: "nope" }]
    });
    expect(document.assets![0].credit).toBeUndefined();
  });
});

describe("an annotation field with no reader is ignored", () => {
  const GONE = ["description", "caption", "visualDna", "palette", "tags"];

  it("keeps what the engine uses and reports nothing", () => {
    const { repairs, document } = normalizeDesignDocument({
      ...baseDoc,
      assets: [
        {
          id: "a",
          name: "hero photo",
          uri: "u",
          width: 12,
          ...Object.fromEntries(GONE.map((k) => [k, null]))
        }
      ]
    });
    expect(assetRepairs(repairs)).toEqual([]);
    expect(document.assets![0].name).toBe("hero photo");
    expect(document.assets![0].width).toBe(12);
  });
});

/**
 * The reference that paints nothing.
 *
 * A dangling `assetId` is the failure no other reader can see: the fill is a
 * legal image paint, the document round-trips, `check` was clean and `shot`
 * produced a picture with the image simply missing.
 */
describe("danglingAssetRefs names what paints nothing", () => {
  const docWith = (assets: unknown[], children: unknown[]) =>
    normalizeDesignDocument({
      version: "0.1",
      name: "t",
      canvas: { width: 100, height: 100 },
      assets,
      pages: [{ id: "p1", name: "P1", children }],
      activePageId: "p1"
    }).document;

  const imageRect = (id: string, assetId: string) => ({
    id,
    type: "rect",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fills: [{ type: "image", assetId }]
  });

  it("reports a reference doc.assets[] does not back, with the element", () => {
    const doc = docWith([], [imageRect("car", "img_gone")]);
    expect(danglingAssetRefs(doc)).toEqual([{ assetId: "img_gone", property: "assetId", elementId: "car" }]);
  });

  it("says nothing when the entry exists", () => {
    const doc = docWith(
      [{ id: "img_car", name: "car", uri: "data:image/png;base64,AA" }],
      [imageRect("car", "img_car")]
    );
    expect(danglingAssetRefs(doc)).toEqual([]);
  });

  it("counts one finding per element and asset, not per layer", () => {
    const doc = docWith([], [
      {
        id: "card",
        type: "frame",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        children: [imageRect("a", "img_gone"), imageRect("b", "img_gone")]
      }
    ]);
    expect(danglingAssetRefs(doc).map((ref) => ref.elementId)).toEqual(["a", "b"]);
  });

  it("finds the id an instance override names", () => {
    const doc = docWith(
      [{ id: "img_ok", name: "ok", uri: "data:image/png;base64,AA" }],
      [
        {
          id: "card",
          type: "component",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          children: [imageRect("slot", "img_ok")]
        },
        {
          id: "inst",
          type: "instance",
          x: 20,
          y: 0,
          componentId: "card",
          overrides: [{ targetId: "slot", property: "assetId", value: "img_gone" }]
        }
      ]
    );
    expect(danglingAssetRefs(doc)).toEqual([{ assetId: "img_gone", property: "assetId", elementId: "inst" }]);
  });
});
