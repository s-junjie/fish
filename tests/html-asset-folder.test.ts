import { describe, it, expect } from "vitest";
import {
  attachMissingAssets,
  indexFolder,
  matchAsset,
  normalizeRelative,
  type FolderFile,
  type ResolvedAsset
} from "../src/core/import/html-asset-folder";
import type { MissingAsset } from "../src/core/import/html-types";
import type { DesignDocument } from "../src/core/dsl/types";

const file = (path: string) => ({ path, file: new File(["x"], path.split("/").pop()!) }) as FolderFile;

describe("normalizeRelative", () => {
  it("collapses the spellings a browser resolves for itself", () => {
    expect(normalizeRelative("./assets/hero.jpg")).toBe("assets/hero.jpg");
    expect(normalizeRelative("assets/../hero.jpg")).toBe("hero.jpg");
    expect(normalizeRelative("assets/hero.jpg?v=2#x")).toBe("assets/hero.jpg");
    expect(normalizeRelative("assets/hero%20shot.jpg")).toBe("assets/hero shot.jpg");
  });

  it("refuses what no picked folder can answer", () => {
    expect(normalizeRelative("../outside.jpg")).toBeUndefined();
    expect(normalizeRelative("https://cdn.test/a.jpg")).toBeUndefined();
    expect(normalizeRelative("data:image/png;base64,xx")).toBeUndefined();
  });
});

describe("matchAsset", () => {
  const index = indexFolder([
    file("demo/ferrari.html"),
    file("demo/assets/hero_final.jpg"),
    file("demo/assets/logo.svg"),
    file("demo/shared/logo.svg")
  ]);

  it("finds the file when the folder IS the page's directory", () => {
    expect(matchAsset("assets/hero_final.jpg", index)?.name).toBe("hero_final.jpg");
  });

  it("finds the file when the folder is above the page's directory", () => {
    expect(matchAsset("hero_final.jpg", index)?.name).toBe("hero_final.jpg");
  });

  /**
   * A bare filename is the weakest evidence there is, so it only counts when the
   * folder holds exactly one: two `logo.svg` in different subdirectories is a
   * guess, and a wrong picture is worse than an empty box.
   */
  it("declines a bare filename that names more than one file", () => {
    expect(matchAsset("logo.svg", index)).toBeUndefined();
    expect(matchAsset("nope.jpg", index)).toBeUndefined();
  });
});

const doc = (fills?: unknown[]): DesignDocument => {
  const children = [
    { id: "hero", type: "rect", name: "hero", x: 0, y: 0, width: 10, height: 10, ...(fills ? { fills } : {}) },
    { id: "other", type: "rect", name: "other", x: 0, y: 0, width: 10, height: 10 }
  ];
  return {
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 100, height: 100 },
    pages: [{ id: "p", name: "Page 1", canvas: { width: 100, height: 100 }, children }],
    activePageId: "p",
    elements: children
  } as unknown as DesignDocument;
};

const missing: MissingAsset[] = [
  { elementId: "hero", url: "assets/hero_final.jpg", paint: { fit: "crop", crop: { x: -0.1, y: 0.2, scale: 1 } } }
];

const bytes: ResolvedAsset[] = [
  {
    url: "assets/hero_final.jpg",
    name: "hero_final.jpg",
    uri: "data:image/jpeg;base64,AAA",
    width: 1440,
    height: 715
  }
];

describe("attachMissingAssets", () => {
  it("puts the picture back on the element that was waiting for it", () => {
    const result = attachMissingAssets(doc(), missing, bytes);
    const [hero, other] = result.doc.pages[0].children;
    expect(result.attached).toBe(1);
    expect(result.remaining).toEqual([]);
    // The framing solved at import time survives the round trip.
    expect(hero.fills?.[0]).toMatchObject({ type: "image", fit: "crop", crop: { x: -0.1, y: 0.2, scale: 1 } });
    expect(hero.fills?.[0]).toHaveProperty("assetId");
    expect(other.fills).toBeUndefined();
  });

  it("registers the bytes once, at the bitmap's own size", () => {
    const result = attachMissingAssets(doc(), missing, bytes);
    expect(result.doc.assets).toHaveLength(1);
    expect(result.doc.assets![0]).toMatchObject({ name: "hero_final.jpg", width: 1440, height: 715 });
  });

  it("stacks the picture over the fill the page already had", () => {
    const result = attachMissingAssets(doc([{ type: "solid", color: "#101017" }]), missing, bytes);
    expect(result.doc.pages[0].children[0].fills).toHaveLength(2);
    expect(result.doc.pages[0].children[0].fills?.[1]).toMatchObject({ type: "image" });
  });

  it("keeps a URL it could not match, rather than forgetting it", () => {
    const result = attachMissingAssets(doc(), missing, []);
    expect(result.attached).toBe(0);
    expect(result.remaining).toEqual(missing);
    expect(result.doc.assets).toBeUndefined();
  });

  it("leaves the document alone when the element is gone", () => {
    const result = attachMissingAssets(doc(), [{ ...missing[0], elementId: "deleted" }], bytes);
    expect(result.doc.pages[0].children.every((el) => el.fills === undefined)).toBe(true);
  });
});
