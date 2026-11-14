import { describe, it, expect } from "vitest";
import { canonicalGradientStops } from "../src/core/dsl/gradient-stops";
import { getGradientStops } from "../src/core/geometry/gradient-utils";
import { normalizePaint } from "../src/core/dsl/normalize/paint";
import type { NormalizationRepair } from "../src/core/dsl/normalize/shared";

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

describe("unreadable paint colours are refused, never defaulted", () => {
  const normalizeWithRepairs = (raw: unknown) => {
    const repairs: NormalizationRepair[] = [];
    return { paint: normalizePaint(raw, "/fills/0", repairs), repairs };
  };

  it("refuses a [color, offset] pair instead of turning the ramp white", () => {
    const { paint, repairs } = normalizeWithRepairs({
      type: "linear-gradient",
      stops: [["#FF0000", 0], ["#0000FF", 1]]
    });
    // Two unreadable stops used to default to #FFFFFF, judge themselves flat and
    // collapse the paint to a white solid that `check` called clean.
    expect(paint).toBeUndefined();
    expect(repairs.some((r) => /\[color, offset\] pair/.test(r.message))).toBe(true);
    expect(repairs.every((r) => r.path.startsWith("/fills/0/stops/"))).toBe(true);
  });

  it("names a misspelt stop key rather than whitening it", () => {
    const { paint, repairs } = normalizeWithRepairs({
      type: "radial-gradient",
      stops: [{ colour: "#FF0000", at: 0 }, { colour: "#0000FF", at: 1 }]
    });
    expect(paint).toBeUndefined();
    expect(repairs.some((r) => /has no "color"/.test(r.message))).toBe(true);
  });

  it("keeps the stops it can read when one is unusable", () => {
    const stops = canonicalGradientStops(
      [{ color: "#FF0000", offset: 0 }, [255, 0, 0], { color: "#0000FF", offset: 1 }],
      "/fills/0/stops",
      []
    );
    expect(stops).toEqual([
      { color: "#FF0000", offset: 0 },
      { color: "#0000FF", offset: 1 }
    ]);
  });

  it("refuses a solid colour that is not a colour", () => {
    for (const raw of ["#FFF → #000", "#FF0000/#0000FF", "gradient red to blue"]) {
      const { paint, repairs } = normalizeWithRepairs(raw);
      expect(paint, raw).toBeUndefined();
      expect(repairs[0]?.message, raw).toMatch(/not a CSS colour/);
    }
  });

  it("keeps every legal colour spelling", () => {
    const spellings = [
      "#8AB4F8",
      "#8AB4F8CC",
      "white",
      "rebeccapurple",
      "rgb(0 0 0 / 50%)",
      "oklch(0.7 0.15 200)",
      "transparent",
      "currentColor",
      "$color-surface",
      "var(--brand)"
    ];
    for (const colour of spellings) {
      expect(normalizePaint({ type: "solid", color: colour }), colour).toEqual({ type: "solid", color: colour });
    }
  });

  it("keeps a token-only stop for the binding pass to fill in", () => {
    expect(canonicalGradientStops([{ tokenId: "tok_brand" }, { color: "#0000FF", offset: 1 }])).toEqual([
      { color: "#FFFFFF", offset: 0, tokenId: "tok_brand" },
      { color: "#0000FF", offset: 1 }
    ]);
  });

  it("reports a stops value that is not an array", () => {
    const repairs: NormalizationRepair[] = [];
    expect(canonicalGradientStops("#FF0000", "/fills/0/stops", repairs)).toBeUndefined();
    expect(repairs[0]?.message).toMatch(/must be an array/);
  });
});
