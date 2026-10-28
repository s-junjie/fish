import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import {
  DesignDocument,
  DesignElement,
  RectElement,
  getActivePage,
  updateActivePageElements
} from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { serializeSelf, loadInitialDocument } from "../src/core/data-bridge";

const canvasA = {
  width: 1440,
  height: 900,
  background: { type: "solid" as const, color: "#141414" },
  unit: "px" as const
};
const canvasB = {
  width: 1920,
  height: 1080,
  background: { type: "solid" as const, color: "#222222" },
  unit: "px" as const
};

const boxOnA: RectElement = {
  id: "rect_a",
  type: "rect",
  name: "Box A",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fills: [{ type: "solid", color: "#3B82F6" }]
};
const boxOnB: RectElement = {
  id: "rect_b",
  type: "rect",
  name: "Box B",
  x: 40,
  y: 40,
  width: 100,
  height: 100,
  fills: [{ type: "solid", color: "#10B981" }]
};

function twoPageDoc(activePageId: "page_a" | "page_b" = "page_a"): DesignDocument {
  return {
    version: "0.1",
    id: "doc_two",
    name: "Two Pages",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: canvasA,
    pages: [
      { id: "page_a", name: "A", canvas: canvasA, children: [boxOnA] },
      { id: "page_b", name: "B", canvas: canvasB, children: [boxOnB] }
    ],
    activePageId
  };
}

describe("Multi-page writes", () => {
  it("writes to the active page of a 2-page document", () => {
    const doc = twoPageDoc();
    const next = updateActivePageElements(doc, [{ ...boxOnA, x: 500 }]);

    expect(getActivePage(next).children[0].x).toBe(500);
  });

  it("does not leak the active page's tree into a non-active page", () => {
    const doc = twoPageDoc();
    const written = updateActivePageElements(doc, [{ ...boxOnA, x: 500 }]);

    expect(getActivePage(written).children[0].x).toBe(500);
    expect(written.pages[1].children[0].id).toBe("rect_b");
    expect(written.pages[1].children[0].x).toBe(40);
  });

  it("keeps an earlier page write when a later one lands", () => {
    const doc = twoPageDoc();
    const dragged = updateActivePageElements(doc, [{ ...boxOnA, x: 500 }]);
    const next = updateActivePageElements(dragged, [
      ...getActivePage(dragged).children.map((el) => ({ ...el, y: 250 }))
    ]);

    expect(getActivePage(next).children[0]).toMatchObject({ x: 500, y: 250 });
    expect(next.pages[0].children[0]).toMatchObject({ x: 500, y: 250 });
  });

  it("writes to whichever page is active", () => {
    const doc = twoPageDoc("page_b");
    const next = updateActivePageElements(doc, [{ ...boxOnB, x: 700 }]);

    expect(next.pages[1].children[0].x).toBe(700);
    expect(next.pages[0].children[0].x).toBe(0);
  });
});

describe("Save / reload does not lose edits made on a 2-page document", () => {
  it("round-trips a page write through serialize + normalize", () => {
    const doc = twoPageDoc();
    const dragged = updateActivePageElements(doc, [{ ...boxOnA, x: 500 }]);

    const html = serializeSelf(dragged, "<html></html>");
    const match = html.match(
      /<script id="design-doc" type="application\/json">\n([\s\S]*?)\n {2}<\/script>/
    );
    expect(match).not.toBeNull();

    const raw = JSON.parse(match![1].replace(/\\u003c/g, "<"));
    const { document: reloaded } = normalizeDesignDocument(raw);

    expect(getActivePage(reloaded).children[0].x).toBe(500);
    expect(reloaded.pages[0].children[0].x).toBe(500);
  });

  it("does not leak the active page's tree into the other page's record", () => {
    const doc = twoPageDoc();
    const dragged = updateActivePageElements(doc, [{ ...boxOnA, x: 500 }]);

    const html = serializeSelf(dragged, "<html></html>");
    const match = html.match(
      /<script id="design-doc" type="application\/json">\n([\s\S]*?)\n {2}<\/script>/
    );
    const raw = JSON.parse(match![1].replace(/\\u003c/g, "<"));

    expect(raw.pages[0].children[0].x).toBe("500px");
    expect(raw.pages[1].children[0]).toMatchObject({ id: "rect_b", x: "40px" });
  });
});

describe("Active page canvas is page-scoped", () => {
  it("reports the active page's own canvas, not the document fallback", () => {
    const doc = twoPageDoc("page_b");
    expect(getActivePage(doc).canvas.width).toBe(1920);
    expect(doc.canvas.width).toBe(1440);
  });
});

describe("Loading a multi-page file relayouts the active page", () => {
  const autoLayoutFrame = {
    id: "frame_row",
    type: "frame" as const,
    name: "Row",
    x: 100,
    y: 200,
    width: 500,
    height: 300,
    ...flattenLayout({
      mode: "flex" as const,
      direction: "row" as const,
      gap: 20,
      padding: 10,
      justify: "start" as const,
      align: "center" as const
    }),
    // Deliberately stale: auto-layout must move these to x = 110 / 210.
    children: [
      { id: "r1", type: "rect" as const, x: 0, y: 0, width: 80, height: 40 },
      { id: "r2", type: "rect" as const, x: 0, y: 0, width: 100, height: 40 }
    ]
  };

  it("bakes auto-layout measurements into the active page of a 2-page file", () => {
    const raw = {
      ...twoPageDoc("page_b"),
      pages: [
        { id: "page_a", name: "A", canvas: canvasA, children: [] },
        { id: "page_b", name: "B", canvas: canvasB, children: [autoLayoutFrame] }
      ]
    };

    const originalDocument = (globalThis as any).document;
    (globalThis as any).document = {
      getElementById: () => ({ textContent: JSON.stringify(raw) })
    };
    try {
      const loaded = loadInitialDocument();
      const loadedPage = getActivePage(loaded);
      const frame = loadedPage.children[0] as any;

      expect(frame.children[0].x).toBe(10);
      expect(frame.children[1].x).toBe(110);
      expect((loaded.pages[1].children[0] as any).children[0].x).toBe(10);
      expect(getActivePage(loaded).children).toBe(loaded.pages[1].children);
    } finally {
      (globalThis as any).document = originalDocument;
    }
  });
});

describe("The file has one tree per page", () => {
  it("serialises no document-level elements array", () => {
    const doc = twoPageDoc();
    const html = serializeSelf(doc, "<html></html>");
    const match = html.match(
      /<script id="design-doc" type="application\/json">\n([\s\S]*?)\n {2}<\/script>/
    );
    const raw = JSON.parse(match![1].replace(/\\u003c/g, "<"));
    expect(raw.elements).toBeUndefined();
    expect(raw.pages.map((p: { children: DesignElement[] }) => p.children.length)).toEqual([1, 1]);
  });
});
