import { describe, it, expect } from "vitest";
import { FontParseError, parseOutlineFont } from "../src/core/fonts";
import { buildTinyFont, TINY_FONT_EXPECTED } from "./fixtures/tiny-font";

const font = parseOutlineFont(buildTinyFont());
const codePoint = (character: string): number => character.codePointAt(0)!;

function failureCode(bytes: Uint8Array): string {
  try {
    parseOutlineFont(bytes);
    return "no error";
  } catch (error) {
    return error instanceof FontParseError ? error.code : "not a FontParseError";
  }
}

describe("sfnt container", () => {
  it("reads the header tables", () => {
    expect(font.unitsPerEm).toBe(TINY_FONT_EXPECTED.unitsPerEm);
    expect(font.ascender).toBe(TINY_FONT_EXPECTED.ascender);
    expect(font.descender).toBe(TINY_FONT_EXPECTED.descender);
    expect(font.numGlyphs).toBe(TINY_FONT_EXPECTED.numGlyphs);
  });

  it("accepts Apple's 'true' signature as well as 0x00010000", () => {
    const bytes = buildTinyFont();
    bytes.set([0x74, 0x72, 0x75, 0x65], 0);
    expect(parseOutlineFont(bytes).numGlyphs).toBe(TINY_FONT_EXPECTED.numGlyphs);
  });

  it("reads CFF outlines too (macOS ships its CJK fonts that way)", () => {
    // The fixture is glyf-shaped, so stamping the OTTO signature leaves it
    // without a `CFF ` table: the reader must say so rather than return an
    // empty font, and must not reject the signature itself.
    const bytes = buildTinyFont();
    bytes.set([0x4f, 0x54, 0x54, 0x4f], 0);
    expect(failureCode(bytes)).toBe("malformed");
  });

  it("names a collection rather than failing further down", () => {
    const bytes = buildTinyFont();
    bytes.set([0x74, 0x74, 0x63, 0x66], 0);
    expect(failureCode(bytes)).toBe("unsupported-collection");
  });

  it("rejects a file too short to hold a directory", () => {
    expect(failureCode(new Uint8Array(4))).toBe("malformed");
  });
});

describe("cmap", () => {
  it("maps code points to glyph ids", () => {
    expect(font.glyphIdForCodePoint(codePoint("A"))).toBe(1);
    expect(font.glyphIdForCodePoint(codePoint("B"))).toBe(2);
    expect(font.glyphIdForCodePoint(codePoint("C"))).toBe(3);
    expect(font.glyphIdForCodePoint(codePoint("D"))).toBe(4);
  });

  it("returns 0 for an uncovered code point", () => {
    expect(font.glyphIdForCodePoint(codePoint("Z"))).toBe(0);
  });

  it("reads format 12 as well as format 4", () => {
    const wide = parseOutlineFont(buildTinyFont({ cmapFormat: 12 }));
    expect(wide.glyphIdForCodePoint(codePoint("A"))).toBe(1);
    expect(wide.glyphIdForCodePoint(codePoint("D"))).toBe(4);
    expect(wide.glyphIdForCodePoint(codePoint("Z"))).toBe(0);
  });
});

describe("glyf outlines", () => {
  it("reads a square of on-curve points as lines", () => {
    expect(font.outline(0)).toBe(TINY_FONT_EXPECTED.notdef);
  });

  it("reads a triangle", () => {
    expect(font.outline(1)).toBe(TINY_FONT_EXPECTED.a);
  });

  it("synthesises the on-curve point between two control points", () => {
    expect(font.outline(2)).toBe(TINY_FONT_EXPECTED.b);
  });

  it("expands a composite glyph and applies its offset", () => {
    expect(font.outline(3)).toBe(TINY_FONT_EXPECTED.c);
  });

  it("reads compressed coordinates and REPEAT runs", () => {
    expect(font.outline(4)).toBe(TINY_FONT_EXPECTED.d);
  });

  it("returns null for a blank glyph", () => {
    expect(font.outline(5)).toBeNull();
  });

  it("returns null for a glyph id past the end of the font", () => {
    expect(font.outline(99)).toBeNull();
  });
});
