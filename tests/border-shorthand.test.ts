import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, RectElement, Stroke } from "../src/core/dsl/types";

/**
 * The CSS `border` shorthand, `<width> || <style> || <color>`.
 *
 * It used to be read as a colour: the whole string became `stroke.color`, so
 * `border: "1px solid #E2E8F0"` produced a 1px stroke painted with the literal
 * text `1px solid #E2E8F0` (and the width was never read). Every case below
 * would have passed as "a stroke exists" before the fix, which is why each one
 * asserts the three parts separately.
 */

const canvas = { width: 800, height: 600, background: { type: "solid", color: "#FFFFFF" } };

const normalizeRect = (over: Record<string, unknown>): RectElement => {
  const doc = {
    version: "0.1",
    canvas,
    pages: [{ id: "p1", name: "P1", canvas, children: [{ id: "r", type: "rect", width: 100, height: 100, ...over }] }],
    activePageId: "p1"
  } as unknown as DesignDocument;
  return normalizeDesignDocument(doc).document.pages[0].children[0] as RectElement;
};

const strokeOf = (over: Record<string, unknown>): Stroke | undefined =>
  (normalizeRect(over).strokes ?? [])[0];

describe("CSS `border` shorthand", () => {
  it("splits width, style and colour", () => {
    expect(strokeOf({ border: "1px solid #E2E8F0" })).toMatchObject({
      width: 1,
      style: "solid",
      color: "#E2E8F0"
    });
  });

  it("reads the three parts in any order", () => {
    expect(strokeOf({ border: "#E2E8F0 1px solid" })).toMatchObject({
      width: 1,
      style: "solid",
      color: "#E2E8F0"
    });
    expect(strokeOf({ border: "solid 2px #123456" })).toMatchObject({
      width: 2,
      style: "solid",
      color: "#123456"
    });
  });

  it("keeps a colour function in one piece", () => {
    expect(strokeOf({ border: "3px solid rgb(18, 52, 86)" })).toMatchObject({
      width: 3,
      color: "rgb(18, 52, 86)"
    });
  });

  it("maps a dashed shorthand onto the dashed pattern", () => {
    const stroke = strokeOf({ border: "1px dashed #000000" });
    expect(stroke?.style).toBe("dashed");
    expect(stroke?.dashArray?.length).toBeGreaterThan(0);
  });

  it("treats `none` as no border", () => {
    expect(normalizeRect({ border: "none", borderColor: "#FF0000", borderWidth: 4 }).strokes ?? []).toEqual([]);
  });

  it("still reads a bare colour, and the longhand properties", () => {
    expect(strokeOf({ border: "#FF0000" })).toMatchObject({ color: "#FF0000", width: 1 });
    expect(strokeOf({ borderColor: "#00FF00", borderWidth: 2 })).toMatchObject({ color: "#00FF00", width: 2 });
  });

  it("reads a per-side shorthand as that side's width plus the shared style and colour", () => {
    expect(strokeOf({ "border-bottom": "3px solid #E2E8F0" })).toMatchObject({
      width: 3,
      style: "solid",
      color: "#E2E8F0",
      side: "custom",
      sides: { top: 0, right: 0, bottom: 3, left: 0 }
    });
  });

  it("keeps one side's border when another side says none", () => {
    expect(
      strokeOf({
        "border-top": "none",
        "border-bottom": "1px dashed #123456"
      })
    ).toMatchObject({
      style: "dashed",
      side: "custom",
      sides: { top: 0, right: 0, bottom: 1, left: 0 }
    });
  });

  it("reads all four side shorthands", () => {
    expect(
      strokeOf({
        "border-top": "1px solid #111111",
        "border-right": "2px solid #222222",
        "border-bottom": "3px solid #333333",
        "border-left": "4px solid #444444"
      })
    ).toMatchObject({ sides: { top: 1, right: 2, bottom: 3, left: 4 } });
  });

  it("does not let `border: none` delete an explicit stroke stack", () => {
    const el = normalizeRect({ border: "none", strokes: [{ color: "#0000FF", width: 5 }] });
    expect(el.strokes?.[0]).toMatchObject({ color: "#0000FF", width: 5 });
  });
});

/**
 * CSS names one corner per property; the dialect holds four. An author writing
 * the standard property used to get `unknown property` for it.
 */
describe("CSS corner longhands", () => {
  it("reads a single corner and leaves the rest square", () => {
    expect(normalizeRect({ "border-top-left-radius": 8 }).borderRadius).toEqual([8, 0, 0, 0]);
  });

  it("reads all four", () => {
    expect(
      normalizeRect({
        "border-top-left-radius": 1,
        "border-top-right-radius": 2,
        "border-bottom-right-radius": 3,
        "border-bottom-left-radius": 4
      }).borderRadius
    ).toEqual([1, 2, 3, 4]);
  });

  it("lets a longhand override the one corner of the shorthand it names", () => {
    expect(normalizeRect({ "border-radius": 8, "border-top-left-radius": 20 }).borderRadius).toEqual([20, 8, 8, 8]);
  });

  it("reads the camel spelling", () => {
    expect(normalizeRect({ borderTopLeftRadius: 6 }).borderRadius).toEqual([6, 0, 0, 0]);
  });
});

/**
 * CSS's border longhands are independent declarations, and the initial value
 * fills the parts an author leaves out — so a lone `border-style` and a lone
 * `border-top-width` each still draw a border. Requiring a colour or a width
 * first turned both into silence: no stroke, no repair.
 */
describe("a partial border still draws one", () => {
  it("reads a lone `border-style`", () => {
    expect(strokeOf({ borderStyle: "dashed" })).toMatchObject({ style: "dashed" });
    expect(strokeOf({ "border-style": "dashed" })).toMatchObject({ style: "dashed" });
  });

  it("reads a lone per-side width", () => {
    expect(strokeOf({ "border-top-width": 4 })).toMatchObject({ sides: { top: 4 } });
    expect(strokeOf({ borderLeftWidth: 2 })).toMatchObject({ sides: { left: 2 } });
  });

  it("lets `border-style: none` win over a colour written beside it", () => {
    expect(normalizeRect({ "border-style": "none", borderColor: "#FF0000", borderWidth: 4 }).strokes ?? []).toEqual([]);
  });

  it("reports a per-side width in a unit it cannot hold instead of dropping it", () => {
    const doc = {
      version: "0.1",
      canvas,
      pages: [{ id: "p1", name: "P1", canvas, children: [{ id: "r", type: "rect", width: 100, height: 100, "border-top-width": "2em" }] }],
      activePageId: "p1"
    } as unknown as DesignDocument;
    const { repairs } = normalizeDesignDocument(doc);
    expect(repairs.some((r) => r.message.includes("border-top-width"))).toBe(true);
  });
});
