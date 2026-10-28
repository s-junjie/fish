/**
 * The picture beside an alignment option.
 *
 * Four fields in the layout panel — Distribute, Align, Align content, Align
 * self — offer the same handful of words (`center` means a different axis in
 * each), and a two-word name cannot say which axis or which object it moves.
 * Each option therefore carries a drawing of itself, drawn from the same
 * arithmetic the layout pass uses: free space, split by `lead` and `gap`.
 *
 * MONOCHROME, three ink levels and nothing else — the panel has one accent
 * (DESIGN.md §Colors), and an alignment value is a state, not an armed tool:
 *
 *   `hi`    the element the control is about (align-self's own item)
 *   `mid`   a peer, on the same footing as the others
 *   `faint` a sibling that this option does not move
 *
 * Two shapes sit outside the options and mean one thing each: the dashed box
 * outline is the container, and the single dashed midline (Align · Center) is
 * the axis the items share. `align-self: auto` is the only DASHED item, because
 * "inherited, not declared here" is the one thing the picture has to add to the
 * name — see `docs/lessons/ui-interaction.md` on why a value with no explicit
 * document key still needs a face.
 */

export type AlignmentKind = "justify" | "align" | "align-content" | "align-self";

export type AlignmentValue =
  | "start"
  | "center"
  | "end"
  | "space-between"
  | "space-around"
  | "space-evenly"
  | "stretch"
  | "auto";

export type GlyphTone = "hi" | "mid" | "faint";

export interface GlyphShape {
  x: number;
  y: number;
  w: number;
  h: number;
  tone: GlyphTone;
  /** Outline only — an item whose position comes from somewhere else. */
  dashed?: boolean;
}

export interface GlyphGeometry {
  shapes: GlyphShape[];
  /** The cross axis every item shares, drawn only where it explains the option. */
  guide?: { y: number };
}

/** The drawing's own user space. Every call site scales from here. */
export const GLYPH_W = 46;
export const GLYPH_H = 28;

const PAD = 3.2;
const INNER_W = GLYPH_W - PAD * 2;
const INNER_H = GLYPH_H - PAD * 2;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Where a `start | center | end | stretch` item sits once its height is known. */
function crossOffset(mode: string, inner: number, size: number): number {
  if (mode === "center") return (inner - size) / 2;
  if (mode === "end") return inner - size;
  return 0;
}

/**
 * One axis of free space, handed out the way CSS does it.
 *
 * `slots` is what the slack is divided BETWEEN: the items for `justify-content`,
 * the LINES for `align-content`. The two menus carry the same six words and the
 * difference is exactly this argument — which is also why the two pictures look
 * alike until the second one is read as rows.
 */
function distribute(value: AlignmentValue, free: number, slots: number) {
  switch (value) {
    case "center":
      return { lead: free / 2, gap: 0 };
    case "end":
      return { lead: free, gap: 0 };
    case "space-between":
      return { lead: 0, gap: slots > 1 ? free / (slots - 1) : 0 };
    case "space-around":
      return { lead: free / (slots * 2), gap: free / slots };
    case "space-evenly":
      return { lead: free / (slots + 1), gap: free / (slots + 1) };
    default:
      return { lead: 0, gap: 0 };
  }
}

const WIDTH_RATIOS = [0.25, 0.29, 0.25];
/**
 * Three DIFFERENT heights, and none of them near the box's own.
 *
 * A middle item at 0.84 of the inner height left 3.5px between its `start` and
 * `end` positions — measured on the shipped menu, Start / Center / End were
 * three pictures of the same tall block. The drawing is an abstraction, not a
 * screenshot: the items are made short enough that where they sit is the thing
 * the eye reads.
 */
const HEIGHT_RATIOS = [0.42, 0.68, 0.52];

/**
 * The gutter a packed row keeps even though the CSS gap is 0.
 *
 * With no gutter, `start` drew three touching blocks and read as ONE wide bar —
 * the picture said "one item" while its name said "three". Every distribution
 * keeps at least this much space between items; the space-* modes are wider.
 */
const MIN_GAP = 1.8;

/** A main-axis row of three items, sized so a 46px drawing still reads as three. */
const rowWidths = () => WIDTH_RATIOS.map((f) => f * INNER_W);

export function alignmentGlyphGeometry(kind: AlignmentKind, value: AlignmentValue): GlyphGeometry {
  const shapes: GlyphShape[] = [];
  let guide: GlyphGeometry["guide"];

  if (kind === "justify") {
    const lens = [0.26, 0.17, 0.23].map((f) => f * INNER_W);
    // The gutters are reserved BEFORE the free space is split, so a packed row
    // (`start`) with the floor gap still ends inside the box.
    const gutters = MIN_GAP * (lens.length - 1);
    const free = Math.max(0, INNER_W - lens.reduce((a, b) => a + b, 0) - gutters);
    const packed = distribute(value, free, lens.length);
    const lead = packed.lead;
    const gap = MIN_GAP + packed.gap;
    const h = INNER_H * 0.6;
    let x = PAD + lead;
    for (const w of lens) {
      shapes.push({ x: r3(x), y: r3(PAD + (INNER_H - h) / 2), w: r3(w), h: r3(h), tone: "mid" });
      x += w + gap;
    }
    return { shapes };
  }

  if (kind === "align" || kind === "align-self") {
    const widths = rowWidths();
    const gap = (INNER_W - widths.reduce((a, b) => a + b, 0)) / (widths.length - 1);
    if (kind === "align" && value === "center") guide = { y: r3(PAD + INNER_H / 2) };
    let x = PAD;
    widths.forEach((w, i) => {
      const self = kind === "align-self" && i === 1;
      // The container aligns every item at once; the child's own field moves
      // exactly one, and its two neighbours keep the inherited position so the
      // drawing says WHICH item changed rather than only where it went.
      const mode = self || kind === "align" ? value : "start";
      const h = mode === "stretch" ? INNER_H : INNER_H * HEIGHT_RATIOS[i];
      shapes.push({
        x: r3(x),
        y: r3(PAD + crossOffset(mode, INNER_H, h)),
        w: r3(w),
        h: r3(h),
        tone: kind === "align" ? "mid" : self ? "hi" : "faint",
        dashed: self && value === "auto"
      });
      x += w + gap;
    });
    return { shapes, guide };
  }

  const lineH = INNER_H * 0.29;
  // Same reservation as the main axis: without a floor the two lines touch and
  // `start` reads as one cluster of five blocks rather than as two rows.
  const free = Math.max(0, INNER_H - lineH * 2 - MIN_GAP);
  const packed = distribute(value, free, 2);
  const lead = packed.lead;
  const gap = MIN_GAP + packed.gap;
  const gutter = INNER_W * 0.055;
  const w = (INNER_W - gutter * 2) / 3;
  [3, 2].forEach((count, line) => {
    const y = PAD + lead + line * (lineH + gap);
    for (let i = 0; i < count; i += 1) {
      shapes.push({ x: r3(PAD + i * (w + gutter)), y: r3(y), w: r3(w), h: r3(lineH), tone: "mid" });
    }
  });
  return { shapes };
}

const TONE_FILL: Record<GlyphTone, string> = {
  hi: "fill-ink group-hover:fill-brand-ink",
  mid: "fill-ink-dim group-hover:fill-brand-ink",
  faint: "fill-ink-muted group-hover:fill-brand-ink"
};

const TONE_STROKE: Record<GlyphTone, string> = {
  hi: "stroke-ink group-hover:stroke-brand-ink",
  mid: "stroke-ink-dim group-hover:stroke-brand-ink",
  faint: "stroke-ink-muted group-hover:stroke-brand-ink"
};

/**
 * `width` decides how much the drawing may say: below ~32px the shared-axis
 * guide and the 1.2 radius are noise, so they are dropped rather than scaled
 * into a smudge. A menu row carries the 36×22 form, which is the smallest size
 * at which three blocks and the space between them are still two facts.
 */
export function AlignmentGlyph(props: {
  kind: AlignmentKind;
  value: AlignmentValue;
  width?: number;
  height?: number;
  className?: string;
}) {
  const { kind, value, width = GLYPH_W, height = GLYPH_H, className = "" } = props;
  const { shapes, guide } = alignmentGlyphGeometry(kind, value);
  const roomy = width >= 32;
  return (
    <svg
      viewBox={`0 0 ${GLYPH_W} ${GLYPH_H}`}
      width={width}
      height={height}
      aria-hidden="true"
      className={`flex-none ${className}`.trim()}
      style={{ display: "block" }}
    >
      {/* Outline only: the drawing sits on a menu row, and on the amber hover
          fill a `paper` plate would become the darkest object in the row. */}
      <rect
        x={0.5}
        y={0.5}
        width={GLYPH_W - 1}
        height={GLYPH_H - 1}
        rx={2.5}
        strokeWidth={0.8}
        className="fill-none stroke-rule-strong group-hover:stroke-brand-ink"
      />
      {guide && roomy && (
        <line
          x1={PAD}
          y1={guide.y}
          x2={GLYPH_W - PAD}
          y2={guide.y}
          strokeWidth={0.8}
          strokeDasharray="2.5 2"
          // `ink-muted`, not `rule-strong`: measured on the shipped menu, the
          // guide in the hairline colour was invisible, and Center then read as
          // a slightly different Start — the one option whose picture is a
          // claim about a shared axis was making no claim at all.
          className="stroke-ink-muted group-hover:stroke-brand-ink"
        />
      )}
      {shapes.map((s, i) => (
        <rect
          key={i}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={roomy ? 1.2 : 0.8}
          strokeWidth={0.8}
          strokeDasharray={s.dashed ? "2 1.6" : undefined}
          className={`${s.dashed ? "fill-none" : TONE_FILL[s.tone]} ${TONE_STROKE[s.tone]}`}
        />
      ))}
    </svg>
  );
}
