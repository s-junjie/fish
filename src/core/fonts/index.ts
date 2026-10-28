import { buildCffOutline } from "./cff";
import { buildCmap } from "./cmap";
import { glyphCommands } from "./glyf";
import { commandsToPathData, GlyphCommand } from "./glyph-path";
import { parseSfnt } from "./sfnt";

export { FontParseError } from "./sfnt";
export type { FontErrorCode, SfntFont, SfntTable } from "./sfnt";
export type { GlyphContour, GlyphPoint } from "./glyf";
export type { CommandsBounds, GlyphCommand } from "./glyph-path";
export { commandsBounds, commandsToPathData, transformCommands } from "./glyph-path";

/**
 * What the outline pipeline needs from a font file: which glyph a character
 * maps to, and what shape that glyph has.
 *
 * Advance widths are deliberately absent. The browser already reports every
 * character's position (see docs/TEXT_OUTLINE_PLAN.md §2.2), and a second
 * opinion computed here would only be a second thing to disagree with it.
 */
export interface OutlineFont {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  numGlyphs: number;
  /** `glyf` carries quadratic curves, `cff` cubic ones. */
  outlineFormat: "glyf" | "cff";
  glyphIdForCodePoint(codePoint: number): number;
  /** Path commands in font units, y up. Empty for a blank glyph (space). */
  commands(glyphId: number): GlyphCommand[];
  /** The same commands serialised. Null for a blank glyph (space). */
  outline(glyphId: number): string | null;
}

export function parseOutlineFont(bytes: Uint8Array): OutlineFont {
  const sfnt = parseSfnt(bytes);
  const lookup = buildCmap(sfnt);
  const commands =
    sfnt.outlineFormat === "cff"
      ? buildCffOutline(sfnt)
      : (glyphId: number) => glyphCommands(sfnt, glyphId);

  return {
    unitsPerEm: sfnt.unitsPerEm,
    ascender: sfnt.ascender,
    descender: sfnt.descender,
    numGlyphs: sfnt.numGlyphs,
    outlineFormat: sfnt.outlineFormat,
    glyphIdForCodePoint: lookup,
    commands,
    outline: (glyphId) => {
      const list = commands(glyphId);
      return list.length === 0 ? null : commandsToPathData(list);
    }
  };
}
