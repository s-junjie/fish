import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { polygonToPathData, rectToPathData, starToPathData } from "../src/core/geometry/shape-path";
import { circularHandleFactor } from "../src/core/geometry/corner-smoothing";
import { parsePathData } from "../src/core/geometry/path-data";
import { closedOutlineToPathData } from "../src/core/geometry/corner-smoothing";
import { convertShapeToPathElement } from "../src/core/geometry/path-convert";
import { elementToRings } from "../src/core/geometry/boolean-ops";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignDocument, RectElement, StarElement } from "../src/core/dsl/types";

const star = (over: Partial<StarElement> = {}): StarElement => ({
  id: "s1",
  type: "star",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  points: 5,
  ...over
});

/** Every coordinate pair in the path, whether it arrived by L or by C. */
const coordsOf = (d: string): number[] =>
  d
    .replace(/[MLCZ]/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

describe("star outline", () => {
  it("emits two vertices per point, first one at top centre", () => {
    const d = starToPathData(star({ points: 5 }));
    expect(d.startsWith("M 50 0")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    // 5 spikes = 10 vertices, so 5 line commands after the move.
    expect(d.match(/L/g)).toHaveLength(9);
    expect(d).not.toMatch(/C/);
  });

  it("scales spike count with points, and is not a polygon of the same count", () => {
    expect(starToPathData(star({ points: 3 })).match(/L/g)).toHaveLength(5);
    // A 5-point star's ten vertices are what makes `points` the honest name: the
    // same outline as `sides: 5` would be a pentagon, not a star.
    expect(starToPathData(star({ points: 5 })).match(/L/g)).toHaveLength(9);
    expect(polygonToPathData({ id: "p", type: "polygon", x: 0, y: 0, width: 100, height: 100, sides: 5 }).match(/L/g)).toHaveLength(4);
  });

  it("pulls alternate vertices in to innerRadius, and 0.99 is nearly a polygon", () => {
    const radiiOf = (inner: number): number[] => {
      const nums = coordsOf(starToPathData(star({ points: 5, innerRadius: inner })));
      const out: number[] = [];
      // Vertices alternate outer, inner, outer… so even indices are the tips.
      for (let i = 0; i + 1 < nums.length; i += 2) out.push(Math.hypot(nums[i] - 50, nums[i + 1] - 50));
      return out;
    };
    const half = radiiOf(0.5);
    expect(half[0]).toBeCloseTo(50, 1);
    expect(half[1]).toBeCloseTo(25, 1);
    expect(radiiOf(0.99)[1]).toBeCloseTo(49.5, 1);
  });

  it("clamps a hostile document rather than emitting a broken outline", () => {
    expect(starToPathData(star({ points: 0 })).match(/L/g)).toHaveLength(5);
    expect(starToPathData(star({ points: 999 })).match(/L/g)).toHaveLength(47);
    expect(starToPathData(star({ width: 0, height: 0 }))).toBe("");
  });

  it("defaults to a hard edge, and Figma's 0.382 inner radius, when nothing is set", () => {
    const d = starToPathData(star({ points: undefined as never, innerRadius: undefined }));
    expect(d).not.toMatch(/C/);
    const nums = coordsOf(d);
    expect(Math.hypot(nums[2] - 50, nums[3] - 50)).toBeCloseTo(50 * 0.382, 1);
  });
});

/**
 * Curvature at the point where a rounded corner meets a straight edge, divided by
 * curvature at the middle of the corner. 1 means a circular arc; below 1 means the
 * junction is flatter than the middle, which is the squircle signature.
 */
function junctionRatio(d: string): number {
  const model = parsePathData(d);
  const seg = model?.segments.find((s) => s.kind === "cubic");
  if (!model || !seg || seg.kind !== "cubic") throw new Error("no cubic in path");
  const a = model.anchors[seg.a];
  const b = model.anchors[seg.b];
  const c1 = seg.ca;
  const c2 = seg.cb;
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y
    };
  };
  const curv = (t: number) => {
    const h = 1e-4;
    const p0 = at(Math.max(0, t - h));
    const p1 = at(t);
    const p2 = at(Math.min(1, t + h));
    const dx = (p2.x - p0.x) / (2 * h);
    const dy = (p2.y - p0.y) / (2 * h);
    return Math.abs((dx * (p2.y - 2 * p1.y + p0.y) - dy * (p2.x - 2 * p1.x + p0.x)) / (h * h)) / Math.hypot(dx, dy) ** 3;
  };
  return curv(0.05) / curv(0.5);
}

/** Max/min curvature along the first corner curve. 1.0 means a perfect circle. */
function curvatureSpread(d: string): number {
  const model = parsePathData(d);
  const seg = model?.segments.find((s) => s.kind === "cubic");
  if (!model || !seg || seg.kind !== "cubic") throw new Error("no cubic in path");
  const a = model.anchors[seg.a];
  const b = model.anchors[seg.b];
  const c1 = seg.ca;
  const c2 = seg.cb;
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y
    };
  };
  const curv = (t: number) => {
    const h = 1e-4;
    const p0 = at(Math.max(0, t - h));
    const p1 = at(t);
    const p2 = at(Math.min(1, t + h));
    const dx = (p2.x - p0.x) / (2 * h);
    const dy = (p2.y - p0.y) / (2 * h);
    return Math.abs((dx * (p2.y - 2 * p1.y + p0.y) - dy * (p2.x - 2 * p1.x + p0.x)) / (h * h)) / Math.hypot(dx, dy) ** 3;
  };
  const vals = [0.1, 0.3, 0.5, 0.7, 0.9].map(curv);
  return Math.max(...vals) / Math.min(...vals);
}

/** Where the outline's first curve begins — the corner's cut-back distance. */
function firstCut(d: string): { x: number; y: number } {
  const m = /^M ([-\d.]+) ([-\d.]+)/.exec(d);
  if (!m) throw new Error("path does not start with a move");
  return { x: Number(m[1]), y: Number(m[2]) };
}

describe("corner radius and corner smoothing are separate axes", () => {
  it("radius 0 is a hard polyline whatever the smoothing says", () => {
    const verts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ];
    expect(closedOutlineToPathData(verts, 0, 0)).toBe("M 0 0 L 10 0 L 10 10 Z");
    // Smoothing with nothing to smooth is not an error and not a rounding.
    expect(closedOutlineToPathData(verts, 0, 1)).toBe("M 0 0 L 10 0 L 10 10 Z");
    expect(starToPathData(star({ cornerRadius: 0, cornerSmoothing: 1 }))).not.toMatch(/C/);
  });

  it("the RADIUS sets how deep the corner is cut, and smoothing does not move it", () => {
    // This is the whole point of the split. The earlier single control cut the
    // corner AND rounded it, so smoothing silently resized the shape.
    const at = (s: number) => firstCut(starToPathData(star({ cornerRadius: 12, cornerSmoothing: s })));
    const shallow = at(0);
    expect(at(0.6)).toEqual(shallow);
    expect(at(1)).toEqual(shallow);
    // A deeper radius really does cut further, so the field is not inert.
    expect(firstCut(starToPathData(star({ cornerRadius: 24 })))).not.toEqual(shallow);
  });

  it("smoothing sets how ROUND the corner is, leaving the depth alone", () => {
    // Measured on a 90-degree corner. A star tip is 36 degrees, where the curve
    // is nearly straight and the ratio is finite-difference noise, not geometry.
    const ratio = (s: number) =>
      junctionRatio(
        rectToPathData({ id: "r", type: "rect", x: 0, y: 0, width: 200, height: 200, borderRadius: 40, cornerSmoothing: s })
      );
    expect(ratio(0)).toBeCloseTo(1, 2);
    expect(ratio(0.6)).toBeLessThan(0.35);
    expect(ratio(1)).toBeLessThan(ratio(0.6));
    // Figma's iOS preset must land in the squircle band, not merely "some value".
    expect(ratio(0.6)).toBeGreaterThan(0.02);
    expect(ratio(0.6)).toBeLessThan(0.3);
  });

  it("rounds every corner once the radius is set", () => {
    const d = starToPathData(star({ cornerRadius: 10, cornerSmoothing: 0 }));
    expect(d.match(/C/g)).toHaveLength(10);
    expect(d.match(/L/g)).toHaveLength(10);
  });

  it("uses an angle-aware factor, so every polygon is a real arc", () => {
    // 0.5523 is the circular factor at 90 degrees ONLY. Hardcoding it drew a
    // visibly wrong corner on every polygon and star that was not a square.
    expect(circularHandleFactor(Math.PI / 2)).toBeCloseTo(0.5523, 4);
    expect(circularHandleFactor((60 * Math.PI) / 180)).toBeCloseTo(0.4444, 4);
    expect(circularHandleFactor((108 * Math.PI) / 180)).toBeCloseTo(0.5963, 4);
    expect(circularHandleFactor((120 * Math.PI) / 180)).toBeCloseTo(0.6188, 4);

    // The real assertion: the outline's curvature is CONSTANT at smoothing 0 for
    // every vertex count, which is what "circular" means.
    for (const sides of [3, 4, 5, 6, 8]) {
      const d = polygonToPathData({ id: "p", type: "polygon", x: 0, y: 0, width: 200, height: 200, sides, cornerRadius: 20 });
      expect(curvatureSpread(d), `${sides}-gon is not a circular arc`).toBeLessThan(1.06);
    }
  });

  it("keeps the polygon's sharp outline byte-identical when no radius is set", () => {
    expect(
      polygonToPathData({ id: "p", type: "polygon", x: 0, y: 0, width: 100, height: 100, sides: 4 })
    ).toBe("M 50 0 L 100 50 L 50 100 L 0 50 Z");
  });
});

describe("rect corners take the same two controls", () => {
  const rect = (over: Record<string, unknown>) =>
    ({ id: "r", type: "rect", x: 0, y: 0, width: 200, height: 200, ...over }) as RectElement;

  it("leaves every existing document byte-identical", () => {
    // The arc form is what every rect written before this field existed emits.
    // Changing it unconditionally would be a rounding change nobody asked for.
    const arc = rectToPathData(rect({ borderRadius: 20 }));
    expect(arc).toContain("A 20 20");
    expect(rectToPathData(rect({ borderRadius: 20, cornerSmoothing: 0 }))).toBe(arc);
    expect(rectToPathData(rect({ borderRadius: 0 }))).toBe("M 0 0 H 200 V 200 H 0 Z");
    expect(rectToPathData(rect({ borderRadius: 0, cornerSmoothing: 1 }))).toBe("M 0 0 H 200 V 200 H 0 Z");
  });

  it("switches to the fuller curve only once smoothing is asked for", () => {
    const smooth = rectToPathData(rect({ borderRadius: 20, cornerSmoothing: 0.6 }));
    expect(smooth).toMatch(/C/);
    expect(junctionRatio(smooth)).toBeLessThan(0.35);
    expect(junctionRatio(rectToPathData(rect({ borderRadius: 20 })))).toBeCloseTo(1, 2);
  });

  it("falls back to the largest radius when the four differ", () => {
    // Smoothing is shape-wide in Figma too; a mixed-radius rect has no single
    // corner to smooth, so it must still draw rather than silently drop radii.
    const d = rectToPathData(rect({ borderRadius: [10, 40, 10, 40], cornerSmoothing: 0.6 }));
    expect(d).toMatch(/C/);
  });

  it("drops smoothing to 0 for a pill shape where the radius consumes the entire half-side", () => {
    // When corner radius reaches half of width or height, Figma leaves no straight
    // edge for squircle blending, rendering a standard circular pill.
    const pill = rectToPathData({ id: "p", type: "rect", x: 0, y: 0, width: 64, height: 28, borderRadius: 100, cornerSmoothing: 0.6 } as RectElement);
    expect(pill).toContain("A 14 14");
    expect(pill).not.toMatch(/C/);
  });
});

describe("star as a path-shaped element", () => {
  it("converts to a path element, carrying the corner geometry with it", () => {
    const sharp = convertShapeToPathElement(star());
    expect(sharp?.type).toBe("path");
    expect(sharp?.d).not.toMatch(/C/);
    const rounded = convertShapeToPathElement(star({ cornerRadius: 12, cornerSmoothing: 0.6 }));
    expect(rounded?.d).toMatch(/C/);
  });

  it("gives booleans a ring that follows the smoothed outline, not a spike", () => {
    const sharp = elementToRings(star({ cornerRadius: 16 }));
    const smooth = elementToRings(star({ cornerRadius: 16, cornerSmoothing: 1 }));
    expect(sharp).toHaveLength(1);
    expect(smooth).toHaveLength(1);
    const maxRadius = (ring: [number, number][]): number =>
      Math.max(...ring.map(([x, y]) => Math.hypot(x - 50, y - 50)));
    // At the SAME cut-back distance, smoothing makes the corner fuller, so the
    // ring reaches FURTHER toward the spike tip than the circular arc does. The
    // earlier single control did the opposite — it cut deeper as it rose — which
    // is what made it a radius wearing smoothing's name.
    expect(maxRadius(smooth[0])).toBeGreaterThan(maxRadius(sharp[0]));
    // Both stay inside the sharp star's own tip.
    expect(maxRadius(smooth[0])).toBeLessThan(50);
  });
});

describe("star normalization", () => {
  const normalize = (el: Record<string, unknown>): { el: Record<string, unknown>; repairs: unknown[] } => {
    const doc = normalizeDesignDocument({
      version: LATEST_DOCUMENT_VERSION,
      canvas: { width: 400, height: 300, unit: "px" },
      elements: [el]
    } as never) as { document: DesignDocument; repairs: unknown[] };
    return { el: getActivePage(doc.document).children[0] as unknown as Record<string, unknown>, repairs: doc.repairs };
  };

  it("keeps its own type", () => {
    const { el } = normalize({ id: "s", type: "star" });
    expect(el.type).toBe("star");
    expect(el.points).toBe(5);
  });

  it("clamps points and both ratios", () => {
    expect(normalize({ id: "s", type: "star", points: 99 }).el.points).toBe(24);
    expect(normalize({ id: "s", type: "star", points: 0 }).el.points).toBe(3);
    expect(normalize({ id: "s", type: "star", innerRadius: 5 }).el.innerRadius).toBe(0.99);
    expect(normalize({ id: "s", type: "star", cornerSmoothing: -2 }).el.cornerSmoothing).toBe(0);
    expect(normalize({ id: "s", type: "star", cornerSmoothing: 9 }).el.cornerSmoothing).toBe(1);
  });

  it("does not backfill the optional ratios, so an unset star round-trips", () => {
    const { el } = normalize({ id: "s", type: "star" });
    expect(el).not.toHaveProperty("innerRadius");
    expect(el).not.toHaveProperty("cornerSmoothing");
  });

  it("backfills fills like the other closed shapes", () => {
    const { repairs } = normalize({ id: "s", type: "star" });
    expect(repairs.some((r) => (r as { message?: string }).message?.includes("star"))).toBe(true);
  });
});