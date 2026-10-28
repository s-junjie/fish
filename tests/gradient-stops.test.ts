import { describe, it, expect } from "vitest";
import { canonicalGradientStops } from "../src/core/dsl/gradient-stops";
import { getGradientStops } from "../src/core/geometry/gradient-utils";
import { normalizePaint } from "../src/core/dsl/normalize/paint";

describe("canonicalGradientStops", () => {
  it("keeps 0..1 offsets directly", () => {
    const raw = [
      { offset: 0, color: "rgba(224, 0, 0, 0.30)" },
      { offset: 0.55, color: "rgba(180, 0, 0, 0.08)" },
      { offset: 1, color: "rgba(7, 7, 8, 0)" }
    ];
    expect(canonicalGradientStops(raw)).toEqual([
      { offset: 0, color: "rgba(224, 0, 0, 0.30)" },
      { offset: 0.55, color: "rgba(180, 0, 0, 0.08)" },
      { offset: 1, color: "rgba(7, 7, 8, 0)" }
    ]);
  });

  it("handles 2-stop 0..1 offsets like [{ offset: 0 }, { offset: 0.22 }]", () => {
    const raw = [
      { offset: 0, color: "rgba(7, 7, 8, 0.85)" },
      { offset: 0.22, color: "rgba(7, 7, 8, 0.0)" }
    ];
    expect(canonicalGradientStops(raw)).toEqual([
      { offset: 0, color: "rgba(7, 7, 8, 0.85)" },
      { offset: 0.22, color: "rgba(7, 7, 8, 0.0)" }
    ]);
  });

  it("handles 2-stop 0..1 endpoints like [{ offset: 0 }, { offset: 1 }]", () => {
    const raw = [
      { offset: 0, color: "#000" },
      { offset: 1, color: "#fff" }
    ];
    expect(canonicalGradientStops(raw)).toEqual([
      { offset: 0, color: "#000" },
      { offset: 1, color: "#fff" }
    ]);
  });

  it("handles position property in 0..1 from figma or other tools", () => {
    const raw = [
      { position: 0, color: "#000" },
      { position: 0.4, color: "#666" },
      { position: 1, color: "#fff" }
    ];
    expect(canonicalGradientStops(raw)).toEqual([
      { offset: 0, color: "#000" },
      { offset: 0.4, color: "#666" },
      { offset: 1, color: "#fff" }
    ]);
  });

  it("evenly spaces bare colour strings in 0..1", () => {
    const raw = ["#ff0000", "#00ff00", "#0000ff"];
    expect(canonicalGradientStops(raw)).toEqual([
      { offset: 0, color: "#ff0000" },
      { offset: 0.5, color: "#00ff00" },
      { offset: 1, color: "#0000ff" }
    ]);
  });
});

describe("fromOffset and toOffset normalization", () => {
  it("normalizes 0..1 fromOffset / toOffset", () => {
    const paint = normalizePaint({
      type: "linear-gradient",
      from: "#000",
      to: "#fff",
      fromOffset: 0,
      toOffset: 1
    } as any);
    expect(paint?.type).toBe("linear-gradient");
    if (paint?.type === "linear-gradient") {
      expect(paint.fromOffset).toBe(0);
      expect(paint.toOffset).toBe(1);
      expect(getGradientStops(paint)).toEqual([
        { offset: 0, color: "#000" },
        { offset: 1, color: "#fff" }
      ]);
    }
  });
});

describe("CSS gradient string shorthand", () => {
  it("normalizes a css linear-gradient string directly", () => {
    const paint = normalizePaint("linear-gradient(90deg, #ff0000 0%, #0000ff 100%)");
    expect(paint?.type).toBe("linear-gradient");
    if (paint?.type === "linear-gradient") {
      expect(paint.angle).toBe(90);
      expect(paint.from).toBe("#FF0000");
      expect(paint.to).toBe("#0000FF");
      expect(paint.stops).toEqual([
        { color: "#FF0000", offset: 0 },
        { color: "#0000FF", offset: 1 }
      ]);
    }
  });

  it("normalizes a css radial-gradient string directly", () => {
    const paint = normalizePaint("radial-gradient(circle at center, #ff0000, #0000ff)");
    expect(paint?.type).toBe("radial-gradient");
    if (paint?.type === "radial-gradient") {
      expect(paint.from).toBe("#FF0000");
      expect(paint.to).toBe("#0000FF");
      expect(paint.stops).toEqual([
        { color: "#FF0000", offset: 0 },
        { color: "#0000FF", offset: 1 }
      ]);
    }
  });

  it("normalizes a css conic-gradient string directly", () => {
    const paint = normalizePaint("conic-gradient(from 45deg at 50% 50%, #ff0000, #00ff00, #0000ff)");
    expect(paint?.type).toBe("angular-gradient");
    if (paint?.type === "angular-gradient") {
      expect(paint.angle).toBe(45);
      expect(paint.stops).toEqual([
        { color: "#FF0000", offset: 0 },
        { color: "#00FF00", offset: 0.5 },
        { color: "#0000FF", offset: 1 }
      ]);
    }
  });
});
