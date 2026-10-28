import { TextElement, TextSpan } from "../dsl/types";
import type { TextDecorationLine } from "../dsl/types";
import {
  effectiveDecoration,
  hasDecoration,
  normalizeTextDecoration,
  toggledDecoration
} from "../dsl/text-decoration";
import { resolveTextSizing, textSpec } from "../layout/text-sizing";
import { measureText } from "../geometry/text-measure";

export interface SpanRange {
  start: number;
  end: number;
}

/**
 * The style keys a run may carry.
 *
 * `fontStyle` was missing from this list while the type, the normalizer, both
 * painters and the export all carried it — so a run authored italic in the file
 * survived a load, but marking a selection italic in the inspector wrote the key
 * and this function dropped it on the way out. The button did nothing, with no
 * repair to say why, and the gap was invisible from the outside because the
 * element-level `fontStyle` went down a different path.
 *
 * `fontStyle: "normal"` and an empty `textDecoration` are VALUES here, not the
 * absence of one: they are how a run inside an italic or underlined paragraph
 * says it is neither.
 */
function cleanSpanStyle(style: NonNullable<TextSpan["style"]>): NonNullable<TextSpan["style"]> {
  const out: NonNullable<TextSpan["style"]> = {};
  if (style.fontFamily) out.fontFamily = style.fontFamily;
  if (style.fontSize) out.fontSize = style.fontSize;
  if (style.fontWeight) out.fontWeight = style.fontWeight;
  if (style.fontStyle) out.fontStyle = style.fontStyle;
  // `!== undefined`, not truthiness: `0` is a value here — "no extra tracking",
  // against a paragraph that sets some. A truthiness test would silently drop it
  // and the run would inherit the paragraph's spacing it was meant to refuse.
  if (style.letterSpacing !== undefined) out.letterSpacing = style.letterSpacing;
  if (style.color) out.color = style.color;
  if (style.textDecoration) {
    // Canonical order, enforced at the one place every rebuilt run passes through.
    // The list IS the value, so a caller that spelled the lines the other way round
    // must not produce a second, unequal spelling of the same style — it would be
    // kept as a separate run by the compactor below and split the text for nothing.
    // The load path canonicalizes too; this is the edit path, and neither may be
    // the only one that does.
    out.textDecoration = normalizeTextDecoration(style.textDecoration, { keepEmpty: true });
  }
  return out;
}

/**
 * Two runs are one run when every style key agrees, INCLUDING the two that used to
 * be left out of the comparison.
 *
 * `fontStyle` was not compared, so italicising a range that sat between two runs
 * of the same family/size/weight/colour merged all three — and the italic
 * disappeared the moment the document was written, which reads as "the button
 * worked, then undid itself". `textDecoration` was compared as a string, which was
 * fine while it was one; as a list it needs an element-wise comparison, and the
 * order is already canonical (`DECORATION_LINES`), so equality is positional.
 */
function isSameSpanStyle(
  s1?: TextSpan["style"],
  s2?: TextSpan["style"]
): boolean {
  if (!s1 && !s2) return true;
  if (!s1 || !s2) return false;
  return (
    s1.fontFamily === s2.fontFamily &&
    s1.fontSize === s2.fontSize &&
    s1.fontWeight === s2.fontWeight &&
    s1.fontStyle === s2.fontStyle &&
    s1.letterSpacing === s2.letterSpacing &&
    s1.color === s2.color &&
    sameDecoration(s1.textDecoration, s2.textDecoration)
  );
}

function sameDecoration(a?: TextDecorationLine[], b?: TextDecorationLine[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function clampRange(el: TextElement, range: SpanRange): SpanRange {
  const length = (el.content || "").length;
  return {
    start: Math.max(0, Math.min(length, range.start)),
    end: Math.max(0, Math.min(length, range.end))
  };
}

/**
 * Splits the spans at the range's boundaries and rebuilds them with `resolve`
 * applied over the covered slices.
 *
 * Shared, because everything in this module has to agree about where the
 * boundaries fall. A setter and a reader that split differently cover different
 * characters, and the symptom is a toggle that reports one thing and writes
 * another — the state it shows is the state it read the second time.
 */
function rewriteSpanRange(
  el: TextElement,
  range: SpanRange,
  resolve: (
    existing: NonNullable<TextSpan["style"]>,
    covered: boolean
  ) => NonNullable<TextSpan["style"]>
): TextElement {
  const content = el.content || "";
  const { start, end } = clampRange(el, range);
  if (start >= end) return el;

  // 1. Deconstruct existing content into atomic character-level span assignments
  const baseSpans: TextSpan[] =
    el.spans && el.spans.length > 0 ? el.spans : [{ text: content, style: {} }];

  interface Interval {
    text: string;
    style?: TextSpan["style"];
    start: number;
    end: number;
  }

  let offset = 0;
  const intervals: Interval[] = [];
  for (const s of baseSpans) {
    const sLen = s.text.length;
    intervals.push({
      text: s.text,
      style: s.style ? { ...s.style } : undefined,
      start: offset,
      end: offset + sLen
    });
    offset += sLen;
  }

  // 2. Break intervals at `start` and `end` boundary points
  const points = Array.from(
    new Set([
      0,
      content.length,
      start,
      end,
      ...intervals.map((i) => i.start),
      ...intervals.map((i) => i.end)
    ])
  )
    .filter((p) => p >= 0 && p <= content.length)
    .sort((a, b) => a - b);

  const newSpans: TextSpan[] = [];
  for (let idx = 0; idx < points.length - 1; idx++) {
    const p1 = points[idx];
    const p2 = points[idx + 1];
    if (p1 === p2) continue;

    const sliceText = content.slice(p1, p2);
    const matched = intervals.find((i) => i.start <= p1 && i.end >= p2);
    const existing: NonNullable<TextSpan["style"]> = matched?.style ? { ...matched.style } : {};
    const cleanStyle = cleanSpanStyle(resolve(existing, p1 >= start && p2 <= end));

    newSpans.push(
      Object.keys(cleanStyle).length > 0 ? { text: sliceText, style: cleanStyle } : { text: sliceText }
    );
  }

  // 3. Compact adjacent spans that have identical styles
  const compacted: TextSpan[] = [];
  for (const span of newSpans) {
    const last = compacted[compacted.length - 1];
    if (last && isSameSpanStyle(last.style, span.style)) {
      last.text += span.text;
    } else {
      compacted.push({ ...span });
    }
  }

  return measureAfterSpanEdit(el, compacted);
}

/**
 * The box is re-measured after any run edit, because a run can change the metrics:
 * a larger `fontSize`, or bold where it was not. Re-resolving is what keeps the
 * element from reserving the height of a layout it no longer has.
 */
function measureAfterSpanEdit(el: TextElement, spans: TextSpan[]): TextElement {
  const updated: TextElement = { ...el, spans };
  const measured = measureText(updated.content, textSpec(updated.style, updated.spans), Infinity);
  const nextWidth = Math.max(updated.width, Math.ceil(measured.width));
  const nextHeight = Math.max(updated.height, Math.ceil(measured.height));
  return resolveTextSizing({ ...updated, width: nextWidth, height: nextHeight }, null);
}

/**
 * Splits the text element's existing spans (or synthesizes a single base span if empty)
 * and applies partial span style to the [start, end] character range.
 *
 * A key set to `undefined` in `partialStyle` is REMOVED from the covered runs
 * rather than written as undefined.
 */
export function applySpanStyleToRange(
  el: TextElement,
  range: SpanRange,
  partialStyle: NonNullable<TextSpan["style"]>
): TextElement {
  return rewriteSpanRange(el, range, (existing, covered) => {
    if (!covered) return existing;
    const next: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(partialStyle)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next as NonNullable<TextSpan["style"]>;
  });
}

/**
 * The style the run containing character `index` declares, or `undefined` when
 * that character carries no run of its own.
 *
 * The READ half of the range, next to the write half it has to agree with. A
 * panel that asks the element while the write goes to a run shows one thing and
 * produces another — and every panel that offers a run-scoped control needs the
 * same answer here, so it is asked once.
 */
export function spanStyleAt(el: TextElement, index: number): TextSpan["style"] {
  if (!el.spans || el.spans.length === 0) return undefined;
  if (index < 0) return undefined;
  let offset = 0;
  for (const span of el.spans) {
    if (index < offset + span.text.length) return span.style;
    offset += span.text.length;
  }
  return undefined;
}

/**
 * Whether every character in the range satisfies `holds`.
 *
 * The RANGE's state, not the first run's. An inspector toggle has to read as on
 * exactly when pressing it would turn the thing off, and "the first run is
 * italic" answers a different question — it answers it wrong for the ordinary case
 * of italicising a selection that is already half italic. A range with no runs at
 * all satisfies nothing: there is no written style there to hold.
 */
function rangeEvery(
  el: TextElement,
  range: SpanRange,
  holds: (style: TextSpan["style"]) => boolean
): boolean {
  const { start, end } = clampRange(el, range);
  if (start >= end) return false;

  // The same synthesis the writers do: a text with no runs is ONE run that
  // declares nothing, so its every character carries the element's own style. An
  // empty list here would answer "nothing holds" for a paragraph that is entirely
  // italic, and the toggle would then offer to turn italic ON for a selection that
  // already is — which is the same defect as reading only the first run.
  const spans: TextSpan[] =
    el.spans && el.spans.length > 0 ? el.spans : [{ text: el.content || "" }];

  let offset = 0;
  let covered = 0;
  for (const span of spans) {
    const from = Math.max(offset, start);
    const to = Math.min(offset + span.text.length, end);
    offset += span.text.length;
    if (from >= to) continue;
    covered += to - from;
    if (!holds(span.style)) return false;
  }
  return covered === end - start;
}

/** Whether every character in the range draws this line. */
export function spanRangeHasDecoration(
  el: TextElement,
  range: SpanRange,
  line: TextDecorationLine
): boolean {
  return rangeEvery(el, range, (style) =>
    hasDecoration(effectiveDecoration(style?.textDecoration, el.style?.textDecoration), line)
  );
}

/** Whether every character in the range is italic. */
export function spanRangeIsItalic(el: TextElement, range: SpanRange): boolean {
  return rangeEvery(el, range, (style) => (style?.fontStyle ?? el.style?.fontStyle) === "italic");
}

/**
 * Toggles ONE decoration line across a range, the way a word processor does: if
 * every covered character already carries the line it comes off, otherwise it goes
 * on everywhere in the range.
 *
 * A partial style cannot express this. `applySpanStyleToRange` replaces
 * `textDecoration` wholesale, so toggling a line on would have to restate the
 * other line — and a range that is half struck through would then have the
 * strikethrough spread onto the half that never had it. The "all of it" test is
 * also what makes the operation idempotent in the direction the user expects: on a
 * mixed range the first press ADDS.
 *
 * The empty list is written as `[]` and stays there. On a run that is a value —
 * "no lines here" — and it is the only way to take a line off part of a paragraph
 * that draws it. See `normalizeTextDecoration`.
 */
export function toggleSpanDecoration(
  el: TextElement,
  range: SpanRange,
  line: TextDecorationLine
): TextElement {
  const clamped = clampRange(el, range);
  if (clamped.start >= clamped.end) return el;
  const on = !spanRangeHasDecoration(el, clamped, line);
  return rewriteSpanRange(el, clamped, (existing, covered) =>
    covered
      ? { ...existing, textDecoration: toggledDecoration(existing.textDecoration, line, on) }
      : existing
  );
}

/**
 * The characters an edit replaced, in the coordinates of the text BEFORE it.
 *
 * `inserted` is not carried: it is whatever now sits between `start` and the
 * shifted tail, which is arithmetic rather than information. Knowing WHERE the
 * edit happened is the whole point — without it the reconciler has to guess from
 * the two strings, and a guess cannot tell "type a character after the second
 * `a` of `aaaa`" from "type one at the end".
 *
 * The editor reads it off `beforeinput`'s target ranges; nothing else can know
 * it, because by the time `input` fires the DOM has already moved.
 */
export interface TextEditRange {
  start: number;
  end: number;
}

interface Interval {
  text: string;
  style?: TextSpan["style"];
  start: number;
  end: number;
}

function intervalsOf(spans: TextSpan[]): Interval[] {
  const out: Interval[] = [];
  let offset = 0;
  for (const s of spans) {
    const len = s.text.length;
    out.push({
      text: s.text,
      style: s.style ? { ...s.style } : undefined,
      start: offset,
      end: offset + len
    });
    offset += len;
  }
  return out;
}

/** The style the run covering `index` declares, or `null` when no run covers it. */
function runStyleAt(intervals: Interval[], index: number): TextSpan["style"] | null {
  const iv = intervals.find((i) => i.start <= index && i.end > index);
  return iv ? iv.style : null;
}

/**
 * The longest common prefix and suffix, as the edit they imply.
 *
 * The fallback for a change nobody described: a programmatic content write, an
 * import, an IME composition. It is a guess and it says so — with repeated
 * characters several edits produce the same pair of strings, and this picks the
 * one that edits farthest right. The bounds (`suffix < oldLen - prefix`) are what
 * keep `end >= start`, and they are why the two loops cannot disagree about which
 * characters are in the middle.
 */
function deriveEdit(oldText: string, newContent: string): TextEditRange {
  let prefix = 0;
  while (
    prefix < oldText.length &&
    prefix < newContent.length &&
    oldText[prefix] === newContent[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newContent.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newContent[newContent.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { start: prefix, end: oldText.length - suffix };
}

function pushRun(
  out: TextSpan[],
  text: string,
  style: TextSpan["style"] | undefined
): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && isSameSpanStyle(last.style, style)) {
    last.text += text;
    return;
  }
  out.push({ text, style: style ? { ...style } : undefined });
}

/**
 * Copies the run structure covering old `[from, to)` into its new position,
 * `delta` code units to the right.
 */
function pushRunSlice(
  out: TextSpan[],
  newContent: string,
  from: number,
  to: number,
  intervals: Interval[],
  delta: number
): void {
  for (const iv of intervals) {
    const s = Math.max(from, iv.start);
    const e = Math.min(to, iv.end);
    if (s >= e) continue;
    pushRun(out, newContent.slice(s + delta, e + delta), iv.style);
  }
}

/**
 * The style freshly typed characters take.
 *
 * A REPLACEMENT inherits the run it replaced: select a word that is blue, type
 * over it, the word is blue. That is what a word processor does, and it is the
 * case this function used to get wrong — it sampled the character to the LEFT of
 * the whole edit, so typing over a blue run at the end of a paragraph wrote the
 * style of whatever preceded it and the blue was gone with nothing left to say
 * it had been there.
 *
 * A pure INSERTION has nothing to replace, so it takes the character before the
 * caret; at the very start of the text it takes the first run, which is the only
 * one there is to extend.
 */
function insertedStyle(intervals: Interval[], start: number, end: number): TextSpan["style"] | undefined {
  if (end > start) {
    const replaced = runStyleAt(intervals, start);
    if (replaced !== null) return replaced;
    const tail = runStyleAt(intervals, end - 1);
    if (tail !== null) return tail;
  }
  if (start > 0) {
    const before = runStyleAt(intervals, start - 1);
    if (before !== null) return before;
  }
  const first = runStyleAt(intervals, 0);
  return first === null ? undefined : first;
}

/**
 * Reconciles an existing span list with updated text content (e.g. after user
 * edits in the canvas editor).
 *
 * The edit is a SPLICE — `[start, end)` of the old text replaced by whatever now
 * sits in its place — and every character outside it keeps the run it had. That
 * is what makes the answer stable: correctness no longer depends on the two
 * strings being unambiguous, so a paste in the middle of a paragraph, a
 * cross-run delete, or typing into a run of repeated characters all land where
 * the caret was.
 *
 * `edit` is optional because a content write does not always come from a
 * keystroke. When it is absent the splice is derived from the strings, which is
 * the best that can be done and is exact whenever the edit is not ambiguous.
 */
export function reconcileSpansOnTextChange(
  spans: TextSpan[] | undefined,
  oldContent: string,
  newContent: string,
  edit?: TextEditRange
): TextSpan[] | undefined {
  if (!spans || spans.length === 0) return undefined;

  const oldText = spans.map((s) => s.text).join("") || oldContent;
  if (newContent === oldText) return spans;

  const intervals = intervalsOf(spans);

  // A range is only usable if it can be believed: it has to sit inside the old
  // text and leave a non-negative amount of new text. Anything else is a stale
  // caller, and the derived edit answers better than a blind splice.
  const usable =
    edit &&
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= oldText.length &&
    newContent.length - (oldText.length - (edit.end - edit.start)) >= 0;
  const { start, end } = usable ? edit! : deriveEdit(oldText, newContent);

  const insertedLen = newContent.length - (oldText.length - (end - start));
  const inserted = newContent.slice(start, start + insertedLen);

  const out: TextSpan[] = [];
  pushRunSlice(out, newContent, 0, start, intervals, 0);
  pushRun(out, inserted, insertedStyle(intervals, start, end));
  pushRunSlice(out, newContent, end, oldText.length, intervals, start + insertedLen - end);

  const hasCustomStyle = out.some((s) => s.style && Object.keys(s.style).length > 0);
  return hasCustomStyle ? out : undefined;
}
