import { describe, it, expect } from "vitest";
import { commandsBounds, parseOutlineFont, transformCommands } from "../src/core/fonts";
import type { GlyphCommand } from "../src/core/fonts";
import { outlineTextElement } from "../src/core/geometry/text-outline";
import type { OutlineLine } from "../src/core/geometry/text-outline";
import type { FrameElement, PathElement, TextElement } from "../src/core/dsl/types";
import { buildTinyFont } from "./fixtures/tiny-font";

/**
 * The fixture font maps 'A'..'D' onto glyphs 1..4 and gives them extents worth
 * asserting on: 'A' is a triangle spanning 100..900 × 0..700 font units, 'C' is a
 * composite (glyph 1 shifted by +200/+100), 'D' a 200×200 square. A fontSize equal
 * to `unitsPerEm` makes the glyph scale exactly 1, so every expected number below
 * is an integer that can be read off the fixture's own comment.
 */
const font = parseOutlineFont(buildTinyFont());
const FONT_SIZE = font.unitsPerEm;

const DEFAULT_LINES: OutlineLine[] = [{ text: "ABCD", xs: [0, 600, 1200, 1800], baselineY: 0 }];

const textElement = (over: Record<string, unknown> = {}): TextElement =>
  ({
    id: "text_1",
    type: "text",
    name: "Wordmark",
    x: 0,
    y: 0,
    width: 2200,
    height: 800,
    content: "ABCD",
    style: { fontSize: FONT_SIZE },
    ...over
  }) as unknown as TextElement;

const outline = (
  over: Record<string, unknown> = {},
  lines: OutlineLine[] = DEFAULT_LINES
): FrameElement => {
  const node = outlineTextElement(textElement(over), font, lines);
  if (!node) throw new Error("outlineTextElement returned nothing");
  return node;
};

const childrenOf = (frame: FrameElement): PathElement[] => frame.children as PathElement[];

/**
 * The result the OLD implementation produced — every glyph welded into one path —
 * recomputed through a different route (all commands at once rather than per
 * glyph), so comparing boxes catches a dropped or mis-measured glyph.
 */
function weldedBounds(lines: OutlineLine[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const scale = FONT_SIZE / font.unitsPerEm;
  const placed: GlyphCommand[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.text.length; i++) {
      const codePoint = line.text.codePointAt(i);
      if (codePoint === undefined) continue;
      if (codePoint > 0xffff) i++;
      const glyphId = font.glyphIdForCodePoint(codePoint);
      if (glyphId === 0) continue;
      const penX = line.xs[i] ?? 0;
      placed.push(
        ...transformCommands(font.commands(glyphId), (x, y) => [
          penX + x * scale,
          line.baselineY - y * scale
        ])
      );
    }
  }
  const bounds = commandsBounds(placed);
  if (!bounds) throw new Error("fixture drew nothing");
  return bounds;
}

describe("outline text lays one path per glyph", () => {
  it("gives every drawn character its own path, named for the character", () => {
    const kids = childrenOf(outline());
    expect(kids).toHaveLength(4);
    expect(kids.map((k) => k.name)).toEqual(["A", "B", "C", "D"]);
    expect(kids.every((k) => k.type === "path")).toBe(true);
    // Glyph outlines are wound so counters read as holes under nonzero.
    expect(kids.every((k) => k.fillRule === "nonzero")).toBe(true);
    expect(kids.every((k) => k.d.length > 0 && /^[MLQCZ0-9 .-]+$/.test(k.d))).toBe(true);
  });

  it("gives each path its own id, so ungrouping yields independent layers", () => {
    const frame = outline();
    const ids = [frame.id, ...childrenOf(frame).map((k) => k.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(frame.id).not.toBe("text_1");
  });

  it("draws no layer for a character with no outline", () => {
    // ' ' resolves to `.notdef` in this fixture, which is skipped rather than
    // drawn as a tofu box.
    const kids = childrenOf(outline({ content: "A B" }, [{ text: "A B", xs: [0, 60, 120], baselineY: 0 }]));
    expect(kids.map((k) => k.name)).toEqual(["A", "B"]);
  });

  it("returns nothing at all when no character draws", () => {
    expect(
      outlineTextElement(textElement({ content: " " }), font, [{ text: " ", xs: [0], baselineY: 0 }])
    ).toBeNull();
  });
});

describe("the frame holds the glyphs", () => {
  it("wraps them in a frame covering the whole word", () => {
    const frame = outline();
    expect(frame.type).toBe("frame");
    expect(frame.name).toBe("Wordmark");
    // 'A' starts at 100, 'C' reaches 2300 (composite lands at 1100 + pen 1200),
    // 'C' is the tallest at y -800 and 'A' the bottom at y 0.
    expect({ x: frame.x, y: frame.y, width: frame.width, height: frame.height }).toEqual({
      x: 100,
      y: -800,
      width: 2200,
      height: 800
    });
  });

  it("rebases each glyph onto the frame's own corner, at its own size", () => {
    const boxes = childrenOf(outline()).map((k) => ({
      x: k.x,
      y: k.y,
      width: k.width,
      height: k.height
    }));
    expect(boxes).toEqual([
      // 'A': triangle 100..900 × 0..700 at pen 0, flipped to y -700..0.
      { x: 0, y: 100, width: 800, height: 700 },
      // 'B': 0..1000 × 0..700 at pen 600.
      { x: 500, y: 100, width: 1000, height: 700 },
      // 'C': composite = glyph 1 shifted +200/+100, at pen 1200.
      { x: 1400, y: 0, width: 800, height: 700 },
      // 'D': the 200×200 square at pen 1800.
      { x: 1700, y: 600, width: 200, height: 200 }
    ]);
  });

  it("covers exactly the box the single welded path used to cover", () => {
    const welded = weldedBounds(DEFAULT_LINES);
    const frame = outline();
    expect(frame.x).toBeCloseTo(welded.minX, 6);
    expect(frame.y).toBeCloseTo(welded.minY, 6);
    expect(frame.x + frame.width).toBeCloseTo(welded.maxX, 6);
    expect(frame.y + frame.height).toBeCloseTo(welded.maxY, 6);
  });

  it("keeps the word's turning, opacity and effects on the frame alone", () => {
    const el = textElement({
      rotation: 30,
      opacity: 0.5,
      blendMode: "multiply",
      effects: [{ type: "drop-shadow" }]
    });
    const frame = outlineTextElement(el, font, DEFAULT_LINES)!;

    // The renderer mounts transform/filter/opacity/blend on the element's own
    // `<g>`, which wraps the children — so these belong here, once, and the
    // shadow is filtered over the composited word rather than per glyph.
    expect(frame.rotation).toBe(30);
    expect(frame.opacity).toBe(0.5);
    expect(frame.blendMode).toBe("multiply");
    expect(frame.effects).toEqual([{ type: "drop-shadow" }]);
    expect(frame.visible).toBeUndefined();

    for (const kid of childrenOf(frame)) {
      const loose = kid as unknown as Record<string, unknown>;
      expect(loose.rotation).toBeUndefined();
      expect(loose.opacity).toBeUndefined();
      expect(loose.effects).toBeUndefined();
      expect(loose.blendMode).toBeUndefined();
    }
  });

  it("leaves the fill on the letters, and paints no rectangle behind them", () => {
    const fills = [{ type: "solid", color: "#FF0000" }];
    const frame = outline({ fills });
    expect(frame.fills).toEqual([]);
    expect(frame.clipContent).toBe(false);
    // On the children, so ungrouping yields letters that recolour one at a time.
    expect(childrenOf(frame).every((k) => (k as unknown as Record<string, unknown>).fills === fills)).toBe(
      true
    );
  });
});
