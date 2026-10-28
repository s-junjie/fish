import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { 
  calcLinearGradientCoords, 
  getPaintColor, 
  getShapeLocalPath,
  getGradientStops,
  buildCssGradient
} from "../src/core/geometry/gradient-utils";
import { RectElement, EllipseElement } from "../src/core/dsl/types";
import { isIdentityBlendPaint } from "../src/ui/canvas/SvgShapeNode";

describe("Styling & Gradient Utilities", () => {
  it("calculates 0° (top to bottom) linear gradient coordinates", () => {
    const coords = calcLinearGradientCoords({ type: "linear-gradient", from: "#000000", to: "#FFFFFF", angle: 0 });
    expect(coords.x1).toBe("50%");
    expect(coords.y1).toBe("100%");
    expect(coords.x2).toBe("50%");
    expect(coords.y2).toBe("0%");
  });

  it("calculates 90° (left to right) linear gradient coordinates", () => {
    const coords = calcLinearGradientCoords({ type: "linear-gradient", from: "#000000", to: "#FFFFFF", angle: 90 });
    expect(coords.x1).toBe("0%");
    expect(coords.y1).toBe("50%");
    expect(coords.x2).toBe("100%");
    expect(coords.y2).toBe("50%");
  });

  it("prefers explicit start/end points over the symmetric angle", () => {
    const coords = calcLinearGradientCoords({
      type: "linear-gradient",
      from: "#000000",
      to: "#FFFFFF",
      angle: 90,
      start: { x: -0.2, y: 1.1 },
      end: { x: 1.4, y: -0.3 }
    });
    expect(coords.x1).toBe("-20%");
    expect(coords.y1).toBe("110%");
    expect(coords.x2).toBe("140%");
    expect(coords.y2).toBe("-30%");
  });

  it("extracts representative color from paints", () => {
    expect(getPaintColor({ type: "solid", color: "#10B981" })).toBe("#10B981");
    expect(getPaintColor({ type: "linear-gradient", from: "#3B82F6", to: "#8B5CF6", angle: 45 })).toBe("#3B82F6");
    expect(getPaintColor({ type: "radial-gradient", from: "#EF4444", to: "#000000" })).toBe("#EF4444");
    expect(getPaintColor(undefined)).toBe("#3B82F6");
  });

  it("computes local shape path data for rect and ellipse", () => {
    const rect: RectElement = {
      id: "r1",
      type: "rect",
      x: 10,
      y: 20,
      width: 100,
      height: 50
    };
    const rectPath = getShapeLocalPath(rect);
    expect(rectPath).toContain("M 0 0");
    expect(rectPath).toContain("100");

    const ell: EllipseElement = {
      id: "e1",
      type: "ellipse",
      x: 10,
      y: 20,
      width: 80,
      height: 60
    };
    const ellPath = getShapeLocalPath(ell);
    expect(ellPath).toContain("A 40 30");
  });

  it("handles multi-color gradient stops with custom percentage offsets", () => {
    const multiStopPaint: any = {
      type: "linear-gradient",
      from: "#FF0000",
      to: "#0000FF",
      angle: 90,
      stops: [
        { color: "#FF0000", offset: 0 },
        { color: "#00FF00", offset: 0.35 },
        { color: "#FFFF00", offset: 0.7 },
        { color: "#0000FF", offset: 1 }
      ]
    };
    const stops = getGradientStops(multiStopPaint);
    expect(stops.length).toBe(4);
    expect(stops[1]).toEqual({ color: "#00FF00", offset: 0.35 });
    expect(stops[2]).toEqual({ color: "#FFFF00", offset: 0.7 });

    const css = buildCssGradient(multiStopPaint);
    expect(css).toContain("linear-gradient(90deg,");
    expect(css).toContain("#00FF00 35%");
    expect(css).toContain("#FFFF00 70%");

    const angledPaint: any = { ...multiStopPaint, angle: 45 };
    expect(buildCssGradient(angledPaint)).toContain("linear-gradient(45deg,");
  });

  it("extracts default 2 stops when stops array is omitted", () => {
    const paint: any = {
      type: "radial-gradient",
      from: "#111111",
      to: "#EEEEEE",
      fromOffset: 0.1,
      toOffset: 0.9
    };
    const stops = getGradientStops(paint);
    expect(stops.length).toBe(2);
    expect(stops[0]).toEqual({ color: "#111111", offset: 0.1 });
    expect(stops[1]).toEqual({ color: "#EEEEEE", offset: 0.9 });
  });

  it("normalizes multiple fills and multiple strokes", async () => {
    const { normalizeDesignDocument } = await import("../src/core/dsl/normalize");
    const rawDoc = {
      canvas: { width: 800, height: 600 },
      elements: [
        {
          id: "rect1",
          type: "rect",
          x: 10,
          y: 10,
          width: 100,
          height: 100,
          fills: [
            { type: "solid", color: "#FF0000" },
            { type: "solid", color: "#00FF00", opacity: 0.5 }
          ],
          strokes: [
            { color: "#000000", width: 2, align: "inside" },
            { color: "#FFFFFF", width: 6, align: "outside" }
          ]
        }
      ]
    };
    const res = normalizeDesignDocument(rawDoc);
    const rect = getActivePage(res.document).children[0] as any;
    expect(rect.fills).toHaveLength(2);
    expect(rect.fills[0].color).toBe("#FF0000");
    expect(rect.fills[1].color).toBe("#00FF00");
    expect(rect.strokes).toHaveLength(2);
    expect(rect.strokes[0].width).toBe(2);
    expect(rect.strokes[0].align).toBe("inside");
    expect(rect.strokes[1].width).toBe(6);
    expect(rect.strokes[1].align).toBe("outside");
  });

  it("builds CSS gradient strings for preview and text rendering", () => {
    const linear = {
      type: "linear-gradient" as const,
      from: "#FF0000",
      to: "#00FF00",
      angle: 45,
      stops: [
        { color: "#FF0000", offset: 0 },
        { color: "#00FF00", offset: 100 }
      ]
    };
    expect(buildCssGradient(linear)).toBe("linear-gradient(45deg, #FF0000 0%, #00FF00 100%)");
  });

  it("identifies identity blend mode paints that are mathematically invisible", () => {
    // White in multiply / color-burn mode leaves background unchanged
    expect(isIdentityBlendPaint({ type: "solid", color: "#ffffff", blendMode: "multiply" })).toBe(true);
    expect(isIdentityBlendPaint({ type: "solid", color: "#FFFFFF", blendMode: "multiply" })).toBe(true);
    expect(isIdentityBlendPaint({ type: "solid", color: "#ffffff", blendMode: "color-burn" })).toBe(true);

    // Black in screen / color-dodge mode leaves background unchanged
    expect(isIdentityBlendPaint({ type: "solid", color: "#000000", blendMode: "screen" })).toBe(true);
    expect(isIdentityBlendPaint({ type: "solid", color: "#000", blendMode: "color-dodge" })).toBe(true);

    // Other colors or normal blend modes are NOT identity
    expect(isIdentityBlendPaint({ type: "solid", color: "#ffffff", blendMode: "normal" })).toBe(false);
    expect(isIdentityBlendPaint({ type: "solid", color: "#ff0000", blendMode: "multiply" })).toBe(false);
    expect(isIdentityBlendPaint({ type: "solid", color: "#000000", blendMode: "multiply" })).toBe(false);
  });
});

