import {
  AutoLayout,
  ContainerElement,
  CornerRadius,
  DesignElement,
  Effect,
  InstanceElement,
  LetterSpacing,
  LineHeight,
  PathElement,
  Stroke,
  TextSpan,
  TextStyle,
  TrackSize
} from "../dsl/types";
import { isLineElement } from "./element-bounds";
import { edgeScaleOf } from "./edge-profiles";
import { layoutOf, withLayout, type FlatAutoLayout } from "../dsl/layout-flat";
import { expectNever } from "../exhaustive";
import { parsePathData, scalePathData, serializePathData } from "./path-data";
import { isContainer } from "./tree-ops";
import { releaseScaledBindings, type ScaledProperties } from "./scale-bindings";

/**
 * Scaling a box is not scaling a shape.
 *
 * `rect` / `ellipse` / `polygon` / `star` regenerate their outline from `width`/`height`
 * on every read, so for them a box change *is* a shape change. Every other type
 * stores its drawn geometry beside the box — a path in `d`, a line in the `dx` /
 * `dy` endpoint deltas — and that geometry does not move when the box does. A
 * write path that resizes without coming through here leaves the selection box
 * and the drawing disagreeing, and nothing downstream can tell that apart from a
 * deliberate edit.
 *
 * So: every write that changes `width`/`height` on a path or a line runs
 * `scaleElementGeometry` in the same commit. The per-type list is the one
 * `path` / `line` / `arrow` need; the other five types have no stored geometry.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A factor multiplied by a factor. Two decimals would lose the relation between
 * a scale and the scale back: 0.78 twice is 0.6084, and rounding it to 0.61 leaves
 * the box and the contents disagreeing by 0.25% for good. Six decimals is beyond
 * what any document can show and still keeps a JSON line short.
 */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The scale factor an instance carries, with absent or degenerate read as 1:1. */
export function instanceScaleOf(inst: InstanceElement): { x: number; y: number } {
  const s = inst.instanceScale;
  if (!s || !(s.x > 0) || !(s.y > 0) || !Number.isFinite(s.x) || !Number.isFinite(s.y)) {
    return { x: 1, y: 1 };
  }
  return s;
}

/**
 * The smallest box edge a scale may produce, in canvas pixels.
 *
 * Sub-pixel on purpose, and 1px was wrong here. The floor exists so a scale cannot
 * write a zero or negative extent, which is degenerate rather than small. It used to
 * be 1px because a 1px layer is still clickable — but the scale BAKES its factor into
 * geometry, so clamping the box is not a display guard, it is a permanent edit: a 3x5
 * signal bar asked for 10% landed on 1x1.67, and growing it back to 10x produced
 * 10x16.7. A 110x4 home indicator came back 275x10. Nothing recovers the lost extent,
 * because the document stores geometry and no longer stores the factor.
 *
 * So the floor is small enough to be invisible and a shrink/grow round trip is exact.
 * A layer scaled past a tenth of a pixel is hard to hit on the canvas, which is
 * Figma's behaviour too, and the layer panel still selects it. Exactness is worth
 * more here than a click target a user can reach another way.
 */
const MIN_DIMENSION = 0.01;

/**
 * Scale a path element's `d` about its own local origin.
 *
 * `null` when the parse yielded no anchors, so the caller leaves the element
 * alone rather than write an empty outline. `parsePathData` reports failure two
 * different ways — `null` for unparseable input, and an anchor-less path for
 * input it tokenized but recognised nothing in — and a check on the first alone
 * lets the second through, which is how a malformed `d` silently becomes `d: ""`
 * and a visible shape turns invisible. Rounds through the same parse/serialize
 * pair the drag-resize gesture uses, so both writers agree on the emitted form
 * (arcs become cubics either way).
 */
export function scalePathGeometry(d: string, sx: number, sy: number): string | null {
  if (!d) return d;
  const parsed = parsePathData(d);
  if (!parsed || parsed.anchors.length === 0) return null;
  return serializePathData(scalePathData(parsed, sx, sy));
}

/**
 * Rewrite the drawn geometry of a `path` / `line` / `arrow` to match a box
 * change, leaving the box itself alone. The caller has already written `width` /
 * `height`; this brings the drawing back under it.
 *
 * Returns the same element when there is nothing to scale or the scale is 1:1,
 * so a caller keeps structural sharing (LESSONS §7).
 */
export function scaleElementGeometry<T extends DesignElement>(el: T, sx: number, sy: number): T {
  if (sx === 1 && sy === 1) return el;
  if (isLineElement(el)) {
    return { ...el, dx: round2(el.dx * sx), dy: round2(el.dy * sy) };
  }
  if (el.type === "path") {
    const d = scalePathGeometry((el as PathElement).d, sx, sy);
    return d === null ? el : ({ ...el, d } as T);
  }
  return el;
}

/** Exported for the instance path: an inherited radius is scaled at RESOLVE time. */
export function scaleCornerRadius(radius: CornerRadius | undefined, k: number): CornerRadius | undefined {
  if (radius === undefined) return undefined;
  if (typeof radius === "number") return round2(radius * k);
  return radius.map((r) => round2(r * k)) as CornerRadius;
}

/**
 * The factor for every property measured in pixels of the box RATHER THAN on one
 * axis: how much the box's SHORTER SIDE grew.
 *
 * Not `min(sx, sy)`, which is the same number until something makes the two axes
 * disagree about which one is shorter — and the box's floor does exactly that. A 20x10
 * card asked to shrink past both floors lands on a square, having shrunk further on the
 * width than on the height; `min` reports the width's larger factor, so a 2px radius
 * keeps less of itself than it should and growing back leaves it short. The shorter
 * side is what actually moved, which is the box these are measured against, and it is
 * the same side the renderer clamps a radius against when it draws (`rectToVectorPath`).
 *
 * A side that is zero is left out of the comparison rather than counted as the shortest.
 * A zero-height divider is not a very short box, it is a line, and measuring against it
 * gives every pixel property a factor of nothing: the stroke would not scale with the
 * 200px of width it actually has. The converse error is worse — flooring the zero side
 * up to `MIN_DIMENSION` made the box non-zero, after which the ordinary factor maths read
 * a 10x off it and multiplied the stroke by 10 on the way back up, every round trip.
 *
 * The same number in the ordinary case, so nothing changes for a scale that never
 * reaches the floor: multiplying both sides by one factor preserves which is shorter.
 * A non-uniform scale (a corner drag) does change it, and deliberately — padding
 * tracks the edge it belongs to, so this is only for the properties with no edge.
 */
function uniformFactorOf(el: DesignElement, width: number, height: number): number {
  const sides: Array<[before: number, after: number]> = [
    [el.width, width],
    [el.height, height]
  ];
  const live = sides.filter(([before]) => before > 0);
  if (live.length === 0) return 1;
  return Math.min(...live.map(([, after]) => after)) / Math.min(...live.map(([before]) => before));
}

function scaleStroke(stroke: Stroke | undefined, k: number): Stroke | undefined {
  return stroke ? { ...stroke, width: round2(stroke.width * k) } : undefined;
}

/** Exported for the instance path: an inherited stroke is scaled at RESOLVE time. */
export function scaleStrokeWidth(stroke: Stroke, k: number): Stroke {
  return { ...stroke, width: round2(stroke.width * k) };
}

/** The blur-family effects (and any future one) scale the same way. */
/** The effects whose only geometry is a blur radius. */
type BlurredEffect = Extract<Effect, { blur: number }>;

function scaleBlur(effect: BlurredEffect, k: number): Effect {
  return { ...effect, blur: round2(effect.blur * k) };
}

/** Exported for the instance path: inherited effects are scaled at RESOLVE time. */
export function scaleEffect(effect: Effect, sx: number, sy: number, k: number): Effect {
  // Switched through a copy: narrowing the parameter itself would make the
  // fallback below a `never` object, and `never` cannot be spread.
  const kind = effect.type;
  switch (kind) {
    case "drop-shadow":
      return {
        ...effect,
        blur: round2(effect.blur * k),
        offset: { x: round2(effect.offset.x * sx), y: round2(effect.offset.y * sy) },
        ...(effect.spread !== undefined ? { spread: round2(effect.spread * k) } : {})
      };
    // An inner shadow scales like a drop shadow but without the silhouette
    // growth. A text's drop shadow does NOT come here: it is a `drop-shadow`, and
    // its offset lives on the glyphs, which the branch above already scales.
    case "inner-shadow":
      return {
        ...effect,
        blur: round2(effect.blur * k),
        offset: { x: round2(effect.offset.x * sx), y: round2(effect.offset.y * sy) },
        ...((effect as any).spread !== undefined ? { spread: round2((effect as any).spread * k) } : {})
      };
    case "layer-blur":
    case "backdrop-blur":
      return scaleBlur(effect, k);
    case "tear":
      // `scale` is a length (the break's own wavelength, or the pitch for the
      // periodic profiles), so a doubled layer breaks at the same place on a
      // doubled curve. The other parameters are dimensionless: roughness and
      // fibre have no size, `inset` is a percentage, a seed is an identity.
      return { ...effect, scale: edgeScaleOf(round2(effect.scale * k)) };
    case "liquid-glass":
      // Two of the nine are LENGTHS and the other seven are not. Scaling the
      // ratios would turn a scale of a panel into a different material — an
      // angle of -35° has no size — and scaling only `depth` would leave the
      // band the wrong length for the blur that reads through it. Frost and
      // Depth move; refraction, dispersion, the two light values, splay, fill
      // and stroke stay exactly as authored.
      return { ...effect, frost: round2(effect.frost * k), depth: round2(effect.depth * k) };
    default:
      // A new effect must be listed above. Left as a catch-all it silently took
      // this path, and the only symptom was that the effect stopped scaling.
      expectNever(kind);
      return scaleBlur(effect, k);
  }
}

function scaleTextStyle(style: TextStyle, sx: number, sy: number, k: number): TextStyle {
  return {
    ...style,
    fontSize: round2(style.fontSize * k),
    ...(style.lineHeight !== undefined ? { lineHeight: scaleLineHeight(style.lineHeight, sy) } : {}),
    ...(style.letterSpacing !== undefined ? { letterSpacing: scaleLetterSpacing(style.letterSpacing, sx) } : {})
  };
}

/**
 * A run's own overrides are the same pixel measurements as the paragraph's, so
 * they follow the same factors. Left unscaled, a partially bold headline keeps
 * its pre-scale type size inside a box that shrank — the run is what paints, so
 * the text visibly outgrows the element it belongs to.
 */
function scaleTextSpan(span: TextSpan, sx: number, sy: number, k: number): TextSpan {
  const style = span.style;
  if (!style) return span;
  return {
    ...span,
    style: {
      ...style,
      ...(style.fontSize !== undefined ? { fontSize: round2(style.fontSize * k) } : {}),
      ...(style.letterSpacing !== undefined
        ? { letterSpacing: scaleLetterSpacing(style.letterSpacing, sx) }
        : {})
    }
  };
}

/**
 * Only an ABSOLUTE tracking scales; a relative one is a ratio and does not.
 * A bare number and `"<n>px"` are lengths and move with `sx`; `"<n>em"` is
 * relative to `fontSize`, which scales by `k` on its own, so it needs no help to
 * track the text it belongs to — multiplying it would compound the growth.
 */
export function scaleLetterSpacing(letterSpacing: LetterSpacing, sx: number): LetterSpacing {
  if (typeof letterSpacing === "number") return round2(letterSpacing * sx);
  if (letterSpacing.endsWith("em")) return letterSpacing;
  return `${round2(Number.parseFloat(letterSpacing) * sx)}px` as LetterSpacing;
}

/**
 * Only an ABSOLUTE line height scales; a multiplier is a ratio and does not.
 * Multiplying `1.5` by a factor would turn a leading into three times a leading,
 * the same mistake `TrackSize`'s `fr` entry is kept out of. `fontSize` scales by
 * `k` on its own, so a multiplier needs no help to track the text it belongs to.
 */
function scaleLineHeight(lineHeight: LineHeight, sy: number): LineHeight {
  return typeof lineHeight === "number"
    ? lineHeight
    : (`${round2(Number.parseFloat(lineHeight) * sy)}px` as LineHeight);
}

function scalePadding(value: NonNullable<AutoLayout["padding"]>, sx: number, sy: number, k: number): NonNullable<AutoLayout["padding"]> {
  if (typeof value === "number") return round2(value * k);
  const [t, r, b, l] = value;
  return [round2(t * sy), round2(r * sx), round2(b * sy), round2(l * sx)];
}

/**
 * A track list, where each px entry is a measurement of THIS geometry and so
 * scales with it, while a `{ fr }` entry is a ratio and must not be touched.
 *
 * Leaving the list out is what made a scale wrong rather than merely incomplete:
 * `[280, { fr: 1 }, 288]` in a 1264 frame scaled to 632 kept both fixed tracks
 * and left the `fr` one 64px, so the tracks no longer fit the frame they
 * describe. `columnWidthMin` — the other minimum — was already scaled, and that
 * asymmetry is what gave the omission away.
 */
function scaleTracks(tracks: TrackSize[] | undefined, sx: number, sy: number, k: number): TrackSize[] | undefined {
  if (!tracks) return undefined;
  return tracks.map((t) => (typeof t === "number" ? round2(t * k) : t));
}

/** Exported for the instance path: a master's layout recipe scales at RESOLVE time. */
export function scaleLayout(layout: AutoLayout, sx: number, sy: number, k: number): AutoLayout {
  const columnSizes = scaleTracks(layout.columnSizes, sx, sy, k);
  const rowSizes = scaleTracks(layout.rowSizes, sx, sy, k);
  return {
    ...layout,
    ...(layout.gap !== undefined ? { gap: round2(layout.gap * k) } : {}),
    ...(layout.padding !== undefined ? { padding: scalePadding(layout.padding, sx, sy, k) } : {}),
    ...(layout.columnGap !== undefined ? { columnGap: round2(layout.columnGap * sx) } : {}),
    ...(layout.rowGap !== undefined ? { rowGap: round2(layout.rowGap * sy) } : {}),
    ...(layout.columnWidthMin !== undefined ? { columnWidthMin: round2(layout.columnWidthMin * sx) } : {}),
    ...(columnSizes !== undefined ? { columnSizes } : {}),
    ...(rowSizes !== undefined ? { rowSizes } : {})
  };
}

/**
 * Proportionally scale one node's drawn geometry *and* the properties measured in
 * pixels of that geometry: corner radii, stroke widths, effect blur / spread /
 * offset, text size and leading, auto-layout gap and padding.
 *
 * Children are not touched — the node is a leaf as far as this call is
 * concerned, and `scaleSubtreeAbout` is what walks the tree. Keeping the two
 * apart is what stops a scale from recursing twice over the same subtree.
 *
 * Properties whose units are not pixels of this element (opacity, blend mode,
 * font family, weight, colour) are deliberately untouched, and neither is
 * rotation: it is an angle, and a proportional scale moves both axes by the same
 * factor, so the angle cannot change.
 *
 * `uniform` is the factor for the properties with no axis of their own — radius,
 * stroke, blur, type size, a scalar gap. It is `min(sx, sy)` unless the caller knows
 * the box was floored or the aspect flipped, which is the one case where the smaller
 * of two axis factors is no longer the box's own scale; see `uniformFactorOf`.
 */
export function scaleElement<T extends DesignElement>(
  el: T,
  sx: number,
  sy: number,
  uniform = Math.min(sx, sy)
): T {
  if (sx === 1 && sy === 1) return el;
  const k = uniform;
  const shaped = scaleElementGeometry(el, sx, sy);
  const box = shaped as DesignElement & {
    borderRadius?: CornerRadius;
    /** Polygon/star corner cut-back, a px length — scales like `borderRadius`. */
    cornerRadius?: number;
    stroke?: Stroke;
    strokes?: Stroke[];
    effects?: Effect[];
    style?: TextStyle;
  };
  let next = box;
  // Which families of pixel measurements this scale actually MOVED. A zero here
  // means the numbers still match the shared style they came from, so the binding
  // stays: unbinding what a non-uniform scale left alone would drop a link the
  // user still has.
  const scaled: ScaledProperties = {};
  // Each field is written only when the element actually has it: spreading an
  // `undefined` in would put a key the DSL declares as absent into the document,
  // and normalize has no way to tell that from a real value.
  if (box.borderRadius !== undefined) {
    const radius = scaleCornerRadius(box.borderRadius, k);
    if (radius !== undefined) {
      next = { ...next, borderRadius: radius };
      scaled.radius = !sameValue(radius, box.borderRadius);
    }
  }
  if (box.cornerRadius !== undefined) {
    next = { ...next, cornerRadius: round2(box.cornerRadius * k) };
    scaled.radius = scaled.radius || next.cornerRadius !== box.cornerRadius;
  }
  if (box.strokes) {
    const strokes = box.strokes.map((s) => scaleStroke(s, k) as Stroke);
    next = { ...next, strokes };
    scaled.stroke = strokes.some((s, i) => s.width !== box.strokes![i]?.width);
  }
  if (box.effects) {
    const effects = box.effects.map((e) => scaleEffect(e, sx, sy, k));
    next = { ...next, effects };
    scaled.effect = effects.some((e, i) => !sameValue(e, box.effects![i]));
  }
  if (box.style) {
    const style = scaleTextStyle(box.style, sx, sy, k);
    next = { ...next, style };
    scaled.text =
      style.fontSize !== box.style.fontSize ||
      style.lineHeight !== box.style.lineHeight ||
      style.letterSpacing !== box.style.letterSpacing;
  }
  const spans = (box as { spans?: TextSpan[] }).spans;
  if (spans && spans.length > 0) {
    const nextSpans = spans.map((span) => scaleTextSpan(span, sx, sy, k));
    next = { ...next, spans: nextSpans } as T;
    scaled.text = scaled.text || nextSpans.some((span, i) => !sameValue(span, spans[i]));
  }
  // Narrowed to the two container types that can carry one: a component set has
  // none (its box comes from `fitComponentSet`), so the branch is dead for it and
  // the union is what says so rather than a cast.
  const boxLayout = layoutOf(box as FlatAutoLayout);
  if (boxLayout && next.type !== "componentSet") {
    const layout = scaleLayout(boxLayout, sx, sy, k);
    next = withLayout(next, layout);
    scaled.spacing = !sameValue(layout, boxLayout);
  }
  if (next.type === "instance") next = accumulateInstanceScale(next, sx, sy);
  return releaseScaledBindings(next, scaled) as T;
}

/**
 * An instance is a projection, not a container: scaling it has nowhere to write
 * the contents, so the factor itself is what carries them. Recorded here rather
 * than at each call site so a direct Scale, a scaled ancestor and a scaled
 * Master all arrive at the same number, and so the box and the factor cannot be
 * written by two different rules.
 *
 * The box is left TRACKING the master — no `sizeOverride` — because
 * master × factor is exactly what a later master resize has to re-derive; the
 * flag would freeze the instance at the size its master happened to have.
 */
function accumulateInstanceScale(inst: InstanceElement, sx: number, sy: number): InstanceElement {
  const before = instanceScaleOf(inst);
  return {
    ...inst,
    instanceScale: { x: round6(before.x * sx), y: round6(before.y * sy) }
  };
}

/** Structural equality for the small value trees a scale rewrites. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The smallest proportional factor that still leaves a box non-degenerate: the one
 * that brings its shorter side to `MIN_DIMENSION`. A scale below it is raised to it.
 *
 * Exported because a control that computes a target SIZE has to clamp somewhere, and
 * the obvious clamp — `Math.max(1, width * f)` beside `Math.max(1, height * f)` — is
 * the aspect-destroying floor this module exists to avoid. A panel that clamps on its
 * own reintroduces it one layer up, where no amount of care here can reach it, so the
 * rule lives here and callers ask.
 */
export function floorScaleFactor(el: { width: number; height: number }, factor: number): number {
  const shorter = Math.min(el.width, el.height);
  return shorter > 0 ? Math.max(factor, MIN_DIMENSION / shorter) : factor;
}

/**
 * The box a scale actually produces, and the factors that go with it.
 *
 * A zero-size element is not a layer at all, so every axis floors — at
 * `MIN_DIMENSION`, which is far enough down to leave the factor readable off the box.
 *
 * The trap this used to fall into was flooring each axis by a DIFFERENT amount.
 * Flooring on its own — `max(1, w * sx)` beside `max(1, h * sy)` — destroys the
 * aspect ratio, and everything measured in pixels of the box then has nothing stable
 * to be measured against:
 *
 *   - a 200x19 line of type asked for 0.5% lands on 1x1, and growing it back has no
 *     way to know it was 200x19 — the shorter side now grows 19x where the width
 *     grows 200x, so the type comes back at 168px inside a 200x200 box. Worse than a
 *     wrong size, because a text box's height is *derived* from its type: once the
 *     two disagree, the stored box stops describing what the renderer draws.
 *   - a 100x100 path asked for 0.5% comes back 200x200, its stroke doubled, because
 *     the floor made a square box and every later factor reads off that.
 *
 * So a PROPORTIONAL scale is clamped by one factor and both axes move by it. The
 * aspect survives, the round trip is exact, and the type size and stroke keep meaning
 * what they meant.
 *
 * A non-uniform scale still floors per axis, and must: there the caller has asked for
 * a specific width and a specific height, so the aspect ratio is the request rather
 * than a property to protect.
 *
 * A side that starts at zero stays at zero. It is not a small side, it is an absent
 * one, and flooring it up would invent a box the element never had — after which every
 * later factor reads a ratio off the invented extent and amplifies the whole element.
 */
function flooredScale(el: DesignElement, sx: number, sy: number): { width: number; height: number } {
  // "Proportional" is a comparison, not an identity: the same factor computed twice —
  // by a drag against a locked aspect, or by a W field dividing a target by a current
  // size — agrees to a few float bits and no further. The tolerance is far tighter
  // than any two-axis resize a hand produces, so this cannot swallow a real one.
  const proportional = Math.abs(sx - sy) <= 1e-6 * Math.max(Math.abs(sx), Math.abs(sy));
  const fx = proportional ? floorScaleFactor(el, sx) : sx;
  const fy = proportional ? fx : sy;
  return {
    width: el.width > 0 ? Math.max(MIN_DIMENSION, round2(el.width * fx)) : 0,
    height: el.height > 0 ? Math.max(MIN_DIMENSION, round2(el.height * fy)) : 0
  };
}

/**
 * Scale a node and its whole subtree by `sx` / `sy` about a fixed point given in
 * the node's own parent space. The same point is fixed for the node and for every
 * descendant, so a frame's children grow away from it.
 */
export function scaleSubtreeAbout(
  el: DesignElement,
  fixed: { x: number; y: number },
  sx: number,
  sy: number
): DesignElement {
  if (sx === 1 && sy === 1) return el;
  const { width, height } = flooredScale(el, sx, sy);
  const resized: DesignElement = {
    ...el,
    // Position by the REQUESTED factors, because a node's `x` is a coordinate in
    // its parent's space and the parent is what the request was about; its own
    // floor says nothing about where in that space it sits. The box and the pixel
    // properties are what the node's own floor gets a say in.
    x: round2(fixed.x + (el.x - fixed.x) * sx),
    y: round2(fixed.y + (el.y - fixed.y) * sy),
    width,
    height
  };
  return withScaledChildren(resized, ...effectiveFactorsOf(el, width, height));
}

/**
 * Scale one node about a point that is a FRACTION of its own box, growing its
 * subtree with it.
 *
 * The anchor is a fraction and not pixels so it survives the resize it is
 * steering: top-left is `(0, 0)` and centre is `(0.5, 0.5)` whatever size the
 * element currently is, which is what makes the inspector's anchor picker a
 * property of the operation rather than a one-shot offset.
 *
 * **The anchor applies to this box only.** Descendants scale about the frame's own
 * `(0, 0)`, not about the same fraction of themselves: scaling a card from its
 * centre must grow its children's spacing away from the card's corner, and giving
 * each child the same 0.5 anchor would hold every child centred inside a box that
 * is itself moving — a different, and wrong, layout.
 */
export function scaleSubtreeByFactor(
  el: DesignElement,
  sx: number,
  sy: number,
  anchor: { x: number; y: number }
): DesignElement {
  if (sx === 1 && sy === 1) return el;
  const { width, height } = flooredScale(el, sx, sy);
  // The anchor's position, held fixed while the box grows around it.
  const anchorX = el.x + anchor.x * el.width;
  const anchorY = el.y + anchor.y * el.height;
  const resized: DesignElement = {
    ...el,
    x: round2(anchorX - anchor.x * width),
    y: round2(anchorY - anchor.y * height),
    width,
    height
  };
  return withScaledChildren(resized, ...effectiveFactorsOf(el, width, height));
}

/**
 * The factors the box **actually** took, which are not always the ones asked for.
 *
 * A floored axis stops shrinking while everything measured in pixels of it may keep
 * going, and a non-uniform scale moves the two axes by different amounts anyway. Either
 * way the request is not the box: a 20px radius on a box that stopped at 0.005 would
 * round to 0 and be indistinguishable from a square corner for good, and scaling back
 * up would restore 0, not the corner the element started with. Shrinking a card and
 * growing it again is an ordinary thing to do, so the floor must not be allowed to eat
 * the proportion.
 *
 * Hence the properties are scaled by what the box became, never by the request, and
 * the radius by `uniformFactorOf` rather than by the smaller of the two. The floor
 * makes the two axes disagree about how far they got, and only the shorter side is
 * what a corner is measured against. It is also the value a reader would recover:
 * the renderer already shrinks an over-large radius proportionally when it draws
 * (`rectToVectorPath`), so the ratio is what the eye sees either way.
 */
function effectiveFactorsOf(
  el: DesignElement,
  width: number,
  height: number
): [number, number, number] {
  return [
    el.width > 0 ? width / el.width : 1,
    el.height > 0 ? height / el.height : 1,
    uniformFactorOf(el, width, height)
  ];
}

function withScaledChildren(resized: DesignElement, sx: number, sy: number, uniform: number): DesignElement {
  const next = scaleElement(resized, sx, sy, uniform);
  if (isContainer(next) && next.children?.length) {
    // Children live in the frame's own local space, whose origin is always (0, 0).
    const corner = { x: 0, y: 0 };
    return {
      ...next,
      children: next.children.map((child) => scaleSubtreeAbout(child, corner, sx, sy))
    } as ContainerElement;
  }
  return next;
}
