import type { GradientStop, ImageCrop, ImagePaint, Paint, PaintStack, PatternAlignment, PatternMotif, PatternPaint, PatternTileType } from "../types";
import { canonicalGradientStops, firstStopTokenId, gradientIsFlat } from "../gradient-stops";
import { clampCrop } from "../../geometry/image-crop";
import { asNumber, clamp, canonicalKey, isPlainObject, FIT_ALIASES, NormalizationRepair } from "./shared";
import { normalizeColorFilter } from "./text-sizing";
import { readBlendMode, reportRefusedBlendMode } from "./blend-mode";
import { paintFromBackgroundImage, backgroundLayers } from "../../import/css-values";
import { PATTERN_ALIGNMENTS, PATTERN_MOTIFS, PATTERN_TILE_TYPES } from "../schema-enums";

/**
 * The spellings a motif arrives as. An unknown one falls back to `dots` with a
 * repair note rather than dropping the layer, because a pattern with a typo is
 * still a pattern the author meant to see.
 */
const PATTERN_MOTIF_ALIASES: Record<string, PatternMotif> = {
  dots: "dots",
  dot: "dots",
  circles: "dots",
  polka: "dots",
  grid: "grid",
  lines: "grid",
  gridlines: "grid",
  "diagonal-stripes": "diagonal-stripes",
  "diagonal-stripe": "diagonal-stripes",
  "diagonal-lines": "diagonal-stripes",
  diagonal: "diagonal-stripes",
  stripes: "diagonal-stripes",
  stripe: "diagonal-stripes",
  crosshatch: "crosshatch",
  "cross-hatch": "crosshatch",
  hatch: "crosshatch",
  lattice: "crosshatch",
  checker: "checker",
  checkerboard: "checker",
  checks: "checker",
  squares: "checker"
};

/** Clamps a paint-layer opacity (accepted as `opacity` or `alpha`) to 0..1. */
export function normalizePaintOpacity(raw: unknown): number | undefined {
  const value = asNumber(raw);
  if (value === undefined) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** A ramp that collapses to a solid keeps the token it was following. */
function solidFromRamp(color: string, stops: GradientStop[] | undefined): Paint {
  const tokenId = firstStopTokenId(stops);
  return { type: "solid", color, ...(tokenId ? { tokenId } : {}) };
}

/**
 * The gradient fields that sit beside `from`/`to` and are read by the renderer.
 * Dropping them here is what flattened every authored ramp to its two endpoints
 * on the first save, so they are carried through verbatim.
 */
function gradientExtras(
  raw: Record<string, unknown>,
  stops: GradientStop[] | undefined
): { stops?: GradientStop[]; fromOffset?: number; toOffset?: number } {
  const fromOffset = asNumber(raw.fromOffset);
  const toOffset = asNumber(raw.toOffset);
  return {
    ...(stops && stops.length > 0 ? { stops } : {}),
    ...(fromOffset !== undefined ? { fromOffset: clamp(fromOffset, 0, 1) } : {}),
    ...(toOffset !== undefined ? { toOffset: clamp(toOffset, 0, 1) } : {})
  };
}

/**
 * Centre in the unit square, and the start angle normalised to `0..360` — the
 * two fields every centred gradient shape reads, angular ones included.
 * `center` doubles as an alias for the inner colour when it is a string, so
 * only the object form is read.
 */
function centreAndAngle(raw: Record<string, unknown>): {
  center?: { x: number; y: number };
  angle?: number;
} {
  const rawCenter = isPlainObject(raw.center) ? raw.center : isPlainObject(raw.centre) ? raw.centre : undefined;
  const cx = rawCenter ? asNumber(rawCenter.x) : undefined;
  const cy = rawCenter ? asNumber(rawCenter.y) : undefined;
  const rawAngle = asNumber(raw.angle);
  return {
    ...(cx !== undefined && cy !== undefined ? { center: { x: clamp(cx, 0, 1), y: clamp(cy, 0, 1) } } : {}),
    ...(rawAngle !== undefined && rawAngle !== 0 ? { angle: ((rawAngle % 360) + 360) % 360 } : {})
  };
}

/**
 * Radial / diamond geometry — every field except `angle`'s meaning is shared:
 * both are a centred shape whose extent is a circle or an ellipse.
 *
 * The circle/ellipse pair is kept canonical: `radius` is the circle shorthand
 * and rx/ry the ellipse form, and an authored value on one side fills the other
 * (radius → rx=ry; a lone rx or ry mirrors itself; equal rx/ry writes radius
 * back), so no reader ever has to consult both.
 */
function ellipseExtras(raw: Record<string, unknown>): {
  center?: { x: number; y: number };
  radius?: number;
  rx?: number;
  ry?: number;
  angle?: number;
} {
  const radius = asNumber(raw.radius);
  let rx = asNumber(raw.rx);
  let ry = asNumber(raw.ry);
  if (rx === undefined && ry === undefined && radius !== undefined) {
    rx = Math.max(0, radius);
    ry = rx;
  }
  if (rx !== undefined && ry === undefined) ry = rx;
  if (ry !== undefined && rx === undefined) rx = ry;
  if (rx !== undefined) rx = Math.max(0, rx);
  if (ry !== undefined) ry = Math.max(0, ry);
  const syncedRadius = rx !== undefined && rx === ry ? rx : undefined;
  const { center, angle } = centreAndAngle(raw);
  return {
    ...(center !== undefined ? { center } : {}),
    ...(syncedRadius !== undefined ? { radius: syncedRadius } : {}),
    ...(rx !== undefined ? { rx } : {}),
    ...(ry !== undefined ? { ry } : {}),
    ...(angle !== undefined ? { angle } : {})
  };
}

/**
 * Angular-only geometry: the sweep has a centre and a start angle, but no
 * extent — it always closes after a full turn, so `radius` / `rx` / `ry` are
 * not read and are dropped with a repair if authored.
 */
function angularExtras(raw: Record<string, unknown>): {
  center?: { x: number; y: number };
  angle?: number;
} {
  return centreAndAngle(raw);
}

/** A fraction-space {x, y} point (linear axis endpoints); finite numbers only. */
function fractionPoint(raw: unknown): { x: number; y: number } | undefined {
  if (!isPlainObject(raw)) return undefined;
  const x = asNumber(raw.x);
  const y = asNumber(raw.y);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

/**
 * `path` / `repairs` are optional because not every reader of a paint can name
 * where it found it: a caller that can, gets a repair for a `blendMode` that
 * names no mode; a caller that cannot (a bare probe, a test) still gets the
 * value.
 */
/**
 * A crop framing, in range or not at all.
 *
 * `x` / `y` / `scale` are the whole placement, so a crop missing any of them is
 * not a partial framing to be repaired — it is a value that would paint the
 * bitmap somewhere the author never asked for, and it is dropped with a reason.
 * A framing that IS complete is clamped rather than refused: a drag may legally
 * leave the bitmap mostly outside its box (that is what cropping does), but a
 * scale of 0 or a runaway offset from a broken writer is not a placement at all.
 */
export function normalizeImageCrop(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[]
): ImageCrop | undefined {
  if (raw === undefined || raw === null) return undefined;
  const refuse = (message: string) => {
    if (path && repairs) repairs.push({ kind: "image", path: `${path}/crop`, message });
    return undefined;
  };
  if (!isPlainObject(raw)) return refuse("crop must be an object and was dropped");
  const x = asNumber(raw.x);
  const y = asNumber(raw.y);
  if (x === undefined || y === undefined) {
    return refuse("crop has no numeric x/y and was dropped");
  }
  const rawScale = asNumber(raw.scale ?? raw.zoom);
  const scale = rawScale === undefined ? 1 : rawScale;
  if (!(scale > 0)) {
    return refuse(`crop scale ${JSON.stringify(rawScale)} is not a positive number and was dropped`);
  }
  const rotation = asNumber(raw.rotation ?? raw.angle);
  return clampCrop({ x, y, scale, ...(rotation !== undefined ? { rotation } : {}) });
}

export function normalizePaint(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[]
): Paint | undefined {
  const paint = normalizePaintInner(raw, path, repairs);
  if (!paint || !isPlainObject(raw)) return paint;
  // `opacity` / `alpha` / `enabled` sit beside the paint shape, so they are read
  // from the raw source rather than from each branch's return. `enabled` is
  // written by the inspector's layer toggle and read by the renderer, so losing
  // it here resurrected a hidden layer on the next load.
  const opacity = normalizePaintOpacity(raw.opacity ?? raw.alpha);
  if (opacity !== undefined) (paint as Paint).opacity = opacity;
  if (typeof raw.enabled === "boolean") (paint as Paint).enabled = raw.enabled;
  const adjustment = normalizeColorFilter(raw.adjust ?? raw.filter);
  // Read on an image layer and nowhere else — the renderer emits a
  // `paintfilter_*` def for an image fill alone, so anywhere else it would be
  // kept, saved, and silently never applied. Refused out loud for the same
  // reason a bad `blendMode` is (see `reportRefusedBlendMode`).
  if (adjustment) {
    if (paint.type === "image") (paint as ImagePaint).adjust = adjustment;
    else if (path && repairs) {
      repairs.push({
        kind: "paint",
        path: `${path}/adjust`,
        message: `adjust is read on an image layer only; it was dropped from this ${paint.type} layer`
      });
    }
  }
  return paint;
}

export function normalizePaintInner(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[]
): Paint | undefined {
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(trimmed)) {
      const parsed = paintFromBackgroundImage(trimmed, 100, 100);
      if (parsed) return parsed;
    }
    return { type: "solid", color: trimmed };
  }
  if (!isPlainObject(raw)) return undefined;

  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
  const blend = readBlendMode(raw);
  if (path && repairs) reportRefusedBlendMode(blend, "paint", `${path}/blendMode`, repairs);
  const withBlend = <T extends Paint>(paint: T): T => (blend.mode ? { ...paint, blendMode: blend.mode } : paint);

  if (type === "linear-gradient" || type === "gradient" || type === "lineargradient") {
    const stops = canonicalGradientStops(raw.stops);
    const from =
      (typeof raw.from === "string" && raw.from) ||
      (typeof raw.start === "string" && raw.start) ||
      stops?.[0]?.color;
    const to =
      (typeof raw.to === "string" && raw.to) ||
      (typeof raw.end === "string" && raw.end) ||
      stops?.[stops.length - 1]?.color;

    if (from && to) {
      // A ramp with no interior variation is really a solid, and saying so keeps
      // the document honest. Flatness is judged on the stops when there are any,
      // because red -> green -> red has equal endpoints and is NOT flat —
      // collapsing it would drop the middle stop. With no stops the ramp is just
      // `from` -> `to`, so the endpoints are the whole story.
      if (stops ? gradientIsFlat(stops) : from === to) {
        return withBlend(solidFromRamp(from, stops));
      }
      // Independent endpoints (Figma-style) win over the symmetric angle; when
      // both arrive, `angle` is re-derived so the scrub and the axis can never
      // disagree. One endpoint alone is not a form — it is dropped.
      const startPoint = fractionPoint(raw.start);
      const endPoint = fractionPoint(raw.end);
      let endPointPair: { start: { x: number; y: number }; end: { x: number; y: number }; angle: number } | undefined;
      if (startPoint && endPoint) {
        const deg = (Math.atan2(endPoint.x - startPoint.x, -(endPoint.y - startPoint.y)) * 180) / Math.PI;
        endPointPair = {
          start: startPoint,
          end: endPoint,
          angle: Math.round(((deg % 360) + 360) % 360) % 360
        };
      }
      return withBlend({
        type: "linear-gradient",
        from,
        to,
        angle: asNumber(raw.angle) ?? 90,
        ...gradientExtras(raw, stops),
        ...endPointPair
      });
    }
    // A malformed gradient degrades to its first colour rather than vanishing.
    const fallback = from || to;
    if (fallback) return withBlend({ type: "solid", color: fallback });
    return undefined;
  }

  // Radial: centre colour `from`, edge colour `to` (the model's CSS-ish
  // spellings `inner`/`outer` are absorbed too).
  if (type === "radial-gradient" || type === "radialgradient" || type === "radial") {
    const stops = canonicalGradientStops(raw.stops);
    const from =
      (typeof raw.from === "string" && raw.from) ||
      (typeof raw.inner === "string" && raw.inner) ||
      (typeof raw.center === "string" && raw.center) ||
      stops?.[0]?.color ||
      undefined;
    const to =
      (typeof raw.to === "string" && raw.to) ||
      (typeof raw.outer === "string" && raw.outer) ||
      (typeof raw.edge === "string" && raw.edge) ||
      stops?.[stops.length - 1]?.color ||
      undefined;
    if (from || to) {
      if (from && to && (stops ? !gradientIsFlat(stops) : from !== to)) {
        return withBlend({
          type: "radial-gradient",
          from,
          to,
          ...gradientExtras(raw, stops),
          ...ellipseExtras(raw)
        });
      }
      return withBlend(solidFromRamp(from ?? (to as string), stops));
    }
    return undefined;
  }

  // Angular: a conic sweep about `center`, beginning at `angle` degrees
  // clockwise from top centre and closing after a full turn. Same `from` / `to`
  // / `stops` shape as the other ramps; `inner` / `outer` are absorbed because
  // an authored document may have been written against the radial spelling.
  if (type === "angular-gradient" || type === "angulargradient" || type === "angular" || type === "conic-gradient" || type === "conic") {
    const stops = canonicalGradientStops(raw.stops);
    const from =
      (typeof raw.from === "string" && raw.from) ||
      (typeof raw.inner === "string" && raw.inner) ||
      stops?.[0]?.color ||
      undefined;
    const to =
      (typeof raw.to === "string" && raw.to) ||
      (typeof raw.outer === "string" && raw.outer) ||
      stops?.[stops.length - 1]?.color ||
      undefined;
    if (from || to) {
      if (from && to && (stops ? !gradientIsFlat(stops) : from !== to)) {
        return withBlend({
          type: "angular-gradient",
          from,
          to,
          ...gradientExtras(raw, stops),
          ...angularExtras(raw)
        });
      }
      return withBlend(solidFromRamp(from ?? (to as string), stops));
    }
    return undefined;
  }

  // Diamond: the same centred shape as a radial, but the iso-lines are diamonds
  // (|dx|/rx + |dy|/ry = const) instead of ellipses.
  if (type === "diamond-gradient" || type === "diamondgradient" || type === "diamond") {
    const stops = canonicalGradientStops(raw.stops);
    const from =
      (typeof raw.from === "string" && raw.from) ||
      (typeof raw.inner === "string" && raw.inner) ||
      stops?.[0]?.color ||
      undefined;
    const to =
      (typeof raw.to === "string" && raw.to) ||
      (typeof raw.outer === "string" && raw.outer) ||
      stops?.[stops.length - 1]?.color ||
      undefined;
    if (from || to) {
      if (from && to && (stops ? !gradientIsFlat(stops) : from !== to)) {
        return withBlend({
          type: "diamond-gradient",
          from,
          to,
          ...gradientExtras(raw, stops),
          ...ellipseExtras(raw)
        });
      }
      return withBlend(solidFromRamp(from ?? (to as string), stops));
    }
    return undefined;
  }

  // Pattern fill: { type: "pattern", motif, tile, scale, spacing, ... }
  if (type === "pattern" || type === "pattern-fill" || type === "patternfill") {
    const foreground =
      (typeof raw.foreground === "string" && raw.foreground) ||
      (typeof raw.fg === "string" && raw.fg) ||
      (typeof raw.color === "string" && raw.color) ||
      undefined;
    const background =
      (typeof raw.background === "string" && raw.background) ||
      (typeof raw.bg === "string" && raw.bg) ||
      undefined;
    if (!foreground && !background) return undefined;

    const motifRaw = typeof raw.motif === "string" ? canonicalKey(raw.motif) : "";
    const motif = PATTERN_MOTIF_ALIASES[motifRaw];
    if (!motif) {
      repairs?.push({
        kind: "paint",
        path: `${path}/motif`,
        severity: "info",
        message: `motif "${String(raw.motif ?? "")}" is not one of ${PATTERN_MOTIFS.join(" | ")}; defaulted to "dots"`
      });
    }

    const tileTypeRaw = typeof raw.tileType === "string" ? canonicalKey(raw.tileType) : "rectangular";
    const tileType = (PATTERN_TILE_TYPES as readonly string[]).includes(tileTypeRaw)
      ? (tileTypeRaw as PatternTileType)
      : "rectangular";

    const rawAlignment = typeof raw.alignment === "string" ? canonicalKey(raw.alignment) : "start";
    const alignment = (PATTERN_ALIGNMENTS as readonly string[]).includes(rawAlignment)
      ? (rawAlignment as PatternAlignment)
      : "start";

    const tileRaw = isPlainObject(raw.tile) ? raw.tile : isPlainObject(raw.cell) ? raw.cell : undefined;
    const tileWidth = (tileRaw ? asNumber(tileRaw.width) : undefined) ?? asNumber(raw.width);
    const tileHeight = (tileRaw ? asNumber(tileRaw.height) : undefined) ?? asNumber(raw.height);
    const cell = {
      width: Math.max(1, tileWidth ?? 16),
      height: Math.max(1, tileHeight ?? 16)
    };

    const spacingRaw = isPlainObject(raw.spacing) ? raw.spacing : undefined;
    const spacingX = spacingRaw ? asNumber(spacingRaw.x) : undefined;
    const spacingY = spacingRaw ? asNumber(spacingRaw.y) : undefined;

    const scale = asNumber(raw.scale) ?? asNumber(raw.scalingFactor);
    const angle = asNumber(raw.angle);
    const weight = asNumber(raw.weight);

    return withBlend({
      type: "pattern",
      motif: motif ?? "dots",
      tile: cell,
      tileType,
      alignment,
      foreground: foreground ?? background!,
      ...(background ? { background } : {}),
      ...(scale !== undefined && scale > 0 ? { scale } : {}),
      ...(spacingX !== undefined || spacingY !== undefined
        ? { spacing: { ...(spacingX !== undefined ? { x: Math.max(0, spacingX) } : {}), ...(spacingY !== undefined ? { y: Math.max(0, spacingY) } : {}) } }
        : {}),
      ...(angle !== undefined ? { angle: ((angle % 360) + 360) % 360 } : {}),
      ...(weight !== undefined ? { weight: Math.max(0, weight) } : {})
    } satisfies PatternPaint);
  }

  // Image fill: { type: "image", assetId, fit, focalPoint, crop }
  if (type === "image" || type === "img" || type === "picture") {
    const assetId =
      (typeof raw.assetId === "string" && raw.assetId) ||
      (typeof raw.asset === "string" && raw.asset) ||
      (typeof raw.src === "string" && raw.src) ||
      undefined;
    if (assetId) {
      const fitRaw = typeof raw.fit === "string" ? canonicalKey(raw.fit) : undefined;
      if (fitRaw && !FIT_ALIASES[fitRaw]) {
        // The alternative was a silent `cover`, which looks applied and is not —
        // the exact failure the repair channel exists to name.
        repairs?.push({
          kind: "paint",
          path: `${path}/fit`,
          message: `fit "${raw.fit}" is not supported (${Object.keys(FIT_ALIASES).join(" | ")}); defaulted to "cover"`
        });
      }
      const fpRaw = raw.focalPoint;
      const fp = isPlainObject(fpRaw) ? fpRaw : undefined;
      const fx = fp ? asNumber(fp.x) : undefined;
      const fy = fp ? asNumber(fp.y) : undefined;
      const crop = normalizeImageCrop(
        raw.crop ?? raw.imageCrop,
        path,
        repairs
      );
      return withBlend({
        type: "image",
        assetId,
        fit: (fitRaw && FIT_ALIASES[fitRaw]) || "cover",
        ...(fx !== undefined && fy !== undefined
          ? { focalPoint: { x: clamp(fx, 0, 1), y: clamp(fy, 0, 1) } }
          : {}),
        ...(crop ? { crop } : {})
      });
    }
    return undefined;
  }

  const color = typeof raw.color === "string" && raw.color;
  const tokenId =
    typeof raw.tokenId === "string" && raw.tokenId.trim() ? raw.tokenId.trim() : undefined;
  if (color) {
    return withBlend({ type: "solid", color, ...(tokenId ? { tokenId } : {}) });
  }

  // Untyped but gradient-shaped: { from, to, angle }
  if (typeof raw.from === "string" && typeof raw.to === "string") {
    const stops = canonicalGradientStops(raw.stops);
    const flat = stops ? gradientIsFlat(stops) : raw.from === raw.to;
    if (flat) return withBlend(solidFromRamp(raw.from, stops));
    return withBlend({
      type: "linear-gradient",
      from: raw.from,
      to: raw.to,
      angle: asNumber(raw.angle) ?? 90,
      ...gradientExtras(raw, stops)
    });
  }

  return undefined;
}

/**
 * Normalizes a fill stack.
 *
 * The canonical property is `fills: Paint[]` (ordered, bottom layer first).
 * CSS fallback sources are absorbed when no `fills` stack was given:
 *  - `backgroundColor` / `background` / `color`;
 *  - `fills` entries that fail to parse are dropped with a repair note.
 */
/** True when a paint entry names its own `fit`, under any of its spellings. */
const declaresFit = (entry: unknown): boolean =>
  isPlainObject(entry) && (entry.fit !== undefined || entry.objectFit !== undefined);

export interface ElementFitOverride {
  fit: ImagePaint["fit"];
  /** The key it was written under, so the repair names what the author typed. */
  key: string;
}

/**
 * The element-level image fit: CSS's `object-fit`, which the property registry
 * listed under three spellings while nothing read any of them, so a value that
 * reached the field changed no pixel and reported no repair. It lands on the
 * IMAGE paint's own `fit` — the one field `object-fit` means — which is also why
 * a stack with no image layer cannot honour it and says so.
 *
 * Nothing is reported here for a value that resolves: the move is announced by
 * the paint that receives it, so a fit with nowhere to land says only that,
 * rather than claiming an absorption and then denying it.
 */
export function normalizeElementFit(
  el: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): ElementFitOverride | undefined {
  // `fit` is the dialect's own spelling of the same idea and is in the
  // vocabulary, so the gate accepted it while this loop read only the CSS pair —
  // an author writing `fit: "cover"` got no fit and no word.
  for (const key of ["objectFit", "object-fit", "fit"] as const) {
    const raw = el[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const fit = FIT_ALIASES[canonicalKey(raw)];
    if (!fit) {
      repairs.push({
        kind: "paint",
        path: `${path}/${key}`,
        message: `objectFit "${raw}" is not supported (${Object.keys(FIT_ALIASES).join(" | ")}); ignored`
      });
      return undefined;
    }
    return { fit, key };
  }
  return undefined;
}

/**
 * The element-level image placement: where the bitmap sits in its box. The
 * vocabulary lists `focalPoint`, `crop` and `imageCrop` on the ELEMENT, while
 * the only reader looked inside each fill — so a placement written beside the
 * element changed no pixel and reported nothing. It lands on the image paint's
 * own `focalPoint` / `crop`, the fields those spellings mean, and a stack with
 * no image layer cannot honour it and says so.
 */
export interface ElementCropOverride {
  focalPoint?: { x: number; y: number };
  /** The key each part was written under, so a repair names what the author typed. */
  focalKey?: string;
  crop?: ImageCrop;
  cropKey?: string;
}

export function normalizeElementCrop(
  el: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): ElementCropOverride | undefined {
  const out: ElementCropOverride = {};

  const fpRaw = el.focalPoint;
  if (fpRaw !== undefined) {
    const fp = isPlainObject(fpRaw) ? fpRaw : undefined;
    const fx = fp ? asNumber(fp.x) : undefined;
    const fy = fp ? asNumber(fp.y) : undefined;
    if (fx !== undefined && fy !== undefined) {
      out.focalPoint = { x: clamp(fx, 0, 1), y: clamp(fy, 0, 1) };
      out.focalKey = "focalPoint";
    } else {
      // The fill-level reader drops a malformed one in silence; at the element
      // level the author named it beside the element and deserves the reason.
      repairs.push({
        kind: "image",
        path: `${path}/focalPoint`,
        message: "focalPoint needs numeric x/y and was dropped"
      });
    }
  }

  const cropRaw = el.crop ?? el.imageCrop;
  if (cropRaw !== undefined) {
    const crop = normalizeImageCrop(cropRaw, path, repairs);
    if (crop) {
      out.crop = crop;
      out.cropKey = el.crop !== undefined ? "crop" : "imageCrop";
    }
  }

  return out.focalPoint || out.crop ? out : undefined;
}

/**
 * Folds the element-level placement into image fills that lack their own. A
 * fill's own declaration is closest to the value and wins, the way `fit` defers
 * to the paint — so the override only fills gaps, never overwrites.
 */
function foldImagePlacement(
  stack: PaintStack,
  override: ElementCropOverride,
  path: string,
  repairs: NormalizationRepair[]
): void {
  let focalApplied = false;
  let cropApplied = false;
  for (let i = 0; i < stack.length; i++) {
    const paint = stack[i];
    if (paint.type !== "image") continue;
    const merged: ImagePaint = { ...paint };
    if (override.focalPoint && merged.focalPoint === undefined) {
      merged.focalPoint = override.focalPoint;
      focalApplied = true;
      repairs.push({
        kind: "image",
        path: `${path}/fills/${i}/focalPoint`,
        severity: "info",
        message: `element-level "${override.focalKey}" absorbed into this image fill's focalPoint`
      });
    }
    if (override.crop && merged.crop === undefined) {
      merged.crop = override.crop;
      cropApplied = true;
      repairs.push({
        kind: "image",
        path: `${path}/fills/${i}/crop`,
        severity: "info",
        message: `element-level "${override.cropKey}" absorbed into this image fill's crop`
      });
    }
    stack[i] = merged;
  }
  const imageless = !stack.some((paint) => paint.type === "image");
  if (override.focalPoint && !focalApplied) {
    repairs.push({
      kind: "image",
      path: `${path}/${override.focalKey}`,
      message: imageless
        ? `focalPoint was not applied: there is no image fill to set it on`
        : `focalPoint was not applied: the image fill here names its own focalPoint`
    });
  }
  if (override.crop && !cropApplied) {
    repairs.push({
      kind: "image",
      path: `${path}/${override.cropKey}`,
      message: imageless
        ? `"${override.cropKey}" was not applied: there is no image fill to set it on`
        : `"${override.cropKey}" was not applied: the image fill here names its own crop`
    });
  }
}

export function normalizePaintStackEntries(
  raw: unknown,
  path: string,
  repairs: NormalizationRepair[],
  fitOverride?: ElementFitOverride,
  /** Reports back whether anything received the override, so a fit with nowhere
   *  to land is distinguishable from one that was absorbed. */
  application?: { applied: boolean }
): PaintStack | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PaintStack = [];
  raw.forEach((entry, index) => {
    const paint = normalizePaint(entry, `${path}/${index}`, repairs);
    if (paint) {
      // A declared `fit` belongs to the paint, so an element-level one defers to
      // it rather than overriding — otherwise `objectFit` silently beat the
      // spelling written closest to the value.
      if (fitOverride && paint.type === "image" && !declaresFit(entry)) {
        repairs.push({
          kind: "paint",
          path: `${path}/${index}/fit`,
          severity: "info",
          message: `element-level "${fitOverride.key}" absorbed into this image fill's fit`
        });
        if (application) application.applied = true;
        out.push({ ...paint, fit: fitOverride.fit });
        return;
      }
      out.push(paint);
    } else if (entry !== null && entry !== undefined && entry !== "") {
      repairs.push({
        kind: "paint",
        path: `${path}/${index}`,
        message: "paint entry is not a recognisable paint; dropped"
      });
    }
  });
  return out.length > 0 ? out : undefined;
}

export function normalizeFillStack(
  el: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): PaintStack | undefined {
  const out: PaintStack = [];

  // Explicit empty fills array: author intentionally declared "no fill".
  if (Array.isArray(el.fills) && el.fills.length === 0) {
    return [];
  }

  const fitOverride = normalizeElementFit(el, path, repairs);
  const cropOverride = normalizeElementCrop(el, path, repairs);
  const application = { applied: false };

  const fromFills = normalizePaintStackEntries(el.fills, `${path}/fills`, repairs, fitOverride, application);
  if (fromFills && fromFills.length > 0) {
    if (fitOverride && !application.applied) {
      const hasImage = fromFills.some((paint) => paint.type === "image");
      repairs.push({
        kind: "paint",
        path: `${path}/${fitOverride.key}`,
        message: hasImage
          ? `objectFit "${fitOverride.fit}" was not applied: the image fill here names its own fit`
          : `objectFit "${fitOverride.fit}" was not applied: there is no image fill to set it on`
      });
    }
    if (cropOverride) foldImagePlacement(fromFills, cropOverride, path, repairs);
    return fromFills;
  }
  if (fitOverride) {
    repairs.push({
      kind: "paint",
      path: `${path}/${fitOverride.key}`,
      message: `objectFit "${fitOverride.fit}" was not applied: there is no image fill to set it on`
    });
  }

  for (const alias of ["backgroundColor", "background-color", "background", "color"] as const) {
    const raw = el[alias];
    // `background` / `background-image` is a comma-separated layer list and CSS
    // paints the FIRST layer on top — the reverse of the DSL's bottom-first
    // stack. Split, then push in reverse so the top CSS layer lands last. A
    // structured paint object (the model-invented spelling) is read whole.
    const layers = typeof raw === "string" ? backgroundLayers(raw) : [raw];
    if (layers.length === 0) continue;
    const paints: Paint[] = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const paint = normalizePaint(layers[i], `${path}/${alias}`, repairs);
      if (paint) paints.push(paint);
    }
    if (paints.length > 0) {
      repairs.push({
        kind: "paint",
        path: `${path}/${alias}`,
        severity: "info",
        message: `"${alias}" absorbed into the fills stack${layers.length > 1 ? ` (${layers.length} layers)` : ""}`
      });
      out.push(...paints);
      if (cropOverride) foldImagePlacement(out, cropOverride, path, repairs);
      return out;
    }
  }

  if (cropOverride) foldImagePlacement(out, cropOverride, path, repairs);
  return out.length > 0 ? out : undefined;
}
