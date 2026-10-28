import { describe, expect, it } from "vitest";
import {
  blendModeIsLive,
  extractBackdropTargets,
  scaledCanvasFilter
} from "../src/core/export-backdrop";

describe("backdrop export", () => {
  // The chain the renderer writes resolves lengths in SVG user space; `ctx.filter`
  // resolves them in destination canvas pixels. Nothing in the canvas pipeline
  // scales, so the export scale is the entire difference — and getting it wrong
  // makes a 2x export carry a 1x blur, which reads as "the blur got weaker when
  // I asked for a sharper image".
  it("restates a filter chain's lengths in destination pixels", () => {
    expect(scaledCanvasFilter("blur(16px) saturate(1.8) brightness(1.08)", 1)).toBe(
      "blur(16px) saturate(1.8) brightness(1.08)"
    );
    expect(scaledCanvasFilter("blur(16px) saturate(1.8)", 3)).toBe(
      "blur(48px) saturate(1.8)"
    );
    expect(scaledCanvasFilter("blur(7.5px)", 2)).toBe("blur(15px)");
  });

  it("leaves the unitless arguments of a colour function alone", () => {
    // `saturate(1.8)` has no px to scale, and rewriting it would change the
    // saturation rather than the radius.
    expect(scaledCanvasFilter("blur(10px) saturate(1.8) brightness(1.08)", 2)).toBe(
      "blur(20px) saturate(1.8) brightness(1.08)"
    );
  });

  // The renderer writes `mix-blend-mode: normal` on every single element group, so
  // reading that as a live blend marks the whole tree as unsplittable. Every
  // frosted panel below the top level then loses its blur in the export while the
  // top-level ones keep working, which is why this is asserted directly rather
  // than left to a pixel check that only covers the top level.
  it("treats the default blend mode as no blend", () => {
    expect(blendModeIsLive("mix-blend-mode: normal;")).toBe(false);
    expect(blendModeIsLive("mix-blend-mode:normal")).toBe(false);
    expect(blendModeIsLive("mix-blend-mode:  NORMAL ;")).toBe(false);
    expect(blendModeIsLive("mix-blend-mode: inherit")).toBe(false);
    expect(blendModeIsLive("mix-blend-mode: unset; fill: red")).toBe(false);
    expect(blendModeIsLive(null)).toBe(false);
    expect(blendModeIsLive("pointer-events: none;")).toBe(false);
  });

  it("recognises a blend that actually composites against the canvas", () => {
    expect(blendModeIsLive("mix-blend-mode: multiply;")).toBe(true);
    expect(blendModeIsLive("mix-blend-mode: screen")).toBe(true);
    expect(blendModeIsLive("opacity: 1; mix-blend-mode: plus-lighter;")).toBe(true);
  });
});

// The renderer grows the backdrop div past the element box so the glass lens has
// backdrop to sample outside the panel, and re-anchors the div's clip-path to the
// margin box, which is the element's own box again. `extractBackdropTargets`
// replays the frost from what it reads off that div, so a clip it cannot parse
// silently degrades every frosted panel to a rectangle — visible only in the
// export, and only where the shape is not one. There is no DOM in this runner;
// the function asks an element for five things, which this stub answers.
function fakeFo(style: string, attrs: Record<string, string>, id: string) {
  const div = { getAttribute: (n: string) => (n === "style" ? style : null) };
  const group = { getAttribute: (n: string) => (n === "data-element-id" ? id : null) };
  return {
    firstElementChild: div,
    closest: (sel: string) => (sel.includes("data-element-id") ? group : null),
    getAttribute: (n: string) => attrs[n] ?? null,
    remove: () => {}
  };
}
const fakeClone = (fos: unknown[]) => ({ querySelectorAll: (sel: string) => (sel === "foreignObject" ? fos : []) });
const D = "M24,0 H276 A24,24 0 0 1 300,24 V196 A24,24 0 0 1 276,220 H24 A24,24 0 0 1 0,196 V24 A24,24 0 0 1 24,0 Z";

describe("the export reads a backdrop div's clip", () => {
  const read = (clipPath: string) => {
    const style = `backdrop-filter: blur(2px) url(#lg_refract_p1); clip-path: ${clipPath}; pointer-events: none`;
    const [target] = extractBackdropTargets(
      fakeClone([fakeFo(style, { x: "60", y: "60", width: "300", height: "220" }, "panel")]) as never
    );
    return target;
  };

  it("takes the shape path off the unadorned form", () => {
    expect(read(`path('${D}')`).clipPathD).toBe(D);
  });

  it("takes it off the margin-box form the grown div writes", () => {
    // The suffix is what re-anchors the path to the element's own box, so the
    // box recorded off the foreignObject below stays the right one.
    expect(read(`path('${D}') margin-box`).clipPathD).toBe(D);
  });

  it("refuses a geometry box that would move the path elsewhere", () => {
    // A grown div's BORDER box starts `pad` up-left of the shape; a path read as
    // relative to it lands off the panel. An unclipped frost is wrong, but a
    // shifted one is wrong in a way no test downstream can see.
    expect(read(`path('${D}') border-box`).clipPathD).toBeNull();
    expect(read(`path('${D}') view-box`).clipPathD).toBeNull();
  });

  it("leaves an unclipped div unclipped", () => {
    expect(read("none").clipPathD).toBeNull();
    expect(read("").clipPathD).toBeNull();
  });

  it("keeps the foreignObject's box and drops the lens from the chain", () => {
    const t = read(`path('${D}') margin-box`);
    expect([t.x, t.y, t.width, t.height]).toEqual([60, 60, 300, 220]);
    expect(t.filter).toBe("blur(2px)");
  });
});
