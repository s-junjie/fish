import type { LiquidGlassEffect } from "./types";

/**
 * Apple's Liquid Glass, on Figma's parameter surface.
 *
 * Figma's glass effect and Apple's material are one target, not two: Apple's own
 * iOS 27 UI kit is built with Figma's glass effect — Figma's help text says so in
 * as many words — so the names, units and ranges below are Figma's, and the
 * defaults are the ones measured against Apple's illustrations of the material
 * (docs/LIQUID-GLASS-RESEARCH.md §8 and §9).
 *
 * Three quantities are OUR conventions, because Figma publishes neither the
 * units nor the mapping, and they are named here rather than buried in the bake:
 *
 *  - Refraction 100 throws the backdrop inward by {@link GLASS_PEAK_RATIO} × Depth
 *    at the peak of the deflection profile.
 *  - Dispersion 100 makes the red and blue throws differ by ±{@link GLASS_DISP_SPREAD}
 *    ÷ 2. Real crown glass is nearer 1 %; Figma's knob is explicitly a stylised
 *    rainbow, so the exaggeration is the intent rather than a mistake.
 *  - Depth is mapped 1:1 in px and capped at {@link GLASS_MAX_DEPTH_FRACTION} of
 *    the element's short side so a band from one rim cannot reach past the middle
 *    of a small control and meet the other.
 *
 * This module is the whole model and none of the rendering: parameters, the
 * derived geometry, the deflection profile and the analytical signed distance
 * fields. It is DOM-free so the inspector, the SVG bake and the tests can all read
 * the same numbers instead of three copies of them.
 */

export interface LiquidGlassParams {
  /** Figma *Frost* — how much the backdrop is blurred, read 1:1 as a px radius. */
  frost: number;
  /** Figma *Refraction*, 0-100 — strength of the distortion along the curved edge. */
  refraction: number;
  /** Figma *Depth* — how far the curved edge reaches inward from the border, in px. */
  depth: number;
  /** Figma *Dispersion*, 0-100 — chromatic split along the curved edge. */
  dispersion: number;
  /** Figma *Light angle* in degrees; 0 is light from the top. */
  lightAngle: number;
  /** Figma *Light intensity*, 0-100 — brightness of the light the rim projects. */
  lightIntensity: number;
  /** Figma *Splay*, 0-100 — how far that light spreads across the glass. */
  splay: number;
}

export interface GlassParamSpec {
  key: keyof LiquidGlassParams;
  /** Figma's own name for the control, and the name the inspector shows. */
  label: string;
  /** The `t()` key that renders {@link label} in the shell. */
  labelKey: string;
  min: number;
  max: number;
  def: number;
  unit: string;
  step: number;
}

export const LIQUID_GLASS_PARAMS: readonly GlassParamSpec[] = [
  { key: "refraction", label: "Refraction", labelKey: "effects.glassRefraction", min: 0, max: 100, def: 80, unit: "%", step: 1 },
  { key: "depth", label: "Depth", labelKey: "effects.glassDepth", min: 1, max: 100, def: 10, unit: "px", step: 1 },
  { key: "dispersion", label: "Dispersion", labelKey: "effects.glassDispersion", min: 0, max: 100, def: 30, unit: "%", step: 1 },
  { key: "frost", label: "Frost", labelKey: "effects.glassFrost", min: 0, max: 100, def: 4, unit: "px", step: 1 },
  { key: "splay", label: "Splay", labelKey: "effects.glassSplay", min: 0, max: 100, def: 20, unit: "%", step: 1 },
  { key: "lightAngle", label: "Light angle", labelKey: "effects.glassLightAngle", min: -180, max: 180, def: -35, unit: "°", step: 1 },
  { key: "lightIntensity", label: "Light intensity", labelKey: "effects.glassLightIntensity", min: 0, max: 100, def: 85, unit: "%", step: 1 }
];

export const LIQUID_GLASS_DEFAULTS: LiquidGlassParams = LIQUID_GLASS_PARAMS.reduce(
  (acc, p) => {
    acc[p.key] = p.def;
    return acc;
  },
  {} as LiquidGlassParams
);

/** Peak throw at Refraction 100, as a fraction of Depth. */
export const GLASS_PEAK_RATIO = 0.55;

/** Red-vs-blue throw split at Dispersion 100, as a fraction of the peak. */
export const GLASS_DISP_SPREAD = 0.5;

/** Width of the subtle edge definition, as a fraction of Depth. */
export const GLASS_DARK_EDGE_RATIO = 0.1;

/**
 * Width, in px, over which the two nearest-face normals are blended across the
 * medial axis. Wide enough that the 90° turn is spread over several pixels,
 * narrow enough that it stays inside the band's outer ramp.
 */
const FACE_BLEND = 2.5;

/** Depth is capped at this fraction of the element's short side. */
export const GLASS_MAX_DEPTH_FRACTION = 0.5;

/** How far the unlit side of the rim is lifted, as a fraction of the lit side. */
export const GLASS_RIM_FLOOR = 0.04;

/** Clamp one parameter to the range its spec declares, by name. */
export function clampGlassParam(key: keyof LiquidGlassParams, value: number): number {
  const spec = LIQUID_GLASS_PARAMS.find((p) => p.key === key);
  if (!spec) return (LIQUID_GLASS_DEFAULTS as any)[key] ?? 0;
  if (!Number.isFinite(value)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, value));
}

/**
 * Read the nine numbers off an effect, clamped into range.
 */
export function liquidGlassParams(effect: LiquidGlassEffect | undefined): LiquidGlassParams {
  const out = { ...LIQUID_GLASS_DEFAULTS };
  if (!effect) return out;
  for (const spec of LIQUID_GLASS_PARAMS) {
    const raw = (effect as unknown as Record<string, unknown>)[spec.key];
    const n = typeof raw === "number" && Number.isFinite(raw) ? raw : spec.def;
    out[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
  }
  return out;
}

/** Everything the bake needs that is not a parameter. */
export interface GlassDerived {
  /** Depth after the short-side cap — what the band actually measures. */
  depth: number;
  /** Peak throw of the green channel, in px. */
  peak: number;
  /** Peak throws of the three channels; R and B are split by Dispersion. */
  peakR: number;
  peakG: number;
  peakB: number;
  /** Half the red-blue split, i.e. how far each fringe channel is thrown apart. */
  fringe: number;
  /** Frost as a blur radius, in px. */
  frostPx: number;
  /** Unit vector the light comes from, in screen coordinates (y grows downward). */
  lx: number;
  ly: number;
  /** Light intensity as a 0-1 fraction. */
  intensity: number;
  /** How far the projected light spreads, as a fraction of Depth. */
  spread: number;
  /** Width of the edge definition zone, in px. */
  darkW: number;
}

export function glassDerived(p: LiquidGlassParams, width: number, height: number): GlassDerived {
  const short = Math.max(1, Math.min(width, height));
  /* Calibrated against Figma's native Glass effect:
     1. Depth maps 1:1 in px to how far the curved dome bevel reaches inward from the border,
        capped at half the short side so opposite rims never cross.
     2. In Figma/Skia, blur radius R maps to Gaussian sigma = R / 2. CSS backdrop-filter: blur(Npx)
        takes Gaussian sigma directly, so frost / 2 matches Figma's Frost 1:1. */
  const depth = Math.min(p.depth, Math.max(1, short * GLASS_MAX_DEPTH_FRACTION));
  const peak = (p.refraction / 100) * depth * GLASS_PEAK_RATIO;
  const k = (p.dispersion / 100) * GLASS_DISP_SPREAD;
  const th = (p.lightAngle * Math.PI) / 180;
  return {
    depth,
    peak,
    peakR: peak * (1 + k),
    peakG: peak,
    peakB: peak * (1 - k),
    fringe: peak * k,
    frostPx: p.frost / 2,
    lx: Math.sin(th),
    ly: -Math.cos(th),
    intensity: p.lightIntensity / 100,
    spread: 0.1 + 0.9 * (p.splay / 100),
    darkW: Math.max(1.5, depth * GLASS_DARK_EDGE_RATIO)
  };
}

/* ------------------------------------------------------------------ profile */

/* Convex bevel deflection across the band. `u` is 0 at the rim and 1 Depth inside.
   Peaks right inside the rim (`u ≈ 0.0625`, where the 3D dome bevel is steepest)
   and decays smoothly and monotonically as `(1 - u)^1.8` to flat at `u = 1`,
   avoiding mid-bevel fold-back rings when Depth is large while keeping `u = 0`
   at zero so the exterior boundary never steps discontinuously. */
const PROFILE_A = 0.12;
const PROFILE_B = 1.8;
const PROFILE_PEAK_U = PROFILE_A / (PROFILE_A + PROFILE_B);
const PROFILE_NORM = Math.pow(PROFILE_PEAK_U, PROFILE_A) * Math.pow(1 - PROFILE_PEAK_U, PROFILE_B);

/** Deflection at `u`, normalised so the peak is exactly 1. */
export function glassProfile(u: number): number {
  if (!(u > 0) || u >= 1) return 0;
  return (Math.pow(u, PROFILE_A) * Math.pow(1 - u, PROFILE_B)) / PROFILE_NORM;
}

/* ---------------------------------------------------------------------- sdf */

export interface GlassSdfSample {
  /** Signed distance: negative inside the shape, positive outside, in px. */
  d: number;
  /** Unit outward normal. */
  nx: number;
  ny: number;
}

/** Smooth C1 ramp that replaces `Math.max(0, q)` when regularizing inner corner normals. */
function softPositive(q: number, w: number): number {
  if (w <= 0 || q >= w) return q > 0 ? q : 0;
  if (q <= -w) return 0;
  const t = q + w;
  return (t * t) / (4 * w);
}

/**
 * Signed distance to a rounded rectangle with four independent corner radii and
 * optional corner smoothing (squircle).
 *
 * When `Depth` exceeds a corner's radius `r`, the raw parallel offset curve of a
 * rounded rectangle pinches to a 0-radius focal singularity at `(hw - r, hh - r)`
 * and jumps in curvature at `qx = 0` / `qy = 0` (where the straight side meets
 * the arc), producing visible creases on curved corners. To prevent that while
 * keeping the distance `d` exact, the normal direction `(nx, ny)` regularizes the
 * effective inner arc radius so it never collapses to zero as `-d` grows past `r`.
 */
export function glassRoundedRectSdf(
  x: number,
  y: number,
  w: number,
  h: number,
  radii: readonly [number, number, number, number],
  smoothing = 0
): GlassSdfSample {
  const hw = w / 2;
  const hh = h / 2;
  const cx = x - hw;
  const cy = y - hh;
  const [tl, tr, br, bl] = radii;
  const r = cx < 0 ? (cy < 0 ? tl : bl) : cy < 0 ? tr : br;

  const qx = Math.abs(cx) - (hw - r);
  const qy = Math.abs(cy) - (hh - r);
  const ax = qx > 0 ? qx : 0;
  const ay = qy > 0 ? qy : 0;

  const dx = hw - Math.abs(cx);
  const dy = hh - Math.abs(cy);
  const dMin = Math.min(dx, dy);

  let d: number;
  if (ax > 0 || ay > 0) {
    if (smoothing > 0 && ax > 0 && ay > 0) {
      const p = 2 + 1.5 * Math.min(1, smoothing);
      d = Math.pow(Math.pow(ax, p) + Math.pow(ay, p), 1 / p) - r;
    } else {
      d = Math.hypot(ax, ay) - r;
    }
  } else {
    d = Math.max(qx, qy) - r;
    if (d < 0 && dMin > r) {
      const wDist = Math.min(dMin * 0.75, Math.max(FACE_BLEND, (dMin - r) * 0.7));
      const diff = wDist - Math.abs(dx - dy);
      if (diff > 0 && wDist > 0) {
        d += (diff * diff) / (4 * wDist);
      }
    }
  }

  // Conical corner-fan regularization: for both sharp rectangles (r = 0) and
  // rounded rectangles when Depth reaches or exceeds r, expand the effective
  // corner radius using `dx + dy` so `qxn = rn - dx ≈ dy` and `qyn = rn - dy ≈ dx`
  // stay positive across the entire 90° corner quadrant instead of collapsing
  // along a 45° diagonal miter crease.
  if (d < 0) {
    const cornerSpan = dx + dy + softPositive(r - (dx + dy), Math.max(FACE_BLEND * 2, r * 0.35));
    const maxCap = Math.min(hw, hh) * 0.9;
    const rn = Math.min(maxCap, Math.max(r, cornerSpan));
    const qxn = Math.abs(cx) - (hw - rn);
    const qyn = Math.abs(cy) - (hh - rn);
    const filletW = dMin > 1 ? Math.min(rn * 0.3, dMin * 0.5) : 0;
    const axn = softPositive(qxn, filletW);
    const ayn = softPositive(qyn, filletW);
    if (axn > 0 || ayn > 0) {
      let gx = axn;
      let gy = ayn;
      if (smoothing > 0 && axn > 0 && ayn > 0) {
        const p = 2 + 1.5 * Math.min(1, smoothing);
        gx = Math.pow(axn, p - 1);
        gy = Math.pow(ayn, p - 1);
      } else if (dx + dy > r && axn > 0 && ayn > 0) {
        // Gently sharpen wall alignment near the edges of the corner fan while
        // keeping the 45° diagonal completely smooth.
        const fanBlend = Math.min(1, (dx + dy - r) / Math.max(8, r + 8));
        const pFan = 1 + 0.5 * fanBlend;
        gx = Math.pow(axn, pFan);
        gy = Math.pow(ayn, pFan);
      }
      const sx = Math.abs(cx) < FACE_BLEND ? cx / FACE_BLEND : cx < 0 ? -1 : 1;
      const sy = Math.abs(cy) < FACE_BLEND ? cy / FACE_BLEND : cy < 0 ? -1 : 1;
      const nxRaw = sx * gx;
      const nyRaw = sy * gy;
      const len = Math.hypot(nxRaw, nyRaw) || 1;
      return { d, nx: nxRaw / len, ny: nyRaw / len };
    }
  } else if (ax > 0 || ay > 0) {
    let gx = ax;
    let gy = ay;
    if (smoothing > 0 && ax > 0 && ay > 0) {
      const p = 2 + 1.5 * Math.min(1, smoothing);
      gx = Math.pow(ax, p - 1);
      gy = Math.pow(ay, p - 1);
    }
    const len = Math.hypot(gx, gy) || 1;
    return {
      d,
      nx: (cx < 0 ? -gx : gx) / len,
      ny: (cy < 0 ? -gy : gy) / len
    };
  }

  const m = qx - qy;
  const t = Math.min(1, Math.max(0, 0.5 + m / (2 * FACE_BLEND)));
  const sx = Math.abs(cx) < FACE_BLEND ? cx / FACE_BLEND : cx < 0 ? -1 : 1;
  const sy = Math.abs(cy) < FACE_BLEND ? cy / FACE_BLEND : cy < 0 ? -1 : 1;
  const bx = sx * t;
  const by = sy * (1 - t);
  const blen = Math.hypot(bx, by) || 1;
  return {
    d,
    nx: bx / blen,
    ny: by / blen
  };
}

/**
 * Analytical signed distance and smooth outward normal for an axis-aligned
 * ellipse of any aspect ratio (`w × h`).
 *
 * Uses the exact analytical Euclidean distance to the ellipse boundary
 * (Quilez formulation), providing exact signed distance across all aspect
 * ratios and smooth, continuous outward normals.
 */
export function glassEllipseSdf(
  x: number,
  y: number,
  w: number,
  h: number
): GlassSdfSample {
  const a = Math.max(0.5, w / 2);
  const b = Math.max(0.5, h / 2);
  const cx = x - a;
  const cy = y - b;
  let px = Math.abs(cx);
  let py = Math.abs(cy);

  let swapped = false;
  let semiA = a;
  let semiB = b;
  if (px > py) {
    const tmpP = px; px = py; py = tmpP;
    const tmpS = semiA; semiA = semiB; semiB = tmpS;
    swapped = true;
  }

  const l = semiB * semiB - semiA * semiA;
  let closestX: number;
  let closestY: number;
  let d: number;

  if (Math.abs(l) < 1e-7) {
    const r = semiA;
    const hyp = Math.hypot(px, py);
    d = hyp - r;
    closestX = hyp > 1e-6 ? (px / hyp) * r : r;
    closestY = hyp > 1e-6 ? (py / hyp) * r : 0;
  } else {
    const m = (semiA * px) / l;
    const m2 = m * m;
    const n = (semiB * py) / l;
    const n2 = n * n;
    const c = (m2 + n2 - 1.0) / 3.0;
    const c3 = c * c * c;
    const q = c3 + m2 * n2 * 2.0;
    const disc = c3 + m2 * n2;
    const g = m + m * n2;
    let co: number;
    if (disc < 0.0) {
      const h = Math.acos(Math.max(-1, Math.min(1, q / c3))) / 3.0;
      const s = Math.cos(h);
      const t = Math.sin(h) * Math.sqrt(3.0);
      const rx = Math.sqrt(Math.max(0, -c * (s + t + 2.0) + m2));
      const ry = Math.sqrt(Math.max(0, -c * (s - t + 2.0) + m2));
      co = (ry + Math.sign(l) * rx + Math.abs(g) / (rx * ry || 1) - m) / 2.0;
    } else {
      const h = 2.0 * m * n * Math.sqrt(Math.max(0, disc));
      const s = Math.sign(q + h) * Math.pow(Math.abs(q + h), 1.0 / 3.0);
      const u = Math.sign(q - h) * Math.pow(Math.abs(q - h), 1.0 / 3.0);
      const rx = -s - u - c * 4.0 + 2.0 * m2;
      const ry = (s - u) * Math.sqrt(3.0);
      const rm = Math.hypot(rx, ry);
      co = (ry / (Math.sqrt(Math.max(0, rm - rx)) || 1) + (2.0 * g) / (rm || 1) - m) / 2.0;
    }
    co = Math.max(0, Math.min(1, co));
    const si = Math.sqrt(Math.max(0, 1.0 - co * co));
    closestX = semiA * co;
    closestY = semiB * si;
    const inside = (px * px) / (semiA * semiA) + (py * py) / (semiB * semiB) <= 1.0;
    d = Math.hypot(px - closestX, py - closestY) * (inside ? -1 : 1);
  }

  if (swapped) {
    const tmp = closestX;
    closestX = closestY;
    closestY = tmp;
  }

  const sx = cx < 0 ? -1 : cx > 0 ? 1 : 0;
  const sy = cy < 0 ? -1 : cy > 0 ? 1 : 0;
  let nx = (closestX / (a * a)) * (sx || 1);
  let ny = (closestY / (b * b)) * (sy || 0);
  if (sx === 0 && sy === 0) {
    nx = 1;
    ny = 0;
  }
  const nLen = Math.hypot(nx, ny) || 1;
  return {
    d,
    nx: nx / nLen,
    ny: ny / nLen
  };
}
