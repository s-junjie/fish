/**
 * Does the text actually sit where the file says it does?
 *
 * Every other check in the engine grades a STATEMENT: normalize says whether a
 * key was understood, `validate` says whether a box fits, `geometryReport` says
 * whether a child landed outside the box meant to hold it. All of them can be
 * satisfied by a page where the label is pinned to the left edge of a 72px tab,
 * because nothing in the document is wrong — only the picture is. This module is
 * the one place that grades the PICTURE, from measurements a browser took.
 *
 * The rules are deliberately few, and each one is a claim that can be false
 * rather than a restatement of the renderer's own code:
 *
 * - `align-not-applied` — the file asked for an alignment and the computed style
 *   disagrees. This is the rendered twin of the silent-drop class that made
 *   `style.textAlign` vanish with `repairs: 0`: it is measured against the RAW
 *   block, so it holds even if the normalizer is the thing that ate the value.
 * - `ink-not-centred` / `ink-not-right` — the alignment was applied, and the
 *   glyphs still are not in the middle / against the right edge. Legal CSS that
 *   produces the wrong frame: a container narrower than the box, a transform
 *   that moved the line, tracking the browser reserves but the ink does not fill.
 * - `group-not-centred` — a label and the icon beside it do not share a centre.
 * - `no-ink` — the box has text and paints none of it.
 *
 * Nothing here decides intent. A box that says `left` and renders left is not
 * reported even when the design obviously wanted a centre; guessing that is what
 * `align-not-applied` exists to avoid needing.
 */

import { canonicalKey } from "../dsl/normalize/shared";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The alignment the FILE asks for, read before normalize touches it. */
export interface AuthoredAlignment {
  align?: string;
  verticalAlign?: string;
}

export interface TextInkSample {
  elementId: string;
  /** Empty content is not a finding: a spacer text is a legitimate box. */
  content: string;
  authored: AuthoredAlignment;
  /** `getComputedStyle(textContainer).textAlign`. */
  computedAlign: string;
  /** The element's frame box. Same coordinate space as `ink` — only offsets between them are read. */
  box: Rect;
  /** Union of the glyph rects, or null when the browser painted no line. */
  ink: Rect | null;
  /** The nearest painted neighbour in the same group — an icon, usually. */
  group?: { elementId: string; box: Rect } | null;
  /** The flex line the text sits on, when the parent states one. */
  parent?: { box: Rect; alignItems: string } | null;
}

export type InkRule =
  | "align-not-applied"
  | "ink-not-centred"
  | "ink-not-right"
  | "group-not-centred"
  | "no-ink";

export interface InkFinding {
  level: "error" | "warning";
  elementId: string;
  rule: InkRule;
  message: string;
}

export interface AuditTolerance {
  /** Horizontal: the ink centre / edge, against the box. */
  x: number;
  /**
   * Vertical: the text's BOX against its group, not its ink.
   *
   * A line box carries descender space the glyphs do not fill, so a label that a
   * flex row centres perfectly still has ink a couple of pixels above the centre
   * — measured against the icon, a correct row reports itself. What can be stated
   * exactly is where the box lands, so that is what this axis grades; where the
   * glyphs sit inside their own line box is a `line-height` question, not an
   * alignment one.
   */
  y: number;
}

export const DEFAULT_TOLERANCE: AuditTolerance = { x: 1, y: 1 };

/**
 * The ink box from the rects a browser reports for a text node's fragments.
 *
 * The correction that matters: an inline box reserves one trailing
 * `letter-spacing` the glyphs do not fill, so a tracked, correctly centred line
 * measures half a tracking off centre. Taking the advance back off the right
 * edge of each LINE is what makes the 1px rule mean 1px of ink; the renderer
 * compensates for the same artefact in `trailingTrackingShift`.
 *
 * Grouped by line, not global: the artefact is per line, and the widest line is
 * not always the last one.
 */
export function unionInkRects(rects: Rect[], tracking = 0): Rect | null {
  const usable = rects.filter((r) => r.width > 0.05 && r.height > 0.05);
  if (usable.length === 0) return null;

  const lines: Rect[] = [];
  for (const r of [...usable].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((l) => isSameLine(l, r));
    if (!line) {
      lines.push({ ...r });
      continue;
    }
    const right = Math.max(line.x + line.width, r.x + r.width);
    line.x = Math.min(line.x, r.x);
    line.width = right - line.x;
  }

  const left = Math.min(...lines.map((l) => l.x));
  const top = Math.min(...lines.map((l) => l.y));
  const right = Math.max(...lines.map((l) => l.x + l.width - tracking));
  const bottom = Math.max(...lines.map((l) => l.y + l.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Two fragments belong to one line when their top and bottom both agree within a pixel. */
function isSameLine(a: Rect, b: Rect): boolean {
  const dyTop = Math.abs(a.y - b.y);
  const dyBottom = Math.abs(a.y + a.height - b.y - b.height);
  return dyTop <= 1 && dyBottom <= 1;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const centreX = (r: Rect) => r.x + r.width / 2;
const centreY = (r: Rect) => r.y + r.height / 2;
const right = (r: Rect) => r.x + r.width;

/**
 * CSS reports the logical values (`start` / `end`) and the DSL stores the
 * physical ones, so both sides of the `align-not-applied` comparison are reduced
 * through this before they are compared. Anything unlisted is compared as
 * written, which is how a genuinely unsupported value still shows up.
 */
const PHYSICAL: Record<string, string> = {
  start: "left",
  left: "left",
  end: "right",
  right: "right",
  center: "center",
  centre: "center",
  middle: "center",
  justify: "justify"
};

const physical = (value: string | undefined): string =>
  value === undefined ? "" : (PHYSICAL[canonicalKey(value)] ?? canonicalKey(value));

/**
 * Whether `sibling` is the thing `own` was laid out BESIDE.
 *
 * The group rule compares centres, and a centre is only meaningful between two
 * boxes that are actually a pair. Picking the sibling whose centre is nearest
 * made every element a pair with something — on a poster, a kicker was graded
 * against a full-bleed grain layer that happened to share its centre line, and
 * the audit reported "kicker is 2px below paper_grain" nineteen times over.
 * The parent anchor below has a gate (`align-items: center`); this is the
 * neighbour's, and it is the same idea: state the relationship first.
 *
 * All four gates are ratios, so a zoomed canvas reads the same way.
 */
export function isGroupAnchor(own: Rect, sibling: Rect, parent: Rect): boolean {
  const parentArea = parent.width * parent.height;
  if (parentArea <= 0) return false;
  // Not a backdrop: a layer covering half the parent is the surface the text
  // sits ON, not the thing it lines up with.
  if (sibling.width * sibling.height > parentArea * 0.5) return false;
  // Side by side: the horizontal intervals meet, or come within a gutter of
  // meeting. A column away is a different composition, not a misalignment.
  const gapX = Math.max(0, Math.max(own.x, sibling.x) - Math.min(own.x + own.width, sibling.x + sibling.width));
  if (gapX > parent.width * 0.08) return false;
  // On one line: stacked siblings have different centres by construction, so a
  // vertical interval that does not overlap is a column, not a row.
  if (Math.min(own.y + own.height, sibling.y + sibling.height) - Math.max(own.y, sibling.y) <= 0) return false;
  // Comparable: a 400px display glyph is not the label a 14px kicker belongs
  // beside, and its centre is not a target anybody aimed at.
  const ratio = Math.max(own.height, sibling.height) / Math.max(0.5, Math.min(own.height, sibling.height));
  return ratio <= 4;
}

/**
 * Grades one sample. Split out from `auditTextInk` because it is the whole rule
 * set for a single element, and the reported case is one element.
 */
export function auditSample(sample: TextInkSample, tolerance: AuditTolerance = DEFAULT_TOLERANCE): InkFinding[] {
  const findings: InkFinding[] = [];
  const { elementId, box, ink } = sample;
  const wants = physical(sample.authored.align);
  const got = physical(sample.computedAlign);

  if (wants && got && wants !== got) {
    findings.push({
      level: "error",
      elementId,
      rule: "align-not-applied",
      message: `text-align "${sample.authored.align}" is not applied (computed: ${sample.computedAlign})`
    });
  }

  if (!ink || ink.width <= 0.5 || ink.height <= 0.5) {
    if (sample.content.trim() !== "") {
      findings.push({
        level: "error",
        elementId,
        rule: "no-ink",
        message: `the box holds ${JSON.stringify(sample.content.trim())} and paints no glyphs`
      });
    }
    return findings;
  }

  // Whatever the file said, the browser's own answer is what got painted.
  if (got === "center") {
    const offset = centreX(ink) - centreX(box);
    if (Math.abs(offset) > tolerance.x) {
      findings.push({
        level: "error",
        elementId,
        rule: "ink-not-centred",
        message: `ink centre is ${round1(Math.abs(offset))}px ${offset < 0 ? "left" : "right"} of the box centre (${round1(box.width)}px box, ${round1(ink.width)}px of ink)`
      });
    }
  } else if (got === "right") {
    const offset = right(ink) - right(box);
    if (Math.abs(offset) > tolerance.x) {
      findings.push({
        level: "error",
        elementId,
        rule: "ink-not-right",
        message: `ink right edge is ${round1(Math.abs(offset))}px ${offset < 0 ? "inside" : "past"} the box right edge (${round1(box.width)}px box)`
      });
    }
  }

  const anchor = sample.group
    ? { id: sample.group.elementId, y: centreY(sample.group.box), x: centreX(sample.group.box) }
    : sample.parent && /center/.test(sample.parent.alignItems)
      ? { id: "parent", y: centreY(sample.parent.box), x: centreX(sample.parent.box) }
      : null;
  if (anchor) {
    const offsetY = centreY(box) - anchor.y;
    if (Math.abs(offsetY) > tolerance.y) {
      const what = sample.group ? `"${anchor.id}"` : "its row";
      findings.push({
        level: "warning",
        elementId,
        rule: "group-not-centred",
        message: `its box centre is ${round1(Math.abs(offsetY))}px ${offsetY < 0 ? "above" : "below"} the centre of ${what}`
      });
    }
  }

  return findings;
}

export function auditTextInk(samples: TextInkSample[], tolerance: AuditTolerance = DEFAULT_TOLERANCE): InkFinding[] {
  return samples.flatMap((sample) => auditSample(sample, tolerance));
}

/** One line per rule, so a caller can say what it looked for, not only what it found. */
export const AUDITED_RULES: readonly InkRule[] = [
  "align-not-applied",
  "ink-not-centred",
  "ink-not-right",
  "group-not-centred",
  "no-ink"
];

// ---------------------------------------------------------------------------
// the raw block
// ---------------------------------------------------------------------------

/**
 * The alignment the file states, read from the block BEFORE normalize runs.
 *
 * This is the whole reason the audit can catch a normalizer bug: every other
 * reader in the pipeline sees the value AFTER it has been folded, defaulted and
 * possibly dropped, so a value lost on the way in is invisible to all of them.
 * Reading the authored object is ugly precisely because it is un-normalized —
 * `text-align`, `textAlign`, `align` and a compact `style` string are all
 * spellings an author may have written, and all of them mean this one field.
 */
export function authoredAlignmentOf(raw: unknown): AuthoredAlignment {
  if (!raw || typeof raw !== "object") return {};
  const el = raw as Record<string, unknown>;
  const keys = Object.keys(el);
  const pick = (names: string[]): string | undefined => {
    for (const name of names) {
      const hit = keys.find((k) => canonicalKey(k) === name);
      if (hit && typeof el[hit] === "string") return el[hit] as string;
    }
    return undefined;
  };

  let align = pick(["text-align", "align"]);
  let verticalAlign = pick(["vertical-align"]);

  const style = el.style;
  if (style && typeof style === "object") {
    const styleKeys = Object.keys(style as Record<string, unknown>);
    const fromStyle = (names: string[]): string | undefined => {
      for (const name of names) {
        const hit = styleKeys.find((k) => canonicalKey(k) === name);
        const value = hit ? (style as Record<string, unknown>)[hit] : undefined;
        if (typeof value === "string") return value;
      }
      return undefined;
    };
    align = fromStyle(["text-align", "align"]) ?? align;
    verticalAlign = fromStyle(["vertical-align"]) ?? verticalAlign;
  }

  return {
    ...(align ? { align } : {}),
    ...(verticalAlign ? { verticalAlign } : {})
  };
}
