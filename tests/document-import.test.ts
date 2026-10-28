import { describe, it, expect } from "vitest";
import { mergeDocumentPages, documentJsonFileName } from "../src/core/document-import";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignDocument, DesignElement, Page } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";

const canvas = {
  width: 1440,
  height: 900,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#101010" }
};

const BITMAP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAA=";

const local: DesignElement = {
  id: "local_rect",
  type: "rect",
  name: "Local",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fills: [{ type: "solid", color: "#3E63DD" }]
};

function doc(pages: Page[], extra: Partial<DesignDocument> = {}): DesignDocument {
  return {
    version: LATEST_DOCUMENT_VERSION,
    id: "doc_local",
    name: "Local",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages,
    activePageId: pages[0].id,
    ...extra
  } as unknown as DesignDocument;
}

function incoming(pages: Page[], extra: Partial<DesignDocument> = {}): DesignDocument {
  return { ...doc(pages), id: "doc_in", name: "Incoming", ...extra } as DesignDocument;
}

/** A component on one page with an instance on another — the case a per-page remap breaks. */
function masterPage(): Page {
  return {
    id: "in_1",
    name: "Cover",
    canvas,
    children: [
      {
        id: "in_master",
        type: "component",
        name: "Card",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        children: []
      }
    ]
  };
}

function instancePage(): Page {
  return {
    id: "in_2",
    name: "Detail",
    canvas,
    children: [
      {
        id: "in_inst",
        type: "instance",
        name: "Card / Large",
        x: 40,
        y: 40,
        width: 320,
        height: 180,
        componentId: "in_master"
      } as unknown as DesignElement
    ]
  };
}

const allIds = (d: DesignDocument): string[] =>
  d.pages.flatMap((p) => {
    const walk = (els: DesignElement[]): string[] =>
      els.flatMap((el) => [
        el.id,
        ...(el as { children?: DesignElement[] }).children ? walk((el as { children?: DesignElement[] }).children!) : []
      ]);
    return [p.id, ...walk(p.children)];
  });

describe("mergeDocumentPages", () => {
  it("appends every page of the incoming document, and lands on the first", () => {
    const out = mergeDocumentPages(doc([{ id: "p1", name: "Page 1", canvas, children: [local] }]), incoming([masterPage(), instancePage()]));
    expect(out.pages.map((p) => p.name)).toEqual(["Page 1", "Cover", "Detail"]);
    expect(out.activePageId).toBe(out.pages[1].id);
  });

  it("leaves everything already in the document alone", () => {
    const before = doc([{ id: "p1", name: "Page 1", canvas, children: [local] }]);
    const out = mergeDocumentPages(before, incoming([masterPage()]));
    expect(out.pages[0]).toEqual(before.pages[0]);
  });

  it("mints ids of its own for pages and elements, so nothing can shadow what is here", () => {
    const out = mergeDocumentPages(doc([{ id: "p1", name: "Page 1", canvas, children: [local] }]), incoming([masterPage()]));
    const ids = allIds(out);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("in_master");
    expect(ids).not.toContain("in_1");
  });

  it("rebinds an instance to a master that arrived on a DIFFERENT page of the same import", () => {
    const out = mergeDocumentPages(doc([{ id: "p1", name: "Page 1", canvas, children: [local] }]), incoming([masterPage(), instancePage()]));
    const detail = out.pages.find((p) => p.name === "Detail")!;
    const instance = detail.children[0] as unknown as { componentId: string };
    const cover = out.pages.find((p) => p.name === "Cover")!;
    expect(instance.componentId).toBe(cover.children[0].id);
  });

  it("leaves a reference that left the import pointing where it pointed", () => {
    const orphan: Page = {
      id: "in_3",
      name: "Orphan",
      canvas,
      children: [
        { id: "in_orphan", type: "instance", name: "Ghost", x: 0, y: 0, width: 10, height: 10, componentId: "never_imported" } as unknown as DesignElement
      ]
    };
    const out = mergeDocumentPages(doc([{ id: "p1", name: "Page 1", canvas, children: [local] }]), incoming([orphan]));
    expect((out.pages[1].children[0] as unknown as { componentId: string }).componentId).toBe("never_imported");
  });

  it("renames a duplicate page rather than showing the same name twice", () => {
    const out = mergeDocumentPages(doc([{ id: "p1", name: "Page 1", canvas, children: [] }]), incoming([masterPage(), { ...masterPage(), id: "in_9" }]));
    expect(out.pages.map((p) => p.name)).toEqual(["Page 1", "Cover", "Cover 2"]);
  });

  it("keeps the merged tree on the page record, with no document-level copy", () => {
    const out = mergeDocumentPages(doc([{ id: "p1", name: "Page 1", canvas, children: [local] }]), incoming([masterPage(), instancePage()]));
    expect(getActivePage(out).children.length).toBeGreaterThan(0);
    expect((out as unknown as Record<string, unknown>).elements).toBeUndefined();
  });

  it("unions assets by id, and never swaps a payload the local document is already using", () => {
    const local_ = doc([{ id: "p1", name: "Page 1", canvas, children: [] }], {
      assets: [{ id: "ast_shared", name: "local.png", uri: BITMAP }, { id: "ast_only_local", name: "l.png", uri: BITMAP }]
    });
    const from = incoming([masterPage()], {
      assets: [{ id: "ast_shared", name: "incoming.png", uri: "data:image/png;base64,OTHER" }, { id: "ast_new", name: "n.png", uri: BITMAP }]
    });
    const out = mergeDocumentPages(local_, from);
    expect(out.assets?.map((a) => a.id)).toEqual(["ast_shared", "ast_only_local", "ast_new"]);
    expect(out.assets?.find((a) => a.id === "ast_shared")?.name).toBe("local.png");
  });

  it("carries a document that lost its pages array to one page rather than to none", () => {
    const out = mergeDocumentPages(doc([{ id: "p1", name: "Page 1", canvas, children: [] }]), { ...doc([{ id: "p1", name: "Page 1", canvas, children: [] }]), pages: [], elements: [local], name: "Orphaned" });
    expect(out.pages).toHaveLength(2);
    expect(out.pages[1].children.map((e) => e.name)).toEqual(["Local"]);
  });

  it("survives the round trip: a merge re-exported and re-imported is the same document", () => {
    const start = doc([{ id: "p1", name: "Page 1", canvas, children: [local] }]);
    const merged = mergeDocumentPages(start, incoming([masterPage(), instancePage()]));
    const again = normalizeDesignDocument(JSON.parse(JSON.stringify(merged))).document as DesignDocument;
    const detail = again.pages.find((p) => p.name === "Detail")!;
    const cover = again.pages.find((p) => p.name === "Cover")!;
    expect((detail.children[0] as unknown as { componentId: string }).componentId).toBe(cover.children[0].id);
  });
});

describe("documentJsonFileName", () => {
  it("names the file after the document when the tab has no file", () => {
    expect(documentJsonFileName(doc([{ id: "p1", name: "Page 1", canvas, children: [] }], { name: "My Design" }))).toBe("my-design.fish.json");
  });

  it("takes the name of the file this tab is editing, not the DSL name", () => {
    const page = doc([{ id: "p1", name: "Page 1", canvas, children: [] }], { name: "FISH — Poster" });
    expect(documentJsonFileName(page, "poster.fish.html")).toBe("poster.fish.json");
    expect(documentJsonFileName(page, "poster.html")).toBe("poster.fish.json");
  });

  it("never produces an empty or path-bearing name", () => {
    const odd = doc([{ id: "p1", name: "Page 1", canvas, children: [] }], { name: "  /// ???  " });
    expect(documentJsonFileName(odd)).toBe("untitled.fish.json");
    expect(documentJsonFileName(odd, "/__fish_bundle__")).toBe("untitled.fish.json");
  });
});