import { describe, it, expect } from "vitest";
import {
  sampleGradientAt,
  getGradientStops,
  buildCssGradient,
  buildGradientBarCss,
  calcRadialGradientCoords,
  calcLinearGradientCoords,
  topGradientPaint,
  linearAngleFromVector,
  linearLeverEndpoints
} from "../src/core/geometry/gradient-utils";
import { normalizePaint } from "../src/core/dsl/normalize/paint";
import { Paint } from "../src/core/dsl/types";

const twoStop = [
  { color: "#000000", offset: 0 },
  { color: "#ffffff", offset: 1 }
];

describe("sampleGradientAt", () => {
  it("interpolates between neighbouring stops", () => {
    expect(sampleGradientAt(twoStop, 0.5)).toBe("#808080");
    expect(sampleGradientAt(twoStop, 0.25)).toBe("#404040");
  });

  it("clamps outside the stop range", () => {
    const stops = [
      { color: "#ff0000", offset: 0.2 },
      { color: "#0000ff", offset: 0.8 }
    ];
    expect(sampleGradientAt(stops, 0)).toBe("#ff0000");
    expect(sampleGradientAt(stops, 1)).toBe("#0000ff");
    expect(sampleGradientAt(stops, 0.2)).toBe("#ff0000");
  });

  it("picks the bracketing pair from unsorted stops", () => {
    const stops = [
      { color: "#ffffff", offset: 1 },
      { color: "#000000", offset: 0 }
    ];
    expect(sampleGradientAt(stops, 0.5)).toBe("#808080");
  });

  it("interpolates alpha as well as color", () => {
    const stops = [
      { color: "#ff000080", offset: 0 },
      { color: "#ff0000ff", offset: 1 }
    ];
    // 50% between alpha 50 and alpha 100 -> 75% -> 191 (0xbf)
    expect(sampleGradientAt(stops, 0.5)).toBe("#ff0000bf");
  });

  it("falls back to white when there are no stops", () => {
    expect(sampleGradientAt([], 0.5)).toBe("#FFFFFF");
  });
});

describe("gradient paint helpers", () => {
  const paint: Paint = {
    type: "linear-gradient",
    from: "#3B82F6",
    to: "#8B5CF6",
    angle: 90,
    stops: [
      { color: "#3B82F6", offset: 0 },
      { color: "#8B5CF6", offset: 1 }
    ]
  };

  it("reads stops back out of a paint", () => {
    expect(getGradientStops(paint)).toEqual([
      { color: "#3B82F6", offset: 0 },
      { color: "#8B5CF6", offset: 1 }
    ]);
  });

  it("builds a css gradient from stops and angle", () => {
    expect(buildCssGradient(paint)).toBe("linear-gradient(90deg, #3B82F6 0%, #8B5CF6 100%)");
  });

  it("renders the stop bar as a 1D sweep for both gradient kinds", () => {
    expect(buildGradientBarCss(paint)).toBe("linear-gradient(90deg, #3B82F6 0%, #8B5CF6 100%)");
    const radial: Paint = {
      type: "radial-gradient",
      from: "#000000",
      to: "#FFFFFF",
      center: { x: 0.2, y: 0.8 },
      radius: 0.4,
      stops: [
        { color: "#FFFFFF", offset: 1 },
        { color: "#000000", offset: 0 }
      ]
    };
    expect(buildGradientBarCss(radial)).toBe("linear-gradient(90deg, #000000 0%, #FFFFFF 100%)");
  });
});

describe("radial gradient geometry", () => {
  const radial = (extra: Record<string, unknown>): Paint | undefined =>
    normalizePaint({ type: "radial-gradient", from: "#FFFFFF", to: "#000000", ...extra });

  it("defaults to the fixed centre and radius the renderer always used", () => {
    const paint = radial({}) as Extract<Paint, { type: "radial-gradient" }>;
    expect(calcRadialGradientCoords(paint)).toEqual({ cx: "50%", cy: "50%", r: "75%" });
  });

  it("carries an authored centre and radius through normalize", () => {
    const paint = radial({ center: { x: 0.2, y: 0.8 }, radius: 0.4 }) as Extract<
      Paint,
      { type: "radial-gradient" }
    >;
    expect(paint.center).toEqual({ x: 0.2, y: 0.8 });
    expect(paint.radius).toBe(0.4);
    expect(calcRadialGradientCoords(paint)).toEqual({ cx: "20%", cy: "80%", r: "40%" });
  });

  it("keeps a string `center` as the inner colour, not as geometry", () => {
    const paint = normalizePaint({
      type: "radial-gradient",
      center: "#123456",
      to: "#000000"
    }) as Extract<Paint, { type: "radial-gradient" }>;
    expect(paint.from).toBe("#123456");
    expect(paint.center).toBeUndefined();
  });

  it("clamps the centre to the box and refuses a negative radius", () => {
    const paint = radial({ center: { x: 4, y: -2 }, radius: -1 }) as Extract<
      Paint,
      { type: "radial-gradient" }
    >;
    expect(paint.center).toEqual({ x: 1, y: 0 });
    expect(paint.radius).toBe(0);
  });

  it("expands the circle shorthand into rx = ry and keeps radius in sync", () => {
    const paint = radial({ radius: 0.4 }) as Extract<Paint, { type: "radial-gradient" }>;
    expect(paint.rx).toBe(0.4);
    expect(paint.ry).toBe(0.4);
    expect(paint.radius).toBe(0.4);
  });

  it("mirrors a lone semi-axis onto the other", () => {
    const paint = radial({ rx: 0.6 }) as Extract<Paint, { type: "radial-gradient" }>;
    expect(paint.ry).toBe(0.6);
    expect(paint.radius).toBe(0.6);
  });

  it("keeps a true ellipse and drops the circle radius", () => {
    const paint = radial({ rx: 0.6, ry: 0.3, radius: 0.75 }) as Extract<
      Paint,
      { type: "radial-gradient" }
    >;
    expect(paint.rx).toBe(0.6);
    expect(paint.ry).toBe(0.3);
    expect(paint.radius).toBeUndefined();
  });

  it("normalizes the ellipse angle into 0..360 and drops zero", () => {
    const paint = radial({ rx: 0.6, ry: 0.3, angle: -45 }) as Extract<Paint, { type: "radial-gradient" }>;
    expect(paint.angle).toBe(315);
    const upright = radial({ rx: 0.6, ry: 0.3, angle: 0 }) as Extract<Paint, { type: "radial-gradient" }>;
    expect(upright.angle).toBeUndefined();
  });

  it("keeps the plain cx/cy/r attributes for the circle form", () => {
    const circle = radial({ center: { x: 0.25, y: 0.75 }, radius: 0.5 }) as Extract<
      Paint,
      { type: "radial-gradient" }
    >;
    expect(calcRadialGradientCoords(circle)).toEqual({ cx: "25%", cy: "75%", r: "50%" });
  });

  it("maps a rotated ellipse through gradientTransform", () => {
    const ellipse = radial({ rx: 0.6, ry: 0.3, angle: 30, center: { x: 0.5, y: 0.5 } }) as Extract<
      Paint,
      { type: "radial-gradient" }
    >;
    const coords = calcRadialGradientCoords(ellipse);
    expect(coords.r).toBe("50%");
    expect(coords.gradientTransform).toBe("translate(0.5 0.5) rotate(30) scale(1.2 0.6) translate(-0.5 -0.5)");
  });

  it("routes a rotated circle through gradientTransform too", () => {
    const rotated = radial({ radius: 0.5, angle: 90 }) as Extract<Paint, { type: "radial-gradient" }>;
    const coords = calcRadialGradientCoords(rotated);
    expect(coords.gradientTransform).toContain("rotate(90)");
  });
});

describe("linear independent endpoints", () => {
  const lin = (extra: Record<string, unknown>): Paint | undefined =>
    normalizePaint({ type: "linear-gradient", from: "#000000", to: "#FFFFFF", ...extra });

  it("absorbs both endpoints and re-derives the angle from them", () => {
    const paint = lin({ angle: 90, start: { x: 0, y: 1 }, end: { x: 1, y: 1 } }) as Extract<
      Paint,
      { type: "linear-gradient" }
    >;
    expect(paint.start).toEqual({ x: 0, y: 1 });
    expect(paint.end).toEqual({ x: 1, y: 1 });
    expect(paint.angle).toBe(90);
  });

  it("derives the angle for an off-axis pair", () => {
    const paint = lin({ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }) as Extract<
      Paint,
      { type: "linear-gradient" }
    >;
    // end - start = (1, 1) points down-right -> atan2(1, -1) = 135°
    expect(paint.angle).toBe(135);
  });

  it("drops a lone endpoint and keeps the angle shorthand", () => {
    const paint = lin({ angle: 45, start: { x: 0.2, y: 0.2 } }) as Extract<
      Paint,
      { type: "linear-gradient" }
    >;
    expect(paint.start).toBeUndefined();
    expect(paint.end).toBeUndefined();
    expect(paint.angle).toBe(45);
  });

  it("keeps endpoints outside the box (the axis may extend past the shape)", () => {
    const paint = lin({ start: { x: -0.2, y: 1.1 }, end: { x: 1.4, y: -0.3 } }) as Extract<
      Paint,
      { type: "linear-gradient" }
    >;
    expect(paint.start).toEqual({ x: -0.2, y: 1.1 });
    expect(paint.end).toEqual({ x: 1.4, y: -0.3 });
  });
});

describe("topGradientPaint", () => {  const linear: Paint = { type: "linear-gradient", from: "#000000", to: "#FFFFFF", angle: 90 };
  const radial: Paint = { type: "radial-gradient", from: "#000000", to: "#FFFFFF" };

  it("returns null for an empty or missing stack", () => {
    expect(topGradientPaint(undefined)).toBeNull();
    expect(topGradientPaint([])).toBeNull();
  });

  it("ignores solid and image layers", () => {
    expect(topGradientPaint([{ type: "solid", color: "#000000" }])).toBeNull();
  });

  it("picks the top-most gradient and reports its index", () => {
    const found = topGradientPaint([{ type: "solid", color: "#000000" }, linear, radial]);
    expect(found?.index).toBe(2);
    expect(found?.paint).toBe(radial);
  });

  it("skips a disabled layer and lands on the enabled one beneath", () => {
    const found = topGradientPaint([linear, { ...radial, enabled: false }]);
    expect(found?.index).toBe(0);
    expect(found?.paint).toBe(linear);
  });
});

describe("linear lever geometry", () => {
  it("reads the CSS angle back from a direction", () => {
    expect(linearAngleFromVector(1, 0)).toBeCloseTo(90, 6);
    expect(linearAngleFromVector(0, -1)).toBeCloseTo(0, 6);
    expect(linearAngleFromVector(0, 1)).toBeCloseTo(180, 6);
    expect(linearAngleFromVector(-1, 0)).toBeCloseTo(270, 6);
    expect(linearAngleFromVector(0.5, 0.5)).toBeCloseTo(135, 6);
  });

  it("normalizes into 0..360", () => {
    const a = linearAngleFromVector(-0.5, -0.5);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
    expect(a).toBeCloseTo(315, 6);
  });

  it("spans the axis the renderer actually paints: centre ± 0.5·u", () => {
    const { start, end } = linearLeverEndpoints(90, 200, 100);
    expect(start.x).toBeCloseTo(0, 6);
    expect(start.y).toBeCloseTo(50, 6);
    expect(end.x).toBeCloseTo(200, 6);
    expect(end.y).toBeCloseTo(50, 6);
    const vertical = linearLeverEndpoints(0, 200, 100);
    expect(vertical.start.x).toBeCloseTo(100, 6);
    expect(vertical.start.y).toBeCloseTo(100, 6);
    expect(vertical.end.x).toBeCloseTo(100, 6);
    expect(vertical.end.y).toBeCloseTo(0, 6);
  });

  it("round-trips angle -> endpoints -> angle in a non-square box", () => {
    for (const angle of [0, 27, 90, 133, 200, 315]) {
      const { start, end } = linearLeverEndpoints(angle, 240, 120);
      // px, not fractions: the angle lives in the box's own space, so the delta
      // has to too — a fraction delta recovers the normalised-box angle, which
      // on a 240×120 is not the one CSS draws.
      const fx = end.x - start.x;
      const fy = end.y - start.y;
      expect(linearAngleFromVector(fx, fy)).toBeCloseTo(angle, 4);
    }
  });

  it("spans CSS's gradient line, |W·sin| + |H·cos|, not the box diagonal", () => {
    for (const [w, h] of [[240, 120], [120, 240], [100, 100]]) {
      for (const angle of [0, 45, 90, 135, 210, 300]) {
        const rad = (angle * Math.PI) / 180;
        const cssLength = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
        const { start, end } = linearLeverEndpoints(angle, w, h);
        expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo(cssLength, 6);
      }
    }
  });

  it("points the gradient 45° across a 2:1 box at a geometric 45°", () => {
    const { start, end } = linearLeverEndpoints(45, 200, 100);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    expect((Math.atan2(-dy, dx) * 180) / Math.PI).toBeCloseTo(45, 6);
  });

  it("reaches corner to corner for 45° on a square box", () => {
    const coords = calcLinearGradientCoords(
      { type: "linear-gradient", from: "#000000", to: "#FFFFFF", angle: 45 },
      { width: 100, height: 100 }
    );
    expect(coords.x1).toBe("0%");
    expect(coords.y1).toBe("100%");
    expect(coords.x2).toBe("100%");
    expect(coords.y2).toBe("0%");
  });

  it("keeps an axis-aligned angle exact whatever the box", () => {
    for (const [w, h] of [[200, 100], [100, 200]]) {
      expect(calcLinearGradientCoords(
        { type: "linear-gradient", from: "#000000", to: "#FFFFFF", angle: 0 },
        { width: w, height: h }
      )).toEqual({ x1: "50%", y1: "100%", x2: "50%", y2: "0%" });
      expect(calcLinearGradientCoords(
        { type: "linear-gradient", from: "#000000", to: "#FFFFFF", angle: 90 },
        { width: w, height: h }
      )).toEqual({ x1: "0%", y1: "50%", x2: "100%", y2: "50%" });
    }
  });
});
