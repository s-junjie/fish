import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { importFigmaFile } from "../src/core/import/figma-import";
import { landFigmaImport } from "../src/core/import/figma-landing";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignDocument, DesignElement, InstanceElement, Page, TextElement } from "../src/core/dsl/types";
import type { FigmaFileResponse, FigmaNode } from "../src/core/import/figma-types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const localPage = (): Page => ({
  id: "page_local",
  name: "Mine",
  canvas: { width: 1440, height: 900, unit: "px", background: { type: "solid", color: "#ffffff" } },
  children: [
    {
      id: "local_rect",
      type: "rect",
      name: "Local",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [{ type: "solid", color: "#3E63DD" }]
    }
  ]
});

const localDoc = (): DesignDocument => {
  const page = localPage();
  return {
    version: LATEST_DOCUMENT_VERSION,
    id: "doc_local",
    name: "Local",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: page.canvas,
    pages: [page],
    activePageId: page.id,
    elements: page.children
  } as unknown as DesignDocument;
};

const text = (id: string, characters: string, box = { x: 0, y: 0, width: 200, height: 24 }): FigmaNode => ({
  id,
  name: id,
  type: "TEXT",
  absoluteBoundingBox: box,
  characters,
  style: { fontFamily: "Inter", fontSize: 16, fontWeight: 600, lineHeightPx: 24 }
});

const frame = (id: string, children: FigmaNode[] = [], extra: Partial<FigmaNode> = {}): FigmaNode => ({
  id,
  name: id,
  type: "FRAME",
  absoluteBoundingBox: { x: -30, y: -10, width: 320, height: 200 },
  children,
  ...extra
});

const canvas = (id: string, name: string, children: FigmaNode[]): FigmaNode => ({
  id,
  name,
  type: "CANVAS",
  children
});

const file = (...canvases: FigmaNode[]): FigmaFileResponse =>
  ({
    name: "Design System",
    document: { id: "0:0", name: "Document", type: "DOCUMENT", children: canvases }
  }) as unknown as FigmaFileResponse;

/** One board — what a selection copy in the plugin produces. */
const oneCanvas = () => file(canvas("0:1", "Landing", [frame("0:2", [text("0:3", "Title")])]));

/** Two boards — what a whole-file copy produces. */
const twoCanvases = () =>
  file(
    canvas("0:1", "Landing", [frame("0:2", [text("0:3", "Title")])]),
    canvas("0:4", "Detail", [frame("0:5", [text("0:6", "Body")])])
  );

/** One board holding an instance, so promotion synthesizes a components page. */
const oneCanvasWithInstance = () =>
  file(
    canvas("0:1", "Landing", [
      {
        id: "0:7",
        name: "Button",
        type: "INSTANCE",
        componentId: "9:99",
        absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
        children: [text("0:8", "Click", { x: 12, y: 8, width: 96, height: 24 })]
      } as FigmaNode
    ])
  );

const allIds = (doc: DesignDocument): string[] => {
  const walk = (els: DesignElement[]): string[] =>
    els.flatMap((el) => [el.id, ...walk((el as { children?: DesignElement[] }).children ?? [])]);
  return doc.pages.flatMap((p) => walk(p.children));
};

const activeElements = (doc: DesignDocument): DesignElement[] =>
  doc.pages.find((p) => p.id === doc.activePageId)?.children ?? [];

const findInstance = (doc: DesignDocument): InstanceElement | null => {
  const walk = (els: DesignElement[]): InstanceElement | null => {
    for (const el of els) {
      if (el.type === "instance") return el as InstanceElement;
      const found = walk((el as { children?: DesignElement[] }).children ?? []);
      if (found) return found;
    }
    return null;
  };
  return walk(activeElements(doc));
};

// ---------------------------------------------------------------------------
// The landing
// ---------------------------------------------------------------------------

describe("landFigmaImport", () => {
  it("joins the open page when a paste carries a single board", async () => {
    const result = await importFigmaFile(oneCanvas());
    expect(result.canvasCount).toBe(1);

    const landing = landFigmaImport(localDoc(), result, { paste: true });

    expect(landing.ontoCurrentPage).toBe(true);
    expect(landing.doc.pages).toHaveLength(1);
    expect(landing.doc.activePageId).toBe("page_local");
    // The local content stays, the pasted content lands after it — array order
    // is z-order, so a paste reads on top of what was already there.
    expect(landing.doc.pages[0].children.map((el) => el.name)).toEqual(["Local", "0:2"]);
    // The landing writes onto the page record itself, so there is no second
    // array that could drift from it.
    expect(getActivePage(landing.doc).children).toBe(landing.doc.pages[0].children);
    // The selection is the paste, not everything on the page.
    expect(landing.landed).toHaveLength(1);
    expect(landing.landed[0]).toBe(landing.doc.pages[0].children[1]);
    expect(landing.landedIds.has("local_rect")).toBe(false);
    expect(landing.landedIds.size).toBe(2);
  });

  it("keeps the importer's verified geometry, margin and all", async () => {
    const result = await importFigmaFile(oneCanvas());
    const landing = landFigmaImport(localDoc(), result, { paste: true });
    const card = activeElements(landing.doc)[1];
    // Figma authored this at (-30, -10); the importer moved the board onto the
    // page margin and the landing must not move it a second time.
    expect(card.x).toBe(result.pages[0].children[0].x);
    expect(card.y).toBe(result.pages[0].children[0].y);
    expect(card.width).toBe(320);
    expect(card.height).toBe(200);
  });

  it("lands pages of its own when the paste carries several", async () => {
    const result = await importFigmaFile(twoCanvases());
    expect(result.canvasCount).toBe(2);

    const landing = landFigmaImport(localDoc(), result, { paste: true });

    expect(landing.ontoCurrentPage).toBe(false);
    expect(landing.doc.pages.map((p) => p.name)).toEqual(["Mine", "Landing", "Detail"]);
    expect(landing.doc.activePageId).toBe(landing.doc.pages[1].id);
    expect(activeElements(landing.doc).length).toBeGreaterThan(0);
    // The open page is untouched, which is the whole point of pages of its own.
    expect(landing.doc.pages[0].children.map((el) => el.name)).toEqual(["Local"]);
  });

  it("keeps the picked-file door on pages of its own, single board or not", async () => {
    const result = await importFigmaFile(oneCanvas());
    const landing = landFigmaImport(localDoc(), result, { paste: false });

    expect(landing.ontoCurrentPage).toBe(false);
    expect(landing.doc.pages.map((p) => p.name)).toEqual(["Mine", "Landing"]);
    expect(landing.doc.activePageId).toBe(landing.doc.pages[1].id);
    expect(landing.doc.pages[0].children.map((el) => el.name)).toEqual(["Local"]);
  });

  it("brings the synthesized components page along, because an instance resolves its master on any page", async () => {
    const result = await importFigmaFile(oneCanvasWithInstance());
    expect(result.canvasCount).toBe(1);
    expect(result.pages).toHaveLength(2);

    const landing = landFigmaImport(localDoc(), result, { paste: true });

    const instance = findInstance(landing.doc);
    expect(instance).toBeTruthy();
    const master = findMasterComponent(landing.doc, instance!.componentId);
    expect(master).toBeTruthy();
    expect(master!.name).toBe("Button");
  });

  it("reflows imported master components and text on landing without (imported) suffix", async () => {
    const json = file(
      canvas("0:1", "Landing", [
        {
          id: "0:7",
          name: "Tooltip",
          type: "INSTANCE",
          componentId: "9:99",
          absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
          children: [
            {
              ...text("0:8", "Open in browser", { x: 12, y: 8, width: 10, height: 16 }),
              textAutoResize: "WIDTH_AND_HEIGHT"
            }
          ]
        } as FigmaNode
      ])
    );
    const result = await importFigmaFile(json);
    const landing = landFigmaImport(localDoc(), result, { paste: false });
    const instance = findInstance(landing.doc);
    expect(instance).toBeTruthy();
    const master = findMasterComponent(landing.doc, instance!.componentId);
    expect(master).toBeTruthy();
    expect(master!.name).toBe("Tooltip");
    const textChild = master!.children[0] as TextElement;
    expect(textChild.width).toBeGreaterThan(10);
  });

  it("survives a second paste of the same selection", async () => {
    const result = await importFigmaFile(oneCanvas());
    const first = landFigmaImport(localDoc(), result, { paste: true });
    const second = landFigmaImport(first.doc, result, { paste: true });

    const ids = allIds(second.doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(activeElements(second.doc).filter((el) => el.name === "0:2")).toHaveLength(2);
    expect(second.doc.pages).toHaveLength(1);
  });

  it("re-mints a Figma id that collides with content already on the page", async () => {
    // `sanitizeFigmaId` turns "local:rect" into "local_rect", which is the id
    // the open page already uses. Landing it verbatim would put two nodes under
    // one id, and every later edit would address whichever came first.
    const json = file(canvas("0:1", "Landing", [frame("local:rect")]));
    const result = await importFigmaFile(json);
    expect(result.pages[0].children[0].id).toBe("local_rect");

    const landing = landFigmaImport(localDoc(), result, { paste: true });

    const ids = activeElements(landing.doc).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("local_rect");
    expect(activeElements(landing.doc)[1].id).not.toBe("local_rect");
  });

  it("gives two imports of the same file distinct page ids and names", async () => {
    const result = await importFigmaFile(oneCanvas());
    const first = landFigmaImport(localDoc(), result, { paste: false });
    const second = landFigmaImport(first.doc, result, { paste: false });

    expect(second.doc.pages.map((p) => p.name)).toEqual(["Mine", "Landing", "Landing 2"]);
    expect(new Set(second.doc.pages.map((p) => p.id)).size).toBe(3);
  });
});
