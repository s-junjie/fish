import { describe, expect, it } from "vitest";
import {
  GLASS_DARK_EDGE_RATIO,
  GLASS_DISP_SPREAD,
  GLASS_MAX_DEPTH_FRACTION,
  GLASS_PEAK_RATIO,
  LIQUID_GLASS_DEFAULTS,
  LIQUID_GLASS_PARAMS,
  clampGlassParam,
  glassDerived,
  glassEllipseSdf,
  glassProfile,
  glassRoundedRectSdf,
  liquidGlassParams
} from "../src/core/dsl/liquid-glass";
import { liquidGlassFrom } from "../src/core/dsl/normalize/effects";
import { LiquidGlassEffect, Paint } from "../src/core/dsl/types";
import { resolveSolidPaintBlend } from "../src/ui/canvas/SvgShapeNode";
import { backdropShapeStyle } from "../src/ui/canvas/backdrop-shape";

// The effect's authoring surface IS the feature: a designer who has used Figma's
// glass must find the same nine controls under the same names, or they cannot
// carry a look across. These pin the table itself, because every consumer — the
// inspector, the bake, the docs — reads it and none of them would notice a
// rename.
const FIGMA_ORDER: Array<[string, string, number, number, number]> = [
  ["refraction", "Refraction", 0, 100, 80],
  ["depth", "Depth", 1, 100, 10],
  ["dispersion", "Dispersion", 0, 100, 30],
  ["frost", "Frost", 0, 100, 4],
  ["splay", "Splay", 0, 100, 20],
  ["lightAngle", "Light angle", -180, 180, -35],
  ["lightIntensity", "Light intensity", 0, 100, 85]
];

const glass = (over: Partial<LiquidGlassEffect> = {}): LiquidGlassEffect => ({
  type: "liquid-glass",
  ...LIQUID_GLASS_DEFAULTS,
  enabled: true,
  ...over
});

describe("the glass parameter surface", () => {
  it("is Figma's seven, in Figma's order, under Figma's names", () => {
    expect(LIQUID_GLASS_PARAMS.map((p) => p.key)).toEqual(FIGMA_ORDER.map(([key]) => key));
    expect(LIQUID_GLASS_PARAMS.map((p) => p.label)).toEqual(FIGMA_ORDER.map(([, label]) => label));
  });

  it("carries Figma's ranges and the calibrated defaults", () => {
    for (const [key, , min, max, def] of FIGMA_ORDER) {
      const spec = LIQUID_GLASS_PARAMS.find((p) => p.key === key)!;
      expect({ key, min: spec.min, max: spec.max, def: spec.def }).toEqual({ key, min, max, def });
      expect(LIQUID_GLASS_DEFAULTS[key as keyof typeof LIQUID_GLASS_DEFAULTS]).toBe(def);
    }
  });

  it("says what the numbers mean: Depth is a length, Refraction is a ratio", () => {
    const unit = (key: string) => LIQUID_GLASS_PARAMS.find((p) => p.key === key)!.unit;
    expect(unit("frost")).toBe("px");
    expect(unit("depth")).toBe("px");
    expect(unit("lightAngle")).toBe("°");
    expect(unit("refraction")).toBe("%");
  });

  it("has dropped the reverse-engineered knobs", () => {
    const keys = LIQUID_GLASS_PARAMS.map((p) => String(p.key));
    expect(keys).not.toContain("blur");
    expect(keys).not.toContain("saturation");
    expect(keys).not.toContain("brightness");
  });

  it("every parameter has a distinct i18n key under effects.", () => {
    const keys = LIQUID_GLASS_PARAMS.map((p) => p.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.startsWith("effects.glass"))).toBe(true);
  });
});

describe("glass parameter clamping", () => {
  it("clamps to the declared range and survives junk", () => {
    expect(clampGlassParam("depth", 0)).toBe(1);
    expect(clampGlassParam("depth", 500)).toBe(100);
    expect(clampGlassParam("lightAngle", -400)).toBe(-180);
    expect(clampGlassParam("splay", Number.NaN)).toBe(LIQUID_GLASS_DEFAULTS.splay);
  });

  it("fills a partially specified effect from the defaults", () => {
    const p = liquidGlassParams({ type: "liquid-glass", depth: 30 } as LiquidGlassEffect);
    expect(p.depth).toBe(30);
    expect(p.refraction).toBe(LIQUID_GLASS_DEFAULTS.refraction);
  });

  it("clamps a stored value that the inspector never wrote", () => {
    // An external author may write any number; the renderer must not trust it.
    const p = liquidGlassParams(glass({ depth: 1e6, frost: -5 }));
    expect(p.depth).toBe(100);
    expect(p.frost).toBe(0);
  });

  it("falls back to the whole default set with no effect at all", () => {
    expect(liquidGlassParams(undefined)).toEqual(LIQUID_GLASS_DEFAULTS);
  });
});

describe("derived geometry", () => {
  it("turns the ratios into the lengths the bake needs", () => {
    const d = glassDerived(liquidGlassParams(glass()), 400, 240);
    expect(d.depth).toBe(10);
    expect(d.peak).toBeCloseTo(GLASS_PEAK_RATIO * 10 * 0.8, 10);
    expect(d.frostPx).toBe(2);
    expect(d.intensity).toBeCloseTo(0.85, 10);
    expect(d.darkW).toBe(1.5);
  });

  it("spreads Dispersion's fringe symmetrically about the green throw", () => {
    const d = glassDerived(liquidGlassParams(glass({ dispersion: 100 })), 400, 240);
    expect(d.peakG).toBeCloseTo(d.peak, 10);
    expect(d.peakR).toBeCloseTo(d.peak * (1 + GLASS_DISP_SPREAD), 10);
    expect(d.peakB).toBeCloseTo(d.peak * (1 - GLASS_DISP_SPREAD), 10);
    expect(d.fringe).toBeCloseTo(d.peakR - d.peak, 10);
  });

  it("takes the light angle clockwise from the top", () => {
    const top = glassDerived(liquidGlassParams(glass({ lightAngle: 0 })), 400, 240);
    expect(top.lx).toBeCloseTo(0, 10);
    expect(top.ly).toBeCloseTo(-1, 10); // screen y grows downward
    const right = glassDerived(liquidGlassParams(glass({ lightAngle: 90 })), 400, 240);
    expect(right.lx).toBeCloseTo(1, 10);
    expect(right.ly).toBeCloseTo(0, 10);
  });

  it("widens Splay's spread but never to nothing", () => {
    const tight = glassDerived(liquidGlassParams(glass({ splay: 0 })), 400, 240);
    const wide = glassDerived(liquidGlassParams(glass({ splay: 100 })), 400, 240);
    expect(tight.spread).toBeCloseTo(0.1, 10);
    expect(wide.spread).toBeCloseTo(1, 10);
  });

  it("caps Depth at half the short side so one band cannot reach the far rim", () => {
    const d = glassDerived(liquidGlassParams(glass({ depth: 90 })), 400, 40);
    expect(d.depth).toBe(40 * GLASS_MAX_DEPTH_FRACTION);
    expect(glassDerived(liquidGlassParams(glass({ depth: 90 })), 400, 240).depth).toBe(90);
  });

  it("keeps the dark edge visible on a tiny panel", () => {
    const d = glassDerived(liquidGlassParams(glass({ depth: 1 })), 20, 20);
    expect(d.darkW).toBe(1.5);
  });
});

describe("the deflection profile", () => {
  it("is zero at both ends of the band and outside it", () => {
    expect(glassProfile(0)).toBe(0);
    expect(glassProfile(1)).toBe(0);
    expect(glassProfile(-0.5)).toBe(0);
    expect(glassProfile(1.5)).toBe(0);
    expect(glassProfile(Number.NaN)).toBe(0);
  });

  it("peaks near the outer rim, normalised to exactly 1", () => {
    let best = { u: 0, v: 0 };
    for (let u = 0.0005; u < 1; u += 0.0005) {
      const v = glassProfile(u);
      if (v > best.v) best = { u, v };
    }
    expect(best.u).toBeCloseTo(0.0625, 3);
    expect(best.v).toBeCloseTo(1, 6); // the norm is the value AT the peak
  });

  it("rises then falls smoothly across the bevel, and never exceeds 1", () => {
    let prev = 0;
    let peakSeen = 0;
    for (let u = 0.001; u < 1; u += 0.005) {
      const v = glassProfile(u);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
      if (u < 0.06) expect(v).toBeGreaterThan(prev);
      else peakSeen = Math.max(peakSeen, v);
      prev = v;
    }
    expect(peakSeen).toBeGreaterThan(0.9);
  });
});

describe("analytical ellipse signed distance", () => {
  it("computes smooth normals without staircase or evolute creases on non-circular ovals", () => {
    const w = 348;
    const h = 150;
    expect(glassEllipseSdf(w / 2, 0, w, h).d).toBeCloseTo(0, 6);
    expect(glassEllipseSdf(0, h / 2, w, h).d).toBeCloseTo(0, 6);
    expect(glassEllipseSdf(w / 2, 10, w, h).ny).toBeCloseTo(-1, 5);
    expect(glassEllipseSdf(10, h / 2, w, h).nx).toBeCloseTo(-1, 5);
  });

  it("returns true Euclidean distance on elongated ovals so the bevel stays active across the width", () => {
    const w = 120;
    const h = 35;
    // At the center of a 120×35 oval, the nearest edge is the top/bottom at 17.5px,
    // never the 60px horizontal semi-axis that a homothetic approximation produces.
    const center = glassEllipseSdf(w / 2, h / 2, w, h);
    expect(center.d).toBeCloseTo(-17.5, 4);

    // 4px inside the top edge at the horizontal midpoint: the nearest rim is 4px away,
    // so -d = 4px (well within the 17.5px bevel depth) rather than the ~46px returned
    // by a homothetic approximation that killed the deflection across the oval's middle.
    const topBevel = glassEllipseSdf(w / 2, 4, w, h);
    expect(topBevel.d).toBeCloseTo(-4, 4);
    expect(glassProfile(-topBevel.d / 17.5)).toBeGreaterThan(0.5);

    const offCenter = glassEllipseSdf(80, h / 2, w, h);
    expect(offCenter.d).toBeGreaterThan(-17.5);
    expect(glassProfile(-offCenter.d / 17.5)).toBeGreaterThan(0);
  });
});

describe("backdrop shape clipping for Chromium foreignObject compositor", () => {
  it("uses border-radius: 50% for full ellipses so ancestor SVG clip-paths do not flatten the backdrop to a box", () => {
    const el = { id: "e1", name: "Oval", type: "ellipse", x: 0, y: 0, width: 120, height: 35 } as any;
    expect(backdropShapeStyle(el, 120, 35, "M 60 0 A 60 17.5 0 1 1 60 35 Z")).toEqual({
      borderRadius: "50%"
    });
  });

  it("uses border-radius for rects and frames without corner smoothing", () => {
    const el = { id: "r1", name: "Rect", type: "rect", x: 0, y: 0, width: 120, height: 35, borderRadius: 12 } as any;
    expect(backdropShapeStyle(el, 120, 35, "M0,0 H120 V35 H0 Z")).toEqual({
      borderRadius: "12px 12px 12px 12px"
    });
  });

  it("falls back to clip-path: path(...) for partial arcs, smoothed corners, and arbitrary paths", () => {
    const arc = { id: "e2", name: "Arc", type: "ellipse", x: 0, y: 0, width: 100, height: 100, sweep: 270 } as any;
    expect(backdropShapeStyle(arc, 100, 100, "M0,0 Z")).toEqual({
      clipPath: "path('M0,0 Z')"
    });
    const smoothRect = {
      id: "r2",
      name: "Squircle",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      borderRadius: 20,
      cornerSmoothing: 0.6
    } as any;
    expect(backdropShapeStyle(smoothRect, 100, 100, "M20,0 Z")).toEqual({
      clipPath: "path('M20,0 Z')"
    });
  });
});

describe("the rounded-rect signed distance", () => {
  const rect: [number, number, number, number] = [30, 30, 30, 30];

  it("is negative inside, positive outside, zero on the edge", () => {
    expect(glassRoundedRectSdf(200, 120, 400, 240, rect).d).toBeCloseTo(-120, 6);
    expect(glassRoundedRectSdf(0, 120, 400, 240, rect).d).toBeCloseTo(0, 6);
    expect(glassRoundedRectSdf(-10, 120, 400, 240, rect).d).toBeCloseTo(10, 6);
  });

  it("measures a LENGTH from the edge, not a normalised position", () => {
    const near = glassRoundedRectSdf(5, 120, 400, 240, rect).d;
    const far = glassRoundedRectSdf(50, 120, 400, 240, rect).d;
    expect(near).toBeCloseTo(-5, 6);
    expect(far).toBeCloseTo(-50, 6);
  });

  it("points the normal outward, along the nearest edge", () => {
    expect(glassRoundedRectSdf(5, 120, 400, 240, rect).nx).toBeCloseTo(-1, 6);
    expect(glassRoundedRectSdf(395, 120, 400, 240, rect).nx).toBeCloseTo(1, 6);
    expect(glassRoundedRectSdf(200, 5, 400, 240, rect).ny).toBeCloseTo(-1, 6);
    expect(glassRoundedRectSdf(200, 235, 400, 240, rect).ny).toBeCloseTo(1, 6);
  });

  it("turns the normal into the corner", () => {
    // 10px in from the left and 10px down from the top, on a 30px corner: the
    // nearest point is 30 - sqrt(30^2 - 20^2) inward of both edges, so the
    // normal is the 45-degree diagonal, not a flat -x or -y.
    const s = glassRoundedRectSdf(10, 10, 400, 240, rect);
    expect(s.nx).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(s.ny).toBeCloseTo(-Math.SQRT1_2, 3);
  });

  it("fans the normal smoothly across a sharp rectangle's corner diagonal at deep Depth without a hard 45° crease", () => {
    const sharp: [number, number, number, number] = [0, 0, 0, 0];
    const w = 224;
    const h = 183;
    const offDiag = glassRoundedRectSdf(40, 20, w, h, sharp);
    expect(offDiag.nx).toBeLessThan(-0.15);
    expect(offDiag.ny).toBeLessThan(-0.7);

    let maxDeg = 0;
    for (let y = 4; y < 85; y++) {
      for (let x = 4; x < 85; x++) {
        const s0 = glassRoundedRectSdf(x, y, w, h, sharp);
        for (const [x1, y1] of [[x + 1, y], [x, y + 1]]) {
          const s1 = glassRoundedRectSdf(x1, y1, w, h, sharp);
          const dot = s0.nx * s1.nx + s0.ny * s1.ny;
          const cross = s0.nx * s1.ny - s0.ny * s1.nx;
          const deg = (Math.abs(Math.atan2(cross, dot)) * 180) / Math.PI;
          if (deg > maxDeg) maxDeg = deg;
        }
      }
    }
    expect(maxDeg).toBeLessThan(15);
  });
});

describe("reading a glass effect off a document", () => {
  it("round-trips a canonical effect without moving it", () => {
    const canonical = glass();
    expect(liquidGlassFrom(canonical)).toEqual(canonical);
  });

  it("reads Refraction as the 0-100 value it is stored as", () => {
    // The old migration doubled anything <= 1, which left no way to store 1%.
    // v1 stores the percentage directly and clamps it to the declared range.
    expect(liquidGlassFrom({ type: "liquid-glass", refraction: 70 })?.refraction).toBe(70);
    expect(liquidGlassFrom({ type: "liquid-glass", refraction: 0.7 })?.refraction).toBe(0.7);
    expect(liquidGlassFrom({ type: "liquid-glass", refraction: 1 })?.refraction).toBe(1);
  });

  it("reads Frost only from its own field", () => {
    expect(liquidGlassFrom({ type: "liquid-glass", frost: 24 })?.frost).toBe(24);
    expect(liquidGlassFrom({ type: "liquid-glass", blur: 24 })?.frost).toBe(LIQUID_GLASS_DEFAULTS.frost);
    expect(liquidGlassFrom({ type: "liquid-glass", radius: 6 })?.frost).toBe(LIQUID_GLASS_DEFAULTS.frost);
  });

  it("ignores snake_case for the light", () => {
    const e = liquidGlassFrom({
      type: "liquid-glass",
      light_angle: 120,
      light_intensity: 80
    });
    expect(e?.lightAngle).toBe(LIQUID_GLASS_DEFAULTS.lightAngle);
    expect(e?.lightIntensity).toBe(LIQUID_GLASS_DEFAULTS.lightIntensity);
  });

  it("carries no fill or stroke of its own", () => {
    // Fill opacity and the hairline outline belong to the element's own fill and
    // stroke stacks, so the glass effect has nowhere to put either.
    const e = liquidGlassFrom({
      type: "liquid-glass",
      fill: 5,
      fillOpacity: 20,
      stroke: 5
    }) as unknown as Record<string, unknown>;
    expect(e.fill).toBeUndefined();
    expect(e.stroke).toBeUndefined();
  });

  it("drops saturation and brightness rather than pretending to honour them", () => {
    // They came from third-party reverse engineering, and a flat brightness lift
    // is most of why the effect read as fogged glass. Silently keeping them would
    // mean an old document renders differently from what its numbers say.
    const e = liquidGlassFrom({ type: "liquid-glass", saturation: 180, brightness: 1.4 }) as unknown as Record<
      string,
      unknown
    >;
    expect(e.saturation).toBeUndefined();
    expect(e.brightness).toBeUndefined();
  });

  it("defaults every field that was omitted", () => {
    const e = liquidGlassFrom({ type: "liquid-glass", frost: 8 });
    expect(e).toEqual({ ...glass(), frost: 8 });
  });

  it("returns nothing for a non-object", () => {
    expect(liquidGlassFrom(null)).toBeUndefined();
    expect(liquidGlassFrom("liquid-glass")).toBeUndefined();
  });
});

describe("liquid glass fill opacity rendering and restoration", () => {
  it("renders a 100% solid fill at 100% opacity so opaque paint covers the glass", () => {
    const solidFill: Paint = { type: "solid", color: "#FFFFFF" };
    // 100% fill must retain its authored opacity (1.0) rather than being forcibly faded to 0.06
    const resolved = resolveSolidPaintBlend(solidFill, [solidFill], true, false);
    expect(resolved.opacity).toBe(1);
    expect(resolved.fillVal).toBe("#FFFFFF");
  });

  it("renders a 20% solid fill with 20% alpha so glass is visible through the translucent tint", () => {
    // 20% fill authored or adjusted upon adding glass
    const tintFill: Paint = { type: "solid", color: "#ffffff33" };
    const resolved = resolveSolidPaintBlend(tintFill, [tintFill], true, false);
    expect(resolved.opacity).toBe(1);
    expect(resolved.fillVal).toBe("#ffffff33");
  });

  it("restores fill opacity to 100% even if a solid paint previously carried a stale opacity property", () => {
    // Simulate a solid fill that got stale opacity: 0.2 attached
    const staleFill: Paint = { type: "solid", color: "#FFFFFF", opacity: 0.2 };
    // When manually setting back to 100%, inspector cleans up opacity property
    const restoredFill: Paint = { ...staleFill, color: "#FFFFFF" };
    delete (restoredFill as any).opacity;

    const resolved = resolveSolidPaintBlend(restoredFill, [restoredFill], false, false);
    expect(resolved.opacity).toBe(1);
    expect(resolved.fillVal).toBe("#FFFFFF");
  });
});

