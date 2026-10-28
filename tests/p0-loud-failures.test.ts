import { flattenLayout } from "../src/core/dsl/layout-flat";
/**
 * Every silent coercion must raise a repair. These are the failures an author
 * cannot detect — geometry that looks applied and is not, with an empty repair
 * list — so the assertion here is deliberately the repair's *message*, not just
 * its presence: a repair naming the wrong cause is a rework of its own.
 */

import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

function docWithElement(extra: Record<string, unknown>) {
  return {
    pages: [
      {
        id: "p1",
        name: "Page 1",
        children: [
          { id: "el1", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10, ...extra }
        ]
      }
    ],
    activePageId: "p1"
  };
}

const repairsFor = (extra: Record<string, unknown>) => normalizeDesignDocument(docWithElement(extra)).repairs;

describe("P0 — silent coercions now report", () => {
  it("sizing bound with a non-px unit reports the unit instead of reading it as px", () => {
    const repairs = repairsFor({ sizing: { maxWidth: "90%" } });
    const hit = repairs.find((r) => r.path.includes("maxWidth"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("%");
  });

  it("a plain px bound is still accepted with no repair", () => {
    const repairs = repairsFor({ sizing: { maxWidth: 90 } });
    expect(repairs.find((r) => r.path.includes("maxWidth"))).toBeUndefined();
  });

  it("flex-direction row-reverse reports rather than silently flipping the axis", () => {
    const repairs = repairsFor({ display: "flex", "flex-direction": "row-reverse" });
    const hit = repairs.find((r) => r.path.includes("direction"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("row-reverse");
  });

  it("top-level gap on a non-ellipse reports (it is read only by the ellipse arc)", () => {
    const repairs = repairsFor({ gap: 16 });
    const hit = repairs.find((r) => r.path.endsWith("/gap"));
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("dropped-property");
  });

  it("an unknown image fit reports instead of silently becoming cover", () => {
    const repairs = repairsFor({ fills: [{ type: "image", assetId: "a1", fit: "squish" }] });
    const hit = repairs.find((r) => r.path.includes("/fit"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("squish");
  });

  it("a non-length, non-mode height reports the 0 it was replaced with", () => {
    const repairs = repairsFor({ height: "wat" });
    const hit = repairs.find((r) => r.path.endsWith("/height"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("wat");
  });

  it("an invalid borderRadius string reports instead of dropping silently", () => {
    const repairs = repairsFor({ borderRadius: "round" });
    const hit = repairs.find((r) => r.message.includes("borderRadius"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("round");
  });

  it("a maskMode typo reports", () => {
    const repairs = repairsFor({ maskMode: "luminence" });
    const hit = repairs.find((r) => r.path.includes("maskMode"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("luminence");
  });

  it("an element-level alpha reports (it is a paint-layer property, not an element one)", () => {
    const repairs = repairsFor({ alpha: 0.5 });
    const hit = repairs.find((r) => r.path.endsWith("/alpha"));
    expect(hit).toBeDefined();
  });

  it("a layout key reports instead of expanding a shorthand", () => {
    const repairs = repairsFor({ layout: "colmun gap=16" });
    expect(repairs.find((r) => r.path.endsWith("/layout"))).toBeDefined();
  });

  it("textColor is a recognised key, and is_mask is reported rather than half-read", () => {
    const repairs = repairsFor({ type: "frame", is_mask: true, textColor: "#fff", children: [] });
    expect(repairs.find((r) => r.message.includes("textColor"))).toBeUndefined();
    // `isMask` is the spelling; `is_mask` canonicalises onto it and would have
    // been accepted by a gate with no reader behind it.
    expect(repairs.find((r) => r.message.includes("is_mask"))).toBeDefined();
  });
});

describe("a corner resolves by the same rule whichever form it is written in", () => {
  const el = (extra: Record<string, unknown>) => {
    const { document: d, repairs } = normalizeDesignDocument(
      docWithElement({ width: 200, height: 200, ...extra }) as never
    );
    return { radius: (d.pages?.[0]?.children?.[0] as { borderRadius?: unknown })?.borderRadius, repairs };
  };
  const cornerRepairs = (repairs: { path: string; message: string }[]) => repairs.filter((r) => r.path.endsWith("/borderRadius"));

  // `asNumber("50%")` is 50, so the object and array forms used to answer 50px
  // where CSS says 50% of min(200,200) = 100. The STRING form already resolved
  // it, so one field gave two answers depending on how it was spelled.
  it("a percentage corner is a share of the box, in all three forms", () => {
    expect(el({ borderRadius: "50%" }).radius).toBe(100);
    expect(el({ borderRadius: { topLeft: "50%" } }).radius).toEqual([100, 0, 0, 0]);
    expect(el({ borderRadius: ["50%", 4, 4, 4] }).radius).toEqual([100, 4, 4, 4]);
    expect(el({ borderRadius: { all: "50%" } }).radius).toBe(100);
  });

  it("a corner unit the dialect cannot resolve is reported, not read as pixels", () => {
    for (const value of [{ topLeft: "2em" }, ["2em", 4, 4, 4], { topLeft: "2em", topRight: 4 }, { all: "3vw" }]) {
      const { repairs } = el({ borderRadius: value });
      const hit = cornerRepairs(repairs);
      expect(hit.length, `${JSON.stringify(value)} -> ${JSON.stringify(repairs)}`).toBeGreaterThan(0);
      expect(hit[0].message).toContain("is not a corner length");
    }
  });

  it("names the unit it refused", () => {
    const { repairs } = el({ borderRadius: { topLeft: "2em" } });
    expect(cornerRepairs(repairs)[0].message).toContain('carries "em"');
  });

  it("a written-but-unreadable corner fails the whole shape; an absent one is 0", () => {
    // The partial object stays a partial object; only an unreadable side is fatal.
    expect(el({ borderRadius: { topLeft: 12 } }).radius).toEqual([12, 0, 0, 0]);
    expect(el({ borderRadius: { topLeft: "2em", topRight: 4 } }).radius).toBeUndefined();
  });

  it("keeps every spelling that does resolve", () => {
    for (const value of [
      8,
      "8px",
      "8",
      "4px 8px",
      [1, 2, 3, 4],
      { all: 6 },
      { topLeft: 3 },
      { tl: 3, top_left: 3 },
      "1rem"
    ]) {
      expect(cornerRepairs(el({ borderRadius: value }).repairs), JSON.stringify(value)).toEqual([]);
    }
  });
});

describe("a per-side border width is an independent declaration", () => {
  const sidesOf = (extra: Record<string, unknown>) => {
    const { document: d, repairs } = normalizeDesignDocument(
      docWithElement({ strokes: [{ color: "#000" }], ...extra }) as never
    );
    const el = d.pages?.[0]?.children?.[0] as { strokes?: Array<{ sides?: unknown }> };
    return { sides: el?.strokes?.[0]?.sides, repairs };
  };
  const widthRepairs = (repairs: { message: string }[]) =>
    repairs.filter((r) => r.message.includes("border-") && r.message.includes("-width"));

  it("reports a side whose unit is not px, and keeps the other three", () => {
    const { sides, repairs } = sidesOf({ "border-top-width": "2em", "border-right-width": 3 });
    const hit = widthRepairs(repairs);
    expect(hit.length, JSON.stringify(repairs)).toBeGreaterThan(0);
    expect(hit[0].message).toContain('carries "em"');
    // the readable sides still stand — CSS treats them as separate properties
    expect(sides).toEqual({ top: 0, right: 3, bottom: 0, left: 0 });
  });

  it("reports a percentage side instead of reading it as that many pixels", () => {
    const { repairs } = sidesOf({ "border-top-width": "5%" });
    expect(widthRepairs(repairs).length).toBeGreaterThan(0);
  });

  it("keeps px, bare numbers and px-strings on every side", () => {
    for (const value of [2, "2", "2px", "0", 0]) {
      expect(widthRepairs(sidesOf({ "border-top-width": value }).repairs), JSON.stringify(value)).toEqual([]);
    }
    expect(sidesOf({ "border-top-width": "2px" }).sides).toEqual({ top: 2, right: 0, bottom: 0, left: 0 });
  });
});
