import { DesignElement, ElementType } from "../../core/dsl/types";
import { isSectionElement } from "../../core/geometry/tree-query";
import { measureText, TextMeasureSpec } from "../../core/geometry/text-measure";
import { CANVAS_CHROME_TEXT } from "./canvas-text";

/**
 * What a top-level frame's name label says, at the current zoom — or nothing.
 *
 * Figma's two rules, and the whole of it:
 *
 *  - the label never grows past the frame's own width; what does not fit is
 *    replaced by an ellipsis, so a label can never land on its neighbour's;
 *  - below 5 % zoom the canvas carries no names at all, because at that scale a
 *    name is bigger than the screen it describes and only adds noise.
 *
 * The label is 11px of SCREEN (see the chrome block in `style.css`), so it does
 * not shrink with the document, and the answer is a screen-space measurement.
 * It is taken in `renderNodeList` — the unmemoized pass — for the same reason
 * the cull is: it decides what gets PAINTED, and a memoized node cannot be asked
 * what its label says without being re-rendered to find out.
 */

/** Below this zoom, no frame is named. Figma's floor, and ours. */
const TITLE_MIN_ZOOM = 0.05;
/** The face the label is painted in — the numbers `SvgNodeRenderer` sets. */
const TITLE_FONT: TextMeasureSpec = {
  fontFamily: CANVAS_CHROME_TEXT,
  fontSize: 11,
  fontWeight: 400,
  lineHeight: 11,
  letterSpacing: 0
};
const ELLIPSIS = "…";
/** Two characters are the least that still says something: "1…". */
const TITLE_MIN_CHARS = 2;

/**
 * What the frame's width does NOT have to pay for: a component's or a set's
 * diamond, drawn before the name, and an instance's typed `◇ ` prefix.
 */
const TITLE_MARK_PX: Partial<Record<ElementType, number>> = { component: 14, componentSet: 14 };
const TITLE_PREFIX_CHARS: Partial<Record<ElementType, number>> = { instance: 2 };

/**
 * What a section's label pays on each side. The label is a PILL that sits
 * outside the box's top edge (Figma's), so the pill's own padding is the only
 * inset — the text may run to the box's right edge minus that padding, and the
 * pill still fits inside the width the section declares.
 */
export const SECTION_LABEL_PAD = 6;

const TITLED_TYPES: ReadonlySet<ElementType> = new Set<ElementType>([
  "frame",
  "component",
  "componentSet",
  "instance"
]);

/**
 * One glyph's advance, measured rather than assumed.
 *
 * The face is a mono stack, so every glyph is the same width and a single
 * measurement turns "how wide is the frame" into "how many characters fit" with
 * no per-label measuring. It is measured rather than written down because the
 * stack resolves to a different font on every platform — Menlo here, Consolas on
 * Windows — and a constant tuned on one of them overflows the frame on another.
 * `measureText` caches, so this is a map hit after the first call.
 */
function charAdvance(): number {
  const sample = "00000000";
  return measureText(sample, TITLE_FONT, Infinity).width / sample.length;
}

/** The name a label would say — an instance may be naming its master. */
export type FrameTitleName = (el: DesignElement) => string;

/**
 * The painted width of a label, in screen pixels — what the section pill behind
 * it has to be. Measured with the same face the text is drawn in, so the plate
 * cannot come out narrower than the word it holds.
 */
export function titleLabelWidth(text: string): number {
  return measureText(text, TITLE_FONT, Infinity).width;
}

export function resolveFrameTitles(
  list: readonly DesignElement[],
  zoom: number,
  nameOf: FrameTitleName
): Map<string, string> {
  const titles = new Map<string, string>();
  if (zoom < TITLE_MIN_ZOOM) return titles;

  const advance = charAdvance();
  for (const el of list) {
    if (el.visible === false || el.isMask || !TITLED_TYPES.has(el.type)) continue;
    const budget =
      Math.floor(
        (el.width * zoom - (TITLE_MARK_PX[el.type] ?? 0) - (isSectionElement(el) ? SECTION_LABEL_PAD * 2 : 0)) /
          advance
      ) - (TITLE_PREFIX_CHARS[el.type] ?? 0);
    if (budget < TITLE_MIN_CHARS) continue;
    const name = nameOf(el);
    titles.set(el.id, name.length <= budget ? name : name.slice(0, budget - 1) + ELLIPSIS);
  }
  return titles;
}
