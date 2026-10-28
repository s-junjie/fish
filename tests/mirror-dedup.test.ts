import { describe, it, expect } from "vitest";
import { DesignDocument, getActivePage, updateActivePageElements } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { serializeSelf } from "../src/core/data-bridge";

const canvas = { width: 1440, height: 900, unit: "px" as const, background: { type: "solid" as const, color: "#141414" } };
const boxA = { id: "rect_a", type: "rect" as const, x: 0, y: 0, width: 100, height: 100, fills: [{ type: "solid" as const, color: "#3B82F6" }] };
const boxB = { id: "rect_b", type: "rect" as const, x: 40, y: 40, width: 100, height: 100, fills: [{ type: "solid" as const, color: "#10B981" }] };

function twoPageDoc(): DesignDocument {
  return {
    version: "0.1",
    id: "doc_two",
    name: "Two Pages",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas,
    pages: [
      { id: "page_a", name: "A", canvas, children: [boxA] },
      { id: "page_b", name: "B", canvas, children: [boxB] }
    ],
    activePageId: "page_a"
  };
}

function serializeParse(doc: DesignDocument): Record<string, any> {
  const html = serializeSelf(doc, "<html></html>");
  const match = html.match(/<script id="design-doc" type="application\/json">\n([\s\S]*?)\n {2}<\/script>/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1].replace(/\\u003c/g, "<"));
}

describe("a saved file has one tree per page", () => {
  it("writes the edit inside its page and nowhere else", () => {
    const dragged = updateActivePageElements(twoPageDoc(), [{ ...boxA, x: 500 }]);
    const raw = serializeParse(dragged);

    expect(raw.elements).toBeUndefined();
    expect(raw.pages[0].children[0].x).toBe("500px");
    expect(raw.pages[1].children[0]).toMatchObject({ id: "rect_b", x: "40px" });
  });

  it("reloads to the same tree without a second copy appearing", () => {
    const dragged = updateActivePageElements(twoPageDoc(), [{ ...boxA, x: 500 }]);
    const { document: reloaded } = normalizeDesignDocument(serializeParse(dragged));

    expect(getActivePage(reloaded).children[0].x).toBe(500);
    expect((reloaded as unknown as Record<string, unknown>).elements).toBeUndefined();
  });

  it("canonicalizes a page-less document to pages-only on disk (B2)", () => {
    // A single-page document carries its tree at the top level. The reader
    // adopts it into page 1, so what leaves the app is one page.
    const single = {
      version: "0.1",
      id: "doc_one",
      name: "One",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      canvas,
      pages: [],
      activePageId: "",
      elements: [{ id: "r1", type: "rect", x: 10, y: 10, width: 50, height: 50 }]
    } as unknown as DesignDocument;

    const raw = serializeParse(single);
    expect(raw.elements).toBeUndefined();
    expect(raw.pages).toHaveLength(1);
    expect(raw.pages[0].children[0].id).toBe("r1");

    const { document: reloaded } = normalizeDesignDocument(raw);
    expect(getActivePage(reloaded).children[0].id).toBe("r1");
  });
});
