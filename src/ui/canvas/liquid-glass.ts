import { DesignElement, Effect, LiquidGlassEffect } from "../../core/dsl/types";
import type { CornerRadius } from "../../core/dsl/types";
import {
  GLASS_RIM_FLOOR,
  GlassDerived,
  LiquidGlassParams,
  glassDerived,
  glassProfile,
  liquidGlassParams
} from "../../core/dsl/liquid-glass";
import { getShapeLocalPath } from "../../core/geometry/gradient-utils";
import { cornerRadiiOf, effectiveCornerSmoothing } from "../../core/geometry/shape-path";
import { isContainer } from "../../core/geometry/tree-ops";
import { BAKE_CACHE_BYTES, createBakeCache, dataUriCost } from "./glass-bake-cache";
import { AnalyticShape, evalAnalyticSdf, getWorkCanvas, samplePathField } from "./glass-field";

/**
 * Liquid Glass, baked into the bitmaps an SVG filter and rim overlay consume.
 *
 *  1. **the displacement field** — one PNG per unique geometry/scale/refraction,
 *     R and G carrying the INWARD normal of the shape scaled by the convex bevel
 *     deflection profile, which `feDisplacementMap` turns into a convex lens bend
 *     of the backdrop (magnifying interior content outward toward the rim, matching
 *     Figma's native Glass filter).
 *  2. **the specular rim overlay** — an element-sized PNG for the directional
 *     specular light projected onto the bevel from `lightAngle` and spread inward
 *     by `Splay`, including secondary internal reflection on the opposite rim.
 */

export interface GlassField {
  /** PNG data URI. R/G = inward normal × deflection profile, encoded around 128. */
  uri: string;
  /** Transparent margin baked into `uri`; the element box sits inside it. */
  pad: number;
  width: number;
  height: number;
  /** `feDisplacementMap` scale for the red, green and blue passes. */
  scaleR: number;
  scaleG: number;
  scaleB: number;
}

export interface GlassOverlay {
  uri: string;
  width: number;
  height: number;
}

export interface GlassBake {
  params: LiquidGlassParams;
  derived: GlassDerived;
  /** Null when Refraction is 0 — the backdrop is then frosted but unbent. */
  field: GlassField | null;
  /** Projected specular rim light. Null when Light intensity is 0. */
  light: GlassOverlay | null;
  /** Kept for structural compatibility; Figma's native Glass filter uses no dark ring. */
  dark: GlassOverlay | null;
  /** Shape outline in element-local coordinates, for the fill plate and stroke. */
  shapeD: string;
}

/** Supersampling floor of the rim overlay at 100 % zoom. */
const OVERLAY_SCALE = 2;

/**
 * Ceiling scale for the displacement normal map consumed by `<feDisplacementMap>`.
 * Because the filter bilinearly interpolates `in2="lg-map"` across a smooth bevel
 * profile, baking above 4x produces indistinguishable refraction while quadrupling
 * pixel count and PNG encoding time at high zoom.
 */
const FIELD_MAX_SCALE = 4;

/** Longest side a baked grid may have, in texels. */
const GLASS_MAX_BAKE_SIDE = 1152;

/** `scale`, reduced so a `side`-document-pixel grid stays inside the budget. */
function fitScale(scale: number, side: number): number {
  return Math.max(1, Math.min(scale, GLASS_MAX_BAKE_SIDE / Math.max(1, side)));
}

function bakeCost(bake: GlassBake): number {
  return dataUriCost([bake.field?.uri, bake.light?.uri, bake.dark?.uri]);
}

const bakeCache = createBakeCache<GlassBake>(BAKE_CACHE_BYTES, bakeCost);
const fieldSubCache = createBakeCache<GlassField>(
  Math.floor(BAKE_CACHE_BYTES / 2),
  (f) => dataUriCost([f.uri], 128)
);
const overlaySubCache = createBakeCache<{ light: GlassOverlay | null; dark: GlassOverlay | null }>(
  Math.floor(BAKE_CACHE_BYTES / 2),
  (o) => dataUriCost([o.light?.uri, o.dark?.uri], 128)
);

export function refractFilterId(elId: string): string {
  return `lg_refract_${elId}`;
}

/** Whether the backdrop has to be bent at all. A zero Refraction is a plain frost. */
export function shouldRefract(params: LiquidGlassParams): boolean {
  return params.refraction > 0.01;
}

/** The element's own glass effect, if it has one that is switched on. */
export function glassEffectOf(effects: Effect[] | undefined): LiquidGlassEffect | undefined {
  return (effects ?? []).find(
    (ef): ef is LiquidGlassEffect => ef.enabled !== false && ef.type === "liquid-glass"
  );
}

export function bakeGlass(
  el: DesignElement,
  effects: Effect[] | undefined,
  size?: { width: number; height: number },
  deviceScale = 1
): GlassBake | null {
  if (typeof document === "undefined" || el.type === "text") return null;
  const effect = glassEffectOf(effects);
  if (!effect) return null;

  const params = liquidGlassParams(effect);
  const width = Math.max(1, Math.round(size?.width ?? el.width));
  const height = Math.max(1, Math.round(size?.height ?? el.height));
  const smoothing = effectiveCornerSmoothing(
    (el as { cornerSmoothing?: number }).cornerSmoothing,
    (el as { borderRadius?: CornerRadius }).borderRadius,
    width,
    height
  );
  const analytic = analyticShapeOf(el, width, height, smoothing);
  const lazyPathD = analytic ? "" : getShapeLocalPath(el);
  const scale = Math.max(1, deviceScale);

  const shapeKey = analytic
    ? analytic.kind === "ellipse"
      ? "ellipse"
      : `rect:${analytic.radii.join(",")}:${analytic.smoothing.toFixed(3)}`
    : `path:${smoothing}:${lazyPathD}`;

  // Keyed on geometry, display scale and parameters (not `el.id`) so identical
  // glass elements and component instances share a single bake across the page.
  const key = [
    width,
    height,
    shapeKey,
    scale,
    params.refraction,
    params.depth,
    params.dispersion,
    params.frost,
    params.splay,
    params.lightAngle,
    params.lightIntensity
  ].join("|");

  const hit = bakeCache.get(key);
  if (hit) return hit;

  const pathD = lazyPathD || getShapeLocalPath(el);
  const dv = glassDerived(params, width, height);
  let bake: GlassBake | null = null;
  try {
    let field: GlassField | null = null;
    if (shouldRefract(params)) {
      const fieldScale = Math.min(scale, FIELD_MAX_SCALE);
      const fKey = `${width}|${height}|${shapeKey}|${fieldScale}|${dv.depth}|${dv.peakR.toFixed(4)}|${dv.peakG.toFixed(4)}|${dv.peakB.toFixed(4)}`;
      field = fieldSubCache.get(fKey) ?? null;
      if (!field) {
        field = buildField(width, height, pathD, analytic, dv, fieldScale);
        if (field) fieldSubCache.set(fKey, field);
      }
    }

    let overlays: { light: GlassOverlay | null; dark: GlassOverlay | null } = { light: null, dark: null };
    if (dv.intensity > 0.001) {
      const oKey = `${width}|${height}|${shapeKey}|${scale}|${dv.depth}|${dv.lx.toFixed(4)}|${dv.ly.toFixed(4)}|${dv.intensity.toFixed(4)}|${dv.spread.toFixed(4)}`;
      const cachedOv = overlaySubCache.get(oKey);
      if (cachedOv) {
        overlays = cachedOv;
      } else {
        overlays = buildOverlays(width, height, pathD, analytic, dv, scale);
        overlaySubCache.set(oKey, overlays);
      }
    }

    bake = {
      params,
      derived: dv,
      field,
      light: overlays.light,
      dark: overlays.dark,
      shapeD: pathD || `M0,0 H${width} V${height} H0 Z`
    };
  } catch {
    bake = null;
  }
  if (!bake) return null;

  bakeCache.set(key, bake);
  return bake;
}

/**
 * The `backdrop-filter` chain for an element's glass.
 *
 * Frost first and displacement second: the field samples an already-frosted
 * backdrop so the refracted bevel keeps its crisp optical edge.
 */
export function glassBackdropCss(elId: string, bake: GlassBake): string {
  const parts: string[] = [];
  if (bake.derived.frostPx > 0) parts.push(`blur(${bake.derived.frostPx}px)`);
  if (bake.field) parts.push(`url(#${refractFilterId(elId)})`);
  return parts.join(" ");
}

/* ---------------------------------------------------------------- geometry */

function analyticShapeOf(
  el: DesignElement,
  width: number,
  height: number,
  smoothing: number
): AnalyticShape | null {
  if (el.type === "line" || el.type === "arrow") return null;
  if (
    el.type === "ellipse" &&
    ((el as any).sweep ?? 360) >= 360 &&
    !((el as any).innerRadius) &&
    !((el as any).gap)
  ) {
    if (width === height) {
      const r = width / 2;
      return { kind: "rect", radii: [r, r, r, r], smoothing: 0 };
    }
    return { kind: "ellipse" };
  }
  if (el.type === "rect" || el.type === "text" || el.type === "instance" || isContainer(el)) {
    const radii = cornerRadiiOf((el as { borderRadius?: CornerRadius }).borderRadius, width, height);
    return { kind: "rect", radii, smoothing };
  }
  return null;
}

/* ------------------------------------------------------------------ baking */

function buildField(
  width: number,
  height: number,
  pathD: string,
  analytic: AnalyticShape | null,
  dv: GlassDerived,
  deviceScale: number
): GlassField | null {
  const pad = Math.ceil(Math.max(dv.peakR, dv.peakB)) + 2;
  const scale = fitScale(Math.min(deviceScale, FIELD_MAX_SCALE), Math.max(width, height) + pad * 2);
  const padPx = Math.round(pad * scale);
  const gridW = Math.max(1, Math.round(width * scale) + padPx * 2);
  const gridH = Math.max(1, Math.round(height * scale) + padPx * 2);

  const work = getWorkCanvas(gridW, gridH);
  if (!work) return null;
  const out = work.ctx.createImageData(gridW, gridH);
  const od = out.data;
  // Pre-fill every pixel with neutral displacement (R=128, G=128, B=128, A=255)
  // in a single 32-bit native fill so padding and interior pixels can be skipped.
  new Uint32Array(od.buffer).fill(0xff808080);

  let ink = 0;

  if (analytic) {
    const jStart = Math.max(0, padPx - 1);
    const jEnd = Math.min(gridH - 1, Math.ceil((height + pad) * scale));
    const iStart = Math.max(0, padPx - 1);
    const iEnd = Math.min(gridW - 1, Math.ceil((width + pad) * scale));

    let skipRect = false;
    let innerX0 = 0;
    let innerX1 = 0;
    let innerY0 = 0;
    let innerY1 = 0;
    let skipEllipse = false;
    const cx = width * 0.5;
    const cy = height * 0.5;
    let ellAIn = 0;
    let ellBIn = 0;

    if (analytic.kind === "rect") {
      const maxR = Math.max(...analytic.radii);
      const band = Math.max(dv.depth, maxR) + 1;
      if (width > band * 2 && height > band * 2) {
        skipRect = true;
        innerX0 = band;
        innerX1 = width - band;
        innerY0 = band;
        innerY1 = height - band;
      }
    } else if (analytic.kind === "ellipse") {
      // Homothetic inner ellipse E(k*a, k*b) with k = 1 - band / min(a, b) satisfies
      // E(k*a, k*b) (+) D(band) <= E(a, b), so every point inside it has Euclidean
      // distance >= band to the outer ellipse boundary.
      const band = dv.depth + 1;
      const minSemi = Math.min(cx, cy);
      if (minSemi > band + 1) {
        const k = 1 - band / minSemi;
        ellAIn = cx * k;
        ellBIn = cy * k;
        skipEllipse = ellAIn > 1 && ellBIn > 1;
      }
    }

    const invScale = 1 / scale;
    const invDepth = 1 / dv.depth;

    for (let j = jStart; j <= jEnd; j++) {
      const y = (j + 0.5) * invScale - pad;
      let rowSkip = false;
      let rowX0 = innerX0;
      let rowX1 = innerX1;
      if (skipRect && y >= innerY0 && y <= innerY1) {
        rowSkip = true;
      } else if (skipEllipse) {
        const dy = Math.abs(y - cy);
        if (dy < ellBIn) {
          const t = dy / ellBIn;
          const dx = ellAIn * Math.sqrt(1 - t * t);
          rowX0 = cx - dx;
          rowX1 = cx + dx;
          rowSkip = dx > 1;
        }
      }
      const rowBase = j * gridW;

      for (let i = iStart; i <= iEnd; i++) {
        const x = (i + 0.5) * invScale - pad;
        if (rowSkip && x > rowX0 && x < rowX1) {
          i = Math.max(i, Math.floor((rowX1 + pad) * scale) - 1);
          continue;
        }
        const sSample = evalAnalyticSdf(x, y, width, height, analytic);
        const u = -sSample.d * invDepth;
        if (u <= 0 || u >= 1) continue;
        const s = glassProfile(u);
        if (s > 0) {
          const o = (rowBase + i) * 4;
          // Convex dome refraction bends the lookup ray INWARD (`-nx, -ny`),
          // pulling interior content outward toward the curved edge like Figma.
          od[o] = Math.round(255 * (0.5 - 0.5 * sSample.nx * s));
          od[o + 1] = Math.round(255 * (0.5 - 0.5 * sSample.ny * s));
          ink++;
        }
      }
    }
  } else {
    const field = samplePathField(width, height, pad, pathD, scale);
    if (!field) return null;
    const invDepth = 1 / dv.depth;
    for (let k = 0; k < field.w * field.h; k++) {
      const s = glassProfile(-field.d[k] * invDepth);
      if (s > 0) {
        const o = k * 4;
        od[o] = Math.round(255 * (0.5 - 0.5 * field.nx[k] * s));
        od[o + 1] = Math.round(255 * (0.5 - 0.5 * field.ny[k] * s));
        ink++;
      }
    }
  }

  if (ink === 0) return null;
  work.ctx.putImageData(out, 0, 0);

  return {
    uri: work.canvas.toDataURL("image/png"),
    pad,
    width,
    height,
    scaleR: 2 * dv.peakR,
    scaleG: 2 * dv.peakG,
    scaleB: 2 * dv.peakB
  };
}

function buildOverlays(
  width: number,
  height: number,
  pathD: string,
  analytic: AnalyticShape | null,
  dv: GlassDerived,
  deviceScale: number
): { light: GlassOverlay | null; dark: GlassOverlay | null } {
  const scale = fitScale(Math.max(OVERLAY_SCALE, deviceScale), Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  // Specular rim starts directly on the outer edge (u = 0) with no dark ring
  // pushing it inward, matching Figma's clean translucent rim highlight.
  const rimReachPx = Math.max(1.5, dv.depth * dv.spread);
  const invRimReach = 1 / rimReachPx;

  const work = getWorkCanvas(w, h);
  if (!work) return { light: null, dark: null };
  const image = work.ctx.createImageData(w, h);
  const ld = image.data;
  let hasLight = false;

  if (analytic) {
    let skipRect = false;
    let innerX0 = 0;
    let innerX1 = 0;
    let innerY0 = 0;
    let innerY1 = 0;
    let skipEllipse = false;
    const cx = width * 0.5;
    const cy = height * 0.5;
    let ellAIn = 0;
    let ellBIn = 0;

    if (analytic.kind === "rect") {
      const maxR = Math.max(...analytic.radii);
      const band = Math.max(rimReachPx, maxR) + 1;
      if (width > band * 2 && height > band * 2) {
        skipRect = true;
        innerX0 = band;
        innerX1 = width - band;
        innerY0 = band;
        innerY1 = height - band;
      }
    } else if (analytic.kind === "ellipse") {
      const band = rimReachPx + 1;
      const minSemi = Math.min(cx, cy);
      if (minSemi > band + 1) {
        const k = 1 - band / minSemi;
        ellAIn = cx * k;
        ellBIn = cy * k;
        skipEllipse = ellAIn > 1 && ellBIn > 1;
      }
    }

    const invScale = 1 / scale;

    for (let j = 0; j < h; j++) {
      const y = (j + 0.5) * invScale;
      let rowSkip = false;
      let rowX0 = innerX0;
      let rowX1 = innerX1;
      if (skipRect && y >= innerY0 && y <= innerY1) {
        rowSkip = true;
      } else if (skipEllipse) {
        const dy = Math.abs(y - cy);
        if (dy < ellBIn) {
          const t = dy / ellBIn;
          const dx = ellAIn * Math.sqrt(1 - t * t);
          rowX0 = cx - dx;
          rowX1 = cx + dx;
          rowSkip = dx > 1;
        }
      }
      const rowBase = j * w;

      for (let i = 0; i < w; i++) {
        const x = (i + 0.5) * invScale;
        if (rowSkip && x > rowX0 && x < rowX1) {
          i = Math.max(i, Math.floor(rowX1 * scale) - 1);
          continue;
        }
        const sSample = evalAnalyticSdf(x, y, width, height, analytic);
        const cov = clamp01(0.5 - sSample.d * scale);
        if (cov <= 0) continue;

        const distIn = -sSample.d;
        const lim = distIn * invRimReach;
        if (lim >= 1) continue;

        const u = 1 - lim;
        const fall = lim <= 0 ? 1 : u * u * Math.sqrt(u);
        const dot = sSample.nx * dv.lx + sSample.ny * dv.ly;
        // Primary highlight on the lit side (`dot > 0`) plus a softer internal
        // reflection on the opposite rim (`dot < 0`), matching Figma's Glass rim.
        const dotp = dot >= 0 ? Math.pow(dot, 2.2) : 0.22 * Math.pow(-dot, 2.6);
        const env = GLASS_RIM_FLOOR + (1 - GLASS_RIM_FLOOR) * dotp;
        const alpha = Math.round(clamp01(dv.intensity * env * fall * cov) * 255);
        if (alpha > 0) {
          const o = (rowBase + i) * 4;
          ld[o] = 255;
          ld[o + 1] = 255;
          ld[o + 2] = 255;
          ld[o + 3] = alpha;
          hasLight = true;
        }
      }
    }
  } else {
    const pad = Math.max(4, Math.ceil(dv.darkW) + 2);
    const padPx = Math.round(pad * scale);
    const field = samplePathField(width, height, pad, pathD, scale);
    if (!field) return { light: null, dark: null };

    for (let j = 0; j < h; j++) {
      const sj = Math.min(field.h - 1, j + padPx);
      for (let i = 0; i < w; i++) {
        const si = Math.min(field.w - 1, i + padPx);
        const k = si + sj * field.w;
        const cov = field.cov[k];
        if (cov <= 0) continue;

        const distIn = -field.d[k];
        const lim = distIn * invRimReach;
        if (lim >= 1) continue;

        const u = 1 - lim;
        const fall = lim <= 0 ? 1 : u * u * Math.sqrt(u);
        const dot = field.nx[k] * dv.lx + field.ny[k] * dv.ly;
        const dotp = dot >= 0 ? Math.pow(dot, 2.2) : 0.22 * Math.pow(-dot, 2.6);
        const env = GLASS_RIM_FLOOR + (1 - GLASS_RIM_FLOOR) * dotp;
        const alpha = Math.round(clamp01(dv.intensity * env * fall * cov) * 255);
        if (alpha > 0) {
          const o = (i + j * w) * 4;
          ld[o] = 255;
          ld[o + 1] = 255;
          ld[o + 2] = 255;
          ld[o + 3] = alpha;
          hasLight = true;
        }
      }
    }
  }

  if (!hasLight) return { light: null, dark: null };
  work.ctx.putImageData(image, 0, 0);
  return {
    light: { uri: work.canvas.toDataURL("image/png"), width, height },
    dark: null
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
