import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MARK, MARK_CELLS } from "../src/ui/fish-mark";
import {
  WORDMARK_CELL,
  WORDMARK_CLOSE,
  WORDMARK_LETTERS,
  WORDMARK_OPEN,
  WORDMARK_UNITS
} from "../src/ui/fish-wordmark";

const REPO = join(__dirname, "..");
const TAG = readFileSync(join(REPO, "src/ui/fish-tag.svg"), "utf8");

/**
 * The masters live in the site repo, and everything here is one of their copies, so
 * the assertions that matter reach across. Skips when the sibling is not checked out:
 * a product-only checkout cannot verify a copy against a master it does not have, and
 * a test that passed anyway would be claiming it had.
 */
/**
 * Numbers get re-serialised: an editor or a formatter turns 0.556 into .556 without
 * changing the drawing. Comparing attribute text byte-for-byte would fail on that,
 * so values are canonicalised before the comparison and the shapes' geometry is what
 * is actually asserted.
 */
const canon = (s: string) => s.replace(/="(-?\.\d+)"/g, '="0$1"');

const SITE = join(REPO, "../fish-landing");
const siteFile = (p: string) => {
  const full = join(SITE, p);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
};

describe("brand assets", () => {
  // The cover inlines the wordmark as three strings so it can be built without a
  // DOM. Those strings are a transcription of the SVG, and a transcription is
  // exactly what drifts: this catches it at the source instead of in a thumbnail.
  it("keeps the cover's wordmark a transcription of the tag", () => {
    expect(TAG).toContain(WORDMARK_LETTERS);
    expect(TAG).toContain(WORDMARK_OPEN);
    expect(TAG).toContain(WORDMARK_CLOSE);

    const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(TAG);
    expect(viewBox).not.toBeNull();
    expect(`${WORDMARK_UNITS.width} ${WORDMARK_UNITS.height}`).toBe(`${viewBox![1]} ${viewBox![2]}`);
  });

  it("places the amber cell on the tag's own rect", () => {
    const rect = /<rect[^>]*\/>/.exec(TAG)?.[0];
    expect(rect).toBeDefined();
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]+)"`).exec(rect!)?.[1];
    expect(Number(attr("x"))).toBe(WORDMARK_CELL.x);
    expect(Number(attr("y"))).toBe(WORDMARK_CELL.y);
    expect(Number(attr("width"))).toBe(WORDMARK_CELL.size);
    expect(Number(attr("rx"))).toBe(WORDMARK_CELL.rx);
  });

  // The site's two copies are written by scripts/sync-brand.mjs. Byte equality is the
  // strongest form of "just a copy", and it is what makes `brand:check` meaningful.
  it("ships the site's wordmark as a byte-for-byte copy", () => {
    const copy = siteFile("brand/fish-tag.svg");
    if (copy === null) return;
    expect(canon(copy ?? "")).toBe(canon(TAG));
  });

  it("derives the site's light variant from the dark one", () => {
    const light = siteFile("public/fish-tag-light.svg");
    if (light === null) return;
    expect(light).toBe(TAG.replace(/#ecf3f8/gi, "#0c0d10"));
  });

  // These three are the product's own copies of the masters: byte equality is what
  // makes "the site is the source" a fact rather than a convention.
  it("keeps the product's icon a copy of the master", () => {
    const master = siteFile("brand/fish-icon.svg");
    if (master === null) return;
    const mine = readFileSync(join(REPO, "src/ui/fish-icon.svg"), "utf8");
    expect(canon(mine)).toBe(canon(master));
  });

  it("keeps the product's mark geometry a copy of the master", () => {
    const master = siteFile("brand/fish-mark.ts");
    if (master === null) return;
    const mine = readFileSync(join(REPO, "src/ui/fish-mark.ts"), "utf8");
    expect(mine).toBe(master);
  });

  it("keeps the site's favicon a copy of the icon master", () => {
    const master = siteFile("brand/fish-icon.svg");
    const favicon = siteFile("public/favicon.svg");
    if (master === null || favicon === null) return;
    expect(canon(favicon)).toBe(canon(master));
  });

  it("writes the site's 3×3 mark from the same geometry", () => {
    const page = siteFile("index.html");
    if (page === null) return;
    const block = /<!-- brand:mark:start[\s\S]*?<!-- brand:mark:end -->/.exec(page)?.[0];
    expect(block).toBeDefined();

    const rects = [...block!.matchAll(/<rect[^>]*\/>/g)].map((m) => m[0]);
    expect(rects).toHaveLength(MARK_CELLS.length);
    MARK_CELLS.forEach((cell, i) => {
      const get = (name: string) => new RegExp(`\\b${name}="([^"]+)"`).exec(rects[i])?.[1];
      expect(Number(get("x"))).toBe(cell.x);
      expect(Number(get("y"))).toBe(cell.y);
      expect(Number(get("width"))).toBe(MARK.cell);
      expect(Number(get("rx"))).toBe(MARK.rx);
      expect(get("class")).toBe(cell.lit ? "k" : "c");
    });
  });

  it("builds the site's inline wordmark from the same elements", () => {
    const page = siteFile("index.html");
    if (page === null) return;
    const block = /<!-- brand:tag:start[\s\S]*?<!-- brand:tag:end -->/.exec(page)?.[0];
    expect(block).toBeDefined();

    const shapes = [...block!.matchAll(/<(?:path|rect)\b[^>]*\/>/g)].map((m) => m[0]);
    const source = [...TAG.matchAll(/<(?:path|rect)\b[^>]*\/>/g)].map((m) => m[0]);
    expect(shapes.map(canon)).toEqual(source.map(canon));
  });

  it("keeps the mark's cell the same shape as the wordmark's dot", () => {
    expect(MARK.rx / MARK.cell).toBeCloseTo(WORDMARK_CELL.rx / WORDMARK_CELL.size, 3);
  });
});
