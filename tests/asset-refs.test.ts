import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

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
