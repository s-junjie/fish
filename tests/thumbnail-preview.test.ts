import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findThumbnailTargetFrame } from "../src/core/thumbnail-target";
import {
  serializeSelf,
  registerPreviewGenerator,
  isSafePreviewHtml,
  createEmptyDocument,
  documentFromHtml
} from "../src/core/data-bridge";
import type { DesignDocument, FrameElement } from "../src/core/dsl/types";
import { coverBlockHtml } from "../src/core/cover-block";
import { renderThumbnailPreviewHtml } from "../src/ui/thumbnail-preview";
import { WORDMARK_CELL } from "../src/ui/fish-wordmark";

function createFrame(id: string, name: string, overrides: Partial<FrameElement> = {}): FrameElement {
  return {
    id,
    name,
    type: "frame",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    children: [],
    ...overrides
  };
}

describe("findThumbnailTargetFrame", () => {
  it("prioritizes explicitly designated doc.thumbnailNodeId across pages", () => {
    const frame1 = createFrame("f1", "Page 1 Frame");
    const frame2 = createFrame("f2", "Target Frame");
    const doc: DesignDocument = {
      ...createEmptyDocument(),
      thumbnailNodeId: "f2",
      pages: [
        { id: "p1", name: "Page 1", children: [frame1], canvas: { unit: "px", background: { type: "solid", color: "#101010" } } },
        { id: "p2", name: "Page 2", children: [frame2], canvas: { unit: "px", background: { type: "solid", color: "#101010" } } }
      ]
    };

    const target = findThumbnailTargetFrame(doc);
    expect(target?.id).toBe("f2");
  });

  it("prioritizes frame with isThumbnail === true over position fallback", () => {
    const frame1 = createFrame("f1", "First Frame");
    const frame2 = createFrame("f2", "Thumbnail Frame", { isThumbnail: true });
    const doc: DesignDocument = {
      ...createEmptyDocument(),
      pages: [
        { id: "p1", name: "Page 1", children: [frame1, frame2], canvas: { unit: "px", background: { type: "solid", color: "#101010" } } }
      ]
    };

    const target = findThumbnailTargetFrame(doc);
    expect(target?.id).toBe("f2");
  });

  it("falls back to the first frame of Page 1 when not explicitly set", () => {
    const frame1 = createFrame("f1", "First Frame");
    const frame2 = createFrame("f2", "Second Frame");
    const doc: DesignDocument = {
      ...createEmptyDocument(),
      pages: [
        { id: "p1", name: "Page 1", children: [frame1, frame2], canvas: { unit: "px", background: { type: "solid", color: "#101010" } } }
      ]
    };

    const target = findThumbnailTargetFrame(doc);
    expect(target?.id).toBe("f1");
  });

  it("returns null when Page 1 has no frames", () => {
    const doc: DesignDocument = {
      ...createEmptyDocument(),
      pages: [
        {
          id: "p1",
          name: "Page 1",
          children: [
            { id: "r1", name: "Rect", type: "rect", x: 0, y: 0, width: 100, height: 100 }
          ],
          canvas: { unit: "px", background: { type: "solid", color: "#101010" } }
        }
      ]
    };

    const target = findThumbnailTargetFrame(doc);
    expect(target).toBeNull();
  });
});

describe("thumbnail preview serialization", () => {
  const baseShell = `<!DOCTYPE html><html><head><script id="design-doc" type="application/json">{}</script></head><body><div id="app"></div></body></html>`;

  afterEach(() => {
    registerPreviewGenerator(null);
  });

  it("injects the preview block ahead of the app when a generator is registered", () => {
    registerPreviewGenerator(() =>
      coverBlockHtml(`<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>`, "#101010")
    );

    const html = serializeSelf(createEmptyDocument(), baseShell);

    expect(html).toContain('data-fish-preview="1"');
    expect(html).toContain("<svg viewBox=\"0 0 100 100\">");
    expect(html).toContain('<div id="app"></div>');
    expect(html.indexOf("data-fish-preview")).toBeLessThan(html.indexOf('<div id="app">'));
  });

  it("cleans old preview blocks on re-save without accumulating", () => {
    registerPreviewGenerator(() => coverBlockHtml(`<div>Preview</div>`, "#101010"));

    const doc = createEmptyDocument();
    const once = serializeSelf(doc, baseShell);
    const twice = serializeSelf(doc, once);

    expect(once.match(/data-fish-preview="1"/g)).toHaveLength(1);
    expect(twice.match(/data-fish-preview="1"/g)).toHaveLength(1);
  });

  it("rejects preview HTML that could break the document it lands in", () => {
    expect(isSafePreviewHtml(`<script>alert(1)</script>`)).toBe(false);
    expect(
      isSafePreviewHtml(`<div data-fish-preview="1"><script>alert(1)</script><div data-fish-preview-end="1"></div></div>`)
    ).toBe(false);
    expect(isSafePreviewHtml(`<div data-fish-preview="1"><div>x</div></div>`)).toBe(false);
    expect(
      isSafePreviewHtml(`<div data-fish-preview="1"><style>.a{}</style><div data-fish-preview-end="1"></div></div>`)
    ).toBe(true);
    expect(
      isSafePreviewHtml(`<div data-fish-preview="1"><style>.a{}</div><div data-fish-preview-end="1"></div></div>`)
    ).toBe(false);
    expect(
      isSafePreviewHtml(`<div data-fish-preview="1"><div>x</div><div data-fish-preview-end="1"></div>`)
    ).toBe(false);
  });

  // A base64 payload is a place a stray `<div` or an unbalanced `<style>` would
  // silently break the block rather than fail loudly, so the guard is asserted on
  // the shape the generator actually emits.
  it("accepts the rasterized cover block", () => {
    const block = coverBlockHtml(
      `<img src="data:image/webp;base64,UklGRiIAAABXRUJQVlA4" alt="" style="display:block;width:100%;height:100%;object-fit:contain">`,
      "#E8E7E3"
    );
    expect(isSafePreviewHtml(block)).toBe(true);
  });
});

describe("default cover", () => {
  const baseShell = `<!DOCTYPE html><html><head><script id="design-doc" type="application/json">{}</script></head><body><div id="app"></div></body></html>`;

  afterEach(() => {
    registerPreviewGenerator(null);
  });

  // A document with no frame has no art to paint, and an absent block is not a
  // design choice a viewer can read: it is the same picture as a corrupt file.
  it("gives an empty document a cover rather than no cover", () => {
    const html = renderThumbnailPreviewHtml(createEmptyDocument());
    expect(isSafePreviewHtml(html)).toBe(true);
    expect(html).toContain('data-fish-preview="1"');
  });

  it("dots the wordmark's i with the brand cell", () => {
    const html = renderThumbnailPreviewHtml(createEmptyDocument());
    expect(html).toContain(`width="${WORDMARK_CELL.size}" height="${WORDMARK_CELL.size}"`);
  });

  it("rides a save of an empty document in front of the app", () => {
    registerPreviewGenerator(renderThumbnailPreviewHtml);
    const html = serializeSelf(createEmptyDocument(), baseShell);
    expect(html.indexOf("data-fish-preview")).toBeGreaterThan(html.indexOf("<body>"));
    expect(html.indexOf("data-fish-preview")).toBeLessThan(html.indexOf('<div id="app">'));
    expect(html.match(/data-fish-preview="1"/g)).toHaveLength(1);
  });
});
