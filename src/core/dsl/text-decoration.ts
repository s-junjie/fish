import type { TextDecorationLine } from "./types";
import { canonicalKey } from "./normalize/shared";

/**
 * The decoration LINES, in canonical order.
 *
 * The order is part of the definition rather than a detail of it. A list is the
 * value, so two lists that draw the same lines have to compare equal whatever
 * order they were written in — `["line-through","underline"]` and
 * `["underline","line-through"]` are one style, and without a canonical order the
 * span compactor would treat them as two, keep both, and split a run for nothing.
 */
export const DECORATION_LINES = ["underline", "line-through"] as const;

const isLine = (value: unknown): value is TextDecorationLine =>
  typeof value === "string" && (DECORATION_LINES as readonly string[]).includes(value);

/**
 * Reads whatever an author wrote as a list of lines.
 *
 * Three spellings are accepted and they are all the same value: the array
 * (`["underline","line-through"]`), the CSS shorthand string (`"underline
 * line-through"` — what a `text-decoration` declaration contains, so markup and
 * a pasted style attribute both arrive in it), and a single line on its own
 * (`"underline"`), which is what every document written before the lines were
 * combinable contains.
 *
 * `undefined` means "nothing is drawn", and that is also what an empty list
 * means — there is no third state, so an empty list normalizes away instead of
 * being stored. This is NOT the `sizing` situation: nothing derives a decoration
 * from an element's situation, so there is no default that has to be written down
 * to stay sayable. `"none"` therefore needs no case of its own: it is not a line,
 * so it falls out as the empty list.
 */
export function normalizeTextDecoration(
  raw: unknown,
  options?: {
    /**
     * Keep an explicitly written empty set as `[]` instead of collapsing it to
     * `undefined`. Only a SPAN wants this.
     *
     * The two states are the same on an element and different on a run:
     * `undefined` means "this run draws whatever the element draws", `[]` means
     * "this run draws nothing, whatever the element draws". Taking one line off
     * part of a paragraph is the only thing `[]` is for, and it is the whole
     * reason a decoration toggle can work on a text selection at all — CSS cannot
     * express it (measured: an inner `text-decoration: none` leaves an ancestor's
     * underline painted, 263 of 276 px still dark), so the canvas stops painting
     * the element's line on the container as soon as the text has spans.
     */
    keepEmpty?: boolean;
  }
): TextDecorationLine[] | undefined {
  const written = typeof raw === "string" || Array.isArray(raw);
  const tokens = typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : [];

  const seen = new Set<string>();
  for (const token of tokens) {
    const key = canonicalKey(typeof token === "string" ? token : "");
    if (isLine(key)) seen.add(key);
  }

  const ordered = DECORATION_LINES.filter((line) => seen.has(line));
  if (ordered.length > 0) return [...ordered];
  return options?.keepEmpty && written ? [] : undefined;
}

/**
 * The value the canvas paints and the SVG export writes, both of which take CSS
 * verbatim — `text-decoration` accepts a space-separated list in a style
 * attribute and in the SVG presentation attribute alike, so both boundaries are
 * a join and neither has to know the vocabulary.
 *
 * `[]` and `undefined` both come out as `undefined` here, and that is correct at
 * this boundary: the two differ in what they SAY about the element's own line,
 * which is a question the painter answers by deciding where to put the line, not
 * by writing a different value.
 */
export function textDecorationCss(lines: TextDecorationLine[] | undefined): string | undefined {
  return lines && lines.length > 0 ? lines.join(" ") : undefined;
}

/**
 * The lines a run actually draws: its own if it said anything, the element's
 * otherwise.
 *
 * This is the resolution the canvas and the export both need, and it exists as a
 * function so they cannot answer it differently. `??` is doing real work: a span
 * that wrote `[]` did say something, and the element's line must not come back.
 */
export function effectiveDecoration(
  spanDecoration: TextDecorationLine[] | undefined,
  elementDecoration: TextDecorationLine[] | undefined
): TextDecorationLine[] | undefined {
  return spanDecoration ?? elementDecoration;
}

/** Whether the text draws this line. */
export function hasDecoration(
  lines: TextDecorationLine[] | undefined,
  line: TextDecorationLine
): boolean {
  return Boolean(lines?.includes(line));
}

/**
 * The list with one line added or removed, still in canonical order.
 *
 * An EMPTY ARRAY rather than `undefined` when that removes the last line: on a run
 * that is a real value ("no lines here"), and it is the only way a line comes off
 * part of a paragraph that draws it. A caller that means the element — where "no
 * lines" is spelled by the absent key — turns the empty result back into
 * `undefined` itself, and says so where it does.
 */
export function toggledDecoration(
  lines: TextDecorationLine[] | undefined,
  line: TextDecorationLine,
  on: boolean
): TextDecorationLine[] {
  const next = new Set(lines ?? []);
  if (on) next.add(line);
  else next.delete(line);
  return DECORATION_LINES.filter((candidate) => next.has(candidate));
}
