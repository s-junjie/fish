import { describe, it, expect } from "vitest";
import { coverBlockHtml, insertCoverBlock, stripCoverBlock } from "../src/core/cover-block";

// Both shapes the generator emits. The raster one nests divs, which is the case a
// block regex anchored on the first `</div>` matches only half of.
const rasterBlock = coverBlockHtml(
  `<img src="data:image/webp;base64,UklGRiIAAABXRUJQVlA4" alt="">`,
  "#E8E7E3"
);

const vectorBlock = coverBlockHtml(`<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>`, "#101010");

// Files written before the block lost its script still carry one; a re-save has to
// replace it rather than land a second cover beside it.
const legacyBlock = `<div data-fish-preview="1"><div style="position:fixed;inset:0;display:flex"><img src="data:image/webp;base64,UklGRiIAAABXRUJQVlA4" alt=""></div></div>\n<script data-fish-preview="1">(function(){})()</script>`;

const shell = `<!DOCTYPE html><html><head><title>x</title></head><body><div id="app"></div><script id="design-doc" type="application/json">{}</script></body></html>`;

describe("cover block splicing", () => {
  it("places the cover ahead of the app markup", () => {
    const next = insertCoverBlock(shell, rasterBlock);
    expect(next.indexOf("data-fish-preview")).toBeGreaterThan(next.indexOf("<body>"));
    expect(next.indexOf("data-fish-preview")).toBeLessThan(next.indexOf('<div id="app">'));
  });

  it("replaces the previous cover instead of stacking a second one", () => {
    const once = insertCoverBlock(shell, vectorBlock);
    const twice = insertCoverBlock(once, rasterBlock);
    expect(twice.match(/data-fish-preview="1"/g)).toHaveLength(1);
    expect(twice).toContain("data:image/webp");
    expect(twice).not.toContain("<svg viewBox");
  });

  it("replaces a cover left by a build that still wrote the script", () => {
    const once = insertCoverBlock(shell, legacyBlock);
    const twice = insertCoverBlock(once, vectorBlock);
    expect(twice.match(/data-fish-preview="1"/g)).toHaveLength(1);
    expect(twice).not.toContain("<script data-fish-preview");
    expect(twice).toContain("<svg viewBox");
  });

  it("anchors on the app div when the shell has no body", () => {
    const fragmentShell = `<html><head></head><div id="app"></div></html>`;
    const next = insertCoverBlock(fragmentShell, rasterBlock);
    expect(next.indexOf("data-fish-preview")).toBeLessThan(next.indexOf('<div id="app">'));
  });

  it("leaves a fragment with nothing to anchor on alone", () => {
    const fragment = `<div><span>not a document</span></div>`;
    expect(insertCoverBlock(fragment, rasterBlock)).toBe(fragment);
  });

  it("strips a raster cover whole, including its wrapper", () => {
    expect(stripCoverBlock(insertCoverBlock(shell, rasterBlock))).toBe(shell);
  });

  // The generator's own output, spliced by the same helpers the save and the shell
  // build use: a block the strip regex cannot find is the failure that leaves a
  // second cover in the file on every save.
  it("round-trips the block the generator writes", () => {
    expect(stripCoverBlock(insertCoverBlock(shell, legacyBlock))).toBe(shell);
    expect(stripCoverBlock(insertCoverBlock(shell, vectorBlock))).toBe(shell);
  });
});
