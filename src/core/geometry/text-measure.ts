/**
 * Offscreen text metrics.
 *
 * This module is the ONE place in `core/` that touches the DOM. The architecture
 * invariant is zero DOM coupling for `core/` (ARCHITECTURE.md §2) so the compiler
 * stays runnable in a worker, in Node and in tests; a real font measurement is
 * impossible without a layout engine, so the exception lives here behind
 * `setTextMeasurer()` and everything else keeps depending on `measureText()`
 * rather than on `document`.
 *
 * Without a DOM (Node, vitest, SSR) the analytic fallback runs instead — same
 * contract, ~0.6em per glyph, so tests get deterministic numbers rather than a
 * crash.
 */

import { resolveStack } from "../font-stack";

export interface TextMeasureSpan {
  text: string;
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number | "normal" | "bold";
    fontStyle?: "normal" | "italic";
    lineHeight?: number;
    letterSpacing?: number;
  };
}

export interface TextMeasureSpec {
  fontFamily: string;
  fontSize: number;
  fontWeight: number | "normal" | "bold";
  /**
   * Italic is a WIDTH, not a paint: the slanted face has its own advances, so a
   * spec that omits it measures an italic run with roman metrics and every box,
   * every wrap point and every centre derived from that number is off. It was
   * omitted from the spec, the cache key and the probe at once, so the wrong
   * number was also the CACHED number.
   */
  fontStyle?: "normal" | "italic";
  /**
   * The casing the glyphs are PAINTED in. The canvas reaches it through CSS, so
   * the source string it holds is unchanged — but a measurement of the source
   * string is a measurement of text nobody is looking at. Uppercase is wider
   * than the lowercase it replaced, and a box measured on the raw string wraps
   * at a different word than the canvas does.
   */
  textTransform?: string;
  /** Line height in PX, already resolved by `resolveDynamicLineHeight`. */
  lineHeight: number;
  letterSpacing: number;
  /**
   * How many lines the box will actually show.
   *
   * It belongs in the METRICS, not only in the renderer: a box measured for
   * three lines while it paints one is the layout reserving room for text nobody
   * can see, and it is how a clamped label ends up with the space of a paragraph.
   * The width is untouched by it — see `measureText`.
   */
  maxLines?: number;
  spans?: TextMeasureSpan[];
}

export interface TextMetrics {
  /** Used width, i.e. `min(max-content, availableWidth)`. */
  width: number;
  height: number;
  lines: number;
}

export type TextMeasurer = (
  content: string,
  spec: TextMeasureSpec,
  availableWidth: number
) => TextMetrics;

const CACHE_LIMIT = 4000;
const cache = new Map<string, TextMetrics>();
let injected: TextMeasurer | null = null;

/**
 * What the glyphs look like once `text-transform` has been applied.
 *
 * The canvas lets the browser do it and keeps the source string intact; every
 * other consumer has to bake it in, because anything that measures the string —
 * the box, the wrap, the export — measures characters, and uppercase characters
 * are not the ones in `content`.
 *
 * `capitalize` upper-cases the first letter of each WORD, which is what CSS does
 * and not what a naive first-letter pass does — see `capitalizeWords`, whose rule
 * was measured against the engine rather than assumed.
 *
 * It lives here rather than next to the layout that first needed it because the
 * MEASUREMENT needs it too, and `text-layout` imports this module — the other
 * direction would be a cycle.
 */
export function applyTextTransform(text: string, transform: string | undefined): string {
  switch (transform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return capitalizeWords(text);
    default:
      return text;
  }
}

/**
 * The first letter of every word, uppercased — the browser's own rule.
 *
 * The regex this replaced (`(^|\s)(\S)`) split on whitespace only, so
 * `well-known` was baked as `Well-Known` for the export while the canvas painted
 * `Well-Known`, and `"quoted"` got its quote upper-cased instead of the letter
 * inside it. The answer is not a better guess but the browser's: the function
 * below reproduced Chromium's `text-transform: capitalize` on 24/24 samples
 * (`well-known`, `"quoted speech"`, `don't`, `3rd place`, `100% sure`,
 * `hello.world`, `e.g. this`, `a/b test`, Cyrillic, full-width digits, the ﬁ
 * ligature, ß, astral Deseret letters).
 *
 * The rule, as measured:
 *  - a letter is uppercased when the character BEFORE it is not a letter, a
 *    digit or an apostrophe — which is why `3rd` keeps its `r` and `don't` keeps
 *    its `t`, while `well-known`, `e.g.` and `hello.world` all start new words;
 *  - a mapping that changes the CODE-POINT COUNT is not applied: `ﬁ` → `FI` and
 *    `ß` → `SS` are left as they are;
 *  - astral letters are left alone (measured; the engine's capitalize is BMP).
 *
 * `Intl.Segmenter` was tried first and is not this rule — it disagreed on four
 * of the same samples.
 */
function capitalizeWords(text: string): string {
  let atWordStart = true;
  let out = "";
  for (const ch of text) {
    let painted = ch;
    if (atWordStart && ch.length === 1 && LETTER_RE.test(ch)) {
      const upper = ch.toUpperCase();
      if (upper.length === 1) painted = upper;
    }
    out += painted;
    atWordStart = !CONTINUES_WORD_RE.test(ch);
  }
  return out;
}

const LETTER_RE = /\p{L}/u;
/** What keeps a word going: a letter, a digit, or either apostrophe. */
const CONTINUES_WORD_RE = /[\p{L}\p{N}'\u2019]/u;

/**
 * How far the DRAWN line has to move for its ink to sit where `align` says.
 *
 * CSS `letter-spacing` is applied after EVERY character, the last one included,
 * so the box the browser reserves for a line is exactly one tracking wider than
 * the ink in it. Measured in Chromium: `"Hello"` at 24px with `letter-spacing:
 * 4px` is 74.703px wide, and the same string is 54.703px at `letter-spacing: 0`
 * — 54.703 + 5 × 4, not 54.703 + 4 × 4. SVG's `getComputedTextLength()` returns
 * the same 74.703, so the canvas and the export already agree with each other;
 * what they both get wrong is the ALIGNMENT, which is computed against that
 * reserved box while the ink stops one tracking short of its right edge. Centred
 * text therefore paints half a tracking left of the box's centre and right-aligned
 * text a whole tracking short of its right edge.
 *
 * The box itself is NOT the thing to fix. Shrinking it to the ink width makes
 * the browser wrap early — measured, `"Hello world"` at 158.7px (ink width) laid
 * out as two lines where the reserved 162.7px box laid out as one. So the box
 * stays the browser's, and the drawn line moves instead.
 */
export function trailingTrackingShift(
  align: string | undefined,
  letterSpacing: number | undefined
): number {
  const tracking = Number(letterSpacing) || 0;
  if (!tracking) return 0;
  if (align === "center") return tracking / 2;
  if (align === "right" || align === "end") return tracking;
  // Left-aligned ink already starts where the line box starts, and justified
  // text is stretched to fill the reserved box on purpose.
  return 0;
}

/**
 * Where one line's glyphs start, given the box and the width the browser reports
 * for that line.
 *
 * The export half of the same rule: an outlined glyph is placed by a number the
 * canvas never computes, so if the two disagree the exported design is not the
 * design. Written once, here, so `outline-text` and the canvas cannot drift —
 * and testable without a font file, which the export path needs and a test rig
 * does not have.
 */
export function alignLineLeft(
  boxX: number,
  boxWidth: number,
  lineWidth: number,
  align: string | undefined,
  letterSpacing: number | undefined
): number {
  const start = boxX + trailingTrackingShift(align, letterSpacing);
  if (align === "center") return start + (boxWidth - lineWidth) / 2;
  if (align === "right" || align === "end") return start + boxWidth - lineWidth;
  return start;
}

/**
 * The document's own precision. Whole pixels were wrong here for the same reason they
 * were wrong in the layout pass: a measured size is written straight into the document,
 * and the Scale tool reads it back as the box it scales. A frame at 27.6px measured as
 * 28 means growing the design to full size reads 280 off that 28, and the frame ends up
 * wider than the parent holding it. Rounding to the precision every other writer uses
 * keeps a scale reversible; the sub-pixel residue it leaves is smaller than a device
 * pixel at any zoom this renders at.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Test/shell seam: replaces the measurer, or restores the default with `null`. */
export function setTextMeasurer(next: TextMeasurer | null): void {
  injected = next;
  cache.clear();
}

export function clearTextMeasureCache(): void {
  cache.clear();
}

/**
 * The spec with every family completed into a real stack (see `resolveStack`).
 *
 * Returns the SAME object when nothing changes, because this runs on every
 * measurement and the common case — a stack that already names its fallback, or
 * a single family that resolves to `"<family>, system-ui, sans-serif"` the second
 * time — must not allocate on the hot path.
 */
function withResolvedFamilies(spec: TextMeasureSpec): TextMeasureSpec {
  const fontFamily = resolveStack(spec.fontFamily);
  const spans = spec.spans;
  let nextSpans: TextMeasureSpan[] | undefined;
  if (spans && spans.length > 0) {
    for (let i = 0; i < spans.length; i++) {
      const family = spans[i].style?.fontFamily;
      if (!family) continue;
      const resolved = resolveStack(family);
      if (resolved === family) continue;
      nextSpans = nextSpans ?? spans.slice();
      nextSpans[i] = { ...spans[i], style: { ...spans[i].style, fontFamily: resolved } };
    }
  }
  if (fontFamily === spec.fontFamily && !nextSpans) return spec;
  return { ...spec, fontFamily, ...(nextSpans ? { spans: nextSpans } : {}) };
}

/**
 * Lays `content` out in a box at most `availableWidth` wide (pass `Infinity` for
 * the never-wrapping `max-content` case) and returns the size it occupies.
 */
export function measureText(
  content: string,
  rawSpec: TextMeasureSpec,
  availableWidth: number = Infinity
): TextMetrics {
  // The stack is completed HERE, on the way in, so the cache key already carries
  // the families the measurement will actually use: resolving later (in the DOM
  // write) would file the answer under the bare name and hand it to a different
  // stack the moment the author changes the fallback.
  const spec = withResolvedFamilies(rawSpec);
  // The width is measured exactly as it would be without a clamp: `maxLines` is
  // about how many lines SHOW, not about how wide the box may be. Deriving the
  // width from "one line, never wrap" instead made a `fit-content` clamp measure
  // at its intrinsic width and overflow the parent that was holding it.
  const box = availableWidth;
  // The casing is baked in BEFORE the key, so two strings that paint the same
  // glyphs share one measurement — which is what makes the cache agree with the
  // painted box instead of with the stored string.
  const text = applyTextTransform(content, spec.textTransform);
  const key = cacheKey(text, spec, box);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return clampLines(hit, spec);
  }
  const metrics = (injected ?? defaultMeasurer)(text, spec, box);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  // The RAW measurement is what is cached, and the clamp is applied on the way
  // out: a clamp is a fact about the element, not about the text, so two elements
  // may share the measurement and differ in how much of it they show.
  cache.set(key, metrics);
  return clampLines(metrics, spec);
}

function clampLines(metrics: TextMetrics, spec: TextMeasureSpec): TextMetrics {
  const maxLines = spec.maxLines;
  if (maxLines === undefined || maxLines <= 0) return metrics;
  const height = Math.min(metrics.height, round2(maxLines * spec.lineHeight));
  return height === metrics.height
    ? metrics
    : { width: metrics.width, height, lines: Math.min(metrics.lines, maxLines) };
}

function cacheKey(content: string, spec: TextMeasureSpec, availableWidth: number): string {
  const box = Number.isFinite(availableWidth) ? round2(availableWidth) : "inf";
  // Every key a run can override has to be in here. It is a cache of the
  // MEASUREMENT, so two runs that differ only by a key the key omits are handed
  // the same box — the classic shape of "the paint and the layout disagree".
  // `fontStyle` is the one that was missing and it is not cosmetic: the italic
  // face has different advances, so its absence handed an italic run the roman
  // measurement of a roman neighbour.
  const spansKey = spec.spans && spec.spans.length > 0
    ? spec.spans
        .map((s) => `${s.text}:${s.style?.fontFamily || ""},${s.style?.fontSize || ""},${s.style?.fontWeight || ""},${s.style?.fontStyle || ""},${s.style?.letterSpacing ?? ""}`)
        .join(";")
    : "";
  return `${spec.fontFamily}|${spec.fontSize}|${spec.fontWeight}|${spec.fontStyle || ""}|${spec.lineHeight}|${spec.letterSpacing}|${box}|${content}|${spansKey}`;
}

function defaultMeasurer(content: string, spec: TextMeasureSpec, availableWidth: number): TextMetrics {
  if (typeof document === "undefined") return estimate(content, spec, availableWidth);
  try {
    return measureInDom(content, spec, availableWidth);
  } catch {
    return estimate(content, spec, availableWidth);
  }
}

let measureEl: HTMLDivElement | null = null;
let fontWatchAttached = false;

function ensureMeasureElement(): HTMLDivElement {
  if (measureEl && measureEl.isConnected) return measureEl;
  const el = document.createElement("div");
  const style = el.style;
  style.position = "absolute";
  style.left = "-10000px";
  style.top = "0";
  style.visibility = "hidden";
  style.pointerEvents = "none";
  style.margin = "0";
  style.padding = "0";
  style.border = "0";
  style.boxSizing = "content-box";
  // Must mirror SvgElementRenderer's text <div> exactly, or the measured box
  // and the painted box disagree.
  style.whiteSpace = "pre-line";
  style.wordBreak = "normal";
  style.overflowWrap = "normal";
  document.body.appendChild(el);
  measureEl = el;

  if (!fontWatchAttached && document.fonts?.ready) {
    fontWatchAttached = true;
    // Metrics taken before a webfont loads are wrong for that font; drop them.
    document.fonts.ready.then(() => clearTextMeasureCache()).catch(() => {});
    // `ready` resolves once and only once, so a font that arrives LATER — a
    // custom family the document declares, a face the browser only fetches when
    // it first needs it — left its fallback metrics cached for the rest of the
    // session. Every further load has to drop them too.
    document.fonts.addEventListener?.("loadingdone", () => clearTextMeasureCache());
  }
  return el;
}

function measureInDom(content: string, spec: TextMeasureSpec, availableWidth: number): TextMetrics {
  const el = ensureMeasureElement();
  const style = el.style;
  style.fontFamily = spec.fontFamily;
  style.fontSize = `${spec.fontSize}px`;
  style.fontWeight = String(spec.fontWeight);
  style.fontStyle = spec.fontStyle || "normal";
  style.lineHeight = `${spec.lineHeight}px`;
  style.letterSpacing = spec.letterSpacing ? `${spec.letterSpacing}px` : "normal";

  // If rich spans exist, build equivalent child spans in DOM
  if (spec.spans && spec.spans.length > 0) {
    el.textContent = "";
    for (const span of spec.spans) {
      const s = document.createElement("span");
      // The container carries no `text-transform` (the string is baked instead),
      // so a run has to be cased here or it would measure its raw characters
      // while the canvas paints it cased.
      s.textContent = applyTextTransform(span.text, spec.textTransform);
      if (span.style?.fontSize) s.style.fontSize = `${span.style.fontSize}px`;
      if (span.style?.fontWeight) s.style.fontWeight = String(span.style.fontWeight);
      if (span.style?.fontFamily) s.style.fontFamily = span.style.fontFamily;
      if (span.style?.fontStyle) s.style.fontStyle = span.style.fontStyle;
      // `!== undefined`: a run that asks for `0` must measure with none of the
      // parent's tracking, not inherit the tracking it refused.
      if (span.style?.letterSpacing !== undefined) s.style.letterSpacing = `${span.style.letterSpacing}px`;
      el.appendChild(s);
    }
  } else {
    el.textContent = content;
  }

  style.width = "max-content";
  const intrinsic = el.getBoundingClientRect();
  const intrinsicWidth = intrinsic.width;
  const intrinsicHeight = intrinsic.height;

  if (!Number.isFinite(availableWidth) || availableWidth <= 0 || availableWidth >= intrinsicWidth) {
    return metricsOf(intrinsicWidth, intrinsicHeight, spec.lineHeight);
  }

  style.width = `${availableWidth}px`;
  const wrapped = el.getBoundingClientRect();
  return metricsOf(availableWidth, wrapped.height, spec.lineHeight);
}

function metricsOf(width: number, height: number, lineHeight: number): TextMetrics {
  return {
    width: round2(width),
    height: round2(height),
    // A COUNT, so it stays whole: it is how many lines were laid out, and a
    // fractional line count is not a thing.
    lines: Math.max(1, Math.round(height / Math.max(1, lineHeight)))
  };
}

function estimate(content: string, spec: TextMeasureSpec, availableWidth: number): TextMetrics {
  let effectiveLineHeight = spec.lineHeight;
  let intrinsicWidth = 0;
  let lines = 0;

  if (spec.spans && spec.spans.length > 0) {
    let currentLineWidth = 0;
    let spanLines = 1;
    for (const span of spec.spans) {
      const spanSize = span.style?.fontSize || spec.fontSize;
      if (span.style?.fontSize) {
        effectiveLineHeight = Math.max(effectiveLineHeight, span.style.fontSize * 1.25);
      }
      const advance = spanSize * 0.6 + (span.style?.letterSpacing ?? spec.letterSpacing);
      const parts = span.text.split("\n");
      for (let pIdx = 0; pIdx < parts.length; pIdx++) {
        if (pIdx > 0) {
          intrinsicWidth = Math.max(intrinsicWidth, currentLineWidth);
          currentLineWidth = 0;
          spanLines++;
        }
        currentLineWidth += parts[pIdx].length * advance;
      }
    }
    intrinsicWidth = Math.max(intrinsicWidth, currentLineWidth);
    lines = spanLines;
  } else {
    const advance = spec.fontSize * 0.6 + spec.letterSpacing;
    const paragraphs = content.split("\n");
    for (const paragraph of paragraphs) {
      const width = paragraph.length * advance;
      intrinsicWidth = Math.max(intrinsicWidth, width);
      lines += Number.isFinite(availableWidth) && availableWidth > 0
        ? Math.max(1, Math.ceil(width / availableWidth))
        : 1;
    }
  }

  const width = Number.isFinite(availableWidth) && availableWidth > 0
    ? Math.min(intrinsicWidth, availableWidth)
    : intrinsicWidth;
  return {
    width: round2(width),
    height: round2(lines * effectiveLineHeight),
    lines
  };
}

/**
 * Where each character of one line actually sits, and where its baseline is.
 *
 * Horizontal positions come from an SVG `<text>` node's `getStartPositionOfChar`
 * rather than from a font's advance widths. Measured across five system fonts,
 * that agrees with the rendered line to 0.00px — while the same font's own
 * kerning disagreed by up to 5.5px on Arial, whose kerning lives in a macOS AAT
 * table that no font library here reads. The browser is the only authority on
 * where it drew the glyphs.
 *
 * The baseline is the other half, and it is arithmetic rather than measurement:
 * an HTML line box puts the baseline at `half-leading + ascent`. The two font
 * metrics are asked of the canvas so that whatever the platform resolved the
 * family to is what gets used.
 */
export interface GlyphPositionSpec {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number | "normal" | "bold";
  fontStyle?: string;
  letterSpacing: number;
  /** Line height in px, already resolved by `resolveDynamicLineHeight`. */
  lineHeight: number;
}

export interface GlyphPositions {
  /** Pen x of each character, relative to the line's left edge. */
  xs: number[];
  /** Advance width of the whole line. */
  width: number;
  /** Distance from the top of the line box down to the baseline. */
  baselineOffset: number;
}

export function measureGlyphPositions(rawSpec: GlyphPositionSpec): GlyphPositions {
  // Same rule as `measureText`: the stack is completed before anything measures,
  // or these pen positions describe a different face than the one painted.
  const fontFamily = resolveStack(rawSpec.fontFamily);
  const spec = fontFamily === rawSpec.fontFamily ? rawSpec : { ...rawSpec, fontFamily };
  if (typeof document === "undefined") return estimateGlyphPositions(spec);
  try {
    return measureGlyphPositionsInDom(spec);
  } catch {
    return estimateGlyphPositions(spec);
  }
}

let positionText: SVGTextElement | null = null;
let measureCanvas: HTMLCanvasElement | null = null;

function ensurePositionText(): SVGTextElement {
  if (positionText && positionText.isConnected) return positionText;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "2000");
  svg.setAttribute("height", "400");
  svg.style.position = "absolute";
  svg.style.left = "-10000px";
  svg.style.top = "0";
  svg.style.visibility = "hidden";
  svg.style.pointerEvents = "none";
  const text = document.createElementNS(ns, "text");
  text.setAttribute("x", "0");
  text.setAttribute("y", "0");
  text.setAttribute("text-anchor", "start");
  svg.appendChild(text);
  document.body.appendChild(svg);
  positionText = text;
  return text;
}

function ensureMeasureContext(): CanvasRenderingContext2D {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  return context;
}

function cssFont(spec: FontSpec): string {
  // Completed here as well as in `measureText`: the canvas `font` shorthand takes
  // a stack, and the ascent/descent this asks for has to come from the face the
  // line box will actually be set in.
  return `${spec.fontStyle ?? "normal"} ${spec.fontWeight} ${spec.fontSize}px ${resolveStack(spec.fontFamily)}`;
}

function measureGlyphPositionsInDom(spec: GlyphPositionSpec): GlyphPositions {
  const text = ensurePositionText();
  text.setAttribute("font-family", spec.fontFamily);
  text.setAttribute("font-size", `${spec.fontSize}px`);
  text.setAttribute("font-weight", String(spec.fontWeight));
  if (spec.fontStyle) text.setAttribute("font-style", spec.fontStyle);
  else text.removeAttribute("font-style");
  text.setAttribute("letter-spacing", spec.letterSpacing ? `${spec.letterSpacing}px` : "normal");
  text.textContent = spec.text;

  const xs: number[] = [];
  if (typeof text.getStartPositionOfChar === "function") {
    for (let i = 0; i < spec.text.length; i++) xs.push(text.getStartPositionOfChar(i).x);
  } else {
    // No per-character API (Firefox today): prefix widths are the closest thing,
    // and they lose kerning between the prefix and the next character.
    const context = ensureMeasureContext();
    context.font = cssFont(spec);
    for (let i = 0; i < spec.text.length; i++) xs.push(context.measureText(spec.text.slice(0, i)).width);
  }

  return { xs, width: text.getComputedTextLength(), baselineOffset: baselineOffsetOf(spec) };
}

/**
 * Which face to ask about. Deliberately NOT all of `GlyphPositionSpec`: the
 * font's metrics and its place in the line box are properties of the face and the
 * line height, so a caller that has no string yet — the exporter laying out a
 * paragraph before it knows how it wraps, or the importer reading a box the
 * browser already computed — can still ask.
 */
export type FontSpec = Pick<GlyphPositionSpec, "fontFamily" | "fontSize" | "fontWeight" | "fontStyle">;

/** A face plus the line height it is being placed in. */
export type BaselineSpec = FontSpec & { lineHeight: number };

/**
 * The font's own ascent and descent, as this platform resolved the family.
 *
 * `fontBoundingBoxAscent`/`Descent` come back ROUNDED to whole pixels — at 6px a
 * font whose real ascent is 5.5 reports 6 — so a caller deriving a baseline from
 * them is up to half a pixel out at small sizes and exact at the sizes a UI
 * actually uses. The analytic 0.8/0.2 estimate stands in when there is no DOM.
 */
export function fontMetricsOf(spec: FontSpec): { ascent: number; descent: number } {
  let ascent = spec.fontSize * 0.8;
  let descent = spec.fontSize * 0.2;
  try {
    const context = ensureMeasureContext();
    context.font = cssFont(spec);
    const metrics = context.measureText("H");
    if (typeof metrics.fontBoundingBoxAscent === "number") ascent = metrics.fontBoundingBoxAscent;
    if (typeof metrics.fontBoundingBoxDescent === "number") descent = metrics.fontBoundingBoxDescent;
  } catch {
    /* keep the 0.8/0.2 estimate */
  }
  return { ascent, descent };
}

/**
 * Distance from the top of a line box down to its baseline.
 *
 * The model is HTML's: the font's own ascent/descent sit centred in the line
 * height, so half of whatever leading is left over goes above. SVG `<text>`
 * places `y` on the BASELINE, which is why anyone writing it needs this number —
 * `dominant-baseline="hanging"` is a different point on the line (0.8×ascent
 * below the top) and substituting it is what lifted every exported run by
 * ~0.26em.
 *
 * Answers from the analytic 0.8/0.2 estimate when there is no DOM, the same
 * fallback `estimateGlyphPositions` uses, so Node and the browser agree in shape.
 */
export function baselineOffsetOf(spec: BaselineSpec): number {
  const { ascent, descent } = fontMetricsOf(spec);
  return (spec.lineHeight - (ascent + descent)) / 2 + ascent;
}

function estimateGlyphPositions(spec: GlyphPositionSpec): GlyphPositions {
  const advance = spec.fontSize * 0.6 + spec.letterSpacing;
  const ascent = spec.fontSize * 0.8;
  const descent = spec.fontSize * 0.2;
  return {
    xs: Array.from({ length: spec.text.length }, (_, i) => i * advance),
    width: spec.text.length * advance,
    baselineOffset: (spec.lineHeight - (ascent + descent)) / 2 + ascent
  };
}
