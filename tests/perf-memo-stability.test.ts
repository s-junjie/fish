import { describe, it, expect } from "vitest";
import { assetUsageCounts } from "../src/core/dsl/asset-usage";
import { collectComponents } from "../src/core/interactions/component-inventory";
import { hashAsset, createAssetStore } from "../src/core/persistence/assets";
import { computeContentHash } from "../src/core/persistence/recovery";
import { stableHash } from "../src/core/persistence/hash";
import { MemoryBackend } from "../src/core/persistence/backend";
import type { AssetRef, DesignDocument, DesignElement, Page } from "../src/core/dsl/types";

/**
 * The invariants that keep a pan, a drag or an autosave from walking the whole
 * document. Each one is a cache whose key is an immutable object, so the tests
 * are about IDENTITY: the second answer must be the `===` of the first.
 */

const page = (id: string, children: DesignElement[]): Page => ({
  id,
  name: id,
  canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
  children
});

const docWith = (pages: Page[], assets: AssetRef[] = []): DesignDocument => ({
  version: "0.2",
  id: "doc_1",
  name: "Doc",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
  pages,
  activePageId: pages[0]?.id ?? "",
  assets
});

const imageRect = (id: string, assetId: string): DesignElement => ({
  id,
  type: "rect",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fills: [{ type: "image", assetId, fit: "cover" } as never]
});

const master = (id: string): DesignElement => ({
  id,
  type: "component",
  name: id,
  x: 0,
  y: 0,
  width: 40,
  height: 20,
  children: []
});

describe("cross-page scans keep their identity when nothing changed", () => {
  it("returns the same usage map when another page changed without moving a count", () => {
    const busy = page("page_busy", [imageRect("r1", "a1")]);
    const empty = page("page_empty", []);
    const before = docWith([busy, empty]);

    // A commit replaces exactly one page and leaves the other object alone.
    const moved: DesignElement = { id: "r2", type: "rect", x: 40, y: 40, width: 10, height: 10 };
    const after = docWith([busy, page("page_empty", [moved])]);

    expect(assetUsageCounts(before)).toBe(assetUsageCounts(before));
    expect(assetUsageCounts(after)).toBe(assetUsageCounts(before));

    const replaced = docWith([busy, page("page_empty", [imageRect("r2", "a2")])]);
    expect(assetUsageCounts(replaced)).not.toBe(assetUsageCounts(before));
    expect(assetUsageCounts(replaced).get("a2")).toBe(1);
  });

  it("returns the same component list when only another page was edited", () => {
    const busy = page("page_busy", [master("c1")]);
    const empty = page("page_empty", []);
    const before = docWith([busy, empty]);
    const after = docWith([busy, page("page_empty", [imageRect("r2", "a2")])]);

    expect(collectComponents(after)).toBe(collectComponents(before));
  });

  it("reports a resized master by walking only the page that moved", () => {
    const busy = page("page_busy", [master("c1")]);
    const before = docWith([busy]);
    const after = docWith([page("page_busy", [{ ...master("c1"), width: 80 } as DesignElement])]);

    expect(collectComponents(before)[0].width).toBe(40);
    expect(collectComponents(after)[0].width).toBe(80);
  });
});

describe("asset hashes", () => {
  it("keeps the persisted key format an earlier build wrote", () => {
    const ref: AssetRef = { id: "a1", name: "img", uri: "data:image/png;base64,AAAA" };
    expect(hashAsset(ref)).toBe("a" + stableHash(ref.uri));
  });

  it("does not rewrite a row that already holds the same ref", async () => {
    const backend = new MemoryBackend();
    let writes = 0;
    const counting = {
      put: (store: "assets" | "recovery", value: unknown) => {
        writes++;
        return backend.put(store, value);
      },
      get: backend.get.bind(backend),
      getAll: backend.getAll.bind(backend),
      delete: backend.delete.bind(backend),
      clearStore: backend.clearStore.bind(backend)
    };
    const store = createAssetStore(counting);
    const ref: AssetRef = { id: "a1", name: "img", uri: "data:image/png;base64,AAAA" };

    await store.put(ref);
    const firstWrite = writes;
    await store.put({ ...ref });
    await store.put({ ...ref });

    expect(firstWrite).toBe(1);
    expect(writes).toBe(1);
  });
});

describe("content hash", () => {
  const asset: AssetRef = { id: "a1", name: "img", uri: "data:image/png;base64," + "A".repeat(2048) };

  it("is stable for one document and moves with an asset's bytes", () => {
    const before = docWith([page("p1", [imageRect("r1", "a1")])], [asset]);
    const same = docWith([page("p1", [imageRect("r1", "a1")])], [{ ...asset }]);
    const changed = docWith(
      [page("p1", [imageRect("r1", "a1")])],
      [{ ...asset, uri: asset.uri + "B" }]
    );

    expect(computeContentHash(same)).toBe(computeContentHash(before));
    expect(computeContentHash(changed)).not.toBe(computeContentHash(before));
  });

  it("ignores the remembered viewport", () => {
    const plain = docWith([page("p1", [])]);
    const viewed: DesignDocument = {
      ...plain,
      pages: [{ ...plain.pages[0], metadata: { viewport: { x: 12, y: 34, zoom: 0.8 } } }]
    };
    expect(computeContentHash(viewed)).toBe(computeContentHash(plain));
  });
});
