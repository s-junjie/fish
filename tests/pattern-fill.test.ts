import { describe, it, expect } from "vitest";
import {
  patternPitch,
  patternOrigin,
  patternWeight,
  stripePhase,
  stripeBands,
  patternSvgPaint,
  patternCssBackground
} from "../src/core/geometry/pattern-tile";
import { normalizePaint } from "../src/core/dsl/normalize/paint";
import { paintStackLayers } from "../src/core/geometry/gradient-utils";
import { PatternPaint } from "../src/core/dsl/types";

const pattern = (extra: Partial<PatternPaint> = {}): PatternPaint =>
  ({
    type: "pattern",
    motif: "dots",
    tile: { width: 16, height: 16 },
    foreground: "#000000",
    ...extra
  } as PatternPaint);

describe("pattern geometry", () => {
  it("adds the gap to the cell to get the period", () => {
    expect(patternPitch(pattern())).toEqual({ x: 16, y: 16 });
    expect(patternPitch(pattern({ tile: { width: 10, height: 6 }, spacing: { x: 4, y: 2 } }))).toEqual({
      x: 14,
      y: 8
    });
  });

  it("scales the cell, and a checker needs two cells per axis", () => {
    expect(patternPitch(pattern({ scale: 2 }))).toEqual({ x: 32, y: 32 });
    expect(patternPitch(pattern({ motif: "checker" }))).toEqual({ x: 32, y: 32 });
  });

  it("puts the grid at the box origin, or splits the remainder", () => {
    const box = { width: 50, height: 44 };
    expect(patternOrigin(pattern(), box)).toEqual({ x: 0, y: 0 });
    expect(patternOrigin(pattern({ alignment: "center" }), box)).toEqual({ x: (50 % 16) / 2, y: (44 % 16) / 2 });
    expect(patternOrigin(pattern({ alignment: "end" }), box)).toEqual({ x: 50 % 16, y: 44 % 16 });
  });

  it("aligns the doubled tile, not the single cell, when the layout is staggered", () => {
    const box = { width: 50, height: 44 };
    expect(patternOrigin(pattern({ tileType: "horizontal-hexagonal", alignment: "center" }), box)).toEqual({
      x: (50 % 32) / 2,
      y: (44 % 32) / 2
    });
  });

  // SVG clips a tile and CSS does not: a dot wider than its cell would be cut on
  // one side and whole on the other.
  it("clamps the weight into the cell", () => {
    expect(patternWeight(pattern({ weight: 100 }), 16)).toBe(8);
    expect(patternWeight(pattern({ weight: 0 }), 16)).toBe(0.1);
  });
});

describe("stripe phase", () => {
  it("reads CSS's gradient-line start off the box", () => {
    // 100x100 at 45°: the line is 141.42 long and starts at (0, 141.42);
    // the origin projects 70.71 along it from that start.
    expect(stripePhase({ width: 100, height: 100 }, 45)).toBeCloseTo(70.7107, 3);
    // 0° is 'to top', so the line runs the box's height and starts at the bottom.
    expect(stripePhase({ width: 100, height: 40 }, 0)).toBeCloseTo(40, 6);
  });

  it("splits one period into bands at the phase, not at zero", () => {
    const bands = stripeBands(10.7107, 2, 20, "#000000", "transparent");
    expect(bands.map((b) => b.at)).toEqual([0, 10.711, 12.711]);
    expect(bands.map((b) => b.color)).toEqual(["transparent", "#000000", "transparent"]);
  });
});

describe("pattern serializers", () => {
  it("draws dots as one circle in a pitch-sized tile", () => {
    const svg = patternSvgPaint(pattern({ weight: 4 }), { width: 100, height: 100 });
    expect(svg).toMatchObject({ kind: "tile", width: 16, height: 16, x: 0, y: 0 });
    if (svg.kind !== "tile") throw new Error("expected a tile");
    expect(svg.shapes).toEqual([{ kind: "circle", cx: 8, cy: 8, r: 2, fill: "#000000" }]);
  });

  it("keeps a background as a rect behind the motif", () => {
    const svg = patternSvgPaint(pattern({ background: "#FFFFFF" }), { width: 10, height: 10 });
    if (svg.kind !== "tile") throw new Error("expected a tile");
    expect(svg.background).toBe("#FFFFFF");
  });

  it("uses a repeating gradient for stripes, sized to one period", () => {
    const svg = patternSvgPaint(pattern({ motif: "diagonal-stripes", weight: 2 }), { width: 100, height: 100 });
    if (svg.kind !== "stripes") throw new Error("expected stripes");
    const { x1, y1, x2, y2 } = svg.gradient;
    expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(16, 6);
    expect(svg.gradient.stops[0].offset).toBe(0);
    expect(svg.gradient.stops[svg.gradient.stops.length - 1].color).toBe("transparent");
  });

  // A tile only closes when its sides are whole multiples of the stripe lattice.
  it("sizes a crosshatch tile to the stripe lattice", () => {
    const svg = patternSvgPaint(pattern({ motif: "crosshatch" }), { width: 100, height: 100 });
    if (svg.kind !== "tile") throw new Error("expected a tile");
    expect(svg.width).toBeCloseTo(16 * Math.SQRT2, 6);
    expect(svg.height).toBeCloseTo(16 * Math.SQRT2, 6);
  });

  it("writes CSS with the same size, position and colours", () => {
    const box = { width: 50, height: 44 };
    expect(patternCssBackground(pattern({ alignment: "center" }), box)).toBe(
      "radial-gradient(circle at 50% 50%, #000000 0 1px, transparent 1px) 1px 6px / 16px 16px repeat"
    );
    expect(patternCssBackground(pattern({ motif: "checker", foreground: "#111111", background: "#222222" }))).toBe(
      "conic-gradient(#111111 0 25%, #222222 0 50%, #111111 0 75%, #222222 0) 0px 0px / 32px 32px repeat"
    );
  });

  it("writes the grid as two axis-locked layers", () => {
    const css = patternCssBackground(pattern({ motif: "grid" }));
    expect(css).toContain("repeat-x");
    expect(css).toContain("repeat-y");
    expect(css.match(/linear-gradient/g)).toHaveLength(2);
  });

  // Two `repeating-linear-gradient`s measure their phase along their own axes,
  // so each family landed a weight out of step and the swatch drew a denser
  // lattice than the canvas. The tile is the one form both sides can share.
  it("writes crosshatch as the tile it paints, not as two gradients", () => {
    const css = patternCssBackground(pattern({ motif: "crosshatch" }), { width: 100, height: 100 });
    expect(css).toContain("data:image/svg+xml");
    expect(css).toContain("rotate(45)");
    expect(css).not.toContain("repeating-linear-gradient");
  });
});

describe("pattern normalization", () => {
  it("accepts the motif's other spellings", () => {
    expect((normalizePaint({ type: "pattern", motif: "Diagonal Stripes", foreground: "#000" }) as PatternPaint).motif)
      .toBe("diagonal-stripes");
    expect((normalizePaint({ type: "pattern", motif: "checkerboard", foreground: "#000" }) as PatternPaint).motif)
      .toBe("checker");
  });

  it("falls back to dots and names the typo", () => {
    const repairs: { path: string; message: string }[] = [];
    const paint = normalizePaint({ type: "pattern", motif: "swirls", foreground: "#000" }, "/fills/0", repairs as any);
    expect((paint as PatternPaint).motif).toBe("dots");
    expect(repairs[0].path).toBe("/fills/0/motif");
  });

  // A staggered layout is a doubled tile with the second copy half a cell along;
  // CSS reaches it through an inline SVG because gradients grid-repeat only.
  it("doubles the tile and offsets the second copy", () => {
    const horizontal = patternSvgPaint(
      pattern({ motif: "dots", tileType: "horizontal-hexagonal", weight: 4 }),
      { width: 100, height: 100 }
    );
    if (horizontal.kind !== "tile") throw new Error("expected a tile");
    expect([horizontal.width, horizontal.height]).toEqual([32, 32]);
    expect(horizontal.shapes).toEqual([
      { kind: "circle", cx: 8, cy: 8, r: 2, fill: "#000000" },
      { kind: "circle", cx: 16, cy: 24, r: 2, fill: "#000000" }
    ]);

    const vertical = patternSvgPaint(
      pattern({ motif: "dots", tileType: "vertical-hexagonal", weight: 4 }),
      { width: 100, height: 100 }
    );
    if (vertical.kind !== "tile") throw new Error("expected a tile");
    expect(vertical.shapes[1]).toEqual({ kind: "circle", cx: 24, cy: 16, r: 2, fill: "#000000" });
  });

  it("keeps the hexagonal tile layout, and writes it as an inline SVG", () => {
    const repairs: { path: string }[] = [];
    const paint = normalizePaint(
      { type: "pattern", motif: "dots", tileType: "horizontal-hexagonal", foreground: "#000" },
      "/fills/0",
      repairs as any
    ) as PatternPaint;
    expect(paint.tileType).toBe("horizontal-hexagonal");
    expect(repairs).toEqual([]);

    const css = patternCssBackground(paint);
    expect(css).toContain("data:image/svg+xml");
    expect(css).toContain("/ 32px 32px repeat");
    expect(css).not.toContain("radial-gradient");
  });

  it("needs a colour to be a paint at all", () => {
    expect(normalizePaint({ type: "pattern", motif: "dots" })).toBeUndefined();
  });

  it("keeps scale, spacing and weight as authored", () => {
    const paint = normalizePaint({
      type: "pattern",
      motif: "grid",
      foreground: "#000",
      scale: 2,
      spacing: { x: 3, y: 4 },
      weight: 1.5
    }) as PatternPaint;
    expect(paint).toMatchObject({ scale: 2, spacing: { x: 3, y: 4 }, weight: 1.5 });
  });
});

describe("pattern in a stack", () => {
  it("becomes one background layer, layer opacity intact", () => {
    const layers = paintStackLayers([pattern({ opacity: 0.4 })], undefined, { width: 20, height: 20 });
    expect(layers).toHaveLength(1);
    expect(layers[0].opacity).toBe(0.4);
    expect(layers[0].background).toContain("radial-gradient");
  });
});
