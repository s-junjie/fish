/**
 * The two import doors must produce the SAME DOCUMENT.
 *
 * `docs/FIGMA_IMPORT_PLAN.md` §0: the mapping exists once, in
 * `src/core/import/figma-*.ts`, and the plugin only reshapes bytes on the way in.
 * That is a claim about two pieces of code agreeing, and the only honest way to
 * hold it is to run both and diff. Everything weaker — "it renders", "there are no
 * empty paths" — passes with a mapping that is subtly, silently different, which
 * is exactly how this line already lost ninety degrees of gradient once
 * (`docs/LESSONS_LEARNED.md` §142).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importFigmaFile } from "../src/core/import/figma-import";
import { isFigmaExportText, isFigmaPluginExport, parseFigmaExport, FigmaExportError } from "../src/core/import/figma-export";
import { buildStoredZip, FISH_BUNDLE_MANIFEST, readFigmaBundle } from "../src/core/import/figma-bundle";
import type { FigmaFileResponse } from "../src/core/import/figma-types";
import type { DesignElement } from "../src/core/dsl/types";
import { loadCollect } from "./helpers/figma-plugin-runtime";
import { toPluginGroups } from "./helpers/figma-plugin-nodes";
import { collectFigmaImageRefs } from "../src/core/import/figma-assets";
import { presentationFrames } from "../src/core/presentation/frames";

const ROOT = path.resolve(import.meta.dirname, "..");
const REST_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/figma-sample-screen.json"), "utf8")) as FigmaFileResponse;
const collect = loadCollect();

/**
 * The same design as the plugin would hand it over.
 *
 * The inverse shim in `figma-plugin-nodes.ts` is derived from the plugin API, not
 * from `collect.js`, so this is the plugin's own view of the file rather than
 * `collect.js`'s view of itself.
 */
function pluginExportOf(response: FigmaFileResponse, images: Record<string, string> = {}): Record<string, unknown> {
  const { groups, meta } = toPluginGroups(response as unknown as Record<string, unknown>);
  return collect.buildExport(groups, { ...meta, scope: "selection", images });
}

const IMAGE_URIS: Record<string, string> = {};
for (const ref of collectImageRefs(REST_FIXTURE)) IMAGE_URIS[ref] = `data:image/png;base64,AAAA-${ref}`;

function collectImageRefs(file: FigmaFileResponse): string[] {
  const refs: string[] = [];
  (function walk(node: unknown): void {
    const record = node as { fills?: Array<{ type?: string; imageRef?: string }>; children?: unknown[] };
    for (const fill of record.fills ?? []) if (fill.type === "IMAGE" && fill.imageRef) refs.push(fill.imageRef);
    for (const child of record.children ?? []) walk(child);
  })(file.document);
  return [...new Set(refs)];
}

/**
 * Asset ids are minted per import, so they cannot be compared directly — and
 * comparing them is not the point. What has to match is WHICH layer carries WHICH
 * picture, which the ref→URI map says without depending on a generated id.
 */
function withoutAssetIds(elements: unknown): unknown {
  return JSON.parse(
    JSON.stringify(elements, (key, value) => (key === "assetId" ? "<asset>" : value))
  );
}

async function importRest() {
  return importFigmaFile(REST_FIXTURE, { imageFills: IMAGE_URIS });
}

async function importPlugin() {
  const parsed = parseFigmaExport(pluginExportOf(REST_FIXTURE, IMAGE_URIS));
  return importFigmaFile(parsed.document, { imageFills: parsed.imageFills });
}

describe("the plugin export and the REST response agree", () => {
  it("produces byte-identical elements, page for page", async () => {
    const rest = await importRest();
    const plugin = await importPlugin();

    expect(plugin.pages.map((p) => ({ id: p.id, name: p.name, canvas: p.canvas }))).toEqual(
      rest.pages.map((p) => ({ id: p.id, name: p.name, canvas: p.canvas }))
    );
    expect(withoutAssetIds(plugin.pages)).toEqual(withoutAssetIds(rest.pages));
  });

  it("reports the same numbers AND the same gaps, because a silent difference is the failure this guards", async () => {
    const rest = await importRest();
    const plugin = await importPlugin();

    expect(plugin.report.elementCount).toBe(rest.report.elementCount);
    expect(plugin.report.pageCount).toBe(rest.report.pageCount);
    expect(plugin.report.maxDelta).toBe(rest.report.maxDelta);
    expect(plugin.report.styleBindings).toBe(rest.report.styleBindings);
    expect(plugin.report.unmapped).toEqual(rest.report.unmapped);
  });

  it("resolves the same image fills to the same URIs", async () => {
    const rest = await importRest();
    const plugin = await importPlugin();
    expect(plugin.imageFills).toEqual(rest.imageFills);
  });

  it("imports zero empty path data through the plugin door", async () => {
    const { pages } = await importPlugin();
    const empty: DesignElement[] = [];
    (function walk(elements: DesignElement[]): void {
      for (const el of elements) {
        if (el.type === "path" && !el.d) empty.push(el);
        const children = (el as { children?: DesignElement[] }).children;
        if (children) walk(children);
      }
    })(pages[0].children);
    expect(empty.map((e) => e.name)).toEqual([]);
  });
});

describe("a real export from Figma", () => {
  /**
   * The test that only exists once someone has actually run the plugin.
   *
   * `scripts/fixtures/figma-plugin-export.json` is the file the FISH Export plugin
   * writes when a designer exports a real frame. Everything above proves the shim
   * is faithful to a MODEL of the plugin API; this one runs against the real
   * thing, which is the only way the difference between the two shows up. Absent
   * until then, and skipped rather than faked — a fixture invented here would be
   * the round trip testing itself again.
   *
   * It does NOT diff against a REST response, because there is no REST twin of a
   * design nobody has imported: what it can check is that the file is internally
   * honest — every node with geometry produced a drawable path, no image went
   * missing, and every layer landed where Figma said it was.
   */
  const realPath = path.join(ROOT, "scripts/fixtures/figma-plugin-export.json");
  const hasReal = fs.existsSync(realPath);

  it.skipIf(!hasReal)("loses nothing the export itself claims to carry", async () => {
    const parsed = parseFigmaExport(JSON.parse(fs.readFileSync(realPath, "utf8")));
    const { pages, report } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });

    expect(report.elementCount).toBeGreaterThan(0);
    expect(countPaths(pages).filter((p) => !p.d).map((p) => p.name)).toEqual([]);

    // An export made without image bytes is a legitimate thing to hand over, so
    // "no unresolved image" is only the right expectation when the file carries
    // them. What holds either way is the importer's own rule: a picture that did
    // not arrive is NAMED, never silently unpainted.
    const refs = [...new Set(collectFigmaImageRefs(parsed.document))];
    const imageGaps = report.unmapped.filter((g) => g.property === "image:unresolved");
    if (refs.length === 0) expect(imageGaps).toEqual([]);
    else if (Object.keys(parsed.imageFills).length === 0) expect(imageGaps.length).toBeGreaterThan(0);
    else expect(imageGaps).toEqual([]);
  });

  it.skipIf(!hasReal)("lands every layer where Figma said it was", async () => {
    const envelope = JSON.parse(fs.readFileSync(realPath, "utf8"));
    const parsed = parseFigmaExport(envelope);
    const { pages } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });

    // The page is shifted once, as a block, to clear Figma's arbitrary origin —
    // so the invariant is not "the box matches" but "every box matches by the SAME
    // constant". That is what separates a correct shift from a drift that grows
    // with depth, which is the failure a rotated leaf or a nested icon produces.
    const boxes = collectAbsoluteBoxes(pages[0].children);
    const driftX = new Set<number>();
    const driftY = new Set<number>();
    for (const [id, box] of boxes) {
      const source = findAbsoluteBox(parsed.document, id);
      if (!source) continue;
      driftX.add(round2(box.x - source.x));
      driftY.add(round2(box.y - source.y));
    }
    // Two offsets on a GOOD file is expected, not a bug: a ROTATED leaf is drawn
    // at its own unrotated `size` re-centred inside the rotated bound, so its box
    // is deliberately not `absoluteBoundingBox` (see `boxOf` in figma-node.ts).
    // Comparing it here would flag the one correction the importer makes on
    // purpose, and hiding the set instead would hide the drift this is for.
    expect([...driftX], `x offsets: ${[...driftX].join(", ")}`).toHaveLength(1);
    expect([...driftY], `y offsets: ${[...driftY].join(", ")}`).toHaveLength(1);
    expect(boxes.size).toBeGreaterThan(0);
  });

  it.skipIf(hasReal)("has no real export checked in yet", () => {
    expect(hasReal).toBe(false);
  });
});

type Any = Record<string, any>;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function countPaths(pages: { children: DesignElement[] }[]): { name: string; d: string }[] {
  const out: { name: string; d: string }[] = [];
  (function walk(elements: DesignElement[]): void {
    for (const el of elements) {
      if (el.type === "path") out.push({ name: el.name ?? "", d: (el as unknown as { d: string }).d });
      const children = (el as { children?: DesignElement[] }).children;
      if (children) walk(children);
    }
  })(pages[0].children);
  return out;
}

/** Absolute boxes as the DOCUMENT holds them, accumulated down the tree. */
function collectAbsoluteBoxes(elements: DesignElement[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  (function walk(list: DesignElement[], ox: number, oy: number): void {
    for (const el of list) {
      const x = ox + el.x;
      const y = oy + el.y;
      out.set(el.id.replace(/_/g, ":"), { x, y });
      const children = (el as { children?: DesignElement[] }).children;
      if (children) walk(children, x, y);
    }
  })(elements, 0, 0);
  return out;
}

function findAbsoluteBox(node: Any, id: string): { x: number; y: number } | null {
  const rotated = typeof node.rotation === "number" && node.rotation !== 0;
  if (node.id === id && node.absoluteBoundingBox && !rotated) {
    return { x: node.absoluteBoundingBox.x, y: node.absoluteBoundingBox.y };
  }
  for (const child of node.children ?? []) {
    const found = findAbsoluteBox(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * A file with more than one page.
 *
 * The first real export had this shape and arrived as a document with no layers.
 * The cause was not the data: it was that the plugin handed Figma's own
 * `PageNode` over as if it were content, and a page node has no bounding box, so
 * the app dropped it and everything beneath it. This is the test for the shape
 * that replaces it — several CANVASes, each with a box-having node inside.
 */
describe("a multi-page Figma file", () => {
  const page = (id: string, name: string, child: string): Record<string, unknown> => ({
    id,
    name,
    type: "CANVAS",
    children: [
      {
        id: `${id}-a`,
        name: child,
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 120 },
        size: { x: 200, y: 120 },
        fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }]
      }
    ]
  });

  const file = (): Record<string, unknown> => ({
    format: "fish.figma.export",
    version: 1,
    document: {
      id: "0:0",
      name: "Kit",
      type: "DOCUMENT",
      children: [page("0:1", "Screens", "Home"), page("0:2", "Flows", "Checkout")]
    },
    images: {},
    unreadable: {}
  });

  it("imports as one FISH page per Figma page, each carrying its own content", async () => {
    const parsed = parseFigmaExport(file());
    const { pages } = await importFigmaFile(parsed.document, {});
    expect(pages.map((p) => p.name)).toEqual(["Screens", "Flows"]);
    expect(pages.map((p) => p.children.map((e) => e.name))).toEqual([["Home"], ["Checkout"]]);
  });

  it("keeps an empty Figma page as an empty FISH page rather than dropping it", async () => {
    const withEmpty = file();
    (withEmpty.document as Any).children.push({ id: "0:3", name: "Scratch", type: "CANVAS", children: [] });
    const parsed = parseFigmaExport(withEmpty);
    const { pages } = await importFigmaFile(parsed.document, {});
    expect(pages.map((p) => [p.name, p.children.length])).toEqual([
      ["Screens", 1],
      ["Flows", 1],
      ["Scratch", 0]
    ]);
  });

  it("never hands the app a boxless node, which is the failure that emptied a real export", async () => {
    // Every node the app walks must carry `absoluteBoundingBox`. The real export
    // that failed had one node with 5323 descendants and no box, and the app's
    // `boxOf` returned null for it — which is a silent drop of the entire tree,
    // reported as "That Figma file has no layers".
    const parsed = parseFigmaExport(file());
    const boxless: string[] = [];
    (function walk(node: Any): void {
      if (node.type !== "DOCUMENT" && node.type !== "CANVAS" && !node.absoluteBoundingBox) {
        boxless.push(`${node.type} ${node.id}`);
      }
      for (const child of node.children ?? []) walk(child);
    })(parsed.document);
    expect(boxless).toEqual([]);
  });
});

/**
 * A Figma Slides deck.
 *
 * The claim worth holding is not "a slide imports" — a slide is a frame, and
 * frames already worked. It is that a deck arrives AS a deck: one page holding N
 * top-level frames, which is exactly what FISH's presentation reads. Get this
 * wrong in the direction of "one page per slide" and the deck presents as a
 * single screen you have to page through by hand, with no error anywhere.
 */
describe("a Figma Slides deck", () => {
  const slide = (id: string, name: string, x: number, y: number, w = 1920): Record<string, unknown> => ({
    id,
    name,
    type: "SLIDE",
    absoluteBoundingBox: { x, y, width: w, height: 540 },
    size: { x: w, y: 540 },
    clipsContent: true,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [
      {
        id: `${id}-t`,
        name: "Heading",
        type: "TEXT",
        absoluteBoundingBox: { x: x + 40, y: y + 40, width: 400, height: 48 },
        characters: name,
        style: { fontFamily: "Inter", fontSize: 32, fontWeight: 700, lineHeightPx: 40 },
        fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }]
      }
    ]
  });

  const deck = (): Record<string, unknown> => ({
    format: "fish.figma.export",
    version: 1,
    document: {
      id: "fish:0",
      name: "Launch deck",
      type: "DOCUMENT",
      children: [
        {
          id: "fish:1",
          name: "Launch deck",
          type: "CANVAS",
          children: [slide("1:1", "Opening", 0, 0), slide("1:2", "Problem", 2080, 0), slide("1:3", "Close", 4160, 0)]
        }
      ]
    },
    images: {},
    unreadable: {}
  });

  it("imports as ONE page holding every slide as a top-level frame", async () => {
    const parsed = parseFigmaExport(deck());
    const { pages, report } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });
    expect(pages).toHaveLength(1);
    expect(pages[0].children.map((el) => el.name)).toEqual(["Opening", "Problem", "Close"]);
    expect(report.elementCount).toBe(6);
  });

  it("reads as a deck to the presentation model, in the order Figma laid them out", async () => {
    const parsed = parseFigmaExport(deck());
    const { pages } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });
    const frames = presentationFrames({ pages, activePageId: pages[0].id, elements: pages[0].children } as never);
    expect(frames.map((f) => f.elements[0].name)).toEqual(["Opening", "Problem", "Close"]);
  });

  it("presents a two-column grid in Figma's row-major order", async () => {
    // Figma's slide grid is two-dimensional, so "the deck's order" is
    // row-major — and FISH's presentation sorts a deck by canvas position,
    // rows first, for the same reason (a deck's order is a property of the
    // page's geometry, not of the order things were added). The two agree only
    // if the importer puts each slide where Figma put it, which is what this
    // pins: a grid laid out in one row would pass either way.
    const grid = deck();
    const canvas = (grid.document as Any).children[0] as Any;
    canvas.children = [
      slide("1:1", "Opening", 0, 0),
      slide("1:2", "Problem", 2080, 0),
      slide("1:3", "Answer", 0, 640),
      slide("1:4", "Close", 2080, 640)
    ];
    const parsed = parseFigmaExport(grid);
    const { pages } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });
    const frames = presentationFrames({ pages, activePageId: pages[0].id, elements: pages[0].children } as never);
    expect(frames.map((f) => f.elements[0].name)).toEqual(["Opening", "Problem", "Answer", "Close"]);
  });

  it("orders the deck by where the slides sit, not by the order they arrived", async () => {
    // The reverse of the row-major case, and the reason the row-major case is worth
    // having: FISH's presentation sorts by canvas position ON PURPOSE, so an export
    // whose array order disagrees with its geometry must present in geometry order.
    // If this ever asserted the array order instead, a designer who drags a slide
    // left in Figma would silently get a different deck in FISH.
    const shuffled = deck();
    const canvas = (shuffled.document as Any).children[0] as Any;
    canvas.children = [
      slide("1:3", "Close", 0, 0),
      slide("1:1", "Opening", 2080, 0),
      slide("1:2", "Problem", 4160, 0)
    ];
    const parsed = parseFigmaExport(shuffled);
    const { pages } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });
    const frames = presentationFrames({ pages, activePageId: pages[0].id, elements: pages[0].children } as never);
    expect(frames.map((f) => f.elements[0].name)).toEqual(["Close", "Opening", "Problem"]);
  });

  it("does not report a slide as an unknown node type — it IS a frame", async () => {
    const parsed = parseFigmaExport(deck());
    const { report, pages } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });
    expect(report.unmapped.filter((g) => g.property.startsWith("node:type:"))).toEqual([]);
    expect(pages[0].children.every((el) => el.type === "frame")).toBe(true);
  });
});

/**
 * The two packagings.
 *
 * The plugin used to write one JSON with every photograph inlined as a data URI,
 * and now writes a folder — `export.json` plus `assets/` — because base64 costs a
 * third on bytes that are already compressed and, worse, the app has to parse all
 * of it before it can decide to shrink anything. A real export was 99.6MB.
 *
 * What is provable HERE is that both carry the same envelope: the folder's
 * manifest differs from the single file in exactly one substitution, each image
 * value becoming the path its bytes sit at. Comparing the resulting DOCUMENTS
 * needs a real image decoder, because the folder runs the app's image policy and
 * an inline data URI never did — so that half is an e2e assertion, in a browser,
 * over real PNG bytes.
 */
describe("the folder and the single file carry the same envelope", () => {
  const design = (): FigmaFileResponse =>
    JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/figma-sample-screen.json"), "utf8"));

  const refOf = (index: Record<string, string>): string => Object.keys(index)[0];

  async function folderOf(envelope: Record<string, unknown>, images: Record<string, Uint8Array>) {
    const index: Record<string, string> = {};
    const entries: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const [ref, bytes] of Object.entries(images)) {
      const path = `assets/${ref}.png`;
      index[ref] = path;
      entries.push({ path, bytes });
    }
    entries.unshift({
      path: FISH_BUNDLE_MANIFEST,
      bytes: new TextEncoder().encode(JSON.stringify({ ...envelope, images: index }))
    });
    return readFigmaBundle(buildStoredZip(entries));
  }

  it("differs from the inline form in the image values and nothing else", async () => {
    const refs = [...new Set(collectFigmaImageRefs(design().document))];
    expect(refs.length).toBeGreaterThan(0);
    const images = Object.fromEntries(refs.map((ref) => [ref, new Uint8Array([0x89, 0x50, 0x4e, 0x47])]));

    const base = { format: "fish.figma.export", version: 1, document: design().document, unreadable: {} };
    const inline = { ...base, images: Object.fromEntries(refs.map((r) => [r, `data:image/png;base64,AA==`])) };
    const bundle = await folderOf(base, images);
    const folder = bundle.manifest as Record<string, unknown>;

    // Everything but `images` is byte-identical, which is what makes one envelope
    // serve two packagings instead of two envelopes.
    expect({ ...folder, images: null }).toEqual({ ...inline, images: null });
    expect(Object.keys(folder.images as object).sort()).toEqual(refs.sort());
    expect((folder.images as Record<string, string>)[refOf(folder.images as Record<string, string>)]).toMatch(
      /^assets\//
    );
  });

  it("hands the app the same document node whichever way it arrived", async () => {
    const refs = [...new Set(collectFigmaImageRefs(design().document))];
    const images = Object.fromEntries(refs.map((ref) => [ref, new Uint8Array([0x89, 0x50, 0x4e, 0x47])]));
    const base = { format: "fish.figma.export", version: 1, document: design().document, unreadable: {} };

    const bundle = await folderOf(base, images);
    const fromFolder = parseFigmaExport(bundle.manifest);
    const fromInline = parseFigmaExport({
      ...base,
      images: Object.fromEntries(refs.map((r) => [r, `data:image/png;base64,AA==`]))
    });

    expect(fromFolder.document).toEqual(fromInline.document);
    expect([...bundle.images.keys()].sort()).toEqual(Object.keys(fromInline.imageFills).sort());
  });
});

describe("parseFigmaExport", () => {
  const envelope = () => pluginExportOf(REST_FIXTURE);

  it("recognises its own format and refuses anything else", () => {
    expect(isFigmaPluginExport(envelope())).toBe(true);
    expect(isFigmaPluginExport(REST_FIXTURE)).toBe(false);
    expect(isFigmaPluginExport(null)).toBe(false);
    expect(isFigmaPluginExport({ format: "something.else" })).toBe(false);
  });

  it("hands the document over unwrapped, because the walk already accepts a bare node", () => {
    const parsed = parseFigmaExport(envelope());
    expect(parsed.document.type).toBe("DOCUMENT");
    expect(parsed.rootName).toBe(REST_FIXTURE.document.name);
    expect(parsed.imageFills).toEqual({});
  });

  it("refuses a version it does not know rather than importing it hopefully", () => {
    const future = { ...envelope(), version: 99 };
    expect(() => parseFigmaExport(future)).toThrow(FigmaExportError);
    expect(() => parseFigmaExport(future)).toThrow(/version 99/);
  });

  it("refuses an envelope with no document, which would import as an empty file", () => {
    expect(() => parseFigmaExport({ ...envelope(), document: { type: "DOCUMENT", children: [] } })).toThrow(/no document/);
    expect(() => parseFigmaExport({ ...envelope(), document: undefined })).toThrow(/no document/);
  });

  it("reports the properties the plugin API could not read, in the app's own words", () => {
    const parsed = parseFigmaExport({ ...envelope(), unreadable: { preserveRatio: 12, nothing: 0 } });
    expect(parsed.unreadable).toEqual([
      {
        property: "preserveRatio",
        count: 12,
        value: expect.stringContaining("aspect-ratio lock")
      }
    ]);
  });

  it("says nothing about a property the plugin read perfectly well", () => {
    expect(parseFigmaExport(envelope()).unreadable).toEqual([]);
  });
});

/**
 * The clipboard sniff.
 *
 * The plugin's Copy button puts the single-file envelope on the system
 * clipboard, and a paste has to recognise it — cheaply, because most pastes are
 * prose, and honestly, because a half envelope is foreign text rather than a
 * broken import.
 */
describe("isFigmaExportText", () => {
  it("recognises the envelope the plugin's Copy button writes", () => {
    const text = JSON.stringify(pluginExportOf(REST_FIXTURE));
    expect(isFigmaExportText(text)).toBe(true);
  });

  it("says no to prose, to a bare node tree, and to a truncated clipboard", () => {
    expect(isFigmaExportText("just some text a designer pasted")).toBe(false);
    expect(isFigmaExportText(JSON.stringify(REST_FIXTURE))).toBe(false);
    expect(isFigmaExportText("")).toBe(false);
    // The tag is present and the JSON is not: a copy cut short mid-transfer is
    // foreign text, not an import that half-worked.
    expect(isFigmaExportText('{"format":"fish.figma.export","version":1,"docu')).toBe(false);
  });
});

/**
 * An effect whose blend mode IS the effect.
 *
 * `scripts/fixtures/figma-glass-alert-export.json` is a real export of the iOS 27
 * alert kit: its glass frames draw their rims with `LINEAR_DODGE` inner shadows
 * in near-black and their hairlines with `LINEAR_BURN` drop shadows in
 * near-white. On the backdrop they were authored against both are invisible —
 * the mode is what makes them rims instead of panels. Painted as normal
 * composites they are the opposite of what the designer drew, and one import
 * arrived with the whole alert card solid dark and its text unreadable.
 *
 * So the rule under test is not "glass imports nicely" — it is that an effect
 * the DSL cannot spell is DROPPED AND NAMED, never painted with the wrong
 * composite. The card losing its rim is a fidelity note; a card nobody can read
 * is a bug.
 */
describe("the glass alert export", () => {
  const glassPath = path.join(ROOT, "scripts/fixtures/figma-glass-alert-export.json");
  const hasGlass = fs.existsSync(glassPath);

  it.skipIf(!hasGlass)("carries the blend-mode effects with their mapped blend modes", async () => {
    const parsed = parseFigmaExport(JSON.parse(fs.readFileSync(glassPath, "utf8")));
    const { pages, report } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });

    const dropped = report.unmapped.filter((g) => g.property.startsWith("effects:blendMode:")).map((g) => g.property);
    expect(dropped).toEqual([]);

    const blendModes: string[] = [];
    const walk = (els: DesignElement[]): void => {
      for (const el of els) {
        for (const ef of el.effects ?? []) {
          if ((ef as any).blendMode) blendModes.push(`${ef.type}:${(ef as any).blendMode}`);
        }
        const children = (el as { children?: DesignElement[] }).children;
        if (children) walk(children);
      }
    };
    for (const p of pages) walk(p.children);
    expect(blendModes).toContain("inner-shadow:plus-lighter");
    expect(blendModes).toContain("drop-shadow:color-burn");
  });

  it.skipIf(!hasGlass)("preserves dark rims as additive plus-lighter inner shadows", async () => {
    const parsed = parseFigmaExport(JSON.parse(fs.readFileSync(glassPath, "utf8")));
    const { pages } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });

    const darkRims: string[] = [];
    const walk = (els: DesignElement[]): void => {
      for (const el of els) {
        for (const ef of el.effects ?? []) {
          if (ef.type !== "inner-shadow") continue;
          const lum = /^#([0-9a-f]{2})/i.exec(ef.color ?? "")?.[1];
          if (lum && parseInt(lum, 16) < 0x60) {
            expect((ef as any).blendMode).toBe("plus-lighter");
            darkRims.push(`${el.name}:${ef.color}`);
          }
        }
        const children = (el as { children?: DesignElement[] }).children;
        if (children) walk(children);
      }
    };
    for (const p of pages) walk(p.children);
    expect(darkRims.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasGlass)("still imports the alert whole — text, buttons and all", async () => {
    const parsed = parseFigmaExport(JSON.parse(fs.readFileSync(glassPath, "utf8")));
    const { pages } = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });

    const texts: string[] = [];
    const fills: string[] = [];
    const walk = (els: DesignElement[]): void => {
      for (const el of els) {
        if (el.type === "text") texts.push((el as { content?: string }).content ?? "");
        for (const f of el.fills ?? []) if (f.type === "solid") fills.push(f.color);
        const children = (el as { children?: DesignElement[] }).children;
        if (children) walk(children);
      }
    };
    for (const p of pages) walk(p.children);

    expect(texts).toContain("A Short Title Is Best");
    expect(texts).toContain("Destructive");
    expect(texts).toContain("Cancel");
    // The Default button's blue survived the import — the fix drops EFFECTS,
    // not the design.
    expect(fills).toContain("#0088ff");
  });
});
