import { describe, it, expect } from "vitest";
import { strokeDashAttrs } from "../src/core/geometry/stroke-utils";
import { DesignElement } from "../src/core/dsl/types";
import { DEFAULT_DASH } from "../src/core/dsl/constants";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

/** Normalizes one element by running it through a throwaway one-page document. */
const normalize = (stroke: Record<string, unknown>): DesignElement => {
  const { document } = normalizeDesignDocument({
    version: "0.2",
    pages: [{ id: "page1", name: "Page 1", children: [{ id: "e1", type: "rect", x: 0, y: 0, width: 10, height: 10, strokes: [stroke] }] }]
  });
  return document.pages[0].children[0] as DesignElement;
};

describe("dash pattern normalisation", () => {
  it("keeps an explicit pattern", () => {
    const el = normalize({ width: 2, dashArray: [10, 6] });
    expect(el.strokes![0].dashArray).toEqual([10, 6]);
  });

  it("expands style: dashed into the default pattern and keeps style: dotted", () => {
    const dashed = normalize({ width: 2, style: "dashed" });
    expect(dashed.strokes![0].dashArray).toEqual([...DEFAULT_DASH]);

    const dotted = normalize({ width: 2, style: "dotted" });
    expect(dotted.strokes![0].style).toBe("dotted");
    expect(dotted.strokes![0].dashArray).toBeUndefined();
  });

  it("lets an explicit pattern outrank a solid style", () => {
    const el = normalize({ width: 2, style: "solid", dashArray: [4, 2] });
    expect(el.strokes![0].dashArray).toEqual([4, 2]);
  });

  it("reads a pattern written as a string", () => {
    const el = normalize({ width: 2, dash: "4 2 1" });
    expect(el.strokes![0].dashArray).toEqual([4, 2, 1]);
  });

  it("drops unusable lengths instead of the whole pattern", () => {
    const el = normalize({ width: 2, dashArray: [4, -1, "x", 2] });
    expect(el.strokes![0].dashArray).toEqual([4, 2]);
  });

  it("reads the dash offset", () => {
    const el = normalize({ width: 2, dashArray: [4, 2], dashOffset: -3 });
    expect(el.strokes![0].dashOffset).toBe(-3);
  });

  it("floors the miter limit at 1", () => {
    const el = normalize({ width: 2, miterLimit: 0.2 });
    expect(el.strokes![0].miterLimit).toBe(1);
  });

  it("keeps cap and join", () => {
    const el = normalize({ width: 2, cap: "round", join: "bevel" });
    expect(el.strokes![0].cap).toBe("round");
    expect(el.strokes![0].join).toBe("bevel");
  });
});

describe("strokeDashAttrs", () => {
  it("emits nothing for a plain solid stroke", () => {
    expect(strokeDashAttrs({ width: 2 })).toEqual({});
  });

  it("renders the pattern as an SVG dasharray", () => {
    expect(strokeDashAttrs({ width: 2, dashArray: [10, 6] }).strokeDasharray).toBe("10 6");
  });

  it("falls back to the default pattern for style: dashed and round dots for style: dotted", () => {
    expect(strokeDashAttrs({ width: 2, style: "dashed" }).strokeDasharray).toBe(DEFAULT_DASH.join(" "));
    expect(strokeDashAttrs({ width: 3, style: "dotted" })).toEqual({
      strokeDasharray: "0 6",
      strokeLinecap: "round"
    });
    expect(strokeDashAttrs({ width: 3, style: "dotted", cap: "square" })).toEqual({
      strokeDasharray: "0 6",
      strokeLinecap: "square"
    });
  });

  it("lets an all-zero pattern switch dashes off entirely", () => {
    // A dash of length 0 never advances, so the pattern would stall the outline
    // rather than draw it — and style: dashed must not talk it back on.
    expect(strokeDashAttrs({ width: 2, style: "dashed", dashArray: [0, 0] })).toEqual({});
  });

  it("carries the offset with the pattern and drops it without one", () => {
    expect(strokeDashAttrs({ width: 2, dashArray: [4, 2], dashOffset: 3 }).strokeDashoffset).toBe("3");
    expect(strokeDashAttrs({ width: 2, dashOffset: 3 }).strokeDashoffset).toBeUndefined();
  });

  it("passes cap, join and miter limit through", () => {
    expect(strokeDashAttrs({ width: 2, cap: "square", join: "round", miterLimit: 8 })).toEqual({
      strokeLinecap: "square",
      strokeLinejoin: "round",
      strokeMiterlimit: 8
    });
  });
});
