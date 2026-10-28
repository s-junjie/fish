import { FrameElement, TextElement } from "../../core/dsl/types";
import { resolveDynamicLineHeight, resolveLetterSpacing } from "../../core/compile";
import { HAlign, layoutTextRun, VAlign } from "../../core/text-layout";
import { alignLineLeft, measureGlyphPositions } from "../../core/geometry/text-measure";
import { outlineTextElement, OutlineLine } from "../../core/geometry/text-outline";
import { resolveOutlineFont } from "./outline-font-source";
import type { OutlineFontFailure } from "./outline-font-source";
import { DEFAULT_FONT_FAMILY } from "../../core/font-stack";

/**
 * The whole Outline text path for one element: find the font file, lay the text
 * out the way the canvas laid it out, ask the browser where each character
 * actually landed, and hand that to the geometry that builds one path per glyph.
 *
 * The result is a frame of those paths, not a single welded one: the letters stay
 * separate layers inside it, so a user can ungroup and move one, and an auto
 * layout that held the text still holds exactly one child.
 *
 * Wrapping comes from `layoutTextRun` — the same function the exporter uses —
 * so the outlined path breaks at the same word the canvas breaks at. Only the
 * positions inside a line come from the browser, and they come from the browser
 * because that is the only source that agrees with what was drawn (see
 * docs/TEXT_OUTLINE_PLAN.md §2.2).
 */
export type OutlineTextResult =
  | { ok: true; node: FrameElement }
  | { ok: false; failure: OutlineFontFailure; detail: string };

export async function outlineText(el: TextElement): Promise<OutlineTextResult> {
  const style = el.style;
  const fontSize = style?.fontSize || 24;
  // Deliberately NOT `resolveStack`: the outline must come from the face the
  // author NAMED. Appending the substitute stack would let `resolveOutlineFont`
  // fall through to `system-ui` and bake the platform default's glyphs into
  // paths — the one mistake outlining makes permanent. A generic the author did
  // write (`system-ui`) still resolves: it names no face, so it was never a
  // missing font.
  const fontFamily = style?.fontFamily || DEFAULT_FONT_FAMILY;
  const weight =
    typeof style?.fontWeight === "number"
      ? style.fontWeight
      : style?.fontWeight === "bold"
        ? 700
        : 400;
  const italic = style?.fontStyle === "italic";

  const outcome = await resolveOutlineFont(fontFamily, weight, italic);
  if (!outcome.ok) return outcome;
  const font = outcome.font;

  const lineHeight = resolveDynamicLineHeight(fontSize, style?.lineHeight);
  const letterSpacing = resolveLetterSpacing(fontSize, style?.letterSpacing);
  const align = (style?.align as HAlign) || "left";

  const layout = layoutTextRun({
    content: el.content || "",
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    fontSize,
    fontFamily,
    fontWeight: String(style?.fontWeight ?? 400),
    fontStyle: italic ? "italic" : undefined,
    lineHeight,
    letterSpacing,
    align,
    verticalAlign: (style?.verticalAlign as VAlign) || "top",
    textTransform:
      style?.textTransform && style.textTransform !== "none" ? style.textTransform : undefined,
    maxLines: style?.maxLines,
    textOverflow: style?.textOverflow
  });

  const lines: OutlineLine[] = layout.lines.map((text, index) => {
    const positions = measureGlyphPositions({
      text,
      fontFamily,
      fontSize,
      fontWeight: weight,
      fontStyle: italic ? "italic" : undefined,
      letterSpacing,
      lineHeight
    });

    // The line is aligned by the width the browser reports, not the width the
    // layout pass measured: those two agree to a fraction of a pixel, and the
    // one that matches the drawn line is the one to trust for placing it.
    //
    // That reported width carries one trailing `letter-spacing` with no glyph
    // under it, so aligning it directly would leave centred text half a tracking
    // left of centre and right-aligned text a whole one short of the right edge
    // — in the export AND on the canvas, which paints through CSS and has the
    // same reserved box. One rule moves both, and it lives in
    // `alignLineLeft`/`trailingTrackingShift` rather than being spelled again
    // here, because two spellings is how the export and the canvas drift apart.
    const left = alignLineLeft(el.x, el.width, positions.width, align, letterSpacing);

    return {
      text,
      xs: positions.xs.map((offset) => left + offset),
      baselineY: layout.startY + index * lineHeight + positions.baselineOffset
    };
  });

  const node = outlineTextElement(el, font, lines);
  return node ? { ok: true, node } : { ok: false, failure: "unreadable", detail: "no glyphs" };
}
