import { FrameElement, PathElement, TextElement } from "../dsl/types";
import { commandsBounds, commandsToPathData, OutlineFont, transformCommands } from "../fonts";
import { createId } from "../id";

/**
 * Turns a laid-out text element into one path per glyph, gathered into a frame.
 *
 * A glyph — not the text layer — is the unit worth handing back: it is what a
 * user moves when they nudge a letterform, and what a fill can differ over. It is
 * also Figma's `Outline stroke` result (`each glyph is converted to its own vector
 * layer`), where its other door, `Flatten`, is the one that welds every glyph into
 * a single path. Splitting costs nothing here — the loop below already holds one
 * glyph's commands at a time — and the frame keeps the word a single child when
 * the text sat in an auto layout, where N sibling paths would be laid out as N
 * items and tear the word apart.
 *
 * Everything here is arithmetic on points: no DOM, no font file. The caller has
 * already decided where each character's pen sits (`measureGlyphPositions`) and
 * which font to draw with; this module only places outlines.
 *
 * Coordinates are converted from the font's own axes (y up, `unitsPerEm` tall)
 * into the document's (y down, `fontSize` tall) — the flip and the scale are the
 * same two numbers for every glyph, so they happen once, here.
 */

export interface OutlineLine {
  /** The line's characters, after `text-transform` and line clamping. */
  text: string;
  /** Absolute pen x of each character of `text`. */
  xs: number[];
  /** Absolute y of the baseline. */
  baselineY: number;
}

export function outlineTextElement(
  el: TextElement,
  font: OutlineFont,
  lines: OutlineLine[]
): FrameElement | null {
  const fontSize = el.style?.fontSize || 24;
  const scale = fontSize / font.unitsPerEm;

  const glyphs: PathElement[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.text.length; i++) {
      const codePoint = line.text.codePointAt(i);
      if (codePoint === undefined) continue;
      // Read the name before the surrogate step below moves `i` past it.
      const name = String.fromCodePoint(codePoint);
      if (codePoint > 0xffff) i++;

      const glyphId = font.glyphIdForCodePoint(codePoint);
      // Glyph 0 is `.notdef`; drawing a tofu box would be worse than a gap.
      if (glyphId === 0) continue;

      const penX = line.xs[i] ?? 0;
      const placed = transformCommands(font.commands(glyphId), (x, y) => [
        penX + x * scale,
        line.baselineY - y * scale
      ]);

      // No commands at all is a blank glyph (a space), and `commandsBounds`
      // reports null for it: it draws nothing, so it earns no layer.
      const bounds = commandsBounds(placed);
      if (!bounds) continue;

      const shifted = transformCommands(placed, (x, y) => [x - bounds.minX, y - bounds.minY]);

      glyphs.push({
        id: createId("path"),
        type: "path",
        name,
        x: bounds.minX,
        y: bounds.minY,
        width: Math.max(1, bounds.maxX - bounds.minX),
        height: Math.max(1, bounds.maxY - bounds.minY),
        fillEnabled: el.fillEnabled,
        fills: el.fills,
        strokes: el.strokes,
        // Glyph outlines are wound so that counters read as holes under nonzero.
        fillRule: "nonzero",
        d: commandsToPathData(shifted)
      });
    }
  }

  return glyphs.length > 0 ? groupGlyphs(el, glyphs) : null;
}

/**
 * The frame the glyph paths hang in.
 *
 * It takes every property that describes the WORD rather than a letter — the
 * turn, the opacity, the effects, the blend, the lock — because the renderer
 * mounts all of those on the element's own `<g>`, which wraps the frame's
 * children. So a drop shadow is filtered once over the composited word, exactly
 * as it was filtered over the single welded path before: N shadows, one per
 * glyph, is what putting `effects` on the children would have bought instead.
 *
 * The fill stays on the children, so ungrouping yields letters that can be
 * recoloured one at a time.
 */
function groupGlyphs(el: TextElement, glyphs: PathElement[]): FrameElement {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of glyphs) {
    if (g.x < minX) minX = g.x;
    if (g.y < minY) minY = g.y;
    if (g.x + g.width > maxX) maxX = g.x + g.width;
    if (g.y + g.height > maxY) maxY = g.y + g.height;
  }

  return {
    id: createId("frame"),
    type: "frame",
    name: el.name || "Text",
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    rotation: el.rotation,
    opacity: el.opacity,
    blendMode: el.blendMode,
    locked: el.locked,
    visible: el.visible,
    isMask: el.isMask,
    effects: el.effects,
    adjust: el.adjust,
    fills: [],
    clipContent: false,
    // Children are parent-local: rebased onto the frame's own top-left.
    children: glyphs.map((g) => ({ ...g, x: g.x - minX, y: g.y - minY }))
  };
}
