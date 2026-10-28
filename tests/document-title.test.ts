import { describe, it, expect } from "vitest";
import { documentTitleFor, stampDocumentTitle } from "../src/core/document-title";
import { serializeSelf, createEmptyDocument } from "../src/core/data-bridge";

/**
 * The title is the one string in a `.fish.html` that names the file itself, and
 * it has two readers: the tab strip, and anyone who opens the file. Both get it
 * from the same derivation, because a tab that says one thing and a file that
 * says another is the bug this module exists to prevent.
 */
describe("the document title", () => {
  describe("what it says", () => {
    it("names the file, without the directory or the document extension", () => {
      expect(documentTitleFor("my-design.fish.html")).toBe("my-design — FISH");
      expect(documentTitleFor("index.html")).toBe("index — FISH");
      expect(documentTitleFor("draft.v2.fish.html")).toBe("draft.v2 — FISH");
      expect(documentTitleFor("plain.htm")).toBe("plain — FISH");
    });

    it("falls back to the document's name when there is no file", () => {
      expect(documentTitleFor(undefined, "Landing Page")).toBe("Landing Page — FISH");
      expect(documentTitleFor("", "Landing Page")).toBe("Landing Page — FISH");
    });

    it("refuses a name that is not a document — the dev route is not a file name", () => {
      // Under the dev bundle route the pathname is `/__fish_bundle__`. A tab
      // titled after it says less than a tab titled after the document.
      expect(documentTitleFor("__fish_bundle__", "Landing Page")).toBe("Landing Page — FISH");
    });

    it("says nothing when neither the file nor the document knows a name", () => {
      expect(documentTitleFor(undefined, undefined)).toBeUndefined();
      expect(documentTitleFor("  ", "   ")).toBeUndefined();
    });
  });

  describe("what it writes into a shell", () => {
    const SHELL = `<!DOCTYPE html><html><head><title>Shipped Title</title></head><body><div id="app"></div></body></html>`;

    it("replaces the shell's title rather than adding one", () => {
      const out = stampDocumentTitle(SHELL, "demo — FISH");
      expect(out).toContain("<title>demo — FISH</title>");
      expect(out).not.toContain("Shipped Title");
      expect(out.match(/<title>/g)).toHaveLength(1);
    });

    it("gives a shell with no title one, and stays idempotent", () => {
      const headless = `<html><head></head><body></body></html>`;
      const once = stampDocumentTitle(headless, "demo — FISH");
      expect(once).toContain("<title>demo — FISH</title>");
      expect(stampDocumentTitle(once, "demo — FISH")).toBe(once);
      expect(stampDocumentTitle(once, "other — FISH").match(/<title>/g)).toHaveLength(1);
    });

    it("leaves a shell with no head alone", () => {
      // The document block goes in as a bare sibling here; a title cannot.
      expect(stampDocumentTitle("<html></html>", "demo — FISH")).toBe("<html></html>");
    });

    it("escapes the name, so it cannot close the element it sits in", () => {
      const out = stampDocumentTitle(SHELL, "</title><script>alert(1)</script>");
      expect(out.match(/<\/title>/g)).toHaveLength(1);
      expect(out).not.toContain("<script>alert(1)");
    });

    it("never touches an SVG title in the body", () => {
      // The thumbnail preview is full of them, and the first one in the document
      // would be the one a document-wide search finds.
      const withPreview = SHELL.replace("<div id=\"app\"></div>", "<svg><title>Frame 1</title></svg>");
      expect(stampDocumentTitle(withPreview, "demo — FISH")).toContain("<title>Frame 1</title>");
    });
  });

  describe("what a save writes", () => {
    it("names the file being written, not the tab that wrote it", () => {
      const out = serializeSelf(createEmptyDocument(), "<html><head><title>Shipped</title></head><body></body></html>", {
        title: documentTitleFor("copy.fish.html", "Landing Page")
      });
      expect(out).toContain("<title>copy — FISH</title>");
    });
  });
});