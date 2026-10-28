import { describe, it, expect } from "vitest";
import type { DesignDocument } from "../src/core/dsl/types";
import { adoptTopLevelElements, getActivePage } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { serializeSelf } from "../src/core/data-bridge";

/**
 * A single-page document carries its tree at the top level. The reader adopts
 * that array into page 1 (`adoptTopLevelElements`) and never writes it back
 * out; the document itself holds no second copy.
 *
 * These are the only fixtures covering that invariant end to end through the
 * real load pipeline — `normalizeDesignDocument`, which is what
 * `loadInitialDocument` and every other reader call. Both spellings exist in the
 * dialect, so a hand- or model-authored document carrying one, the other, or
 * both is the ordinary case rather than a corrupt one.
 */
const read = (raw: unknown): DesignDocument =>
  normalizeDesignDocument(raw, { preserveUnknown: true }).document;

const canvas = { width: 800, height: 600, unit: "px" as const };

describe("a document with no `pages`, only top-level elements", () => {
  const raw = {
    version: "0.1",
    canvas,
    elements: [{ id: "r1", type: "rect", x: 1, y: 2, width: 3, height: 4 }]
  };

  it("loads the elements and derives a page record", () => {
    const doc = read(raw);
    expect(getActivePage(doc).children).toHaveLength(1);
    expect(getActivePage(doc).children[0]).toMatchObject({ id: "r1", x: 1, y: 2 });
    expect(doc.pages).toHaveLength(1);
  });
});

describe("a document that supplies both spellings", () => {
  const shared = [{ id: "r1", type: "rect", x: 9, y: 9, width: 3, height: 4 }];
  const raw = {
    version: "0.1",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: shared }],
    activePageId: "page_1",
    elements: shared
  };

  it("loads it without duplicating or losing the tree", () => {
    const doc = read(raw);
    expect(getActivePage(doc).children).toHaveLength(1);
    expect((doc as unknown as Record<string, unknown>).elements).toBeUndefined();
  });

  it("drops the top-level key when pages already carry the tree", () => {
    const doc = adoptTopLevelElements(raw as unknown as DesignDocument);
    expect(doc.pages[0].children).toHaveLength(1);
    expect((doc as unknown as Record<string, unknown>).elements).toBeUndefined();
  });

  it("writes it back in the single-source-of-truth shape", () => {
    const out = serializeSelf(read(raw), "<html><head></head><body></body></html>");
    const body = /<script\s+id="design-doc"[^>]*>([\s\S]*?)<\/script>/.exec(out)?.[1] ?? "{}";
    const written = JSON.parse(body);
    expect(written.elements).toBeUndefined();
    expect(written.pages[0].children).toHaveLength(1);
  });
});
