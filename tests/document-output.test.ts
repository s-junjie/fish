import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { serializeSelf } from "../src/core/data-bridge";
import { documentJson } from "../src/core/document-json";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * One document, one text. The `.fish.html` block, the `.fish.json` export, the
 * clipboard and the two CLI subcommands are five readers of the same format;
 * these tests exist so they cannot drift back into five writers.
 */

const BITMAP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#101010" } };

const elements: DesignElement[] = [
  {
    id: "card",
    type: "frame",
    name: "Card",
    x: 10,
    y: 10,
    width: 200,
    height: 120,
    clipContent: true,
    borderRadius: 12,
    fills: [{ type: "solid", color: "#1c1c1c" }],
    children: [
      {
        id: "label",
        type: "text",
        name: "Label",
        x: 8,
        y: 8,
        width: 100,
        height: 20,
        content: "Hello",
        style: { fontFamily: "Inter", fontSize: 14, color: "#ededed" }
      }
    ]
  }
];

function makeDoc(): DesignDocument {
  return {
    docId: "doc_convergence",
    version: LATEST_DOCUMENT_VERSION,
    id: "doc_convergence",
    name: "Convergence",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    canvas,
    pages: [{ id: "page_1", name: "Cover", canvas, children: elements }],
    activePageId: "page_1",
    elements,
    assets: [{ id: "ast_1", name: "hero.png", uri: BITMAP, width: 4, height: 4 }]
  } as unknown as DesignDocument;
}

const blockOf = (html: string, id: string): string | undefined =>
  new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html)?.[1];

/** The `#design-doc` block, with the split asset URIs folded back in. */
function payloadOf(html: string): Record<string, unknown> {
  const body = blockOf(html, "design-doc");
  expect(body, "the shell must carry a #design-doc block").toBeTruthy();
  const doc = JSON.parse(body!.trim()) as { assets?: { id: string }[] };
  const uris = JSON.parse((blockOf(html, "fish-assets") ?? "{}").trim() || "{}") as Record<string, string>;
  if (Array.isArray(doc.assets)) {
    doc.assets = doc.assets.map((ref) => (uris[ref.id] ? { ...ref, uri: uris[ref.id] } : ref)) as typeof doc.assets;
  }
  return doc as unknown as Record<string, unknown>;
}

describe("one document, one text", () => {
  it("writes the same document into .fish.html as documentJson does", () => {
    const doc = makeDoc();
    const html = serializeSelf(doc, "<html><head></head><body></body></html>");
    // The comment on `documentJson` claimed this and could not keep it: the
    // shell lifted bitmaps into their own block while the export kept them
    // inline, and the export also kept the `elements` mirror. Both are gone.
    expect(payloadOf(html)).toEqual(JSON.parse(documentJson(doc)));
  });

  it("splits bitmaps out of the structure block, and only there", () => {
    const doc = makeDoc();
    const html = serializeSelf(doc, "<html><head></head><body></body></html>");
    const inBlock = JSON.parse(blockOf(html, "design-doc")!.trim()) as { assets: { uri?: string }[] };
    expect(inBlock.assets[0].uri).toBeUndefined();
    expect(JSON.parse(blockOf(html, "fish-assets")!.trim())).toEqual({ ast_1: BITMAP });
    expect(documentJson(doc)).toContain(BITMAP);
  });

  it("keeps a single element tree on disk", () => {
    const html = serializeSelf(makeDoc(), "<html><head></head><body></body></html>");
    const keys = Object.keys(payloadOf(html));
    expect(keys).not.toContain("elements");
    expect(keys).toContain("pages");
  });

  it("has no second writer — a bare JSON.stringify of a document is the bug", async () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (full.endsWith(path.join("core", "document-json.ts"))) continue;
        files.push(full);
      }
    };
    walk(path.resolve(process.cwd(), "src"));
    // Read concurrently: one synchronous read per file costs tens of ms inside a
    // vitest worker, which alone was eating most of this test's time budget.
    const sources = await Promise.all(files.map((full) => fs.promises.readFile(full, "utf-8")));
    const offenders = files.filter((_full, i) => /JSON\.stringify\(\s*(result\.|this\.)?doc\b/.test(sources[i]));
    expect(offenders).toEqual([]);
  });

  it("reads the dialect it writes without a single repair", () => {
    // The reason `overflow` / `visibility` stopped being aliases that report
    // themselves: a writer that emits a spelling the reader calls a repair gives
    // every saved file one info entry per frame, which buries the real ones.
    const { repairs } = normalizeDesignDocument({
      version: LATEST_DOCUMENT_VERSION,
      name: "Written dialect",
      canvas: { width: 800, height: 600, background: "#FFFFFF" },
      elements: [
        {
          id: "f",
          type: "frame",
          width: 200,
          height: 100,
          overflow: "hidden",
          visibility: "visible",
          children: [{ id: "p", type: "path", d: "M0 0L10 10Z", "fill-rule": "evenodd" }]
        }
      ]
    });
    expect(repairs).toEqual([]);
  });
});
