import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";
import { computePathBounds, parsePathData } from "../src/core/geometry/path-data";

/**
 * The CSS properties an author writes that the DSL has a field for, but which
 * the normalizer did not read. Each one used to reach the unknown-key pass and
 * be dropped — the layer drew square, unmirrored, unblurred, or stacked in the
 * first free grid track, with nothing said.
 */

const canvas = { width: 800, height: 600, background: { type: "solid", color: "#FFFFFF" } };

const normalize = (over: Record<string, unknown>, type = "rect") => {
  const doc = {
    version: "0.1",
    canvas,
    pages: [{ id: "p1", name: "P1", canvas, children: [{ id: "e", type, width: 100, height: 100, ...over }] }],
    activePageId: "p1"
  } as unknown as DesignDocument;
  const result = normalizeDesignDocument(doc);
  return { el: result.document.pages[0].children[0], repairs: result.repairs };
};

const prop = (el: DesignElement, key: string): unknown => (el as unknown as Record<string, unknown>)[key];

describe("CSS `transform`, `rotate` and `scale`", () => {
  it("reads the standalone `rotate` property, in any angle unit", () => {
    expect(normalize({ rotate: "45deg" }).el.rotation).toBe(45);
    expect(normalize({ rotate: "0.5turn" }).el.rotation).toBe(180);
    expect(normalize({ rotate: "-90deg" }).el.rotation).toBe(-90);
  });

  it("reads `rotate()` out of a transform list", () => {
    expect(normalize({ transform: "rotate(30deg)" }).el.rotation).toBe(30);
    expect(normalize({ transform: "translateX(4px) rotate(10deg)" }).el.rotation).toBe(10);
  });

  it("turns a negative scale into the flip it means", () => {
    expect(normalize({ transform: "scaleX(-1)" }).el.flipX).toBe(true);
    expect(normalize({ transform: "scaleY(-1)" }).el.flipY).toBe(true);
    expect(normalize({ scale: -1 }).el).toMatchObject({ flipX: true, flipY: true });
  });

  it("reads a perspective tilt", () => {
    expect(normalize({ transform: "rotateX(12deg) rotateY(-8deg)" }).el).toMatchObject({
      rotateX: 12,
      rotateY: -8
    });
  });

  it("reads the perspective() distance, which the field already had", () => {
    // The distance is a field, but the FUNCTION form sat in the "no field" list
    // for longer than the field existed — a card that set its depth inside
    // `transform` fell back to the engine's 800.
    expect(normalize({ transform: "perspective(600px) rotateX(20deg)" }).el).toMatchObject({
      rotateX: 20,
      perspective: 600
    });
    expect(normalize({ perspective: 900, transform: "perspective(600px)" }).el.perspective).toBe(900);
  });

  it("lets the DSL's own field win over the absorbed CSS", () => {
    expect(normalize({ rotation: 5, transform: "rotate(45deg)" }).el.rotation).toBe(5);
    // `flipX: false` is not stored (absent already means "not mirrored"), so the
    // claim is only that the transform did not turn it into a mirror.
    expect(normalize({ flipX: false, transform: "scaleX(-1)" }).el.flipX).not.toBe(true);
  });

  it("reads a shear, one axis or both", () => {
    expect(normalize({ transform: "skew(10deg)" }).el).toMatchObject({ skewX: 10 });
    expect(normalize({ transform: "skew(10deg, 4deg)" }).el).toMatchObject({ skewX: 10, skewY: 4 });
    expect(normalize({ transform: "skewX(10deg) skewY(-6deg)" }).el).toMatchObject({ skewX: 10, skewY: -6 });
    expect(normalize({ skewX: 12 }).el).toMatchObject({ skewX: 12 });
  });

  it("names the functions it cannot hold instead of dropping them", () => {
    const { el, repairs } = normalize({ transform: "translateX(4px) scale(2)" });
    expect(el.rotation).toBeUndefined();
    expect(repairs.some((r) => r.message.includes("translatex"))).toBe(true);
  });

  it("clamps a shear past the vertical axis", () => {
    expect(normalize({ skewX: 120 }).el.skewX).toBe(89);
    expect(normalize({ skewY: -120 }).el.skewY).toBe(-89);
  });

  it("refuses the shear pair that collapses the box to a line", () => {
    const { el, repairs } = normalize({ skewX: 45, skewY: 45 });
    expect(el.skewX).toBe(45);
    // `det = 1 − tan(a)·tan(b)` is zero here: the quad has no area, so nothing
    // can be painted or inverse-mapped through it.
    expect(el.skewY).toBeUndefined();
    expect(repairs.some((r) => r.message.includes("collapses the box"))).toBe(true);
    // A pair that is merely steep is still a box and is kept whole.
    expect(normalize({ skewX: 45, skewY: 20 }).el).toMatchObject({ skewX: 45, skewY: 20 });
  });
});

describe("CSS `writing-mode`", () => {
  /**
   * A vertical line is not a field: the DSL draws it as horizontal text turned a
   * quarter turn. The box is swapped about its centre, which a turn leaves fixed
   * — so a 12×240 sidebar label becomes a 240×12 line in the same place.
   */
  it("folds a vertical line onto rotation plus a swapped box", () => {
    const { el } = normalize({ "writing-mode": "vertical-rl", x: 100, y: 40, width: 12, height: 240 }, "text");
    expect(el).toMatchObject({ x: 100 + 6 - 120, y: 40 + 120 - 6, width: 240, height: 12, rotation: 90 });
  });

  it("reads the camel spelling and composes with an authored rotation", () => {
    expect(normalize({ writingMode: "vertical-lr", width: 10, height: 100 }, "text").el.rotation).toBe(90);
    expect(normalize({ "writing-mode": "vertical-rl", rotation: 30, width: 10, height: 100 }, "text").el.rotation).toBe(120);
  });

  it("leaves horizontal text exactly as authored", () => {
    const { el } = normalize({ "writing-mode": "horizontal-tb", x: 4, y: 5, width: 10, height: 100 }, "text");
    expect(el).toMatchObject({ x: 4, y: 5, width: 10, height: 100 });
    expect(el.rotation).toBeUndefined();
  });

  it("names what a single turn cannot reproduce instead of turning it", () => {
    expect(normalize({ "writing-mode": "vertical-rl" }, "rect").repairs.some((r) => r.message.includes("only read on text"))).toBe(true);
    expect(normalize({ "writing-mode": "vertical-rl", "text-orientation": "upright" }, "text").el.rotation).toBeUndefined();
    // CJK under the default `mixed` is set upright, so a turn would tip it.
    expect(normalize({ "writing-mode": "vertical-rl", content: "標本 F-07" }, "text").el.rotation).toBeUndefined();
  });

  it("reads `text-orientation` only beside a vertical line", () => {
    const { repairs } = normalize({ "text-orientation": "upright" }, "text");
    expect(repairs.some((r) => r.message.includes("no effect without"))).toBe(true);
    // It is a reader input, not an unknown key.
    expect(repairs.some((r) => r.message.includes("unknown property"))).toBe(false);
  });
});

describe("CSS `backdrop-filter`", () => {
  it("becomes a backdrop-blur effect, sigma doubled to the DSL radius", () => {
    const { el } = normalize({ "backdrop-filter": "blur(10px)" });
    expect(el.effects?.[0]).toMatchObject({ type: "backdrop-blur", blur: 20 });
  });

  it("ignores a top-level `backdropBlur` field", () => {
    const { el, repairs } = normalize({ backdropBlur: 4, "backdrop-filter": "blur(10px)" });
    expect(el.effects?.filter((e) => e.type === "backdrop-blur")).toHaveLength(1);
    expect(el.effects?.[0]).toMatchObject({ blur: 20 });
    expect(repairs.some((r) => r.message.includes("backdropBlur"))).toBe(true);
  });

  it("reports a colour adjustment on the backdrop, which has no field", () => {
    const { repairs } = normalize({ "backdrop-filter": "brightness(0.5)" });
    expect(repairs.some((r) => r.message.includes("brightness"))).toBe(true);
  });

  it("reads `none` as no effect at all", () => {
    expect(normalize({ "backdrop-filter": "none" }).el.effects ?? []).toEqual([]);
  });
});

describe("a CSS declaration the dialect has no field for", () => {
  // `outline` is the text glyph's own geometry in this dialect, so CSS's ring
  // landed nowhere and said nothing.
  it("names a CSS `outline` instead of dropping it", () => {
    const { repairs } = normalize({ outline: "1px solid red" });
    expect(repairs.some((r) => r.kind === "dropped-property" && r.message.includes("outline"))).toBe(true);
  });

  it("keeps the glyph outline a text carries", () => {
    const { el, repairs } = normalize({ outline: { d: "M0 0H4V4Z" } }, "text");
    expect((el as unknown as Record<string, unknown>).outline).toBeDefined();
    expect(repairs.some((r) => r.message.includes("not a text glyph outline"))).toBe(false);
  });
});

describe("CSS grid placement", () => {
  it("reads `grid-column: 2 / span 2` as a start and a span", () => {
    const { el } = normalize({ "grid-column": "2 / span 2" }, "frame");
    expect(prop(el, "grid-area")).toEqual({ column: 2, columnSpan: 2 });
  });

  it("turns an end line into a span", () => {
    expect(prop(normalize({ "grid-row": "1 / 3" }, "frame").el, "grid-area")).toEqual({ row: 1, rowSpan: 2 });
  });

  it("merges the two axes, and prefers them over `grid-area`", () => {
    const { el } = normalize({ "grid-area": { column: 1, row: 1 }, "grid-column": "3" }, "frame");
    expect(prop(el, "grid-area")).toEqual({ column: 3, row: 1 });
  });

  it("reads the CSS `grid-area` shorthand as row / column / row / column", () => {
    expect(prop(normalize({ "grid-area": "2 / 3 / 4 / 5" }, "frame").el, "grid-area")).toEqual({
      row: 2,
      rowSpan: 2,
      column: 3,
      columnSpan: 2
    });
  });

  it("reports a value that is not a line range", () => {
    const { repairs } = normalize({ "grid-column": "left" }, "frame");
    expect(repairs.some((r) => r.path.endsWith("/grid-column"))).toBe(true);
  });
});

describe("a path's `viewBox`", () => {
  const boundsOf = (d: unknown) => {
    const parsed = parsePathData(String(d));
    if (!parsed) return undefined;
    return computePathBounds(parsed);
  };

  it("scales the geometry into the box the element declares", () => {
    const { el } = normalize({ type: "path", width: 48, height: 48, viewBox: "0 0 24 24", d: "M0 0 H24 V24 H0 Z" }, "path");
    expect(boundsOf(prop(el, "d"))).toMatchObject({ minX: 0, minY: 0, maxX: 48, maxY: 48 });
  });

  it("keeps the viewBox's own extent when the box is not declared", () => {
    const { el } = normalize({ type: "path", width: undefined, height: undefined, viewBox: "0 0 24 24", d: "M0 0 H24 V24 H0 Z" }, "path");
    expect(boundsOf(prop(el, "d"))).toMatchObject({ maxX: 24, maxY: 24 });
    // The geometry was baked to that extent, so the BOX has to be it too: the
    // element used to keep the 0×0 it was initialised with, which made a
    // correctly-scaled drawing invisible.
    expect([el.width, el.height]).toEqual([24, 24]);
  });

  it("writes the axis it filled in and keeps the one it was given", () => {
    const { el } = normalize({ type: "path", width: 48, height: undefined, viewBox: "0 0 24 24", d: "M0 0 H24 V24 H0 Z" }, "path");
    expect([el.width, el.height]).toEqual([48, 24]);
  });

  it("subtracts the viewBox's origin", () => {
    const { el } = normalize({ type: "path", width: 40, height: 40, viewBox: "10 10 20 20", d: "M10 10 H30 V30 H10 Z" }, "path");
    expect(boundsOf(prop(el, "d"))).toMatchObject({ minX: 0, minY: 0, maxX: 40, maxY: 40 });
  });

  it("reads a four-number array too", () => {
    const { el } = normalize({ type: "path", width: 20, height: 20, viewBox: [0, 0, 10, 10], d: "M0 0 H10 V10 Z" }, "path");
    expect(boundsOf(prop(el, "d"))).toMatchObject({ maxX: 20, maxY: 20 });
  });

  it("reports a malformed viewBox instead of guessing", () => {
    const { el, repairs } = normalize({ type: "path", viewBox: "0 0 0 24", d: "M0 0 H24 V24 Z" }, "path");
    expect(prop(el, "d")).toBe("M0 0 H24 V24 Z");
    expect(repairs.some((r) => r.path.endsWith("/viewBox"))).toBe(true);
  });
});

describe("`white-space: nowrap`", () => {
  it("measures a text by its content", () => {
    const { el } = normalize({ type: "text", content: "A long label", width: undefined, height: undefined, whiteSpace: "nowrap" }, "text");
    expect(prop(el, "sizing")).toMatchObject({ width: "max-content" });
  });

  it("is read in the kebab spelling too", () => {
    const { el } = normalize({ type: "text", content: "A long label", width: undefined, height: undefined, "white-space": "nowrap" }, "text");
    expect(prop(el, "sizing")).toMatchObject({ width: "max-content" });
  });

  it("does not override a width the author pinned", () => {
    const { el } = normalize({ type: "text", content: "A long label", width: 200, whiteSpace: "nowrap" }, "text");
    expect(prop(el, "sizing")).toBeUndefined();
  });
});
