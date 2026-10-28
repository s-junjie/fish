import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OFFICIAL_PROVIDERS, lucideProvider, remixProvider } from "../src/core/plugins";
import { openverseProvider, __resetOpenverseThrottle } from "../src/core/plugins/openverse-provider";
import { createWikimediaProvider } from "../src/plugins/wikimedia/provider";
import { PixabayError, searchPixabay } from "../src/plugins/pixabay/provider";
import { insertRemoteImage } from "../src/core/plugins/remote-image";
import { __resetIconifyCaches, fetchIconNames } from "../src/core/assets/iconify";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { validateDocument } from "../src/core/validate";
import { DesignDocument, Paint, PathElement } from "../src/core/dsl/types";
import { DEFAULT_STROKE_COLOR } from "../src/core/dsl/defaults";
import type { AssetInsertResult } from "../src/core/plugins/types";
import lucideFixture from "./fixtures/iconify-lucide.json";
import remixFixture from "./fixtures/iconify-ri.json";

/**
 * Real Iconify wire format, checked in. The icon path is the one part of the
 * app that consumes markup it did not author, and every rule in it — a `<g>`
 * carrying the paint, an alias answered under its parent's name, a body that
 * opens with a relative moveto — only shows up in data that came off the wire.
 * Fetching it during a test would make the suite depend on someone else's
 * uptime; a fixture keeps the shape and loses the flakiness.
 */

interface WireSet {
  prefix: string;
  width: number;
  height: number;
  icons: Record<string, { body: string }>;
  aliases: Record<string, { parent: string }>;
}

const SETS: Record<string, WireSet> = {
  lucide: lucideFixture as unknown as WireSet,
  ri: remixFixture as unknown as WireSet
};

const collectionMeta = {
  collections: {
    lucide: {
      prefix: "lucide",
      name: "Lucide",
      total: 1928,
      homepage: "https://lucide.dev/icons/",
      license: { title: "ISC", spdx: "ISC", url: "https://lucide.dev/LICENSE" }
    },
    ri: {
      prefix: "ri",
      name: "Remix Icon",
      total: 3229,
      homepage: "https://remixicon.com/",
      license: { title: "Apache 2.0", spdx: "Apache-2.0", url: "https://github.com/Remix-Design/RemixIcon/blob/master/License" }
    }
  }
};

/** Icons whose glyph control points leave the 24 box the element is given. */
const KNOWN_OUTSIDE_BOX = new Set(["drumstick", "edge-fill"]);

let calls: string[] = [];
let realFetch: typeof globalThis.fetch;
let failWith: number | null = null;

/** Serves the three endpoints the transport uses, from the fixtures. */
function installFetch(): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);

    if (failWith !== null) {
      return { ok: false, status: failWith, statusText: "nope" } as unknown as Response;
    }
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

    if (url.pathname === "/collections") {
      const wanted = (url.searchParams.get("prefixes") || "").split(",");
      return json({
        collections: Object.fromEntries(wanted.map((p) => [p, collectionMeta.collections[p as keyof typeof collectionMeta.collections]]))
      });
    }
    if (url.pathname === "/collection") {
      const set = SETS[url.searchParams.get("prefix") || ""];
      return json({ prefix: set.prefix, uncategorized: Object.keys(set.icons), aliases: set.aliases });
    }
    const batch = url.pathname.match(/^\/([^/]+)\.json$/);
    if (batch && SETS[batch[1]]) {
      const set = SETS[batch[1]];
      const wanted = (url.searchParams.get("icons") || "").split(",");
      const icons: Record<string, { body: string }> = {};
      const aliases: Record<string, { parent: string }> = {};
      const not_found: string[] = [];
      for (const name of wanted) {
        if (set.icons[name]) icons[name] = set.icons[name];
        else if (set.aliases[name]) {
          aliases[name] = set.aliases[name];
          icons[set.aliases[name].parent] = set.icons[set.aliases[name].parent];
        } else not_found.push(name);
      }
      return json({ prefix: set.prefix, width: set.width, height: set.height, icons, aliases, not_found });
    }
    return { ok: false, status: 404, statusText: "not found" } as unknown as Response;
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  __resetIconifyCaches();
  calls = [];
  failWith = null;
  realFetch = globalThis.fetch;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetIconifyCaches();
});

describe("iconify transport", () => {
  it("asks for names, then bodies, then licence metadata — never the search endpoint", async () => {
    await lucideProvider.search("star");
    const paths = calls.map((c) => c.split("?")[0]);
    expect(paths).toContain("/collection");
    expect(paths.some((p) => p === "/lucide.json")).toBe(true);
    expect(paths).toContain("/collections");
    expect(calls.some((c) => c.includes("/search"))).toBe(false);
  });

  it("sorts the requested names so the same page is one CDN cache entry", async () => {
    await lucideProvider.search("");
    const body = calls.find((c) => c.startsWith("/lucide.json"))!;
    const names = (body.split("icons=")[1] || "").split(",");
    expect(names.length).toBeGreaterThan(1);
    expect([...names].sort()).toEqual(names);
  });

  it("asks for no more bodies than the page can show", async () => {
    await lucideProvider.search("", 4);
    const body = calls.find((c) => c.startsWith("/lucide.json"))!;
    expect((body.split("icons=")[1] || "").split(",").length).toBe(4);
  });

  it("caches the name list for the session instead of refetching it per keystroke", async () => {
    await lucideProvider.search("a");
    await lucideProvider.search("b");
    expect(calls.filter((c) => c.startsWith("/collection?")).length).toBe(1);
  });

  it("returns nothing rather than throwing when the library is unreachable", async () => {
    failWith = 503;
    await expect(lucideProvider.search("star")).resolves.toEqual([]);
  });

  it("carries the set's licence on every result", async () => {
    const [star] = await lucideProvider.search("star");
    expect(star.credit?.name).toContain("ISC");
    expect(star.credit?.url).toBe("https://lucide.dev/icons/");
  });
});

describe("icon search", () => {
  it("ranks the exact name above a longer one that contains it", async () => {
    const results = await lucideProvider.search("filter");
    expect(results[0].name).toBe("Filter");
  });

  it("resolves an alias onto its parent's geometry", async () => {
    const [home] = await lucideProvider.search("home");
    expect(home.id).toBe("lucide:home");
    const [house] = await lucideProvider.search("house");
    expect(home.iconPaths).toEqual(house.iconPaths);
  });

  // The panel decides a set is exhausted when a window comes back shorter than
  // it asked for. That is only sound while every name in a window becomes a
  // result, so a glyph the converter starts rejecting would truncate the grid
  // for the whole set rather than cost one icon.
  it("returns one result per name, so a short window really does mean the end", async () => {
    for (const [prefix, provider] of [
      ["lucide", lucideProvider],
      ["ri", remixProvider]
    ] as const) {
      const names = await fetchIconNames(prefix);
      const results = await provider.search("", 500);
      expect(results.map((r) => r.id).sort()).toEqual(
        names.map((n) => `${prefix}:${n}`).sort()
      );
    }
  });

  it("resolves every fixture icon to absolute geometry inside the 24 box", async () => {
    for (const [prefix, provider] of [
      ["lucide", lucideProvider],
      ["ri", remixProvider]
    ] as const) {
      for (const result of await provider.search("", 200)) {
        const d = result.iconPaths![0];
        expect(d, `${prefix}:${result.name}`).toMatch(/^M/);
        expect(d, `${prefix}:${result.name} is not fully absolute`).not.toMatch(/[a-z]/);
        const nums = d.match(/-?\d*\.?\d+/g)!.map(Number);
        const outOfBox = nums.filter((v) => v < -26 || v > 26);
        if (KNOWN_OUTSIDE_BOX.has(result.id.split(":")[1])) {
          expect(outOfBox.length, `${result.name} was expected to overhang`).toBeGreaterThan(0);
        } else {
          expect(outOfBox, `${prefix}:${result.name} leaves the 24 box: ${outOfBox}`).toEqual([]);
        }
      }
    }
  });
});

describe("icon paging", () => {
  it("continues the ranked list instead of starting a fresh one", async () => {
    const first = await lucideProvider.search("c", 6, 0);
    const second = await lucideProvider.search("c", 6, 6);

    expect(first.map((r) => r.name)).toEqual(["Calendar", "Camera", "Check", "Circle", "Circle Check", "Clock"]);
    // Still inside the prefix group the first page left, and past it: a slice
    // taken before the sort would hand back "Accessibility" here, because the
    // alphabetical head of the set is not the head of this query's ranking.
    expect(second.map((r) => r.name).slice(0, 2)).toEqual(["Cloud", "Credit Card"]);
    expect(second.map((r) => r.id).some((id) => first.some((f) => f.id === id))).toBe(false);
  });

  it("asks for bodies only for the window it is showing", async () => {
    const first = await lucideProvider.search("c", 6, 0);
    await lucideProvider.search("c", 6, 6);
    const second = calls.filter((c) => c.startsWith("/lucide.json"))[1]!;
    const sent = second.split("icons=")[1].split(",");

    expect(sent.length).toBe(6);
    // The first window's names are not in the second request: paging must not
    // re-download what the panel is already holding, or every click would cost
    // the whole first page again.
    for (const shown of first) {
      expect(sent.includes(shown.id.split(":")[1])).toBe(false);
    }
  });

  it("returns a short page at the end, which is how the panel stops", async () => {
    const all = await lucideProvider.search("", 100, 0);
    const last = await lucideProvider.search("", 6, all.length - 3);
    expect(last).toHaveLength(3);
    await expect(lucideProvider.search("", 6, all.length + 10)).resolves.toEqual([]);
  });
});

describe("icon insert", () => {
  const at = (x: number, y: number) => ({ x, y });

  it("writes an outline set as a stroke and no fill", async () => {
    const [star] = await lucideProvider.search("star");
    const { element } = lucideProvider.insert(star, at(100, 200)) as AssetInsertResult;
    const path = element as PathElement;
    expect(path.type).toBe("path");
    expect(path.x).toBe(100);
    expect(path.y).toBe(200);
    expect(path.width).toBe(24);
    expect(path.height).toBe(24);
    expect(path.d).toMatch(/^M/);
    expect(path.strokes?.[0]).toEqual({ color: DEFAULT_STROKE_COLOR, width: 2, cap: "round", join: "round" });
    expect(path.fills ?? []).toEqual([]);
  });

  it("writes a solid set as a fill and no stroke, which is the only way it reads", async () => {
    const [home] = await remixProvider.search("home-4-line");
    const { element } = remixProvider.insert(home, at(0, 0)) as AssetInsertResult;
    const path = element as PathElement;
    expect(path.strokes?.[0]).toBeUndefined();
    expect(path.fills).toEqual([{ type: "solid", color: DEFAULT_STROKE_COLOR }]);
  });

  it("carries an interior rule only when it changes the rendering", async () => {
    // The one Lucide glyph that is solid, and the only one with a hole in it.
    const [searchLarge] = await lucideProvider.search("search-large");
    const holed = (lucideProvider.insert(searchLarge, at(0, 0)) as AssetInsertResult).element as PathElement;
    expect(holed.fillRule).toBe("evenodd");
    expect(holed.fills).toEqual([{ type: "solid", color: DEFAULT_STROKE_COLOR }]);
    expect(holed.strokes?.[0]).toBeUndefined();

    const [x] = await lucideProvider.search("x");
    const plain = (lucideProvider.insert(x, at(0, 0)) as AssetInsertResult).element as PathElement;
    expect("fillRule" in plain).toBe(false);
  });
});

describe("inserted icons validate cleanly", () => {
  it("produces no errors, and warns only on the glyphs that overhang their box", async () => {
    const warned: string[] = [];
    const seen = new Set<string>();
    for (const provider of [lucideProvider, remixProvider]) {
      for (const result of await provider.search("", 200)) {
        const iconName = result.id.split(":")[1];
        seen.add(iconName);
        const { element } = provider.insert(result, { x: 0, y: 0 }) as AssetInsertResult;
        const doc: DesignDocument = {
          version: "0.2",
          id: "icon_test",
          name: "icon test",
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
          canvas: { unit: "px", background: { type: "solid", color: "#0D0D0D" } },
          pages: [],
          activePageId: "",
          elements: [element]
        };
        const { document: normalized } = normalizeDesignDocument(doc);
        const diagnostics = validateDocument(normalized).filter((d) => d.level !== "info");
        const errors = diagnostics.filter((d) => d.level === "error");
        expect(errors, `icon ${result.id}: ${JSON.stringify(errors)}`).toEqual([]);
        if (diagnostics.length > 0) {
          expect(diagnostics.every((d) => /outside local box/.test(d.message))).toBe(true);
          warned.push(iconName);
        }
      }
    }
    // The extent guard is conservative — it measures Bézier control points, not
    // the curve — so a glyph whose handles reach past 24 warns while drawing
    // nothing there. These are the only such glyphs across the 5157 in the two
    // sets, and the count is here so a new one shows up as a failure.
    expect(warned.sort()).toEqual([...KNOWN_OUTSIDE_BOX].filter((n) => seen.has(n)).sort());
  });
});

describe("provider registry", () => {
  it("offers both icon sets and the photo sources", () => {
    expect(OFFICIAL_PROVIDERS.map((p) => p.id)).toEqual(["lucide", "ri", "openverse"]);
  });

  it("gives every provider a translated name", () => {
    for (const p of OFFICIAL_PROVIDERS) {
      expect(p.nameKey, `${p.id} has no nameKey, so the panel would print a literal`).toBeTruthy();
    }
  });

  it("declares every network-backed source remote", () => {
    // A remote source that omits `remote` gets asked for a feed on mount. The
    // two icon sets are the only non-remote providers, and the invariant is
    // here so a future image source cannot quietly regress into that path.
    for (const p of OFFICIAL_PROVIDERS) {
      expect(p.remote ?? false, `${p.id} does not declare remote`).toBe(p.kind === "image");
    }
  });

  it("declares itself remote, which is what makes the panel hold it back", () => {
    expect(openverseProvider.remote).toBe(true);
  });
});

describe("openverse provider", () => {
  const image = {
    id: "4bc43a04-ef46-4544-a0c1-63c63f56e276",
    title: "Tree Bark Photo",
    url: "https://cdn.stocksnap.io/img-thumbs/960w/XNVBVXO3B7.jpg",
    thumbnail: "https://api.openverse.org/v1/images/4bc43a04/thumb/",
    creator: "Tim Sullivan",
    foreign_landing_url: "https://stocksnap.io/photo/XNVBVXO3B7",
    width: 6016,
    height: 4016,
    license: "cc0",
    license_version: "1.0",
    mature: false
  };

  let calls: string[];
  let realFetch: typeof globalThis.fetch;
  let realImage: typeof globalThis.Image;

  /**
   * The provider now asks the browser whether a URL resolves before writing it
   * into the document, so the suite has to be able to say no. `globalThis.Image`
   * is replaced because the real one needs a live document to fire anything.
   */
  const imageLoads = (loadable: (src: string) => boolean, size = { width: 1024, height: 680 }) => {
    (globalThis as { Image?: unknown }).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = size.width;
      naturalHeight = size.height;
      set src(value: string) {
        setTimeout(() => (loadable(value) ? this.onload?.() : this.onerror?.()), 0);
      }
    };
  };

  beforeEach(() => {
    calls = [];
    __resetOpenverseThrottle();
    realFetch = globalThis.fetch;
    realImage = (globalThis as { Image?: unknown }).Image as typeof globalThis.Image;
    imageLoads(() => true);
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ result_count: 1, results: [image] })
      } as unknown as Response;
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { Image?: unknown }).Image = realImage;
  });

  it("searches with no credential and no settings to fill in", async () => {
    const results = await openverseProvider.search("tree bark");
    expect(results).toHaveLength(1);
    expect(calls[0]).toContain("q=tree%20bark");
    // No auth of any kind is what makes this source zero-config; a token here
    // would mean it is not.
    expect(calls[0]).not.toMatch(/client_id|token|Authorization/i);
  });

  it("clamps the page size to the anonymous cap instead of asking and being refused", async () => {
    // The panel asks every provider for ICON_PAGE_SIZE (120); the anonymous tier
    // answers 401 above 20 rather than clamping, so the cap has to be here.
    await openverseProvider.search("tree", 120);
    expect(calls[0]).toContain("page_size=20");
  });

  it("previews through the API proxy and stores the original url", async () => {
    const [result] = await openverseProvider.search("tree");
    expect(result.preview).toBe(image.thumbnail);
    expect(result.src).toBe(image.url);
  });

  it("states the licence beside the author for the panel to show", async () => {
    const [result] = await openverseProvider.search("tree");
    expect(result.credit).toEqual({
      name: "Tim Sullivan",
      url: "https://stocksnap.io/photo/XNVBVXO3B7",
      license: "CC0 1.0"
    });
  });

  it("expands a licence slug into its readable name", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ ...image, creator: "A Photographer", license: "by-nc-sa", license_version: "4.0" }]
        })
      } as unknown as Response)) as typeof globalThis.fetch;
    const [result] = await openverseProvider.search("tree");
    expect(result.credit!.license).toBe("CC BY-NC-SA 4.0");
    expect(result.credit!.name).toBe("A Photographer");
  });

  it("narrows to the licences that carry no obligations at all", async () => {
    // `license` ORs its slugs, so one request covers both CC0 and the Public
    // Domain Mark rather than excluding one of them.
    await openverseProvider.search("tree", 24, 0, { license: "unrestricted" });
    expect(calls[0]).toContain("license=cc0,pdm");
  });

  it("asks the API for permission sets, not for licence slugs", async () => {
    // "commercial" is a word in `license_type` and nothing else — the same value
    // passed as `license` is a 400 from this API.
    await openverseProvider.search("tree", 24, 0, { license: "commercial" });
    expect(calls[0]).toContain("license_type=commercial");
    expect(calls[0]).not.toContain("&license=");

    await openverseProvider.search("tree", 24, 0, { license: "remixable" });
    expect(calls[1]).toContain("license_type=commercial,modification");
  });

  it("spends no licence parameter on a filter it does not know", async () => {
    await openverseProvider.search("tree", 24, 0, { license: "not-a-real-filter" });
    expect(calls[0]).not.toContain("license");
  });

  it("does not name the Public Domain Mark as though CC published it", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ ...image, license: "pdm", license_version: null }]
        })
      } as unknown as Response)) as typeof globalThis.fetch;
    const [result] = await openverseProvider.search("tree");
    expect(result.credit!.license).toBe("Public domain");
  });

  it("omits the licence when the source states none", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ ...image, license: null, license_version: null }] })
      } as unknown as Response)) as typeof globalThis.fetch;
    const [result] = await openverseProvider.search("tree");
    expect(result.credit).toEqual({
      name: "Tim Sullivan",
      url: "https://stocksnap.io/photo/XNVBVXO3B7"
    });
  });

  it("leaves out works flagged mature", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ ...image, mature: true }, { ...image, id: "other" }] })
      } as unknown as Response)) as typeof globalThis.fetch;
    const results = await openverseProvider.search("tree");
    expect(results.map((r) => r.id)).toEqual(["openverse:other"]);
  });

  it("spends no request on an empty query", async () => {
    // The panel already holds remote sources back, but the source is the thing
    // that knows the query is unusable, so it must not call out either.
    expect(await openverseProvider.search("   ")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reports throttling as its own failure, not a generic search error", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429 } as unknown as Response)) as typeof globalThis.fetch;
    await expect(openverseProvider.search("tree")).rejects.toThrow("assets.throttled");
  });

  it("stores the url by reference and sizes the element from the work", async () => {
    const [result] = await openverseProvider.search("tree");
    const { element, asset } = await openverseProvider.insert(result, { x: 10, y: 20 });
    expect(asset!.uri).toBe(image.url);
    expect(asset!.credit).toEqual({
      name: "Tim Sullivan",
      url: "https://stocksnap.io/photo/XNVBVXO3B7"
    });
    expect(element.type).toBe("rect");
    const layer = (element.fills as Paint[])[0];
    expect(layer.type).toBe("image");
    expect((layer as Extract<Paint, { type: "image" }>).assetId).toBe(asset!.id);
    // Natural size of the probed 1024x680 file, not the 6016x4016 the API
    // reports: the element has to match the file that will paint. 1024 is under
    // the app's MAX_IMAGE_EDGE, so nothing scales it.
    expect(element.width).toBe(1024);
    expect(element.height).toBe(680);
    // No download-tracking call: CC sources do not require tracking,
    // and a stray request would be a licence claim that is not true.
    expect(calls).toHaveLength(1);
  });

  it("keeps the original when it loads, for its resolution", async () => {
    const [result] = await openverseProvider.search("tree");
    const { asset } = await openverseProvider.insert(result, { x: 0, y: 0 });
    expect(asset!.uri).toBe(image.url);
    // Read off the probe, not off the API: these are the pixels that will paint.
    expect(asset!.width).toBe(1024);
    expect(asset!.height).toBe(680);
  });

  it("falls back to the proxy when the original will not load", async () => {
    // Measured on a real network: every live.staticflickr.com result failed to
    // load while the same work's /thumb/ proxy served it at 600px. Storing the
    // original there is what left the canvas empty under a grid that rendered.
    imageLoads((src) => src === image.thumbnail, { width: 600, height: 398 });
    const [result] = await openverseProvider.search("tree");
    const { element, asset } = await openverseProvider.insert(result, { x: 0, y: 0 });
    expect(asset!.uri).toBe(image.thumbnail);
    // And the recorded size follows the file that is actually there, not the
    // 6016x4016 the API reports for the original.
    expect(asset!.width).toBe(600);
    expect(asset!.height).toBe(398);
    expect(element.width).toBe(600);
    expect(element.height).toBe(398);
  });

  it("refuses rather than writing a link nothing can open", async () => {
    imageLoads(() => false);
    const [result] = await openverseProvider.search("tree");
    // A silent insert would put a dead URL in the file and paint nothing, which
    // is indistinguishable from a deleted layer for the rest of the document's life.
    await expect(openverseProvider.insert(result, { x: 0, y: 0 })).rejects.toThrow("assets.imageUnavailable");
  });

  it("does not probe a result whose only link is the one already proven", async () => {
    imageLoads((src) => src === image.thumbnail, { width: 600, height: 398 });
    const [result] = await openverseProvider.search("tree");
    const { asset } = await openverseProvider.insert({ ...result, src: image.thumbnail }, { x: 0, y: 0 });
    expect(asset!.uri).toBe(image.thumbnail);
  });

  it("writes no licence into the document", async () => {
    // The UI shows one and the file does not carry it, which is the whole
    // arrangement: `AssetRef.credit` has no such field, and normalize hands
    // `credit` through whole, so a forwarded key would reach every saved file.
    const [result] = await openverseProvider.search("tree");
    expect(result.credit!.license).toBe("CC0 1.0");
    const { asset } = await openverseProvider.insert(result, { x: 0, y: 0 });
    expect(Object.keys(asset!.credit!).sort()).toEqual(["name", "url"]);

    // And it stays out through a save/load round trip, not just on the way out.
    const { document: doc } = normalizeDesignDocument({
      version: "0.1",
      activePageId: "p1",
      pages: [{ id: "p1", name: "Page 1", children: [] }],
      assets: [asset!]
    } as never);
    expect(Object.keys(doc.assets![0].credit!).sort()).toEqual(["name", "url"]);
    expect(JSON.stringify(doc)).not.toContain("CC0");
  });

  it("falls back to the proxy when a work has no direct url", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ ...image, url: null }] })
      } as unknown as Response)) as typeof globalThis.fetch;
    const [result] = await openverseProvider.search("tree");
    expect(result.src).toBe(image.thumbnail);
  });

  it("drops a work with no image at all rather than inserting an empty box", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ ...image, url: null, thumbnail: null }] })
      } as unknown as Response)) as typeof globalThis.fetch;
    expect(await openverseProvider.search("tree")).toEqual([]);
  });
});

describe("remote image placement", () => {
  const realImage = (globalThis as { Image?: unknown }).Image as typeof globalThis.Image;

  const imageLoads = (size = { width: 1024, height: 680 }) => {
    (globalThis as { Image?: unknown }).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = size.width;
      naturalHeight = size.height;
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    };
  };

  afterEach(() => {
    (globalThis as { Image?: unknown }).Image = realImage;
  });

  it("applies the starting size the source asked for", async () => {
    imageLoads();
    const { element } = await insertRemoteImage(
      {
        id: "pixabay:1",
        name: "tree",
        src: "https://example.test/tree.jpg",
        displayMaxDimension: 320
      },
      { x: 0, y: 0 }
    );
    expect(element.width).toBe(320);
    expect(element.height).toBe(213);
  });

  it("leaves a source that states no size at the file's own pixels", async () => {
    imageLoads();
    const { element, asset } = await insertRemoteImage(
      { id: "custom:1", name: "tree", src: "https://example.test/tree.jpg" },
      { x: 0, y: 0 }
    );
    expect(asset!.width).toBe(1024);
    expect(asset!.height).toBe(680);
    expect(element.width).toBe(1024);
    expect(element.height).toBe(680);
  });

  it("caps a source at the app's own MAX_IMAGE_EDGE", async () => {
    imageLoads({ width: 6000, height: 4000 });
    const { element } = await insertRemoteImage(
      { id: "custom:big", name: "big", src: "https://example.test/big.jpg" },
      { x: 0, y: 0 }
    );
    expect(element.width).toBe(4096);
    expect(element.height).toBe(2731);
  });

  it("does not let a source ask for more than the app's ceiling", async () => {
    imageLoads({ width: 6000, height: 4000 });
    const { element } = await insertRemoteImage(
      {
        id: "custom:huge",
        name: "huge",
        src: "https://example.test/huge.jpg",
        displayMaxDimension: 8000
      },
      { x: 0, y: 0 }
    );
    expect(element.width).toBe(4096);
    expect(element.height).toBe(2731);
  });

  it("never enlarges a file to reach the cap", async () => {
    imageLoads({ width: 300, height: 200 });
    const { element } = await insertRemoteImage(
      {
        id: "custom:2",
        name: "small",
        src: "https://example.test/small.jpg",
        displayMaxDimension: 1280
      },
      { x: 0, y: 0 }
    );
    expect(element.width).toBe(300);
    expect(element.height).toBe(200);
  });
});

describe("pixabay provider", () => {
  const hit = {
    id: 42,
    pageURL: "https://pixabay.com/photos/tree-42/",
    tags: "tree, forest",
    previewURL: "https://cdn.pixabay.com/preview.jpg",
    webformatURL: "https://pixabay.com/get/42_640.jpg",
    largeImageURL: "https://pixabay.com/get/42_1280.jpg",
    imageWidth: 4000,
    imageHeight: 2250,
    user: "alice"
  };

  let realFetch: typeof globalThis.fetch;
  let calls: string[];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ hits: [hit] }) } as unknown as Response;
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("asks with the key and maps the largest free link", async () => {
    const [result] = await searchPixabay("KEY-123", "tree", 24);
    expect(calls[0]).toContain("key=KEY-123");
    expect(calls[0]).toContain("q=tree");
    expect(result.src).toBe(hit.largeImageURL);
    expect(result.preview).toBe(hit.webformatURL);
    expect(result.credit).toEqual({
      name: "alice",
      url: hit.pageURL,
      license: "Pixabay"
    });
  });

  it("names a rejected key as its own failure", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 400 } as unknown as Response)) as typeof globalThis.fetch;
    await expect(searchPixabay("bad", "tree")).rejects.toMatchObject({ code: "invalidKey" });
  });

  it("spends no request on an empty query", async () => {
    expect(await searchPixabay("KEY", "   ")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("exposes its failure codes to the panel", async () => {
    const err = new PixabayError("throttled");
    expect(err.code).toBe("throttled");
    expect(err.name).toBe("PixabayError");
  });
});

const wikimediaProvider = createWikimediaProvider(insertRemoteImage);

describe("wikimedia provider", () => {
  const page = {
    pageid: 1,
    title: "File:Tree bark.jpg",
    index: 1,
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/1/1f/Tree_bark.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo",
        thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Tree_bark.jpg/500px-Tree_bark.jpg?utm_source=commons.wikimedia.org",
        responsiveUrls: {
          "2": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Tree_bark.jpg/960px-Tree_bark.jpg?utm_source=commons.wikimedia.org"
        },
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Tree_bark.jpg",
        width: 3008,
        height: 2000,
        mime: "image/jpeg",
        extmetadata: {
          ObjectName: { value: "Tree Bark" },
          Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a>' },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" }
        }
      }
    ]
  };

  let calls: string[];
  let realFetch: typeof globalThis.fetch;
  let realImage: typeof globalThis.Image;

  const imageLoads = (loadable: (src: string) => boolean, size = { width: 1024, height: 680 }) => {
    (globalThis as { Image?: unknown }).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = size.width;
      naturalHeight = size.height;
      set src(value: string) {
        setTimeout(() => (loadable(value) ? this.onload?.() : this.onerror?.()), 0);
      }
    };
  };

  beforeEach(() => {
    calls = [];
    realFetch = globalThis.fetch;
    realImage = (globalThis as { Image?: unknown }).Image as typeof globalThis.Image;
    imageLoads(() => true);
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ query: { pages: [page] } })
      } as unknown as Response;
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { Image?: unknown }).Image = realImage;
  });

  it("searches the File namespace through the CORS-enabled API", async () => {
    const results = await wikimediaProvider.search("tree bark");
    expect(results).toHaveLength(1);
    expect(calls[0]).toContain("generator=search");
    expect(calls[0]).toContain("gsrnamespace=6");
    expect(calls[0]).toContain("filetype%3Abitmap");
    expect(calls[0]).toContain("origin=*");
    expect(calls[0]).not.toMatch(/token|Authorization/i);
  });

  it("maps the page to an image result and strips campaign parameters", async () => {
    const [result] = await wikimediaProvider.search("tree");
    expect(result.id).toBe("wikimedia:1");
    expect(result.name).toBe("Tree Bark");
    expect(result.src).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Tree_bark.jpg/960px-Tree_bark.jpg"
    );
    expect(result.preview).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Tree_bark.jpg/500px-Tree_bark.jpg"
    );
    expect(result.credit).toEqual({
      name: "Jane Doe",
      url: "https://commons.wikimedia.org/wiki/File:Tree_bark.jpg",
      license: "CC BY-SA 4.0"
    });
  });

  it("keeps search order instead of object-key order", async () => {
    const second = { ...page, pageid: 2, index: 2, title: "File:Second.jpg" };
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ query: { pages: [second, page] } })
      } as unknown as Response)) as typeof globalThis.fetch;
    const results = await wikimediaProvider.search("tree");
    expect(results.map((r) => r.id)).toEqual(["wikimedia:1", "wikimedia:2"]);
  });

  it("drops non-image files and pages with no imageinfo", async () => {
    const pdf = {
      ...page,
      pageid: 3,
      imageinfo: [{ ...page.imageinfo[0], mime: "application/pdf" }]
    };
    const empty = { pageid: 4, title: "File:Empty.jpg", index: 3 };
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ query: { pages: [pdf, empty] } })
      } as unknown as Response)) as typeof globalThis.fetch;
    expect(await wikimediaProvider.search("tree")).toEqual([]);
  });

  it("spends no request on an empty query", async () => {
    expect(await wikimediaProvider.search("   ")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reports throttling as its own failure", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429 } as unknown as Response)) as typeof globalThis.fetch;
    await expect(wikimediaProvider.search("tree")).rejects.toThrow("assets.throttled");
  });

  it("stores the cleaned url and sizes the element from the probed file", async () => {
    const [result] = await wikimediaProvider.search("tree");
    const { element, asset } = await wikimediaProvider.insert(result, { x: 10, y: 20 });
    expect(asset!.uri).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Tree_bark.jpg/960px-Tree_bark.jpg"
    );
    expect(asset!.credit).toEqual({
      name: "Jane Doe",
      url: "https://commons.wikimedia.org/wiki/File:Tree_bark.jpg"
    });
    expect(element.width).toBe(1024);
    expect(element.height).toBe(680);
  });

  it("falls back to the thumbnail when the original will not load", async () => {
    imageLoads((src) => src.includes("/500px-"), { width: 600, height: 398 });
    const [result] = await wikimediaProvider.search("tree");
    const { asset } = await wikimediaProvider.insert(result, { x: 0, y: 0 });
    expect(asset!.uri).toBe(result.preview);
    expect(asset!.width).toBe(600);
    expect(asset!.height).toBe(398);
  });
});
