import { ADJUST_AXES } from "../dsl/color-filter";
import type {
  ColorFilter,
  DesignElement,
  GradientStop,
  LineHeight,
  LetterSpacing,
  Paint,
  PaintStack,
  Stroke,
  TextSpan,
  TextStyle
} from "../dsl/types";
import { lerpColor, transparentColor } from "./interpolate-color";

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const pick = <T,>(a: T | undefined, b: T | undefined, p: number): T | undefined =>
  p < 0.5 ? (a ?? b) : (b ?? a);

/** Absent alpha is opaque, the same reading `morph` gives an element's own. */
const alphaOf = (paint: Paint | Stroke): number => (typeof paint.opacity === "number" ? paint.opacity : 1);

/** The numeric fields both halves state — the only ones that can travel. */
function lerpNumbers(
  out: Record<string, unknown>,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keys: readonly string[],
  p: number
): void {
  for (const key of keys) {
    if (typeof a[key] === "number" && typeof b[key] === "number") {
      out[key] = round2(lerp(a[key] as number, b[key] as number, p));
    }
  }
}

function lerpPoint(
  out: Record<string, unknown>,
  key: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  p: number
): void {
  const pa = a[key] as { x?: number; y?: number } | undefined;
  const pb = b[key] as { x?: number; y?: number } | undefined;
  if (typeof pa?.x !== "number" || typeof pa?.y !== "number") return;
  if (typeof pb?.x !== "number" || typeof pb?.y !== "number") return;
  out[key] = { x: round2(lerp(pa.x, pb.x, p)), y: round2(lerp(pa.y, pb.y, p)) };
}

/**
 * A gradient ramp at `p`.
 *
 * Stops pair by INDEX, because a ramp has no identity beyond its order — and a
 * stop only one side carries is held where it is with a transparent colour, so
 * the ramp does not gain or lose an anchor in a single frame.
 */
function lerpStops(
  a: GradientStop[] | undefined,
  b: GradientStop[] | undefined,
  p: number
): GradientStop[] | undefined {
  if (!a && !b) return undefined;
  const out: GradientStop[] = [];
  const count = Math.max(a?.length ?? 0, b?.length ?? 0);
  for (let i = 0; i < count; i++) {
    const sa = a?.[i];
    const sb = b?.[i];
    if (!sa || !sb) {
      const only = (sa ?? sb)!;
      out.push({ ...only, color: transparentColor(only.color) });
      continue;
    }
    out.push({ ...sb, color: lerpColor(sa.color, sb.color, p), offset: round2(lerp(sa.offset, sb.offset, p)) });
  }
  return out;
}

/**
 * Whether two paints describe the same thing, so their FIELDS can be merged.
 *
 * A solid against a gradient has no field in common, and a different bitmap has
 * nothing to melt into — those cross-fade instead (see `interpolatePaints`).
 */
function mergeable(a: Paint, b: Paint): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "image" && b.type === "image") return a.assetId === b.assetId;
  return true;
}

function lerpPaint(a: Paint, b: Paint, p: number): Paint {
  const pa = a as unknown as Record<string, unknown>;
  const pb = b as unknown as Record<string, unknown>;
  const out = { ...pb };

  const alpha = round2(lerp(alphaOf(a), alphaOf(b), p));
  if (alpha === 1) delete out.opacity;
  else out.opacity = alpha;
  if (a.blendMode !== b.blendMode) {
    const mode = pick(a.blendMode, b.blendMode, p);
    if (mode === undefined) delete out.blendMode;
    else out.blendMode = mode;
  }

  if (a.type === "solid" && b.type === "solid") {
    out.color = lerpColor(a.color, b.color, p);
    return out as unknown as Paint;
  }

  if (b.type === "image") {
    const cropA = pa.crop as Record<string, unknown> | undefined;
    const cropB = pb.crop as Record<string, unknown> | undefined;
    if (cropA && cropB) {
      const crop = { ...cropB };
      lerpNumbers(crop, cropA, cropB, ["x", "y", "scale", "rotation"], p);
      out.crop = crop;
    }
    lerpPoint(out, "focalPoint", pa, pb, p);
    return out as unknown as Paint;
  }

  out.from = lerpColor(pa.from as string, pb.from as string, p);
  out.to = lerpColor(pa.to as string, pb.to as string, p);
  lerpNumbers(out, pa, pb, ["fromOffset", "toOffset", "angle", "radius", "rx", "ry"], p);
  lerpPoint(out, "start", pa, pb, p);
  lerpPoint(out, "end", pa, pb, p);
  lerpPoint(out, "center", pa, pb, p);
  const stops = lerpStops(pa.stops as GradientStop[] | undefined, pb.stops as GradientStop[] | undefined, p);
  if (stops !== undefined) out.stops = stops;
  return out as unknown as Paint;
}

/**
 * A paint stack at `p`, layer by layer.
 *
 * Layers pair by index — the stack is ordered, and "the second fill" is the same
 * fill on both slides. A layer only one side carries fades in or out rather than
 * switching on at the midpoint, and a pair that cannot merge dissolves under its
 * replacement, because two paints have no halfway the way two numbers do.
 */
export function interpolatePaints(
  from: PaintStack | undefined,
  to: PaintStack | undefined,
  p: number
): PaintStack | undefined {
  const a = from ?? [];
  const b = to ?? [];
  if (a.length === 0 && b.length === 0) return undefined;

  const out: Paint[] = [];
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) {
    const pa = a[i];
    const pb = b[i];
    if (!pa || !pb) {
      const only = (pa ?? pb)!;
      const fade = pa ? 1 - p : p;
      out.push({ ...only, opacity: round2(alphaOf(only) * fade) } as Paint);
      continue;
    }
    if (mergeable(pa, pb)) {
      out.push(lerpPaint(pa, pb, p));
      continue;
    }
    out.push({ ...pa, opacity: round2(alphaOf(pa) * (1 - p)) } as Paint);
    out.push({ ...pb, opacity: round2(alphaOf(pb) * p) } as Paint);
  }
  return out;
}

/**
 * A stroke stack at `p`. A stroke only one side has animates its WIDTH from
 * zero, since a zero-width edge paints nothing — no alpha needed, and the line
 * reads as growing rather than as appearing.
 */
export function interpolateStrokes(
  from: Stroke[] | undefined,
  to: Stroke[] | undefined,
  p: number
): Stroke[] | undefined {
  const a = from ?? [];
  const b = to ?? [];
  if (a.length === 0 && b.length === 0) return undefined;

  const out: Stroke[] = [];
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) {
    const sa = a[i];
    const sb = b[i];
    if (!sa || !sb) {
      const only = (sa ?? sb)!;
      out.push({ ...only, width: round2(only.width * (sa ? 1 - p : p)) });
      continue;
    }

    const row: Stroke = { ...sb, width: round2(lerp(sa.width, sb.width, p)) };
    if (sa.color && sb.color) row.color = lerpColor(sa.color, sb.color, p);
    if (typeof sa.miterLimit === "number" && typeof sb.miterLimit === "number") {
      row.miterLimit = round2(lerp(sa.miterLimit, sb.miterLimit, p));
    }
    if (typeof sa.dashOffset === "number" && typeof sb.dashOffset === "number") {
      row.dashOffset = round2(lerp(sa.dashOffset, sb.dashOffset, p));
    }
    if (sa.opacity !== undefined || sb.opacity !== undefined) {
      row.opacity = round2(lerp(sa.opacity ?? 1, sb.opacity ?? 1, p));
    }
    // A dash pattern is a set of lengths, and two patterns of different lengths
    // are different patterns: the target's takes over rather than pretending to
    // be the average of both.
    if (sa.dashArray && sb.dashArray && sa.dashArray.length === sb.dashArray.length) {
      row.dashArray = sa.dashArray.map((n, j) => round2(lerp(n, sb.dashArray![j], p)));
    }
    if (sa.sides && sb.sides) {
      row.sides = { ...sb.sides };
      lerpNumbers(row.sides as Record<string, unknown>, sa.sides as Record<string, unknown>, sb.sides as Record<string, unknown>, ["top", "right", "bottom", "left"], p);
    }
    if (sa.paint || sb.paint) {
      const paint = interpolatePaints(sa.paint ? [sa.paint] : undefined, sb.paint ? [sb.paint] : undefined, p);
      if (paint?.[0]) row.paint = paint[0];
    }
    out.push(row);
  }
  return out;
}

/** A `1.4` / `"14px"` / `"0.05em"` value at `p`, or nothing when the units differ. */
function lerpLength<T extends LineHeight | LetterSpacing>(
  a: T | undefined,
  b: T | undefined,
  p: number
): T | undefined {
  if (typeof a === "number" && typeof b === "number") return round2(lerp(a, b, p)) as T;
  const pa = /^(-?\d*\.?\d+)(px|em)$/.exec(String(a ?? ""));
  const pb = /^(-?\d*\.?\d+)(px|em)$/.exec(String(b ?? ""));
  if (!pa || !pb || pa[2] !== pb[2]) return undefined;
  return `${round2(lerp(Number(pa[1]), Number(pb[1]), p))}${pa[2]}` as T;
}

/**
 * A text style at `p`: the type grows and the tracking follows, instead of the
 * box scaling under a glyph run that jumps to its final size on frame one.
 *
 * Only the measurable part travels. The family, the weight and the alignment
 * have no halfway, so the target's own values stand.
 */
export function interpolateTextStyle(
  from: TextStyle | undefined,
  to: TextStyle | undefined,
  p: number
): TextStyle | undefined {
  if (!from || !to) return undefined;
  const out: TextStyle = { ...to };
  out.fontSize = round2(lerp(from.fontSize, to.fontSize, p));
  const lineHeight = lerpLength(from.lineHeight, to.lineHeight, p);
  if (lineHeight !== undefined) out.lineHeight = lineHeight;
  const letterSpacing = lerpLength(from.letterSpacing, to.letterSpacing, p);
  if (letterSpacing !== undefined) out.letterSpacing = letterSpacing;
  if (from.color && to.color) out.color = lerpColor(from.color, to.color, p);
  return out;
}

/**
 * The RUNS at `p`, so a rich text grows as a whole.
 *
 * The element's own `fontSize` travels (see above) and a run's size is the one
 * thing that overrides it — an override written in ABSOLUTE px on the incoming
 * slide. Left alone it painted at its final size from frame one, inside a box
 * that was still the outgoing one's: the paragraph then wrapped into three or
 * four lines and unwrapped again on the way out. The line count is a discrete
 * function of that mismatch, so the whole animation flickered.
 *
 * Runs pair by INDEX, the same rule the paint stack follows: a paragraph has no
 * identity beyond its order, and "the second run" is the same run on both
 * slides. The fields with no halfway (family, weight, style) stand at the
 * target's, exactly as they do for the element.
 *
 * A run states its size and tracking only where it overrides the paragraph's, so
 * what it INHERITED is the other half of the pair: a run that said nothing about
 * its size was painted at `style.fontSize`, and that is the number it travels
 * from — including a run the outgoing slide did not have at that index at all.
 */
export function interpolateSpans(
  from: DesignElement,
  to: DesignElement,
  p: number
): TextSpan[] | undefined {
  const target = (to as { spans?: TextSpan[] }).spans;
  if (!target || target.length === 0) return undefined;
  const source = (from as { spans?: TextSpan[] }).spans;
  const fromStyle = (from as { style?: TextStyle }).style;
  const toStyle = (to as { style?: TextStyle }).style;

  return target.map((span, i) => {
    const a = source?.[i]?.style;
    const b = span.style;
    const style = { ...b };

    const sizeA = a?.fontSize ?? fromStyle?.fontSize;
    const sizeB = b?.fontSize ?? toStyle?.fontSize;
    if (sizeA !== undefined && sizeB !== undefined) style.fontSize = round2(lerp(sizeA, sizeB, p));

    const tracking = lerpLength(
      a?.letterSpacing ?? fromStyle?.letterSpacing,
      b?.letterSpacing ?? toStyle?.letterSpacing,
      p
    );
    if (tracking !== undefined) style.letterSpacing = tracking;

    if (a?.color && b?.color) style.color = lerpColor(a.color, b.color, p);
    return { ...span, style };
  });
}

/**
 * A colour filter at `p`, axis by axis.
 *
 * A filter fading in has to start at NEUTRAL, not at zero: `brightness` neutral
 * is 1, so reading an absent axis as 0 would pass the layer through a black
 * frame on its way in.
 */
export function interpolateAdjust(
  from: ColorFilter | undefined,
  to: ColorFilter | undefined,
  p: number
): ColorFilter | undefined {
  if (!from && !to) return undefined;
  const out: ColorFilter = {};
  for (const axis of ADJUST_AXES) {
    const a = from?.[axis.key];
    const b = to?.[axis.key];
    if (a === undefined && b === undefined) continue;
    out[axis.key] = round2(lerp(a ?? axis.neutral, b ?? axis.neutral, p));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface TextPath {
  pathId: string;
  startOffset?: number;
  side?: "in" | "out";
}

/**
 * The run along a path at `p` — its travel, not its guide. A run that changes
 * PATH is on two different curves and slides rather than flies.
 */
function interpolateOnPath(from: DesignElement, to: DesignElement, p: number): TextPath | undefined {
  const a = (from as { onPath?: TextPath }).onPath;
  const b = (to as { onPath?: TextPath }).onPath;
  if (!a || !b || a.pathId !== b.pathId) return undefined;
  return { ...b, startOffset: round2(lerp(a.startOffset ?? 0, b.startOffset ?? 0, p)) };
}

/**
 * Everything about a layer that is neither its box nor its rotation: the paint
 * it is filled with, the edges drawn around it, the type it is set in — down to
 * the runs that override that type — the filter over it, and where its run sits
 * on a path.
 *
 * One call because these travel together, and because a field added to any of
 * them has one place to be handled rather than four.
 */
export function appearanceFrame(from: DesignElement, to: DesignElement, p: number): Record<string, unknown> {
  const a = from as unknown as Record<string, unknown>;
  const b = to as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const fills = interpolatePaints(a.fills as PaintStack | undefined, b.fills as PaintStack | undefined, p);
  if (fills !== undefined) out.fills = fills;
  const strokes = interpolateStrokes(a.strokes as Stroke[] | undefined, b.strokes as Stroke[] | undefined, p);
  if (strokes !== undefined) out.strokes = strokes;
  const style = interpolateTextStyle(a.style as TextStyle | undefined, b.style as TextStyle | undefined, p);
  if (style !== undefined) out.style = style;
  const spans = interpolateSpans(from, to, p);
  if (spans !== undefined) out.spans = spans;
  const adjust = interpolateAdjust(a.adjust as ColorFilter | undefined, b.adjust as ColorFilter | undefined, p);
  if (adjust !== undefined) out.adjust = adjust;
  const onPath = interpolateOnPath(from, to, p);
  if (onPath !== undefined) out.onPath = onPath;

  return out;
}
