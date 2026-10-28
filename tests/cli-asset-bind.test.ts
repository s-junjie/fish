import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { bindAssetFill, dropUnreferencedAssets, embedLocalDocumentAssets, imageAssetIdsOn } from "../src/core/cli/fish-assets";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DesignDocument, DesignElement, ImagePaint, RectElement } from "../src/core/dsl/types";

/**
 * `assets import` and `assets search --add-to` mint a random asset id per run,
 * so an asset that is only registered is an asset nothing points at. `--to`
 * writes the fill in the same pass, and these pin how it writes it.
 */

const rect = (id: string, extra: Partial<RectElement> = {}): RectElement =>
  ({ id, type: "rect", x: 0, y: 0, width: 10, height: 10, ...extra } as RectElement);

const doc = (elements: DesignElement[]): DesignDocument =>
  ({
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 100, height: 100 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 100, height: 100 }, children: elements }],
    activePageId: "page_1"
  } as unknown as DesignDocument);

const fill: ImagePaint = { type: "image", assetId: "asset_x", fit: "cover" };

describe("bindAssetFill", () => {
  it("puts the image on the element that was named", () => {
    const next = bindAssetFill(doc([rect("hero")]), "hero", fill)!;
    expect(getActivePage(next).children[0].fills).toEqual([fill]);
  });

  it("reaches a nested child, not just a top-level one", () => {
    const tree = [{ ...rect("wrap"), children: [rect("hero")] } as DesignElement];
    const next = bindAssetFill(doc(tree), "hero", fill)!;
    const child = (getActivePage(next).children[0] as { children?: DesignElement[] }).children?.[0];
    expect(child?.fills).toEqual([fill]);
    // The wrapper was touched only because its child was; it must not gain a fill.
    expect(getActivePage(next).children[0].fills).toBeUndefined();
  });

  it("appends, so an existing placeholder colour stays underneath", () => {
    const hero = rect("hero", { fills: [{ type: "solid", color: "#CCCCCC" }] });
    const next = bindAssetFill(doc([hero]), "hero", fill)!;
    const fills = getActivePage(next).children[0].fills ?? [];
    expect(fills[fills.length - 1]).toEqual(fill);
    expect(fills[0]).toEqual({ type: "solid", color: "#CCCCCC" });
  });

  it("refuses an unknown id, so the caller can write nothing at all", () => {
    expect(bindAssetFill(doc([rect("hero")]), "nope", fill)).toBeNull();
  });

  it("replace swaps the photo instead of stacking a second one", () => {
    const old: ImagePaint = { type: "image", assetId: "asset_old", fit: "cover" };
    const hero = rect("hero", { fills: [{ type: "solid", color: "#CCCCCC" }, old] });
    const next = bindAssetFill(doc([hero]), "hero", fill, "replace")!;
    // The placeholder colour is a decision; the previous photograph is not.
    expect(getActivePage(next).children[0].fills).toEqual([{ type: "solid", color: "#CCCCCC" }, fill]);
  });

  it("names the assets a replace is about to drop", () => {
    const old: ImagePaint = { type: "image", assetId: "asset_old", fit: "cover" };
    const tree = [{ ...rect("wrap"), children: [rect("hero", { fills: [old] })] } as DesignElement];
    expect(imageAssetIdsOn(doc(tree), "hero")).toEqual(["asset_old"]);
  });
});

describe("dropUnreferencedAssets", () => {
  const withAssets = (elements: DesignElement[], ids: string[]): DesignDocument =>
    ({
      ...doc(elements),
      assets: ids.map((id) => ({ id, name: id, uri: "data:image/svg+xml;base64,AA" }))
    } as DesignDocument);

  const image = (id: string, assetId: string): DesignElement =>
    rect(id, { fills: [{ type: "image", assetId, fit: "cover" }] } as Partial<RectElement>);

  it("drops an asset nothing points at any more", () => {
    const next = dropUnreferencedAssets(withAssets([image("hero", "asset_new")], ["asset_old", "asset_new"]), [
      "asset_old"
    ]);
    expect(next.dropped).toEqual(["asset_old"]);
    expect(next.doc.assets?.map((a) => a.id)).toEqual(["asset_new"]);
  });

  it("keeps an asset a second element still uses", () => {
    const next = dropUnreferencedAssets(
      withAssets([image("a", "asset_old"), image("b", "asset_old")], ["asset_old"]),
      ["asset_old"]
    );
    expect(next.dropped).toEqual([]);
    expect(next.doc.assets).toHaveLength(1);
  });

  it("keeps an asset an instance override still names", () => {
    const instance = {
      ...rect("inst"),
      type: "instance",
      overrides: [{ property: "assetId", value: "asset_old" }]
    } as unknown as DesignElement;
    const next = dropUnreferencedAssets(withAssets([instance], ["asset_old"]), ["asset_old"]);
    expect(next.dropped).toEqual([]);
  });

  it("keeps an asset a shared paint style still paints with", () => {
    // A layer bound to `fillStyleId` names the asset nowhere in the tree, so a
    // scan of pages alone deleted the bytes under a live style.
    const source = withAssets([image("a", "asset_new")], ["asset_old", "asset_new"]);
    source.styles = [
      { id: "st_fill", name: "Hero fill", styleType: "paint", paints: [{ type: "image", assetId: "asset_old", fit: "cover" }] }
    ];
    expect(dropUnreferencedAssets(source, ["asset_old"]).dropped).toEqual([]);
  });

  it("keeps an asset a shared stroke style still paints with", () => {
    const source = withAssets([image("a", "asset_new")], ["asset_old", "asset_new"]);
    source.styles = [
      {
        id: "st_stroke",
        name: "Photo border",
        styleType: "stroke",
        strokes: [{ width: 2, paint: { type: "image", assetId: "asset_old", fit: "cover" } }]
      }
    ];
    expect(dropUnreferencedAssets(source, ["asset_old"]).dropped).toEqual([]);
  });

  it("says nothing when there is nothing to drop", () => {
    const source = withAssets([image("a", "asset_new")], ["asset_new"]);
    expect(dropUnreferencedAssets(source, []).dropped).toEqual([]);
    expect(dropUnreferencedAssets(source, ["asset_new"]).doc).toBe(source);
  });
});

describe("embedLocalDocumentAssets", () => {
  it("resolves and embeds local file declared in assets manifest", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-test-assets-"));
    try {
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="20"/></svg>';
      const imgPath = path.join(tmpDir, "icon.svg");
      fs.writeFileSync(imgPath, svgContent, "utf8");

      const doc = {
        version: "0.1",
        assets: [
          { id: "asset_icon", file: "./icon.svg", name: "Custom Icon" },
          { id: "asset_remote", uri: "https://example.com/photo.jpg" }
        ]
      };

      const result = await embedLocalDocumentAssets(doc, tmpDir);
      expect(result.count).toBe(1);
      expect(result.error).toBeUndefined();

      const asset = doc.assets[0] as Record<string, unknown>;
      expect(asset.uri).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(asset.width).toBe(48);
      expect(asset.height).toBe(48);
      expect(asset.name).toBe("Custom Icon");
      expect(asset.file).toBeUndefined();

      // Remote asset is untouched
      expect((doc.assets[1] as Record<string, unknown>).uri).toBe("https://example.com/photo.jpg");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports an error when the local file does not exist", async () => {
    const doc = {
      assets: [{ id: "missing", file: "./non-existent-image.png" }]
    };
    const result = await embedLocalDocumentAssets(doc, "/some/dir");
    expect(result.count).toBe(0);
    expect(result.error).toMatch(/local file not found/);
  });
});

