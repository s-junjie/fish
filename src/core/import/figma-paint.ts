/**
 * Figma paint → DSL paint.
 *
 * Pure leaf module: no DOM, no document, no I/O, which is what lets the mapping
 * tables be unit-tested without a browser. It started life inside a Node script
 * that imported Figma files from the command line; when that script went, this
 * stayed, because there is exactly one answer to what a Figma gradient becomes
 * and this is it.
 */

import type { BlendMode, ColorFilter, Effect, LiquidGlassEffect, Paint, PaintStack, Stroke } from "../dsl/types";
import { LIQUID_GLASS_DEFAULTS } from "../dsl/liquid-glass";
import { figmaFillCrop } from "./figma-image-fill";
import type { FigmaColor, FigmaEffect, FigmaNode, FigmaPaint } from "./figma-types";

/** A 0..255 channel as two hex digits, clamped so an out-of-gamut float cannot
 *  produce a three-digit byte and a five-digit colour. */
const HEX = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

/**
 * Figma's `{r,g,b,a}` are floats in 0..1. A paint's own `opacity` is a SEPARATE
 * multiplier in Figma, and the two multiply — which is why they are two
 * arguments here rather than one pre-multiplied colour read off the node.
 */
export function figmaColor(c: FigmaColor | undefined, opacity = 1): string {
  if (!c) return "#000000";
  const r = Math.round((c.r ?? 0) * 255);
  const g = Math.round((c.g ?? 0) * 255);
  const b = Math.round((c.b ?? 0) * 255);
  const a = (c.a ?? 1) * opacity;
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  return `#${HEX(r)}${HEX(g)}${HEX(b)}`;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * A gradient matrix's own axes, mapped back into the element's box.
 *
 * `gradientTransform` maps the ELEMENT into gradient space — not the other way
 * round. That is the direction Figma reads it in: its own helper inverts the
 * matrix before pulling the handles off it
 * (`extractLinearGradientParamsFromTransform`), and REST's
 * `gradientHandlePositions` is that same inversion. So the direction a ramp runs
 * in is the first column of the INVERSE — `(d, −c)/det` — and reading it off the
 * matrix directly mirrors every angle about the vertical axis.
 *
 * The identity is a fixed point of that mistake, and so is every symmetric
 * matrix, which is why a fixture and a hand-written case could agree with both
 * readings: a top-to-bottom ramp landed on 0° (i.e. bottom-to-top) and a 45° one
 * on 315°. Test the off-axis case — the axis-aligned ones cannot tell them
 * apart.
 *
 * `center` is the inverse of gradient space's midpoint `(0.5, 0.5)`, which is
 * the centre every Figma gradient is built around.
 */
function figmaGradientAxes(
  transform: number[][] | undefined
): { axis: { x: number; y: number }; center: { x: number; y: number } } | null {
  if (!transform || !Array.isArray(transform[0]) || !Array.isArray(transform[1])) return null;
  const [a, b, tx] = transform[0];
  const [c, d, ty] = transform[1];
  if (![a, b, tx, c, d, ty].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const det = a * d - b * c;
  if (det === 0) return null;

  // A⁻¹ = (1/det)·[[d, −b], [−c, a]] applied to `gradient point − translation`.
  const at = (u: number, v: number) => ({
    x: (d * (u - tx) - b * (v - ty)) / det,
    y: (a * (v - ty) - c * (u - tx)) / det
  });
  const center = at(0.5, 0.5);
  // Gradient space's +x midpoint is where a ramp's `0` stop points from the
  // centre, for a linear gradient and for a conic's sweep alike.
  const along = at(1, 0.5);
  const axis = { x: along.x - center.x, y: along.y - center.y };
  if (axis.x === 0 && axis.y === 0) return null;
  return { axis, center };
}

/**
 * The DSL's angle convention, shared with `ellipse.startAngle`: 0° points at
 * top-centre and grows clockwise, so a direction `(dx, dy)` is `atan2(dx, −dy)`.
 */
function angleFromTop(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360) % 360;
}

/**
 * Figma's gradient direction → the DSL's linear `angle`.
 *
 * Both sides measure in the element's BOX FRACTIONS: the renderer turns this
 * angle into percentage endpoints, so a linear ramp's angle is the direction
 * those fractions take and the box's aspect ratio is not part of the number.
 * The angular case below is the one that has to scale it.
 */
export function figmaGradientAngle(transform: number[][] | undefined): number {
  const axes = figmaGradientAxes(transform);
  return axes ? angleFromTop(axes.axis.x, axes.axis.y) : 0;
}

/**
 * Figma's blend-mode enum → the DSL's `BlendMode`.
 *
 * `LINEAR_DODGE` is additive (`Cb + Cs`) and CSS spells that `plus-lighter`,
 * which the DSL carries. It used to map to `color-dodge`, which is a DIVISION
 * (`Cb / (1 - Cs)`) — so a 60% `#444` dodge layer, painted inside an isolated
 * group whose backdrop is transparent black, resolved to 0/0.733 = black and
 * dragged the whole iOS tab bar from #888888 down to #555555. The two are not
 * neighbours; one is the identity at 50% grey and the other is its opposite.
 *
 * `LINEAR_BURN` has no CSS counterpart — additive-subtractive `Cb + Cs - 1` was
 * dropped from the compositing spec, and no browser implements `plus-darker` —
 * so `color-burn` stays as the nearest name. The approximation is fair where a
 * linear burn is actually used (over light artwork it also lands on the
 * source's hue) and it is never reported as a gap, because it does paint.
 */
const BLEND_MODES: Record<string, BlendMode> = {
  NORMAL: "normal",
  DARKEN: "darken",
  MULTIPLY: "multiply",
  LINEAR_BURN: "color-burn",
  COLOR_BURN: "color-burn",
  LIGHTEN: "lighten",
  SCREEN: "screen",
  LINEAR_DODGE: "plus-lighter",
  COLOR_DODGE: "color-dodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity"
};

export function figmaBlendMode(mode: string | undefined): BlendMode | undefined {
  return mode ? BLEND_MODES[mode] : undefined;
}

function stopsOf(paint: FigmaPaint): { color: string; offset: number }[] {
  return (paint.gradientStops ?? []).map((s) => ({
    color: figmaColor(s.color),
    offset: s.position ?? 0
  }));
}

/**
 * Resolves an `imageRef` to the id of the asset already holding its bytes.
 * Returning `undefined` means the bytes never arrived, which the caller reports
 * rather than painting a blank rectangle that looks like a design decision.
 */
export type ImageRefResolver = (ref: string) => string | undefined;

/**
 * What placing a paint needs beyond the paint itself.
 *
 * `box` is the element's own box: the space a crop framing is written in, and
 * the space a conic's sweep angle has to be measured in — a conic is a true
 * circle in px, so its box's aspect ratio is part of its angle.
 *
 * `naturalOf` answers with the size the asset pipeline recorded — the very size
 * the renderer will read back — so the framing solved here and the framing
 * painted are solved from the same two numbers. It is absent for a paint that
 * cannot be a bitmap at all, which is every stroke this importer maps.
 */
export interface PaintPlacement {
  box: { width: number; height: number };
  naturalOf?: (assetId: string) => { width: number; height: number } | null;
}

/**
 * Figma's `scaleMode` → the DSL's `fit`.
 *
 * `FILL` is a COVER: Figma scales the bitmap up until it fills the box and crops
 * what overflows. The DSL's `fill` is CSS's `object-fit: fill` — a stretch — and
 * the two were mapped together, so every photograph whose box aspect differed
 * from the bitmap's arrived distorted, which is most of them and is invisible in
 * every measurement: a stretched bitmap still occupies the box it was given.
 * `cover` is the fit that means FILL; `STRETCH` is the stretch.
 *
 * `TILE` has no DSL paint — nothing tiles a bitmap — so it falls back to `cover`
 * (the nearest thing to what the designer drew) and the caller names the gap
 * rather than letting a flat copy pass for the design. `CROP` is not one of
 * these any more: its framing lives in `imageTransform` and `figmaFillCrop`
 * reads it, so `cover` here is only ever the plain, square-to-the-box reading.
 */
function imageFit(scaleMode: string | undefined): "cover" | "contain" | "fill" {
  if (scaleMode === "FIT") return "contain";
  if (scaleMode === "STRETCH") return "fill";
  return "cover";
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Figma's photo sliders → the DSL's `ColorFilter`.
 *
 * Both are seven axes and four of them are already in the same unit on both
 * sides (neutral 0, range -1..+1), so those cross unchanged. The other three
 * are the same axis under a different neutral: Figma's contrast and saturation
 * are offsets from nothing, the DSL's are ratios from 1, and Figma's exposure
 * runs ±1 where the DSL's runs ±2 stops. Each is rebased rather than copied —
 * the alternative imports a photo whose exposure is at half strength, which
 * looks like an importer bug because it is one.
 *
 * Returns `undefined` for an all-neutral set: a filter object that adjusts
 * nothing would be written into the document and re-checked on every load to
 * learn that again.
 */
function imageColorFilter(filters: unknown): ColorFilter | undefined {
  if (!filters || typeof filters !== "object") return undefined;
  const raw = filters as Record<string, unknown>;
  const at = (key: string): number => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : 0);
  const out: ColorFilter = {};
  if (at("exposure") !== 0) out.exposure = clamp(at("exposure") * 2, -2, 2);
  if (at("contrast") !== 0) out.contrast = clamp(1 + at("contrast"), 0, 2);
  if (at("saturation") !== 0) out.saturation = clamp(1 + at("saturation"), 0, 2);
  if (at("temperature") !== 0) out.temperature = clamp(at("temperature"), -1, 1);
  if (at("tint") !== 0) out.tint = clamp(at("tint"), -1, 1);
  if (at("highlights") !== 0) out.highlights = clamp(at("highlights"), -1, 1);
  if (at("shadows") !== 0) out.shadows = clamp(at("shadows"), -1, 1);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One Figma paint → one DSL paint, or `null` when it does not carry across.
 *
 * A dropped paint is never silent — the caller records the type against the
 * node's id, so the gap list names exactly which of Figma's paint kinds the DSL
 * cannot express instead of the import quietly arriving one layer short.
 *
 * `resolve` is needed because an IMAGE paint names an `imageRef`, and the bytes
 * behind it were fetched before this walk — so the mapping that would otherwise
 * be a pure function of the paint is a lookup for this one case.
 */
export function mapFigmaPaint(
  paint: FigmaPaint | undefined,
  resolve?: ImageRefResolver,
  placement?: PaintPlacement
): Paint | null {
  if (!paint || paint.visible === false) return null;
  const opacity = paint.opacity ?? 1;
  const blendMode = figmaBlendMode(paint.blendMode);
  const common = {
    ...(blendMode && blendMode !== "normal" ? { blendMode } : {}),
    ...(opacity !== 1 ? { opacity } : {})
  };

  switch (paint.type) {
    case "SOLID":
      // NOT `figmaColor(paint.color, opacity)`. The paint's own opacity has a
      // slot of its own on the layer — `common` carries it, and the renderer
      // multiplies it into the colour's alpha — so baking it here as well
      // squared it: a 25% black wash arrived at 6.25%, and the iOS tab bar's
      // four-layer sheen composited to #555555 where Figma paints #888888.
      return { type: "solid", color: figmaColor(paint.color), ...common };
    case "IMAGE": {
      const assetId = paint.imageRef ? resolve?.(paint.imageRef) : undefined;
      if (!assetId) return null;
      const filter = imageColorFilter(paint.filters);
      const crop = figmaFillCrop(paint, placement?.box, placement?.naturalOf?.(assetId));
      return {
        type: "image",
        assetId,
        fit: crop ? ("crop" as const) : imageFit(paint.scaleMode),
        ...(crop ? { crop } : {}),
        ...(filter ? { adjust: filter } : {}),
        enabled: true,
        ...common
      };
    }
    case "VIDEO": {
      // A clip's bytes are unreachable from a plugin, so what the export carries
      // under a video's ref is its POSTER — a still of the layer, rendered by the
      // plugin — and the layer is painted from that. `cover` and not `fill`: the
      // poster was rendered at the layer's own size, so it lands exactly, and
      // `cover` cannot distort it when a size is all the export recorded.
      const assetId = paint.videoRef ? resolve?.(paint.videoRef) : undefined;
      if (!assetId) return null;
      const filter = imageColorFilter(paint.filters);
      return { type: "image", assetId, fit: "cover", ...(filter ? { adjust: filter } : {}), enabled: true, ...common };
    }
    case "GRADIENT_LINEAR": {
      const stops = stopsOf(paint);
      if (stops.length < 2) return null;
      return {
        type: "linear-gradient",
        from: stops[0].color,
        to: stops[stops.length - 1].color,
        angle: figmaGradientAngle(paint.gradientTransform),
        stops,
        ...common
      };
    }
    case "GRADIENT_RADIAL": {
      const stops = stopsOf(paint);
      if (stops.length < 2) return null;
      return { type: "radial-gradient", from: stops[0].color, to: stops[stops.length - 1].color, stops, ...common };
    }
    // The two non-linear gradient kinds. The DSL has carried `angular-gradient`
    // and `diamond-gradient` from the start — they render through the pattern
    // path in `GradientDef` — so reporting these as unmappable was the importer
    // being behind its own engine, and a conic or diamond fill is common enough
    // in real files for that to be a visible hole.
    case "GRADIENT_ANGULAR": {
      const stops = stopsOf(paint);
      if (stops.length < 2) return null;
      const axes = figmaGradientAxes(paint.gradientTransform);
      // A conic's sweep is a true circle in px (`dirFromTop`), so its start angle
      // is measured there and the box's aspect ratio IS part of it — the one
      // gradient kind whose angle a square element cannot validate
      // (LESSONS_LEARNED §114). A box that is not known is read as the square,
      // which is the one ratio where the two spaces agree.
      const box = placement?.box ?? { width: 1, height: 1 };
      return {
        type: "angular-gradient",
        from: stops[0].color,
        to: stops[stops.length - 1].color,
        ...(axes
          ? {
              angle: angleFromTop(axes.axis.x * box.width, axes.axis.y * box.height),
              center: { x: round4(axes.center.x), y: round4(axes.center.y) }
            }
          : {}),
        stops,
        ...common
      };
    }
    case "GRADIENT_DIAMOND": {
      const stops = stopsOf(paint);
      if (stops.length < 2) return null;
      return { type: "diamond-gradient", from: stops[0].color, to: stops[stops.length - 1].color, stops, ...common };
    }
    default:
      return null;
  }
}

/**
 * Figma's `fills[]` are painted FIRST-BOTTOM-LAST-TOP, which is the DSL's paint
 * stack order too (`ARCHITECTURE.md` §3), so the array is copied and not
 * reversed. `MIX_BLEND_MODE`-style alpha nodes and the hidden ones drop out.
 */
export function mapFigmaFills(
  fills: FigmaPaint[] | undefined,
  resolve?: ImageRefResolver,
  placement?: PaintPlacement
): PaintStack | undefined {
  if (!Array.isArray(fills)) return undefined;
  const paints = fills.map((f) => mapFigmaPaint(f, resolve, placement)).filter((p): p is Paint => p !== null);
  return paints.length > 0 ? paints : undefined;
}

const STROKE_ALIGNS: Record<string, Stroke["align"]> = {
  INSIDE: "inside",
  CENTER: "center",
  OUTSIDE: "outside"
};

const CAPS: Record<string, Stroke["cap"]> = { NONE: "butt", ROUND: "round", SQUARE: "square", LINE_ARROW: "butt", TRIANGLE_ARROW: "butt" };
const JOINS: Record<string, Stroke["join"]> = { MITER: "miter", ROUND: "round", BEVEL: "bevel" };

/**
 * The geometry every stroke on a node shares.
 *
 * Figma carries ONE `strokeWeight` / `strokeAlign` / `strokeDashes` per node, so
 * a node's strokes differ only in their paint — which is why this is built once
 * and handed to each of them.
 *
 * Per-side weights are the DSL's `sides`, which it declares precisely so a
 * four-sided border can be drawn rather than averaged — the same reason the HTML
 * importer reads a four-value `border`. Figma sends this field only when the
 * weights were set individually, but a designer who set all four to the same
 * number sends it too, and four equal numbers are not a custom side: taking that
 * branch would put every ordinary bordered box on the renderer path reserved for
 * genuinely mixed weights.
 */
function strokeShape(node: FigmaNode): Omit<Stroke, "paint" | "color"> & { color?: string } {
  const dashes = Array.isArray(node.strokeDashes) && node.strokeDashes.length > 0 ? node.strokeDashes : undefined;
  const individual = node.individualStrokeWeights;
  const weights = individual
    ? ([individual.top, individual.right, individual.bottom, individual.left].filter(
        (v): v is number => typeof v === "number"
      ) as number[])
    : [];
  const hasSideWeights = new Set(weights).size > 1;

  return {
    width: node.strokeWeight ?? 1,
    style: dashes ? "dashed" : "solid",
    ...(dashes ? { dashArray: dashes } : {}),
    align: STROKE_ALIGNS[node.strokeAlign ?? ""] ?? "center",
    ...(node.strokeCap && CAPS[node.strokeCap] ? { cap: CAPS[node.strokeCap] } : {}),
    ...(node.strokeJoin && JOINS[node.strokeJoin] ? { join: JOINS[node.strokeJoin] } : {}),
    // `custom` is what tells the renderer the four weights are not one number.
    ...(hasSideWeights
      ? {
          side: "custom" as const,
          sides: {
            top: individual!.top,
            right: individual!.right,
            bottom: individual!.bottom,
            left: individual!.left
          }
        }
      : {}),
    enabled: true
  };
}

/**
 * One node's visible stroke paints, in paint order (first is bottom-most).
 *
 * The box is threaded through for the same reason the fills get it: a conic
 * stroke's sweep angle is a px-space angle, so the box's ratio is part of it. A
 * bitmap cannot arrive as a stroke at all — nothing resolves an image ref for
 * one — which is why the placement carries no `naturalOf` here.
 */
function strokePaints(node: FigmaNode, box?: { width: number; height: number }): Paint[] {
  const paints: Paint[] = [];
  for (const stroke of node.strokes ?? []) {
    if (stroke.visible === false) continue;
    const paint = mapFigmaPaint(stroke, undefined, box ? { box } : undefined);
    if (paint) paints.push(paint);
  }
  return paints;
}

/**
 * A node's strokes → the DSL's `strokes` stack.
 *
 * Figma paints `strokes[]` bottom-first and the DSL's `strokes[]` is the same
 * stack, so more than one stroke maps as a stack. It used to map as the FIRST
 * one alone, and the loss was silent: an inner outline plus an outer ring — the
 * most common way a real file draws a button — imported as one of the two, with
 * nothing in the report.
 */
export function mapFigmaStrokes(
  node: FigmaNode,
  box?: { width: number; height: number }
): { strokes: Stroke[] } | undefined {
  const paints = strokePaints(node, box);
  if (paints.length === 0) return undefined;
  const shape = strokeShape(node);
  return { strokes: paints.map((paint) => ({ ...shape, paint })) };
}

/**
 * A stroke-only node's paints, as the FILLS that paint its `strokeGeometry`.
 *
 * Figma already expanded the stroke to a region in `strokeGeometry`, so filling
 * that region with the stroke's own paint is the faithful way to draw it — there
 * is no centreline left to stroke. See `mapVector`, which reaches for this only
 * when the node has no visible fill.
 */
export function mapFigmaStrokeAsFills(node: FigmaNode, box?: { width: number; height: number }): Paint[] | undefined {
  const paints = strokePaints(node, box);
  return paints.length > 0 ? paints : undefined;
}

/**
 * Figma's shadow effects carry a `spread`, which maps directly to the DSL's
 * `spread` on `drop-shadow` and `inner-shadow`.
 */
/**
 * The blend modes an effect may carry and still paint as itself.
 *
 * An effect's `blendMode` is not decoration, and this is the lesson a real
 * export taught: the iOS glass frames in an alert panel draw their rims with
 * `LINEAR_DODGE` inner shadows in near-black and their hairlines with
 * `LINEAR_BURN` drop shadows in near-white. On the backdrop they were authored
 * against, both are invisible — the mode IS the effect. Painted as normal
 * composites they are the opposite of what the designer drew: a near-black
 * inner shadow across a light card, which is how one import arrived with its
 * whole alert panel solid dark and its text unreadable.
 *
 * The DSL's effect has no blend mode — the filter chain is `feMerge`, and
 * `feBlend` spells five of CSS's sixteen — so an effect that needs one is
 * DROPPED here and named by the caller, never painted with the wrong
 * composite. `PASS_THROUGH` is Figma's "no blend" and maps to nothing.
 */
/**
 * The blend modes an effect may carry.
 *
 * All recognized Figma blend modes map to the DSL's `blendMode` on `drop-shadow`
 * and `inner-shadow`, and render via SVG filter primitives (`<feBlend>` or
 * `<feComposite operator="arithmetic">` for `plus-lighter`).
 */
export const EFFECT_BLEND_MODES = new Set([...Object.keys(BLEND_MODES), "PASS_THROUGH"]);

export function mapFigmaEffects(effects: FigmaEffect[] | undefined): Effect[] | undefined {
  if (!Array.isArray(effects)) return undefined;
  const out: Effect[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    const blendMode = figmaBlendMode(e.blendMode);
    if (typeof e.blendMode === "string" && e.blendMode !== "PASS_THROUGH" && !blendMode) continue;
    const offset = { x: e.offset?.x ?? 0, y: e.offset?.y ?? 0 };
    const spread = e.spread ?? 0;
    switch (e.type) {
      case "DROP_SHADOW":
        out.push({
          type: "drop-shadow",
          color: figmaColor(e.color),
          offset,
          blur: e.radius ?? 0,
          ...(spread !== 0 ? { spread } : {}),
          ...(blendMode && blendMode !== "normal" ? { blendMode } : {}),
          enabled: true
        });
        break;
      case "INNER_SHADOW":
        out.push({
          type: "inner-shadow",
          color: figmaColor(e.color),
          offset,
          blur: e.radius ?? 0,
          ...(spread !== 0 ? { spread } : {}),
          ...(blendMode && blendMode !== "normal" ? { blendMode } : {}),
          enabled: true
        });
        break;
      case "LAYER_BLUR":
        out.push({ type: "layer-blur", blur: e.radius ?? 0, enabled: true });
        break;
      case "BACKGROUND_BLUR":
        out.push({ type: "backdrop-blur", blur: e.radius ?? 0, enabled: true });
        break;
      case "GLASS":
        out.push(mapFigmaGlass(e));
        break;
      default:
        break;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Figma's glass effect → the DSL's `liquid-glass`.
 *
 * Same material on both sides, and the DSL's fields are already Figma's names,
 * so this is a rebasing rather than a translation — which is the whole reason
 * `core/dsl/liquid-glass.ts` says the parameter surface is Figma's. Figma's
 * ratios run 0..1 where the DSL's run 0..100; its `radius` is the DSL's Frost
 * and `depth` is already a length on both.
 *
 * A parameter Figma does not publish takes the DSL's own default rather than
 * zero. `splay` is the one that exists today, and writing 0 for it would import
 * every glass panel as a hard-edged lens — a confident-looking wrong answer
 * where the default is at least the material's own resting shape.
 */
function mapFigmaGlass(e: FigmaEffect): LiquidGlassEffect {
  const raw = e as Record<string, unknown>;
  const d = LIQUID_GLASS_DEFAULTS;
  // The fallback is the DSL's default restated in Figma's units — a ratio is
  // given back as the fraction it is written as, so the line below reads as one
  // rule rather than a default in two scales.
  const ratio = (key: string, fallbackPercent: number): number =>
    clamp(num(key, fallbackPercent / 100) * 100, 0, 100);
  const num = (key: string, fallback: number): number =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : fallback;

  return {
    type: "liquid-glass",
    refraction: ratio("refraction", d.refraction),
    dispersion: ratio("dispersion", d.dispersion),
    lightIntensity: ratio("lightIntensity", d.lightIntensity),
    splay: ratio("splay", d.splay),
    // Already the DSL's unit on both sides: px for Frost and Depth, degrees for
    // the light angle.
    depth: Math.max(1, num("depth", d.depth)),
    frost: Math.max(0, num("radius", d.frost)),
    lightAngle: clamp(num("lightAngle", d.lightAngle), -180, 180),
    enabled: true
  };
}

/**
 * Figma stores either one `cornerRadius` or four `rectangleCornerRadii`, and the
 * four are ordered TL / TR / BR / BL — which is the DSL's `[TL, TR, BR, BL]`
 * `CornerRadius` order, so the array is carried through unrotated.
 */
export function mapFigmaCornerRadius(node: FigmaNode): number | [number, number, number, number] | undefined {
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length === 4) {
    return node.rectangleCornerRadii.slice(0, 4) as [number, number, number, number];
  }
  if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) return node.cornerRadius;
  return undefined;
}