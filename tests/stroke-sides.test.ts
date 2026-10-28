import { describe, it, expect } from "vitest";
import { resolveStrokeWeights } from "../src/core/geometry/stroke-utils";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { Stroke } from "../src/core/dsl/types";

describe("Single-sided stroke capabilities", () => {
  it("resolves uniform stroke weights for default or 'all'", () => {
    const s1: Stroke = { width: 2 };
    expect(resolveStrokeWeights(s1)).toEqual({
      top: 2,
      right: 2,
      bottom: 2,
      left: 2,
      isUniform: true
    });

    const s2: Stroke = { width: 3, side: "all" };
    expect(resolveStrokeWeights(s2)).toEqual({
      top: 3,
      right: 3,
      bottom: 3,
      left: 3,
      isUniform: true
    });
  });

  it("resolves single side weights correctly", () => {
    expect(resolveStrokeWeights({ width: 2, side: "top" })).toEqual({
      top: 2,
      right: 0,
      bottom: 0,
      left: 0,
      isUniform: false
    });

    expect(resolveStrokeWeights({ width: 2, side: "bottom" })).toEqual({
      top: 0,
      right: 0,
      bottom: 2,
      left: 0,
      isUniform: false
    });

    expect(resolveStrokeWeights({ width: 2, side: "left" })).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 2,
      isUniform: false
    });

    expect(resolveStrokeWeights({ width: 2, side: "right" })).toEqual({
      top: 0,
      right: 2,
      bottom: 0,
      left: 0,
      isUniform: false
    });
  });

  it("resolves custom per-side weights", () => {
    const custom: Stroke = {
      width: 1,
      side: "custom",
      sides: { top: 2, bottom: 4, left: 0, right: 0 }
    };
    expect(resolveStrokeWeights(custom)).toEqual({
      top: 2,
      right: 0,
      bottom: 4,
      left: 0,
      isUniform: false
    });

    const uniformCustom: Stroke = {
      width: 2,
      side: "custom",
      sides: { top: 2, bottom: 2, left: 2, right: 2 }
    };
    expect(resolveStrokeWeights(uniformCustom)).toEqual({
      top: 2,
      right: 2,
      bottom: 2,
      left: 2,
      isUniform: true
    });
  });

  it("normalizes single-sided strokes and aliases", () => {
    const doc = {
      version: "0.2",
      pages: [
        {
          id: "page1",
          name: "Page 1",
          children: [
            {
              id: "r1",
              type: "rect",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              strokes: [{
                color: "#FF0000",
                width: 2,
                side: "BOTTOM"
              }]
            },
            {
              id: "f1",
              type: "frame",
              x: 0,
              y: 0,
              width: 200,
              height: 200,
              strokes: [{
                color: "#00FF00",
                width: 1,
                side: "custom",
                sides: { top: 1, bottom: 3 }
              }],
              children: []
            },
            {
              id: "r2",
              type: "rect",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              strokes: [{ color: "#0000FF", width: 2 }],
              borderTopWidth: 4,
              borderBottomWidth: 4
            }
          ]
        }
      ]
    };

    const { document: normalized } = normalizeDesignDocument(doc);
    const r1 = normalized.pages[0].children[0];
    expect(r1.strokes?.[0]?.side).toBe("bottom");
    expect(r1.strokes?.[0]?.width).toBe(2);

    const f1 = normalized.pages[0].children[1];
    expect(f1.strokes?.[0]?.side).toBe("custom");
    expect(f1.strokes?.[0]?.sides).toEqual({ top: 1, right: 0, bottom: 3, left: 0 });

    const r2 = normalized.pages[0].children[2];
    expect(r2.strokes?.[0]?.sides?.top).toBe(4);
    expect(r2.strokes?.[0]?.sides?.bottom).toBe(4);
  });
});
