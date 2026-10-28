import { flattenLayout } from "../src/core/dsl/layout-flat";
import { DesignElement } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { validateDocument } from "../src/core/validate";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { resolveDynamicLineHeight } from "../src/core/layout/text-sizing";
import type { AutoLayout, DesignDocument, FrameElement, PathElement, TextElement } from "../src/core/dsl/types";

function frame(id: string, x: number, y: number, w: number, h: number, children: DesignElement[] = []): FrameElement {
  return { id, type: "frame", name: id, x, y, width: w, height: h, children, clipContent: false };
}

function doc(elements: DesignElement[], background: DesignDocument["canvas"]["background"] = { type: "solid", color: "#FFFFFF" }): DesignDocument {
  const canvas = { width: 1000, height: 1000, unit: "px" as const, background };
  return {
    version: "0.1",
    id: "test",
    name: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
    activePageId: "page_1",
    elements
  };
}

function pathEl(id: string, x: number, y: number, w: number, h: number, d: string): PathElement {
  return { id, type: "path", name: id, x, y, width: w, height: h, d };
}

function textEl(id: string, x: number, y: number, w: number, h: number, content: string, fontSize = 16): TextElement {
  return {
    id, type: "text", name: id, x, y, width: w, height: h, content,
    style: { fontFamily: "Arial", fontSize, color: "#000000" }
  };
}

describe("validateDocument", () => {
  it("passes a clean document", () => {
    const el = pathEl("arc", 10, 10, 100, 100, "M 50 4 A 46 46 0 0 1 96 50");
    expect(validateDocument(doc([el]))).toHaveLength(0);
  });

  it("flags an instance whose component is not in the document", () => {
    const inst = {
      id: "inst",
      type: "instance",
      name: "Orphan",
      componentId: "gone",
      x: 0,
      y: 0,
      width: 40,
      height: 40
    } as DesignElement;
    const diags = validateDocument(doc([inst]));
    expect(diags).toHaveLength(1);
    expect(diags[0].elementId).toBe("inst");
    expect(diags[0].level).toBe("error");
  });

  it("names the type mismatch when the master is present but not a component", () => {
    // The document walk builds the master index on `type === "component"` alone,
    // so a master authored as a frame is invisible to it while plainly present.
    // Reporting that as "not in this document" sends the author looking for a
    // missing asset instead of at the one-word difference that fixes it.
    const inst = {
      id: "inst",
      type: "instance",
      name: "Book a test ride",
      componentId: "cmp/Button",
      x: 0,
      y: 0,
      width: 40,
      height: 40
    } as DesignElement;
    const shadow = {
      id: "cmp/Button",
      type: "frame" as const,
      name: "Button",
      x: 0,
      y: 100,
      width: 40,
      height: 40
    } as DesignElement;
    const diags = validateDocument(doc([inst, shadow]));
    expect(diags).toHaveLength(1);
    expect(diags[0].elementId).toBe("inst");
    expect(diags[0].level).toBe("error");
    expect(diags[0].message).toContain('exists but is a frame node');
    expect(diags[0].message).toContain('type:"component"');
  });

  it("accepts an instance whose component lives on another page", () => {
    const inst = {
      id: "inst",
      type: "instance",
      name: "Fine",
      componentId: "cmp_remote",
      x: 0,
      y: 0,
      width: 40,
      height: 40
    } as DesignElement;
    const base = doc([inst]);
    const remote = {
      id: "cmp_remote",
      type: "component" as const,
      name: "Remote",
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      children: []
    };
    const multi: DesignDocument = {
      ...base,
      pages: [
        { id: "page_1", name: "Page 1", canvas: base.canvas, children: [inst] },
        { id: "page_2", name: "Components", canvas: base.canvas, children: [remote] }
      ]
    };
    expect(validateDocument(multi)).toHaveLength(0);
  });

  it("flags path data authored outside the local box", () => {
    const el = pathEl("arc", 10, 10, 100, 100, "M 760 66 A 46 46 0 0 1 806 112");
    const diags = validateDocument(doc([el]));
    expect(diags).toHaveLength(1);
    expect(diags[0].elementId).toBe("arc");
    expect(diags[0].message).toContain("outside local box");
  });

  it("flags text that wraps past its box", () => {
    const el = textEl("pill", 0, 0, 88, 20, "#M5-125-006 Auction", 8);
    const diags = validateDocument(doc([el]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("exceeds element height");
  });

  it("respects explicit newlines when estimating text height", () => {
    const el = textEl("head", 0, 0, 240, 80, "Purchase\nInspection", 27);
    expect(validateDocument(doc([el]))).toHaveLength(0);
  });

  it("does not estimate text height inside a component master", () => {
    // The master's authored box is a template: every instance re-derives the
    // size it paints at and may override the text itself, so the estimate
    // grades a box nothing renders at those numbers. The same text inside a
    // plain frame is exactly what the estimate is for and still warns.
    const clipped = textEl("spec_title", 0, 0, 88, 20, "#M5-125-006 Auction", 8);
    const comp: any = {
      id: "my_comp",
      type: "component",
      name: "Card",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [clipped]
    };
    const masterDiags = validateDocument(doc([comp]));
    expect(masterDiags.filter((d) => /exceeds element height/.test(d.message))).toHaveLength(0);
    const frameDiags = validateDocument(doc([frame("card", 0, 0, 200, 200, [clipped])]));
    expect(frameDiags.some((d) => /exceeds element height/.test(d.message))).toBe(true);
  });

  it("does not estimate text height inside a component set variant", () => {
    const clipped = textEl("spec_title", 0, 0, 88, 20, "#M5-125-006 Auction", 8);
    const variant: any = {
      id: "variant_default",
      type: "component",
      name: "Default",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [clipped],
      setId: "set_1"
    };
    const set: any = {
      id: "set_1",
      type: "componentSet",
      name: "Card",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [variant]
    };
    const diags = validateDocument(doc([set]));
    expect(diags.filter((d) => /exceeds element height/.test(d.message))).toHaveLength(0);
  });

  it("flags unknown paint types", () => {
    const el = { ...pathEl("p", 0, 0, 10, 10, "M 0 0 L 10 10"), fills: [{ type: "mesh" }] } as unknown as PathElement;
    const diags = validateDocument(doc([el]));
    expect(diags.some((d) => d.message.includes('Unknown paint type "mesh"'))).toBe(true);
  });

  it("flags unsupported canvas backgrounds", () => {
    const diags = validateDocument(doc([], { type: "radial-gradient", from: "#111", to: "#222" }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("canvas.background");
  });

  it("reports children entirely outside their parent frame as info", () => {
    const inner = pathEl("stray", 900, 900, 50, 50, "M 0 0 L 10 10");
    const parent = frame("card", 10, 10, 200, 200, [inner]);
    const diags = validateDocument(doc([parent]));
    expect(diags).toHaveLength(1);
    expect(diags[0].level).toBe("info");
    expect(diags[0].elementId).toBe("stray");
  });

  it("does not flag overlapping children when there is no text collision", () => {
    const inner = textEl("ok", 20, 20, 100, 20, "hello", 12);
    const parent = frame("card", 10, 10, 200, 200, [inner]);
    expect(validateDocument(doc([parent]))).toHaveLength(0);
  });

  it("warns when sibling text elements visually overlap inside a plain frame", () => {
    const t1 = textEl("t1", 0, 0, 200, 40, "Heading Line 1", 32);
    const t2 = textEl("t2", 0, 10, 200, 40, "Heading Line 2", 32);
    const parent = frame("headline_frame", 10, 10, 300, 100, [t1, t2]);
    const diags = validateDocument(doc([parent]));
    const warn = diags.find((d) => d.elementId === "t2" && /visually overlap/.test(d.message));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warning");
  });

  it("does not warn about sibling text elements when parent has auto-layout", () => {
    const t1 = textEl("t1", 0, 0, 200, 40, "Heading Line 1", 32);
    const t2 = textEl("t2", 0, 10, 200, 40, "Heading Line 2", 32);
    const parent: any = {
      ...frame("headline_frame", 10, 10, 300, 100, [t1, t2]),
      ...flattenLayout({ mode: "flex", direction: "column", gap: 8 })
    };
    const diags = validateDocument(doc([parent]));
    expect(diags.filter((d) => /visually overlap/.test(d.message))).toHaveLength(0);
  });

  it("covers every element recursively including nested frames", () => {
    const bad = pathEl("deep", 0, 0, 50, 50, "M 400 400 L 500 500");
    const inner = frame("inner", 10, 10, 100, 100, [bad]);
    const outer = frame("outer", 0, 0, 300, 300, [inner]);
    const diags = validateDocument(doc([outer]));
    expect(diags).toHaveLength(1);
    expect(diags[0].elementId).toBe("deep");
  });

  it("does not flag children outside parent frame when parent is auto-layout (flex or grid)", () => {
    const child = textEl("btn", 0, 0, 100, 20, "Click", 12);
    const flexFrame: any = {
      ...frame("flex_card", 100, 100, 300, 200, [child]),
      ...flattenLayout({ mode: "flex", direction: "column", gap: 8 })
    };
    expect(validateDocument(doc([flexFrame]))).toHaveLength(0);
  });

  it("recursively validates component children", () => {
    const bad = pathEl("deep_comp", 0, 0, 50, 50, "M 400 400 L 500 500");
    const comp: any = {
      id: "my_comp",
      type: "component",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [bad]
    };
    const diags = validateDocument(doc([comp]));
    expect(diags).toHaveLength(1);
    expect(diags[0].elementId).toBe("deep_comp");
  });

  it("validates line endpoints: flags NaN/undefined but allows negative slopes", () => {
    const validNegativeSlope: any = {
      id: "neg_line",
      type: "line",
      x: 100,
      y: 500,
      dx: 400,
      dy: -300,
      width: 400,
      height: 300
    };
    expect(validateDocument(doc([validNegativeSlope]))).toHaveLength(0);

    const validDeltaLine: any = {
      id: "delta_line",
      type: "line",
      x: 100,
      y: 500,
      dx: 400,
      dy: -300,
      width: 400,
      height: 300
    };
    expect(validateDocument(doc([validDeltaLine]))).toHaveLength(0);

    const badLine: any = {
      id: "bad_line",
      type: "line",
      x: 100,
      y: 500,
      dx: NaN,
      dy: 200,
      width: 400,
      height: 300
    };
    const diags = validateDocument(doc([badLine]));
    expect(diags).toHaveLength(1);
    expect(diags[0].level).toBe("error");
    expect(diags[0].elementId).toBe("bad_line");
  });

  it("does not flag child inside non-origin frame as outside parent (v0.3 local coords)", () => {
    const nonOriginFrame: any = {
      id: "frame_at_300",
      type: "frame",
      x: 300,
      y: 300,
      width: 200,
      height: 200,
      children: [
        {
          id: "child_inside",
          type: "rect",
          x: 20,
          y: 20,
          width: 50,
          height: 50
        }
      ]
    };
    const diags = validateDocument(doc([nonOriginFrame]));
    expect(diags.filter((d) => d.level === "info")).toHaveLength(0);
  });
});

describe("a content-driven size nothing can compute is reported", () => {
  const doc = (frame: unknown) =>
    ({
      canvas: { width: 800, height: 600, unit: "px", background: { type: "solid", color: "#000" } },
      elements: [frame]
    }) as unknown as DesignDocument;

  it("warns about a frame that hugs with no auto layout to hug from", () => {
    const bare = {
      id: "bare",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      sizing: { height: "fit-content" },
      children: [{ id: "c", type: "rect", x: 0, y: 0, width: 10, height: 10 }]
    };
    const warnings = validateDocument(doc(bare));
    expect(warnings.some((w) => w.elementId === "bare" && /Auto-Layout/.test(w.message))).toBe(true);

    const withLayout = { ...bare, ...flattenLayout({ mode: "flex", direction: "column" }) };
    expect(validateDocument(doc(withLayout)).some((w) => w.elementId === "bare")).toBe(false);
  });

  it("warns about a grid that hugs a width its own columns derive from", () => {
    const grid = {
      id: "auto",
      type: "frame",
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      sizing: { width: "fit-content" },
      ...flattenLayout({ mode: "grid", columnsMode: "auto", columnWidthMin: 100 }),
      children: [{ id: "c", type: "rect", x: 0, y: 0, width: 10, height: 10 }]
    };
    const warnings = validateDocument(doc(grid));
    expect(warnings.some((w) => w.elementId === "auto" && /columns/i.test(w.message))).toBe(true);
  });
});

/**
 * `placement: "column"` reads `rows` as the stride, which is what CSS grid does —
 * but "Cols 3 / Rows 4" reads like a 3x4 grid, and a big `rows` silently packs
 * every child into the first column. Say so rather than leaving it to look broken.
 */
describe("a grid that fills by column reports the columns it cannot reach", () => {
  const grid = (layout: AutoLayout, children: unknown[]) =>
    ({
      canvas: { width: 800, height: 600, unit: "px", background: { type: "solid", color: "#000" } },
      elements: [
        {
          id: "g",
          type: "frame",
          name: "g",
          x: 0,
          y: 0,
          width: 600,
          height: 400,
          ...flattenLayout(layout),
          children
        }
      ]
    }) as unknown as DesignDocument;

  const four = [0, 1, 2, 3].map((i) => ({
    id: `c${i}`,
    type: "rect",
    x: 0,
    y: 0,
    width: 50,
    height: 40
  }));

  it("warns when rows as a stride leaves declared columns empty", () => {
    const warnings = validateDocument(grid({ mode: "grid", columns: 3, rows: 4, placement: "column" }, four));
    expect(warnings.some((w) => /only reach 1 of its 3 columns/.test(w.message))).toBe(true);
  });

  it("stays quiet when every declared column is reached", () => {
    const six = [0, 1, 2, 3, 4, 5].map((i) => ({
      id: `c${i}`,
      type: "rect",
      x: 0,
      y: 0,
      width: 50,
      height: 40
    }));
    const warnings = validateDocument(grid({ mode: "grid", columns: 3, rows: 2, placement: "column" }, six));
    expect(warnings.some((w) => /only reach/.test(w.message))).toBe(false);
  });

  it("does not fire for row-major placement", () => {
    const warnings = validateDocument(grid({ mode: "grid", columns: 3, rows: 4 }, four));
    expect(warnings.some((w) => /only reach/.test(w.message))).toBe(false);
  });
});

/**
 * The single-line text that every agent-authored document produced: no `height`,
 * so normalize supplies one — and `check` then warned that the line did not fit
 * in the box normalize had just written. The box was 32px (`ceil(24 × 1.3)`) and
 * the line was 33.12px (`resolveDynamicLineHeight`), i.e. the engine reporting
 * its own two coefficients disagreeing as an authoring mistake.
 */
describe("the height normalize derives for a text that names none", () => {
  const normalizeText = (el: Record<string, unknown>) =>
    normalizeDesignDocument({
      version: "0.1",
      id: "test",
      name: "test",
      canvas: { width: 1000, height: 1000, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
      pages: [{ id: "page_1", name: "Page 1", children: [el] }]
    }).document.pages![0].children[0];

  it("is the line box the renderer and check both measure", () => {
    const el = normalizeText({ id: "t", type: "text", x: 0, y: 0, width: 240, content: "Hello", style: { fontSize: 24 } });
    expect((el as TextElement).height).toBe(resolveDynamicLineHeight(24, undefined));
  });

  it("does not then warn that the line does not fit in it", () => {
    const el = normalizeText({ id: "t", type: "text", x: 0, y: 0, width: 240, content: "Hello", style: { fontSize: 24 } });
    expect(validateDocument(doc([el])).some((d) => /exceeds element height/.test(d.message))).toBe(false);
  });

  it("still warns when the text really is taller than the box it was given", () => {
    const el = normalizeText({
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      width: 40,
      height: 30,
      content: "A line that has to wrap several times over",
      style: { fontSize: 24 }
    });
    expect(validateDocument(doc([el])).some((d) => /exceeds element height/.test(d.message))).toBe(true);
  });
});

describe("two text boxes that overlap", () => {
  const overlapWarnings = (children: TextElement[]) =>
    validateDocument(doc([frame("cover", 0, 0, 400, 300, children)])).filter((d) => /visually overlap/.test(d.message));

  it("report a real collision between comparable boxes", () => {
    expect(overlapWarnings([textEl("t1", 0, 0, 200, 40, "Heading Line 1", 32), textEl("t2", 0, 10, 200, 40, "Heading Line 2", 32)])).toHaveLength(1);
  });

  it("say nothing when one box sits inside the other — that is layering, not a collision", () => {
    // A wordmark over a display glyph: the glyph's box swallows the label's.
    expect(overlapWarnings([textEl("F", 0, 0, 240, 240, "F", 200), textEl("mark", 40, 40, 120, 24, "FISH", 14)])).toHaveLength(0);
  });

  it("say nothing about a sliver, because the box is estimated from a character count", () => {
    // 8 of 40px: inside the error of the 0.6em/char estimate the rule measures
    // with, so grading it graded the estimator.
    expect(overlapWarnings([textEl("t1", 0, 0, 200, 40, "Heading Line 1", 32), textEl("t2", 0, 32, 200, 40, "Heading Line 2", 32)])).toHaveLength(0);
  });
});
