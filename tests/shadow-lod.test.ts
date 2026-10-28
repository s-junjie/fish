import { describe, it, expect } from "vitest";
import {
  applyShadowLod,
  dropShadowReach,
  paintsShadow,
  shadowLodMarks,
  MIN_SHADOW_REACH_PX,
  SHADOW_CHAIN_ATTR,
  SHADOW_REACH_ATTR
} from "../src/ui/canvas/shadow-lod";

// No DOM in this runner, and the pass only ever asks an element for three things:
// what the node authored, what the reach is, and whether anything has said `none`
// yet. The browser half is `scratch/verify-shadow-lod.mjs`.
function fakeNode(chain: string | null, reach: string | null) {
  const attrs: Record<string, string> = {
    // Rendered state: the node put its own chain on, like the real markup does.
    // Starting with no `filter` at all would make every element read as gated.
    ...(chain ? { filter: chain } : {}),
    ...(chain ? { [SHADOW_CHAIN_ATTR]: chain } : {}),
    ...(reach !== null ? { [SHADOW_REACH_ATTR]: reach } : {})
  };
  return {
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    setAttribute: (n: string, v: string) => { attrs[n] = v; }
  };
}

const rootOf = (nodes: any[]) => ({ querySelectorAll: () => nodes });

const SHADOW = { type: "drop-shadow", blur: 8, offset: { x: 2, y: 4 } };

describe("a shadow's reach is what a zoom can erase", () => {
  it("is the distance it paints past the silhouette, not the blur alone", () => {
    // blur 8 x 3 + the larger offset 4 = 28 document px.
    expect(dropShadowReach(SHADOW)).toBe(28);
  });

  it("counts a spread, which is what makes a zero-blur ring visible", () => {
    expect(dropShadowReach({ type: "drop-shadow", blur: 0, spread: 2, offset: { x: 0, y: 0 } })).toBe(2);
  });

  it("is zero when it hides exactly behind its own shape", () => {
    // Nothing to see, and nothing to save: leaving it painted is free.
    expect(dropShadowReach({ type: "drop-shadow", blur: 0, offset: { x: 0, y: 0 } })).toBe(0);
  });

  it("is dropped below the floor and painted from it up", () => {
    // A reach of 28 needs zoom 2/28 = 0.0714 to reach one pixel's worth.
    expect(paintsShadow(28, 0.05)).toBe(false); // 1.4 screen px of reach
    expect(paintsShadow(28, MIN_SHADOW_REACH_PX / 28)).toBe(true); // exactly at the floor
    expect(paintsShadow(28, 0.1)).toBe(true); // 2.8 screen px
  });

  it("keeps a large shadow at the same zoom that erases a small one", () => {
    expect(paintsShadow(8, 0.3)).toBe(true);
    expect(paintsShadow(2, 0.3)).toBe(false);
  });
});

describe("only an all-shadow filter is eligible", () => {
  it("marks a filter made of drop shadows", () => {
    expect(shadowLodMarks("url(#filter_a)", [SHADOW], undefined)).toEqual({
      [SHADOW_CHAIN_ATTR]: "url(#filter_a)",
      [SHADOW_REACH_ATTR]: "28"
    });
  });

  it("takes the widest reach when several shadows share a filter", () => {
    const marks = shadowLodMarks("url(#f)", [SHADOW, { type: "drop-shadow", blur: 4, offset: { x: 0, y: 0 } }], undefined);
    expect(marks[SHADOW_REACH_ATTR]).toBe("28");
  });

  it("refuses a filter shared with a colour adjustment", () => {
    // A colour change survives being scaled down: the colour of a 2px dot is the
    // colour of that dot.
    expect(shadowLodMarks("url(#f)", [SHADOW], { brightness: 1.2 })).toEqual({});
  });

  it("refuses a filter carrying an effect it has not measured", () => {
    expect(shadowLodMarks("url(#f)", [SHADOW, { type: "layer-blur", blur: 4 }], undefined)).toEqual({});
  });

  it("refuses a filter that is only blur with no offset", () => {
    expect(shadowLodMarks("url(#f)", [{ type: "drop-shadow", blur: 0, offset: { x: 0, y: 0 } }], undefined)).toEqual({});
  });

  it("marks nothing when there is no filter at all", () => {
    expect(shadowLodMarks(undefined, [], undefined)).toEqual({});
  });
});

describe("the pass drops and restores the reference", () => {
  it("writes none below the floor", () => {
    const n = fakeNode("url(#filter_a)", "28");
    applyShadowLod(rootOf([n]) as any, 0.05);
    expect(n.getAttribute("filter")).toBe("none");
  });

  it("puts the authored chain back above it", () => {
    const n = fakeNode("url(#filter_a)", "28");
    applyShadowLod(rootOf([n]) as any, 1);
    expect(n.getAttribute("filter")).toBe("url(#filter_a)");
  });

  it("decides per element, so one zoom can keep one shadow and drop another", () => {
    const small = fakeNode("url(#a)", "8");
    const large = fakeNode("url(#b)", "40");
    applyShadowLod(rootOf([small, large]) as any, 0.2); // 1.6 vs 8 screen px
    expect(small.getAttribute("filter")).toBe("none");
    expect(large.getAttribute("filter")).toBe("url(#b)");
  });

  it("leaves a node alone when its reach cannot be read", () => {
    const n = fakeNode("url(#filter_a)", null);
    applyShadowLod(rootOf([n]) as any, 0.001);
    expect(n.getAttribute("filter")).toBe("url(#filter_a)");
  });

  it("does not rewrite a node that is already right", () => {
    const n = fakeNode("url(#filter_a)", "28");
    applyShadowLod(rootOf([n]) as any, 0.05);
    n.setAttribute = () => { throw new Error("touched an unchanged element"); };
    applyShadowLod(rootOf([n]) as any, 0.05);
    expect(n.getAttribute("filter")).toBe("none");
  });
});

/**
 * The stub above is built with the attributes `applyShadowLod` already looks
 * for, so it cannot see whether the renderer ever writes them — and nothing
 * links a JSX spread to a querySelector string at compile time. That link is
 * asserted in a real browser by `tests/e2e/effect-lod.spec.mjs`, which reads the
 * mark off a rendered node and checks the shadow comes and goes with the zoom.
 *
 * This file used to grep `shadowLodMarks` out of both emitters instead. That
 * matched the import line and the local `const`, so it stayed green when the
 * spread was moved onto the wrong branch of the `ownsEffects` ternary — the
 * marks reached exactly the nodes the pass must not touch.
 */
