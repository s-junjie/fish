import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { MAX_GRID_TRACKS } from "../src/core/dsl/normalize/auto-layout";
import { MAX_FONT_SIZE } from "../src/core/dsl/normalize/text-sizing";
import { relayoutDocumentTree } from "../src/core/compile";
import { gridColumnCount, gridRowCount } from "../src/core/layout/grid-layout";
import { duplicatePage } from "../src/core/interactions/page-ops";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import type { DesignDocument, DesignElement, Page } from "../src/core/dsl/types";

/**
 * Two invariants a hand-edited file, a model response, or the Duplicate Page
 * button can all break, and both fail catastrophically rather than gracefully:
 * a grid track count sizes a real array, and an element id is a document-wide
 * primary key that several lookups resolve by "first match wins".
 */

const doc = (elements: unknown[], extra: Record<string, unknown> = {}): DesignDocument =>
  ({
    docId: "d",
    version: "0.1",
    name: "n",
    pages: [{ id: "p1", name: "P1", children: elements }],
    ...extra
  }) as unknown as DesignDocument;

const page = (id: string, elements: DesignElement[]): Page =>
  ({ id, name: id, canvas: { width: 100, height: 100, unit: "px" }, children: elements }) as Page;

describe("grid track counts are bounded", () => {
  it("clamps an authored row count that would size a huge array", () => {
    const out = normalizeDesignDocument(
      doc([
        {
          id: "a", type: "frame", name: "f", x: 0, y: 0, width: 100, height: 100,
          children: [], ...flattenLayout({ mode: "grid", columns: 2, rows: 1e9 })
        }
      ])
    );
    const layout = layoutOf(out.document.pages[0].children[0] as any)!;
    expect(layout.rows).toBe(MAX_GRID_TRACKS);
    // Reported, not silent: a clamped value the user did not ask for is a fact
    // they need in order to trust the layout they are looking at.
    expect(out.repairs.some((r) => r.path.endsWith("/rows"))).toBe(true);
  });

  it("clamps an authored column count", () => {
    const out = normalizeDesignDocument(
      doc([
        {
          id: "a", type: "frame", name: "f", x: 0, y: 0, width: 100, height: 100,
          children: [], ...flattenLayout({ mode: "grid", columns: 1e9, masonry: true })
        }
      ])
    );
    expect(layoutOf(out.document.pages[0].children[0] as any)!.columns).toBe(MAX_GRID_TRACKS);
  });

  it("leaves a plausible grid untouched and repair-free", () => {
    const out = normalizeDesignDocument(
      doc([
        {
          id: "a", type: "frame", name: "f", x: 0, y: 0, width: 300, height: 200,
          children: [], ...flattenLayout({ mode: "grid", columns: 3, rows: 2 })
        }
      ])
    );
    expect(layoutOf(out.document.pages[0].children[0] as any)).toMatchObject({ columns: 3, rows: 2 });
    // Only the clamp is under test here; the fixture omits `canvas`, so the
    // unrelated canvas repair is expected.
    expect(out.repairs.filter((r) => /track limit/.test(r.message))).toEqual([]);
  });

  it("survives relayout of a clamped grid", () => {
    const out = normalizeDesignDocument(
      doc([
        {
          id: "a", type: "frame", name: "f", x: 0, y: 0, width: 300, height: 200,
          children: [
            { id: "c1", type: "rect", name: "c", x: 0, y: 0, width: 10, height: 10 }
          ],
          ...flattenLayout({ mode: "grid", columns: 2, rows: 1e9 })
        }
      ])
    );
    const els = out.document.pages[0].children as DesignElement[];
    expect(() => relayoutDocumentTree(els)).not.toThrow();
    expect(Number.isFinite((els[0] as any).height)).toBe(true);
  });

  it("clamps the count derived from columnsMode:auto and a huge width", () => {
    // `columnsMode: "auto"` divides the element's own width by the min column
    // width, so an uncapped width produced an uncapped column count even when
    // `columns` was never authored.
    const layout = { mode: "grid", columnsMode: "auto", columnWidthMin: 10 } as any;
    expect(gridColumnCount(layout, 1e12)).toBe(MAX_GRID_TRACKS);
  });

  // 1e9 children in a single-column grid: the clamp is the point, but building
  // the count walked the full suite's remaining budget at the default 5s.
  it("clamps rows derived from a huge child count", () => {
    const rows = gridRowCount({ mode: "grid", columns: 1 } as any, 100, 1e9);
    expect(rows.rows).toBe(MAX_GRID_TRACKS);
  }, 30000);
});

describe("font size is bounded", () => {
  it("clamps an absurd fontSize that would hang the text measurer", () => {
    const out = normalizeDesignDocument(
      doc([
        {
          id: "t", type: "text", name: "T", x: 0, y: 0, width: 100, height: 20,
          content: "hi", style: { fontSize: 1e9 }
        }
      ])
    );
    const style = (out.document.pages[0].children[0] as any).style;
    expect(style.fontSize).toBe(MAX_FONT_SIZE);
    // The estimated box is derived from fontSize, so it must stay finite too.
    expect(Number.isFinite((out.document.pages[0].children[0] as any).width)).toBe(true);
  });

  it("leaves a normal fontSize alone", () => {
    const out = normalizeDesignDocument(
      doc([
        {
          id: "t", type: "text", name: "T", x: 0, y: 0, width: 100, height: 20,
          content: "hi", style: { fontSize: 14 }
        }
      ])
    );
    expect((out.document.pages[0].children[0] as any).style.fontSize).toBe(14);
  });
});

describe("synthesized ids are unique across the document", () => {
  it("does not hand two pages the same id-less element id", () => {
    // The fallback counter restarted per page, so this produced two `el_1`s —
    // and `findMasterComponent` scans pages in order, so the second component
    // was unreachable and its instances bound to the first.
    const out = normalizeDesignDocument({
      docId: "d",
      version: "0.1",
      name: "n",
      pages: [
        { id: "p1", name: "P1", children: [{ id: "", type: "component", name: "C1", x: 0, y: 0, width: 10, height: 10, children: [] }] },
        { id: "p2", name: "P2", children: [{ id: "", type: "component", name: "C2", x: 0, y: 0, width: 10, height: 10, children: [] }] }
      ]
    } as unknown as DesignDocument);
    const ids = out.document.pages.map((p) => p.children[0].id);
    expect(new Set(ids).size).toBe(2);
  });

  it("does not report a canonical document as self-duplicating", () => {
    // One ledger across every page: a normal file has one tree, not a mirror of it.
    const source = doc([
      { id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10 }
    ]);
    const out = normalizeDesignDocument(source);
    expect(out.repairs.filter((r) => /ids must be unique/.test(r.message))).toEqual([]);
  });

  it("reports an authored duplicate instead of renaming it", () => {
    // Renaming would break whatever an instance already points at. The fact that
    // their file holds two elements with one id is theirs to resolve.
    const out = normalizeDesignDocument(
      doc([
        { id: "dup", type: "rect", name: "a", x: 0, y: 0, width: 10, height: 10 },
        { id: "dup", type: "rect", name: "b", x: 0, y: 0, width: 10, height: 10 }
      ])
    );
    expect(out.repairs.some((r) => /ids must be unique/.test(r.message))).toBe(true);
    expect(out.document.pages[0].children.map((e) => e.id)).toEqual(["dup", "dup"]);
  });
});

describe("duplicating a page does not create a shadow master", () => {
  const componentPage = (pageId: string): Page =>
    page(pageId, [
      { id: "master", type: "component", name: "Card", x: 0, y: 0, width: 10, height: 10, children: [] } as DesignElement,
      { id: "inst", type: "instance", name: "Use", x: 0, y: 0, width: 10, height: 10, children: [], componentId: "master" } as unknown as DesignElement
    ]);

  it("mints fresh ids for the copy", () => {
    const copy = duplicatePage(componentPage("p1"));
    const ids = copy.children.map((e) => e.id);
    expect(ids).not.toContain("master");
    expect(ids).not.toContain("inst");
    expect(new Set(ids).size).toBe(2);
    expect(copy.id).not.toBe("p1");
  });

  it("rebinds the copied instance to the copied master", () => {
    const copy = duplicatePage(componentPage("p1"));
    const inst = copy.children.find((e) => e.type === "instance") as any;
    const master = copy.children.find((e) => e.type === "component") as any;
    expect(inst.componentId).toBe(master.id);
  });

  it("resolves each page's instance to its own master", () => {
    // The bug: the copy kept the original ids, `findMasterComponent` scans pages
    // in order, and the instance on the copy bound to page 1's component — so
    // editing the original silently restyled the duplicate.
    const p1 = componentPage("p1");
    const p2 = duplicatePage(p1);
    const d = {
      docId: "d", version: "0.1", name: "n",
      canvas: { width: 100, height: 100, unit: "px" },
      pages: [p1, p2], activePageId: p2.id, elements: p2.children, styles: [], assets: []
    } as unknown as DesignDocument;

    const instOnCopy = p2.children.find((e) => e.type === "instance") as any;
    const masterOnCopy = p2.children.find((e) => e.type === "component") as any;
    const resolved = findMasterComponent(d, instOnCopy.componentId);
    expect(resolved?.id).toBe(masterOnCopy.id);
    expect(resolved?.id).not.toBe("master");
  });

  it("leaves an instance alone when its master is not on the page", () => {
    const copy = duplicatePage(
      page("p1", [
        { id: "inst", type: "instance", name: "Use", x: 0, y: 0, width: 10, height: 10, children: [], componentId: "elsewhere" } as unknown as DesignElement
      ])
    );
    // Rewriting this would invent a master the page never had.
    expect((copy.children[0] as any).componentId).toBe("elsewhere");
  });
});
