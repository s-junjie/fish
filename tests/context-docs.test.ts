/**
 * `metadata` is genuinely unread: nothing interprets a key inside it, which
 * means nothing may rewrite one either. A rename is the one edit that silently
 * changes a document nobody edited, and it bought nothing for a key no reader had
 * ever asked for. The assertion is on the general invariant rather than on the key
 * that used to be renamed, so a future migration cannot reintroduce it by adding a
 * case here.
 *
 * Second, the showcase document carries no `metadata` at all for the same reason
 * from the other side: it is the first document a new author reads, and a
 * free-form provenance bag on it teaches a habit with no reader behind it.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

const root = path.resolve(__dirname, "..");

// The inlined bundle carries `<script id="design-doc">` as template-literal text,
// so this has to be the anchored pattern the CLI uses, not a bare `<script` scan.
const DOC_BLOCK_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;

function showcaseDocument(): Record<string, unknown> {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const match = DOC_BLOCK_RE.exec(html);
  expect(match, "index.html has no #design-doc block").toBeTruthy();
  return JSON.parse((match as RegExpExecArray)[1].replace(/\\u003c/g, "<"));
}

describe("metadata is unread, so nothing rewrites it", () => {
  it("carries any key through untouched, with no repair", () => {
    const metadata = { retired_key: true, another: { nested: 1 } };
    const { document, repairs } = normalizeDesignDocument({
      version: "0.1",
      id: "doc_meta",
      name: "meta",
      canvas: { width: 100, height: 100 },
      elements: [],
      metadata
    });
    expect(document.metadata).toEqual(metadata);
    expect(repairs.some((r) => r.path.startsWith("/metadata"))).toBe(false);
  });

  it("leaves a page out of it entirely rather than inventing one", () => {
    const { document } = normalizeDesignDocument({
      version: "0.1",
      id: "doc_meta",
      name: "meta",
      canvas: { width: 100, height: 100 },
      elements: []
    });
    expect(document.metadata).toBeUndefined();
  });
});

describe("the showcase document", () => {
  it("carries no metadata — a key nothing reads teaches nothing", () => {
    expect(showcaseDocument().metadata).toBeUndefined();
  });

  it("still parses as the document the demo is", () => {
    const raw = showcaseDocument();
    expect(raw.version).toBeDefined();
    expect(Array.isArray(raw.pages)).toBe(true);
  });

  it("carries one element tree, on its pages", () => {
    const raw = showcaseDocument();
    expect(raw.elements).toBeUndefined();
    const pages = raw.pages as Array<{ children?: unknown[] }>;
    expect(pages.every((page) => Array.isArray(page.children))).toBe(true);
  });

  it("is authored in the dialect the writer emits", () => {
    const raw = showcaseDocument();
    expect(raw.$schema).toBeUndefined();
    const elements: Array<Record<string, unknown>> = [];
    const visit = (nodes: unknown) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const record = node as Record<string, unknown>;
        elements.push(record);
        visit(record.children);
      }
    };
    for (const page of raw.pages as Array<{ children?: unknown[] }>) visit(page.children);

    for (const element of elements) {
      expect(element).not.toHaveProperty("borderRadius");
      expect(element).not.toHaveProperty("clipContent");
      if (element.type === "text") expect(element).not.toHaveProperty("style");
    }
    const assets = raw.assets as Array<Record<string, unknown>>;
    expect(assets.every((asset) => !("uri" in asset))).toBe(true);
  });
});