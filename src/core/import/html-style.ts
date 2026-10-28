import type {
  BlendMode,
  ColorFilter,
  CornerRadius,
  Effect,
  ImagePaint,
  InnerShadowEffect,
  Paint,
  PaintStack,
  Stroke,
  TextStyle
} from "../dsl/types";
import type { MissingPaint } from "./html-types";
import type { TokenLookup } from "./html-tokens";
import {
  backgroundImageUrls,
  backgroundLayers,
  isFullyTransparent,
  isPureTranslation,
  paintFromBackgroundImage,
  parseBoxShadows,
  parseCssColor,
  parseFilterValue,
  px,
  rotationFromTransform,
  unrotateBox
} from "./css-values";

/** Reports a CSS property this import could not carry across. */
export type UnmappedSink = (property: string, value: string) => void;

/** The design token a property binds to when the page wrote it as `var(--x)`. */
export type TokenSource = TokenLookup | undefined;

/** What a `url(...)` resolved to: the asset, or why there is none. */
export interface AssetLookup {
  assetId?: string;
  reason?: string;
  /** The URL in the page's own spelling, for a folder that may supply it later. */
  url?: string;
}

/** The asset a `url(...)` comes from, resolved before the walk because it is async. */
export type AssetResolver = (
  url: string,
  hint: { name: string; width: number; height: number }
) => AssetLookup;

export interface BorderWidths {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** Every DRAWN side has the same width and colour, which `stroke` can say directly. */
  uniform: boolean;
  color: string | null;
}

export interface VisualStyle {
  fills?: PaintStack;
  /** `background-clip: text` layers: the text's ink, not the box's. */
  textFills?: PaintStack;
  stroke?: Stroke;
  borderRadius?: CornerRadius;
  effects?: Effect[];
  adjust?: ColorFilter;
  opacity?: number;
  blendMode?: BlendMode;
  clipContent?: boolean;
  rotation?: number;
  visible?: boolean;
  border: BorderWidths;
  /**
   * `property → Number Token id`, for every numeric property the page wrote as
   * `var(--x)`. Written onto the element beside the materialised value, which is
   * what the renderer and the layout pass still read.
   */
  tokenBindings?: Record<string, string>;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Reads a property `CSSStyleDeclaration`'s own type omits on some targets. */
function cssProperty(cs: CSSStyleDeclaration, name: string): string {
  const value = (cs as unknown as Record<string, string | undefined>)[name];
  return typeof value === "string" ? value : "";
}

/**
 * The angle an element's own `rotate` property carries.
 *
 * `rotate` is a standalone property now, so a page that rotates with it has
 * `transform: none` and the old code read nothing at all — the element came
 * across unrotated, unreported, and carrying the AXIS-ALIGNED bound the browser
 * measured, which is a different shape from the one the page drew.
 *
 * Composed onto `transform`'s own rotation, which is what CSS does. An axial
 * form (`rotate: y 30deg`) has no dialect spelling and yields `undefined`, so
 * the caller names it instead of inventing an angle from its first number.
 */
function standaloneRotation(cs: CSSStyleDeclaration): number | undefined {
  const raw = cssProperty(cs, "rotate");
  if (!raw || raw === "none") return undefined;
  const trimmed = raw.trim();
  return /^-?[\d.]+deg$/.test(trimmed) ? Number.parseFloat(trimmed) : undefined;
}

function sideValue(cs: CSSStyleDeclaration, side: string, suffix: string): string {
  return cs.getPropertyValue(`border-${side}-${suffix}`) || (cs as unknown as Record<string, string>)[`border${cap(side)}${cap(suffix)}`] || "";
}

/**
 * The four border widths, and whether they agree.
 *
 * "Agree" is asked of the sides that are actually DRAWN. A computed border
 * colour is reported for every side whether or not the side has a width, and the
 * three sides nobody painted carry the initial `currentColor` — comparing those
 * too made a single-side rule (`border-left: 1px solid var(--line)`) look like a
 * four-colour border, which the DSL cannot express, and sent seven elements down
 * the "unmapped" path for a border it had already mapped exactly.
 *
 * Asking it ONLY of the drawn sides is the other half of that mistake: one drawn
 * side trivially "agrees with itself", so `border-bottom: 1px solid var(--acc)`
 * came back uniform and `strokeFrom` wrote it as a full outline — a tab's
 * underline arrived as a box around the tab. A uniform border is all four sides;
 * anything less is a `side`/`sides` stroke.
 */
export function borderWidthsOf(cs: CSSStyleDeclaration): BorderWidths {
  const widths = SIDES.map((side) => {
    const style = sideValue(cs, side, "style");
    if (!style || style === "none" || style === "hidden") return 0;
    return Math.max(0, px(sideValue(cs, side, "width")) ?? 0);
  });
  const colours = SIDES.map((side) => parseCssColor(sideValue(cs, side, "color")));
  const drawn = widths.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
  const drawnWidths = drawn.map((i) => widths[i]);
  const drawnColours = drawn.map((i) => colours[i]?.color ?? null);
  return {
    top: widths[0],
    right: widths[1],
    bottom: widths[2],
    left: widths[3],
    uniform:
      drawn.length === SIDES.length &&
      drawnWidths.every((w) => Math.abs(w - drawnWidths[0]) < 1e-6) &&
      drawnColours.every((c) => c === drawnColours[0]),
    color: drawnColours[0] ?? null
  };
}

/**
 * The one line style a drawn border uses, which is all `Stroke.style` holds.
 *
 * A dashed hairline is how every empty state, drop target and "add" affordance
 * is drawn, and it was arriving solid: `style` was written from nothing at all.
 * `dotted` has no DSL spelling and is named rather than silently upgraded, for
 * the same reason an unmappable radius is.
 */
function borderStyleOf(cs: CSSStyleDeclaration, widths: number[], sink: UnmappedSink): Stroke["style"] {
  const styles = SIDES.map((side) => sideValue(cs, side, "style"));
  const drawn = SIDES.map((side, i) => (widths[i] > 0 ? i : -1)).filter((i) => i >= 0);
  const used = drawn.map((i) => styles[i]);
  if (new Set(used).size > 1) sink("border-style", used.join(" "));
  const first = used[0] ?? "solid";
  if (first === "dashed") return "dashed";
  /* The 3D words are how a UA stylesheet draws a native control's edge, and each
     of them paints one colour along the border — what a solid stroke draws. They
     are folded rather than named so every unstyled `<input>` and `<button>` does
     not put a row in the report; `dotted` and `double` are genuinely a different
     line and are said instead. */
  if (first === "inset" || first === "outset" || first === "groove" || first === "ridge") return "solid";
  if (first !== "solid") sink("border-style", first);
  return "solid";
}

/**
 * The colour token a border was written with, or nothing.
 *
 * Asked of every DRAWN side and only accepted when they agree on one custom
 * property: `border-bottom: 1px solid var(--line)` is a tab's underline, and
 * binding the whole stroke to whatever `border-color` happens to answer would
 * turn the other three sides into a box the page never drew.
 */
function strokeTokenOf(cs: CSSStyleDeclaration, border: BorderWidths, tokens: TokenSource): string | undefined {
  if (!tokens || !border.color) return undefined;
  const widths = [border.top, border.right, border.bottom, border.left];
  /* The shorthand is in the list because Chrome answers NOTHING for the longhand
     when the shorthand carries a `var()` — the whole declaration sits behind a
     pending substitution until computed-value time, and `border: 1px solid
     var(--line)`, the commonest way to write one, then binds to no token at all.
     Most specific first, which is the order the cascade would resolve in. */
  const names = SIDES.map((side, i) =>
    widths[i] > 0 ? tokens.name([`border-${side}-color`, `border-${side}`, "border-color", "border"]) : undefined
  );
  const drawn = names.filter((name, i) => widths[i] > 0);
  if (drawn.length === 0 || drawn.some((name) => !name)) return undefined;
  if (new Set(drawn).size > 1) return undefined;
  const first = names.findIndex((name) => name !== undefined);
  return tokens.color([`border-${SIDES[first]}-color`, `border-${SIDES[first]}`, "border-color", "border"], border.color);
}

function strokeFrom(
  cs: CSSStyleDeclaration,
  border: BorderWidths,
  sink: UnmappedSink,
  tokens?: TokenSource
): Stroke | undefined {
  const widths = [border.top, border.right, border.bottom, border.left];
  if (widths.every((w) => w === 0)) return undefined;
  if (!border.color) return undefined;

  const style = borderStyleOf(cs, widths, sink);
  const tokenId = strokeTokenOf(cs, border, tokens);

  // `align: "inside"` because that is what a CSS border is: the box it is drawn
  // in is the border box, and the content starts inside it. The layout padding
  // is widened by the same amount so children land where the browser put them.
  if (border.uniform) {
    return { color: border.color, width: Math.max(...widths), align: "inside", style, ...(tokenId ? { tokenId } : {}) };
  }

  const drawnColours = SIDES.map((side, i) => (widths[i] > 0 ? parseCssColor(sideValue(cs, side, "color"))?.color ?? null : null)).filter(Boolean);
  if (new Set(drawnColours).size > 1) {
    // `Stroke.sides` carries widths only — a per-side colour has nowhere to go.
    sink("border-color", SIDES.map((s) => sideValue(cs, s, "color")).join(" "));
  }
  return {
    color: border.color,
    width: Math.max(...widths),
    align: "inside",
    style,
    ...(tokenId ? { tokenId } : {}),
    side: "custom",
    sides: {
      ...(widths[0] > 0 ? { top: widths[0] } : {}),
      ...(widths[1] > 0 ? { right: widths[1] } : {}),
      ...(widths[2] > 0 ? { bottom: widths[2] } : {}),
      ...(widths[3] > 0 ? { left: widths[3] } : {})
    }
  };
}

/** A corner radius length, with a percentage resolved against the box it rounds. */
function radiusLength(raw: string, basis: number): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return undefined;
  if (value.endsWith("%")) return (n / 100) * basis;
  return Math.max(0, n);
}

function radiusFrom(
  cs: CSSStyleDeclaration,
  box: { width: number; height: number },
  sink: UnmappedSink
): CornerRadius | undefined {
  const keys = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"];
  const corners: number[] = [];
  for (const key of keys) {
    const raw = cs.getPropertyValue(key).trim();
    if (!raw) {
      corners.push(0);
      continue;
    }
    // Chrome writes a slash radius as the two longhand values: `10px 20px`.
    const parts = raw.split(/\s+/);
    const horizontal = radiusLength(parts[0], box.width);
    // A SINGLE value is one radius on each axis, not one radius borrowed from
    // the width: `border-radius: 50%` is `50% / 50%`, which is a circle only on
    // a square box. Reading it from the width alone turned every ellipse into a
    // round-rect of half the width — and because the vertical then agreed with
    // the horizontal, the check below could not see that either.
    const vertical = parts.length > 1 ? radiusLength(parts[1], box.height) : radiusLength(parts[0], box.height);
    if (horizontal === undefined || vertical === undefined) {
      sink("border-radius", raw);
      return undefined;
    }
    if (Math.abs(horizontal - vertical) > 0.5) {
      // An elliptical corner has two radii; the DSL has one.
      sink("border-radius", raw);
      return undefined;
    }
    corners.push(horizontal);
  }
  if (corners.every((r) => r === 0)) return undefined;
  if (corners.every((r) => Math.abs(r - corners[0]) < 1e-6)) return corners[0];
  return corners as [number, number, number, number];
}

function effectsFrom(
  cs: CSSStyleDeclaration,
  filter: ReturnType<typeof parseFilterValue>,
  sink: UnmappedSink
): Effect[] {
  const out: Effect[] = [];
  for (const shadow of parseBoxShadows(cs.boxShadow)) {
    out.push({
      type: shadow.inset ? "inner-shadow" : "drop-shadow",
      color: shadow.color,
      offset: { x: shadow.offsetX, y: shadow.offsetY },
      blur: shadow.blur,
      ...(shadow.spread !== 0 ? { spread: shadow.spread } : {}),
      enabled: true
    });
  }
  for (const shadow of filter.shadows) {
    out.push({
      type: "drop-shadow",
      color: shadow.color,
      offset: { x: shadow.offsetX, y: shadow.offsetY },
      blur: shadow.blur,
      ...(shadow.spread !== 0 ? { spread: shadow.spread } : {}),
      enabled: true
    });
  }
  if (filter.blur !== undefined && filter.blur > 0) {
    out.push({ type: "layer-blur", blur: filter.blur, enabled: true });
  }
  for (const name of filter.unsupported) sink("filter", `${name}()`);

  // `backdrop-filter` is the same blur applied to what is BEHIND the element,
  // which is exactly the DSL's `backdrop-blur`. Only the blur half maps: the
  // colour adjustments act on the backdrop and have no counterpart.
  const backdrop = cs.backdropFilter;
  if (backdrop && backdrop !== "none") {
    const parsed = parseFilterValue(backdrop);
    if (parsed.blur !== undefined && parsed.blur > 0) {
      out.push({ type: "backdrop-blur", blur: parsed.blur, enabled: true });
    }
    if (parsed.filter) sink("backdrop-filter", backdrop);
    for (const name of parsed.unsupported) sink("backdrop-filter", `${name}()`);
  }
  return out;
}

/**
 * `background-size` → the DSL's image `fit`.
 *
 * The DSL can stretch, cover or contain; it cannot draw a bitmap at its own
 * size. `auto` is the default and is therefore mapped rather than reported, but
 * it is an approximation — a natural-size tile comes across stretched to the
 * box — and every other size is reported as well as approximated.
 */
const FIT: Record<string, ImagePaint["fit"]> = {
  cover: "cover",
  contain: "contain",
  "100% 100%": "fill"
};

/** `background-position: 0% 0%` is the DSL's own framing — the box's top-left. */
function isDefaultPosition(raw: string): boolean {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true;
  if (parts[0] === "0%" || parts[0] === "left") return parts[1] === undefined || parts[1] === "0%" || parts[1] === "top";
  return false;
}

function urlPaint(
  url: string,
  cs: CSSStyleDeclaration,
  box: { width: number; height: number },
  sink: UnmappedSink,
  resolveAsset: AssetResolver | undefined,
  onMissing?: (url: string, paint: MissingPaint) => void
): ImagePaint | null {
  // The framing is CSS, so it is solved whether or not the bytes arrive: a
  // folder attached later only has to supply the asset.
  const fit = FIT[cs.backgroundSize] ?? "fill";
  const template: MissingPaint = { fit };
  const found = resolveAsset?.(url, { name: "background", width: box.width, height: box.height });
  if (!found?.assetId) {
    // Named in the page's own spelling, so the report reads like the HTML does.
    const pageUrl = found?.url ?? url;
    sink("background-image", found?.reason ? `${pageUrl} — ${found.reason}` : pageUrl);
    onMissing?.(pageUrl, template);
    return null;
  }
  // Every size the DSL cannot spell is named, `auto` included: `auto` draws the
  // bitmap at its own size and centred-on-nothing besides, where the import
  // stretches it to the box. The old code left `auto` silent, which made a
  // decorative bitmap look imported correctly when it had been resized.
  if (!FIT[cs.backgroundSize]) sink("background-size", cs.backgroundSize);
  // An IMAGE paint covers the whole box and cannot tile, so `repeat` is the
  // value that loses something and `no-repeat` is the one that does not — the
  // reverse of what was being reported. (A procedural `pattern` paint can tile,
  // but a bitmap has no motif to read out of it.)
  if (cs.backgroundRepeat !== "no-repeat") sink("background-repeat", cs.backgroundRepeat);
  if (!isDefaultPosition(cs.backgroundPosition)) sink("background-position", cs.backgroundPosition);
  return { type: "image", assetId: found.assetId, ...template };
}

/**
 * `background-clip: text` paints the background INSIDE the glyphs, so the layers
 * are the text's ink and the box has none. Read as a box fill they cover the
 * words with the very gradient that was meant to be seen through them, which is
 * how every `linear-gradient` headline imports as a blank slab.
 */
function clipsBackgroundToText(cs: CSSStyleDeclaration): boolean {
  return cs.backgroundClip === "text" || cssProperty(cs, "webkitBackgroundClip") === "text";
}

function fillsFrom(
  cs: CSSStyleDeclaration,
  box: { width: number; height: number },
  sink: UnmappedSink,
  resolveAsset: AssetResolver | undefined,
  onMissing: ((url: string, paint: MissingPaint) => void) | undefined,
  tokens: TokenSource
): { fills?: PaintStack; textFills?: PaintStack } {
  const toText = clipsBackgroundToText(cs);
  const fills: Paint[] = [];
  const textFills: Paint[] = [];
  const stack = toText ? textFills : fills;

  const background = parseCssColor(cs.backgroundColor);
  if (background) {
    const tokenId = tokens?.color(["background-color", "background"], background.color);
    stack.push({
      type: "solid",
      color: background.color,
      ...(background.opacity !== undefined ? { opacity: background.opacity } : {}),
      ...(tokenId ? { tokenId } : {})
    });
  }

  const layers = backgroundLayers(cs.backgroundImage);
  // CSS paints the FIRST layer on top; the DSL's stack is bottom-first.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const paint = paintFromBackgroundImage(layer, box.width, box.height);
    if (paint) {
      stack.push(paint);
      continue;
    }
    const urls = backgroundImageUrls(layer);
    if (urls.length > 0) {
      // Whatever could not be inlined is reported here, with the reason the
      // asset pass recorded — a missing bitmap and an unreadable one differ.
      const paint = urlPaint(urls[urls.length - 1], cs, box, sink, resolveAsset, onMissing);
      if (paint) stack.push(paint);
    } else if (layer && layer !== "none") {
      sink("background-image", layer);
    }
  }

  return {
    fills: fills.length > 0 ? fills : undefined,
    textFills: textFills.length > 0 ? textFills : undefined
  };
}

function clipFrom(cs: CSSStyleDeclaration, sink: UnmappedSink): boolean | undefined {
  const x = cs.overflowX;
  const y = cs.overflowY;
  const clips = (v: string) => v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
  if (!clips(x) && !clips(y)) return undefined;
  if (x !== y) sink("overflow", `${x} ${y}`);
  // The DSL clips but never scrolls, so a scrolling container keeps its visible
  // frame and loses the content past the edge.
  if (x === "auto" || x === "scroll" || y === "auto" || y === "scroll") {
    sink("overflow", `${x} ${y}`);
  }
  return true;
}

export function visualStyleOf(
  cs: CSSStyleDeclaration,
  box: { width: number; height: number },
  sink: UnmappedSink,
  resolveAsset?: AssetResolver,
  onMissingImage?: (url: string, paint: MissingPaint) => void,
  tokens?: TokenSource
): VisualStyle {
  const border = borderWidthsOf(cs);
  const filter = parseFilterValue(cs.filter);
  const effects = effectsFrom(cs, filter, sink);
  const stroke = strokeFrom(cs, border, sink, tokens);
  const opacity = px(cs.opacity);

  const blendMode = cs.mixBlendMode && cs.mixBlendMode !== "normal" ? (cs.mixBlendMode as BlendMode) : undefined;

  /* The angle is resolved BEFORE it is trusted, because everything it is checked
     against is measured on the box the element had before rotating: `getBounding
     ClientRect` hands back the axis-aligned bound, which for a rotated element is
     larger than it is, so comparing `transform-origin` against THAT box found the
     centre was off and reported every rotation as lost. Undoing the angle on the
     bound recovers the layout box, which is what `transform-origin` is half of. */
  const matrixAngle = cs.transform && cs.transform !== "none" ? rotationFromTransform(cs.transform) : undefined;
  const spin = standaloneRotation(cs);

  let rotation: number | undefined;
  if (cs.transform && cs.transform !== "none") {
    // A pure translation is already inside the box the browser measured, so the
    // DSL reproduces it by drawing the element at that origin — reporting it
    // would name a gap that does not exist.
    if (matrixAngle !== undefined) rotation = matrixAngle;
    else if (!isPureTranslation(cs.transform)) sink("transform", cs.transform);
  }
  if (spin !== undefined) {
    rotation = (rotation ?? 0) + spin;
  }

  if (cs.position === "fixed" || cs.position === "sticky") sink("position", cs.position);
  // `z-index` is NOT reported here: the walk carries it as the siblings' paint
  // order, and only it knows whether that could be done (see `paintOrderOf`).
  if (cs.clipPath && cs.clipPath !== "none") sink("clip-path", cs.clipPath);
  if (cs.isolation && cs.isolation !== "auto") sink("isolation", cs.isolation);

  /* Everything from here is a declaration the dialect has no field for and whose
     loss changes what is DRAWN rather than merely what is stored. Each is named
     because a silence here is indistinguishable from a property that mapped. */
  const scaled = cssProperty(cs, "scale");
  if (scaled && scaled !== "none") {
    const axes = scaled.trim().split(/\s+/).map(Number.parseFloat);
    if (axes.some((n) => !Number.isFinite(n) || n !== 1)) sink("scale", scaled);
  }
  if (cs.outlineStyle && cs.outlineStyle !== "none" && (px(cs.outlineWidth) ?? 0) > 0) {
    sink("outline", `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`.trim());
  }
  const masked = cssProperty(cs, "maskImage") || cssProperty(cs, "webkitMaskImage");
  if (masked && masked !== "none") sink("mask-image", masked);
  // `writing-mode` is not reported here: a vertical LINE is reproduced by the
  // walk as horizontal text carrying a quarter turn, and only it knows whether
  // the element is the kind of text leaf that can be turned.
  if (cs.direction === "rtl") sink("direction", cs.direction);
  const columns = Number.parseFloat(cs.columnCount);
  if (Number.isFinite(columns) && columns > 1) sink("column-count", cs.columnCount);

  // Size bounds are NOT reported here any more: the layout engine resolves them
  // now (`sizing.min/maxWidth|Height`), and `childSizingFor` reads them off this
  // same computed style. What still cannot be carried is a bound written in a
  // unit the import does not parse, or one on an element that gets no sizing at
  // all — both are named by the walk, not by the visual pass.

  const style: VisualStyle = { border };
  const { fills, textFills } = fillsFrom(cs, box, sink, resolveAsset, onMissingImage, tokens);
  if (fills) style.fills = fills;
  if (textFills) style.textFills = textFills;
  if (stroke) style.stroke = stroke;
  const radius = radiusFrom(cs, box, sink);
  if (radius !== undefined) {
    style.borderRadius = radius;
    if (typeof radius === "number" && tokens) {
      const tokenId = tokens.number(["border-radius", "border-top-left-radius"], radius);
      if (tokenId) style.tokenBindings = { ...style.tokenBindings, borderRadius: tokenId };
    }
  }

  /* `box-shadow: inset 0 0 0 1px <c>` over a background with nothing in it is a
     1px border written the long way — every ghost chip and hairline swatch in a
     dark UI is spelled that way. As a shadow it needs a silhouette, and a
     transparent background has none: the element covers no pixels, so the filter
     has nothing to flood and the ring silently disappears. As a stroke it draws
     in every consumer, and it is what the page actually meant. Only the exact
     no-offset, no-blur form converts — `inset 0 2px 0 <c>` is a bar, not a
     border, and still needs the shadow. */
  const emptyBackground = cs.backgroundImage === "none" && parseCssColor(cs.backgroundColor) === null;
  if (!stroke && emptyBackground && effects.length === 1) {
    const ring = effects[0] as InnerShadowEffect;
    if (ring.type === "inner-shadow" && ring.offset.x === 0 && ring.offset.y === 0 && ring.blur === 0 && (ring.spread ?? 0) > 0) {
      style.stroke = {
        color: ring.color,
        width: ring.spread as number,
        align: "inside",
        style: "solid"
      };
      effects.length = 0;
    }
  }

  if (effects.length > 0) style.effects = effects;
  if (filter.filter) style.adjust = filter.filter;
  if (opacity !== undefined && opacity < 1) style.opacity = opacity;
  if (blendMode) style.blendMode = blendMode;
  const clip = clipFrom(cs, sink);
  if (clip) style.clipContent = true;
  if (rotation !== undefined && Math.abs(rotation) > 1e-6) style.rotation = round2(rotation);
  if (cs.visibility === "hidden" || cs.visibility === "collapse") style.visible = false;
  return style;
}

const ALIGN: Record<string, TextStyle["align"]> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
  justify: "justify"
};

export interface TextStyleResult {
  style: TextStyle;
  maxLines?: number;
  textOverflow?: TextStyle["textOverflow"];
  /**
   * The paint the glyphs are drawn with, as the fill stack the DSL reads.
   *
   * An EMPTY array is a DECISION, not an absence: `color: transparent` is how
   * the web writes a heading whose ink is a stroke or a clipped gradient, and
   * the two must not collapse into each other.
   */
  fills: Paint[];
  /** `-webkit-text-stroke` — the other half of an outline-only heading. */
  strokes?: Stroke[];
  /**
   * `property → Number Token id`, for a type size or tracking the page wrote as
   * `var(--x)`. Element-level, like every other numeric binding: the value stays
   * on `style` beside it.
   */
  tokenBindings?: Record<string, string>;
}

/**
 * `-webkit-text-stroke` → the DSL's stroke.
 *
 * `color: transparent` under a stroked heading is the standard CSS for outline
 * type, and the DSL models it exactly — an empty fill stack plus a stroke — so
 * the property has to be read, or every such heading arrives as solid black
 * glyphs with no outline at all. It is a `-webkit-` shorthand, so the width and
 * the colour are read from the longhands when the shorthand is unusable; the
 * align is the default `center`, which is what the browser draws.
 */
function textStrokeOf(cs: CSSStyleDeclaration, sink: UnmappedSink): Stroke[] | undefined {
  // Both spellings, because `CSSStyleDeclaration`'s own type omits the
  // `-webkit-` pair on some targets and `cssProperty` is the untyped read.
  const read = (kebab: string, camel: string): string =>
    cssProperty(cs, camel) || cs.getPropertyValue(`-webkit-${kebab}`);
  const shorthand = read("text-stroke", "webkitTextStroke").trim();
  const match = shorthand ? /^([\d.]+)px\s+(.+)$/.exec(shorthand) : null;
  const width = match ? Number(match[1]) : px(read("text-stroke-width", "webkitTextStrokeWidth"));
  if (width === undefined || !(width > 0)) return undefined;
  const colour = (match ? match[2] : read("text-stroke-color", "webkitTextStrokeColor")).trim();
  const paint = parseCssColor(colour);
  if (!paint) {
    if (!isFullyTransparent(colour)) sink("-webkit-text-stroke-color", colour);
    return undefined;
  }
  return [{ color: paint.color, width, ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}) }];
}

export function textStyleOf(
  cs: CSSStyleDeclaration,
  sink: UnmappedSink,
  clippedTextFills?: PaintStack,
  tokens?: TokenSource
): TextStyleResult {
  const decoration: TextStyle["textDecoration"] = [];
  for (const line of cs.textDecorationLine.split(/\s+/)) {
    if (line === "underline" || line === "line-through") decoration.push(line);
    else if (line && line !== "none") sink("text-decoration-line", line);
  }
  /* Only the LINE survives: the dialect's `textDecoration` is a list of names.
     A heading underlined in a lighter grey than itself, a `wavy` validation
     hint and a thickening that keeps a long descender clear of the rule are all
     common and all invisible after this — so the colour, the style and the
     offset name themselves rather than leaving an apparently faithful underline
     behind. */
  if (decoration.length > 0) {
    const colour = cs.getPropertyValue("text-decoration-color");
    if (colour && colour !== cs.color) sink("text-decoration-color", cs.textDecorationColor);
    const styleToken = cssProperty(cs, "textDecorationStyle");
    if (styleToken && styleToken !== "solid") sink("text-decoration-style", styleToken);
    const thickness = px(cssProperty(cs, "textDecorationThickness"));
    const auto = Math.max(1, (Number.parseFloat(cs.fontSize) || 16) * 0.05);
    if (thickness !== undefined && Math.abs(thickness - auto) > 0.5) sink("text-decoration-thickness", String(thickness));
    const offset = px(cssProperty(cs, "textUnderlineOffset"));
    if (offset !== undefined && Math.abs(offset) > 0.5) sink("text-underline-offset", String(offset));
  }

  const fontSize = Math.max(1, px(cs.fontSize) ?? 16);
  const weightRaw = cs.fontWeight;
  const weight = /^\d+$/.test(weightRaw) ? parseInt(weightRaw, 10) : undefined;
  const letterSpacingRaw = cs.letterSpacing;
  const letterSpacing = letterSpacingRaw === "normal" ? undefined : px(letterSpacingRaw);
  const transformRaw = cs.textTransform;

  /* `start` / `end` are DIRECTION-relative and `left` / `right` are physical, so
     the same `text-align: start` means opposite alignments in an RTL block.
     Both resolve to a physical value the dialect can hold, and the direction
     itself is reported by the caller because every other axis of the box — the
     reading order of the runs, which side padding lands on — is still wrong. */
  const rtl = cs.direction === "rtl";
  let align = ALIGN[cs.textAlign];
  if (!align || align === (rtl ? "right" : "left")) {
    const display = cs.display;
    if (display === "flex" || display === "inline-flex") {
      const isCol = cs.flexDirection.startsWith("column");
      const flexAlign = isCol ? cs.alignItems : cs.justifyContent;
      if (flexAlign === "center" || flexAlign === "space-around" || flexAlign === "space-evenly") {
        align = "center";
      } else if (flexAlign === "flex-end" || flexAlign === "end") {
        align = rtl ? "left" : "right";
      } else if (flexAlign === "flex-start" || flexAlign === "start") {
        align = rtl ? "right" : "left";
      }
    } else if (display === "grid" || display === "inline-grid") {
      const gridAlign = cs.justifyItems || cs.justifyContent;
      if (gridAlign === "center" || gridAlign === "space-around" || gridAlign === "space-evenly") {
        align = "center";
      } else if (gridAlign === "end" || gridAlign === "flex-end") {
        align = rtl ? "left" : "right";
      } else if (gridAlign === "start" || gridAlign === "flex-start") {
        align = rtl ? "right" : "left";
      }
    }
  }
  const side = rtl && (align === "left" || align === "right") ? (align === "left" ? "right" : "left") : align;

  /* `color` is the one property here that can also spell its own ABSENCE.
     `parseCssColor` reads `transparent` / `rgba(0,0,0,0)` as `null` — the same
     answer it gives for a value it does not implement — and the old
     `?? "#000000"` collapsed both onto black, so a heading the page HID behind
     `color: transparent` imported as solid black ink. The two are told apart
     here, with the same ruler the shape fills use: a transparent colour is the
     author's decision and becomes an empty stack, an unrecognised value is a
     named gap rather than an invented black. */
  const ink = parseCssColor(cs.color);
  const hidden = !ink && isFullyTransparent(cs.color);
  if (!ink && !hidden) sink("color", cs.color);
  /* A paint's `opacity` IS carried, on the stack the renderer and the exporter
     both read (`fill-opacity` / the foreignObject's own `opacity`). It used to be
     named and dropped, back when a text was believed to paint `style.color`
     alone — a belief that left every `rgba(255,255,255,.55)` label imported at
     full strength. */
  const inkToken = clippedTextFills ? undefined : ink ? tokens?.color("color", ink.color) : undefined;
  const fills: Paint[] = clippedTextFills
    ? [...clippedTextFills]
    : ink
      ? [
          {
            type: "solid",
            color: ink.color,
            ...(ink.opacity !== undefined ? { opacity: ink.opacity } : {}),
            ...(inkToken ? { tokenId: inkToken } : {})
          }
        ]
      : [];

  const style: TextStyle = {
    fontFamily: cs.fontFamily,
    fontSize,
    ...(weight !== undefined ? { fontWeight: weight } : {}),
    ...(cs.fontStyle === "italic" || cs.fontStyle === "oblique" ? { fontStyle: "italic" as const } : {}),
    ...(cs.fontVariantNumeric === "tabular-nums" ? { fontVariantNumeric: "tabular-nums" as const } : {}),
    ...(letterSpacing !== undefined ? { letterSpacing } : {}),
    ...(side ? { align: side } : {}),
    color: ink?.color ?? (hidden ? "transparent" : "#000000"),
    ...(decoration.length > 0 ? { textDecoration: decoration } : {}),
    ...(transformRaw === "uppercase" || transformRaw === "lowercase" || transformRaw === "capitalize"
      ? { textTransform: transformRaw }
      : {}),
    ...(cs.textShadow && cs.textShadow !== "none" ? { textShadow: cs.textShadow } : {})
  };

  // `white-space: nowrap` is the one CSS value that maps onto a line clamp
  // exactly: a single line, cut at the box edge, with `text-overflow` deciding
  // whether the cut is spelled with an ellipsis. `pre` does not wrap either, but
  // its content is multi-line BY CONSTRUCTION — clamping it would collapse a
  // `<pre>` to one clipped line and drop the newlines `collapseText` went to the
  // trouble of keeping — so it is named as the gap it is instead.
  const nowrap = cs.whiteSpace === "nowrap";
  const strokes = textStrokeOf(cs, sink);
  const tokenBindings: Record<string, string> = {};
  if (tokens) {
    const size = tokens.number("font-size", fontSize);
    if (size) tokenBindings.fontSize = size;
    if (letterSpacing !== undefined) {
      const tracking = tokens.number("letter-spacing", letterSpacing);
      if (tracking) tokenBindings.letterSpacing = tracking;
    }
  }
  const result: TextStyleResult = {
    style,
    fills,
    ...(strokes ? { strokes } : {}),
    ...(Object.keys(tokenBindings).length > 0 ? { tokenBindings } : {})
  };
  if (nowrap) {
    result.maxLines = 1;
    result.textOverflow = cs.textOverflow === "ellipsis" ? "ellipsis" : "clip";
  }
  // See the note above about `nowrap`: it is carried, `pre` and its relatives
  // are not, because their newlines have no dialect spelling. `text-indent`
  // moves the first line of every paragraph and has no field either, and the
  // break opportunities `word-break` / `overflow-wrap` describe are decided by
  // the user agent at layout — the imported text may well break elsewhere, so
  // both are named rather than left to look faithful.
  if (cs.whiteSpace !== "normal" && !nowrap) sink("white-space", cs.whiteSpace);
  const indent = px(cs.textIndent);
  if (indent !== undefined && Math.abs(indent) > 0.5) sink("text-indent", cs.textIndent);
  if (cs.wordBreak && cs.wordBreak !== "normal") sink("word-break", cs.wordBreak);
  // `word-break: break-all` and `overflow-wrap: break-word` both cut a word that
  // is wider than the line, and the layout engine does not: `wrapLines` breaks at
  // whitespace and lets a longer segment overflow. So every value but `normal` is
  // a real gap, `break-word` included.
  if (cs.overflowWrap && cs.overflowWrap !== "normal") sink("overflow-wrap", cs.overflowWrap);
  if (cs.hyphens && cs.hyphens !== "manual") sink("hyphens", cs.hyphens);

  /* `-webkit-line-clamp` is how nearly every card, list row and search result
     truncates, and it maps onto what the dialect already has: N lines, cut at
     the box edge, with an ellipsis. Without it the full string arrives and
     overflows the box the browser clamped it inside. Read only where it is in
     force — clamp without `overflow: hidden` draws every line anyway. */
  if (!nowrap) {
    const clamp = Number.parseFloat(cssProperty(cs, "webkitLineClamp"));
    if (Number.isFinite(clamp) && clamp > 0 && (cs.overflow === "hidden" || cs.overflowY === "hidden")) {
      result.maxLines = clamp;
      result.textOverflow = "ellipsis";
    }
  }
  return result;
}
