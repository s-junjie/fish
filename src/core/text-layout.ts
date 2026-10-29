import { applyTextTransform, baselineOffsetOf, measureText, TextMeasureSpec } from "./geometry/text-measure";

// Re-exported for the callers that knew it here first; the definition moved down
// to `text-measure` because the measurement needs it too and that module must not
// import this one.
export { applyTextTransform };

/**
 * How a text element's string becomes lines and where those lines sit.
 *
 * Pure, and DOM-free: the only thing it reaches for is `measureText`, which is
 * the one module allowed to touch a layout engine. The exporter is the consumer
 * today — `emitTextRun` builds its `<text>`/`<tspan>` from here — and it was
 * extracted because the canvas was about to need the same answers for the same
 * runs. An exported file that wraps a run at a different word than the canvas
 * did is a silent regression in the one artifact the user ships, and two
 * implementations of `white-space: pre-line` cannot be kept honest by review.
 *
 * The canvas does NOT use this yet. Painting a plain run as native `<text>` was
 * written and measured, and held back on two findings, both from
 * `demo/performance2.html`:
 *
 *  - `dominant-baseline="hanging"` only approximates the HTML line box. The first
 *    line lands 1-2px off, and it shows on a 28px label.
 *  - Wrapping can disagree. The "Log In" button is a 75px hug box whose text
 *    measures 80.16px: HTML keeps one line, this breaks it. Since `measureText`
 *    feeds `relayoutDocumentTree`, a disagreement moves every auto-layout frame
 *    on the page — so the canvas may only take this path for a run that needs no
 *    break at all (one line, no newline, no clamp, measuring inside its box).
 *    Gated that narrowly the wrap problem goes away and the vertical one does
 *    not.
 *
 * On a synthetic 17-case fixture the two renderings differ by 0.01 % of pixels
 * (max intensity 54/255, and nothing wraps differently), so the layout here is
 * sound. The vertical metric was the one thing missing — `baselineOffset` is it:
 * `hanging` puts the baseline at 0.8×ascent below `y` where the HTML line box
 * puts it `half-leading + ascent` below the top, and the residual showed up as an
 * 0.26em lift on every exported run.
 */

export type HAlign = "left" | "center" | "right" | "justify";
export type VAlign = "top" | "middle" | "bottom";

/** The typographic half of a text run — everything layout depends on, and nothing else. */
export interface TextLayoutInput {
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string | number;
  /** `italic` measures with its own advances — it is not a paint. */
  fontStyle?: string;
  /** Already resolved to px by `resolveDynamicLineHeight`. */
  lineHeight: number;
  letterSpacing: number;
  align: HAlign;
  verticalAlign: VAlign;
  textTransform?: string;
  maxLines?: number;
  textOverflow?: string;
}

/** Where one line's `<tspan>` goes, relative to the `<text>` node it hangs off. */
export interface LinePlacement {
  x: number;
  /** `0` on the first line and one line height on every line after it. */
  dy: string;
  textLength?: number;
  lengthAdjust?: string;
}

export interface TextLayout {
  lines: string[];
  /** `x`/`y` for the `<text>` node itself. */
  startX: number;
  /**
   * The top of the first LINE BOX — not the baseline.
   *
   * An HTML line box puts its baseline `half-leading + ascent` below its top;
   * SVG `<text>` puts `y` on the baseline. They are different points on the same
   * line, and the exporter read this one as the other for as long as
   * `dominant-baseline="hanging"` looked close enough — every exported run sat
   * ~0.26em high. Callers writing SVG take `startY + baselineOffset`.
   */
  startY: number;
  /** Distance from the line box's top down to its baseline. */
  baselineOffset: number;
  textAnchor: "start" | "middle" | "end";
  lineHeight: number;
  placement(idx: number): LinePlacement;
}

/**
 * What the glyphs look like once `text-transform` has been applied — defined in
 * `text-measure` and re-exported here for the callers that knew it here first.
 */

function specOf(run: TextLayoutInput): TextMeasureSpec {
  return {
    fontFamily: run.fontFamily,
    fontSize: run.fontSize,
    fontWeight: typeof run.fontWeight === "string" ? parseInt(run.fontWeight, 10) || 400 : run.fontWeight,
    fontStyle: run.fontStyle === "italic" ? "italic" : undefined,
    lineHeight: run.lineHeight,
    letterSpacing: run.letterSpacing
  };
}

/**
 * A user-perceived character, as an array.
 *
 * `slice(0, n)` counts UTF-16 code units, so a binary search over it can land
 * between the two halves of a surrogate pair or inside a ZWJ sequence — and the
 * clip then ships a lone surrogate, which is not a character at all and renders
 * as a replacement glyph. Segmentation is what the eye counts in.
 *
 * `Intl.Segmenter` is the only thing that knows; the `Array.from` fallback is
 * code points, which at least never splits a pair.
 */
let graphemeSegmenter: { segment(s: string): Iterable<{ segment: string }> } | null | undefined;

function graphemes(text: string): string[] {
  if (graphemeSegmenter === undefined) {
    const Segmenter = (Intl as { Segmenter?: new (l?: string, o?: object) => any }).Segmenter;
    graphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (g: any) => g.segment);
  return Array.from(text);
}

/** The widest prefix of `text` whose width still leaves room for `suffix`. */
function clipToWidth(text: string, maxWidth: number, spec: TextMeasureSpec, suffix: string): string {
  if (measureText(text + suffix, spec, Infinity).width <= maxWidth) return text;
  const chars = graphemes(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(chars.slice(0, mid).join("") + suffix, spec, Infinity).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("").replace(/\s+$/, "");
}

/**
 * `maxLines` applied to the wrapped lines.
 *
 * `1` is not simply "keep the first line": the canvas reaches it through
 * `white-space: nowrap`, which also turns the newlines that survived
 * `white-space: pre-line` into spaces. Taking the first line alone would paint a
 * run that ends where the canvas one continues.
 */
function applyLineClamp(lines: string[], content: string, run: TextLayoutInput, spec: TextMeasureSpec): string[] {
  const maxLines = run.maxLines;
  if (!maxLines || maxLines <= 0) return lines;

  let kept = maxLines === 1
    ? [applyTextTransform(content, run.textTransform).replace(/\s+/g, " ").trim()]
    : lines.slice(0, maxLines);
  if (run.textOverflow !== "ellipsis" || kept.length === 0) return kept;

  const last = kept.length - 1;
  // Only the line the clamp actually cut: an ellipsis on text that fit would
  // claim something was dropped when nothing was.
  const cut =
    Number.isFinite(run.width) &&
    run.width > 0 &&
    (maxLines === 1
      ? measureText(kept[last], spec, Infinity).width > run.width
      : lines.length > maxLines);
  if (cut) {
    kept = kept.slice();
    kept[last] = clipToWidth(kept[last], Math.max(0, run.width), spec, "\u2026") + "\u2026";
  }
  return kept;
}

/**
 * The scripts that break BETWEEN characters rather than at a space.
 *
 * `white-space: pre-line` plus the browser's own line breaking gives a break
 * opportunity between two CJK ideographs, kana, hangul syllables, fullwidth
 * forms — and between one of those and a CJK punctuation mark, which is why the
 * punctuation is in the class rather than left to ride on the word before it.
 *
 * This module only ever broke at whitespace, so a Chinese paragraph arrived in
 * the export as a single line running out of its box while the canvas had
 * wrapped it. ASCII punctuation is deliberately NOT here: it attaches to the
 * Latin word it belongs to, exactly as it did before.
 */
const CJK = /[\u1100-\u11ff\u2e80-\u303f\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97c\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff01-\uff60\uffe0-\uffe6]/;

/** A character that may not BEGIN a line — the marks that belong to the one before it. */
const NO_LINE_START = /[。，、．：；！？…—～）〕］｝〉》」』】〗｠｣・ーゝゞ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ%‰°′″℃]/;

/** A character that may not END a line — the openers that would orphan what follows. */
const NO_LINE_END = /[（〔［｛〈《「『【〖｟｢‘“]/;

/**
 * The units a line may be broken between.
 *
 * Whitespace runs and Latin words behave exactly as `split(/(\s+)/)` did, so the
 * Latin answer is unchanged; each CJK character becomes its own unit, which is
 * the break opportunity the browser gives it. Code POINTS, not code units, so a
 * surrogate pair is never the thing being weighed.
 */
function breakTokens(paragraph: string): string[] {
  const out: string[] = [];
  let word = "";
  let space = "";
  const flushWord = () => { if (word) { out.push(word); word = ""; } };
  const flushSpace = () => { if (space) { out.push(space); space = ""; } };
  for (const ch of paragraph) {
    if (/\s/.test(ch)) {
      flushWord();
      space += ch;
    } else if (CJK.test(ch)) {
      flushWord();
      flushSpace();
      out.push(ch);
    } else {
      flushSpace();
      word += ch;
    }
  }
  flushWord();
  flushSpace();
  return out;
}

/**
 * `white-space: pre-line` plus word wrapping, as the browser does it: an
 * explicit newline is a hard break, runs of whitespace collapse, a break is
 * allowed at a space, and between two CJK characters.
 *
 * The two kinsoku (line-break prohibition) rules are the ones the browser applies and this module could not:
 * a closing mark or a comma must not be pushed to the start of a line, and an
 * opening bracket must not be left at the end of one. Rather than move the mark
 * the box is allowed to overflow by the one glyph — which is what the browser
 * does too (hanging punctuation), and it keeps the break points equal.
 *
 * Both are checked ONLY for a single CJK character, so the Latin breaks stay
 * exactly where they were: a browser happily starts a line with ",world", and a
 * rule that refused to would move the very break this module exists to match.
 */
function wrapLines(run: TextLayoutInput, spec: TextMeasureSpec): string[] {
  const lines: string[] = [];
  for (const paragraph of applyTextTransform(run.content, run.textTransform).split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const maxWidth = run.width;
    if (
      measureText(paragraph, spec, Infinity).width <= maxWidth ||
      !Number.isFinite(maxWidth) ||
      maxWidth <= 0
    ) {
      lines.push(paragraph);
      continue;
    }
    let currentLine = "";
    for (const token of breakTokens(paragraph)) {
      const testLine = currentLine + token;
      if (measureText(testLine, spec, Infinity).width > maxWidth && currentLine.length > 0) {
        const single = token.length === 1 && CJK.test(token);
        const hangs = single && (NO_LINE_START.test(token) || NO_LINE_END.test(currentLine.slice(-1)));
        if (hangs) {
          currentLine = testLine;
          continue;
        }
        lines.push(currentLine);
        currentLine = token.trimStart();
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return applyLineClamp(lines, run.content, run, spec);
}

export function layoutTextRun(run: TextLayoutInput): TextLayout {
  const spec = specOf(run);
  const lines = wrapLines(run, spec);

  const totalHeight = lines.length * run.lineHeight;
  let startY = run.y;
  if (run.verticalAlign === "middle") {
    startY = run.y + Math.max(0, (run.height - totalHeight) / 2);
  } else if (run.verticalAlign === "bottom") {
    startY = run.y + Math.max(0, run.height - totalHeight);
  }

  let textAnchor: TextLayout["textAnchor"] = "start";
  let startX = run.x;
  if (run.align === "center") {
    textAnchor = "middle";
    startX = run.x + run.width / 2;
  } else if (run.align === "right") {
    textAnchor = "end";
    startX = run.x + run.width;
  }

  /**
   * `text-align: justify` in SVG, which has no keyword for it.
   *
   * `textLength` + `lengthAdjust="spacing"` stretches the gaps between glyphs so
   * the run occupies exactly the box — the same thing CSS justify does, and the
   * reason it is only ever applied to lines that are NOT the last: a final line
   * is left ragged in both models. It also replaces the anchor, since a
   * stretched line is pinned to both edges rather than to one.
   */
  const justified = (idx: number): boolean =>
    run.align === "justify" && lines.length > 1 && idx < lines.length - 1 && Boolean(lines[idx]);

  const placement = (idx: number): LinePlacement => {
    const out: LinePlacement = {
      x: run.align === "justify" ? run.x : startX,
      dy: idx === 0 ? "0" : `${run.lineHeight}px`
    };
    if (justified(idx) && run.width > 0) {
      out.textLength = run.width;
      out.lengthAdjust = "spacing";
    }
    return out;
  };

  return {
    lines,
    startX,
    startY,
    baselineOffset: baselineOffsetOf(spec),
    textAnchor,
    lineHeight: run.lineHeight,
    placement
  };
}
