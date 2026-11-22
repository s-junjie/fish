import { describe, expect, it } from "vitest";
import type { AssetRef, DesignDocument, DesignElement } from "../src/core/dsl/types";
import { dedupeAssetForInsert } from "../src/core/interactions/asset-dedupe";

const docWith = (assets: AssetRef[]): DesignDocument => ({ assets }) as DesignDocument;

const elementUsing = (assetId: string): DesignElement =>
  ({
    id: "r1",
    type: "image",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fills: [{ type: "image", assetId }]
  }) as unknown as DesignElement;

const imageAsset = (id: string, uri: string): AssetRef =>
  ({ id, name: "photo", uri }) as AssetRef;

describe("repeated image imports", () => {
  it("reuses an existing row and re-points the new element at it", () => {
    const existing = imageAsset("a1", "data:image/png;base64,AAAA");
    const fresh = imageAsset("a2", existing.uri);
    const result = dedupeAssetForInsert(docWith([existing]), elementUsing(fresh.id), fresh);

    expect(result.asset).toBeUndefined();
    const fills = (result.element as unknown as { fills: Array<{ assetId: string }> }).fills;
    expect(fills[0].assetId).toBe("a1");
  });

  it("keeps a genuinely new image", () => {
    const fresh = imageAsset("a9", "data:image/png;base64,BBBB");
    const result = dedupeAssetForInsert(docWith([]), elementUsing(fresh.id), fresh);

    expect(result.asset?.id).toBe("a9");
    const fills = (result.element as unknown as { fills: Array<{ assetId: string }> }).fills;
    expect(fills[0].assetId).toBe("a9");
  });

  it("remaps a bare assetId as well as an image fill", () => {
    const existing = imageAsset("a1", "data:video/mp4;base64,AAAA");
    const fresh = imageAsset("a2", existing.uri);
    const el = { id: "v1", type: "video", assetId: fresh.id } as unknown as DesignElement;
    const result = dedupeAssetForInsert(docWith([existing]), el, fresh);

    expect((result.element as unknown as { assetId: string }).assetId).toBe("a1");
  });

  it("remaps an html poster and a stroke's paint", () => {
    const existing = imageAsset("a1", "data:image/png;base64,AAAA");
    const fresh = imageAsset("a2", existing.uri);
    const el = {
      id: "h1",
      type: "html",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      posterAssetId: fresh.id,
      strokes: [{ width: 2, paint: { type: "image", assetId: fresh.id } }]
    } as unknown as DesignElement;
    const result = dedupeAssetForInsert(docWith([existing]), el, fresh);

    expect(result.asset).toBeUndefined();
    const out = result.element as unknown as {
      posterAssetId: string;
      strokes: Array<{ width: number; paint: { assetId: string } }>;
    };
    expect(out.posterAssetId).toBe("a1");
    expect(out.strokes[0].paint.assetId).toBe("a1");
    expect(out.strokes[0].width).toBe(2);
  });
});
