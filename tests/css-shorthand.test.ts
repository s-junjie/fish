import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

/**
 * Regression coverage for the CSS-shorthand intakes wired into the DSL normalize
 * layer. Each shorthand is WRITE-ONLY: the string is expanded into the canonical
 * structured model on the first normalize pass and then dropped, so a document
 * re-normalized after saving must already be in structured form.
 *
 * The model's stacks (fills / strokes / effects) are bottom-first, which is the
 * OPPOSITE of CSS (background / box-shadow paint the first-listed layer on top).
 * Every test below asserts the reversal landed the CSS top layer last.
 */

function rect(extra: Record<string, unknown>) {
  return {
    canvas: { width: 800, height: 600 },
    elements: [
      {
        id: "rect1",
        type: "rect",
        x: 10,
        y: 10,
        width: 100,
        height: 100,
        ...extra
      }
    ]
  };
}

describe("CSS box-shadow shorthand → effects[]", () => {
  it("reverses CSS order so the front shadow ends up on top of the stack", () => {
    const res = normalizeDesignDocument(
      rect({
        boxShadow: "rgba(0,0,0,0.2) 0px 4px 12px, inset 0px 1px 2px rgb(255,255,255)"
      })
    );
    const el = getActivePage(res.document).children[0] as any;
    expect(el.effects).toHaveLength(2);
    // CSS lists the front (drop) shadow first; the DSL stores bottom-first,
    // so the inset (back) shadow is index 0 and the drop shadow is index 1.
    expect(el.effects[0]).toMatchObject({
      type: "inner-shadow",
      color: "rgb(255,255,255)",
      offset: { x: 0, y: 1 },
      blur: 2,
      enabled: true
    });
    expect(el.effects[1]).toMatchObject({
      type: "drop-shadow",
      color: "rgba(0,0,0,0.2)",
      offset: { x: 0, y: 4 },
      blur: 12,
      enabled: true
    });
  });

  it("reports the expansion as a repair", () => {
    const res = normalizeDesignDocument(rect({ boxShadow: "0 2px 4px rgba(0,0,0,0.3)" }));
    const repair = res.repairs.find((r) => r.path.endsWith("/boxShadow"));
    expect(repair).toBeDefined();
    expect(repair!.message).toMatch(/boxShadow.*effects/i);
    // The shorthand key is honoured, so it must not also be reported as dropped.
    expect(res.repairs.some((r) => r.kind === "dropped-property")).toBe(false);
  });

  it("treats 'none' and absent values as no effects", () => {
    const none = normalizeDesignDocument(rect({ boxShadow: "none" }));
    expect((getActivePage(none.document).children[0] as any).effects).toBeUndefined();
    const absent = normalizeDesignDocument(rect({}));
    expect((getActivePage(absent.document).children[0] as any).effects).toBeUndefined();
  });
});

describe("CSS filter shorthand → filter object + effects", () => {
  it("merges colour adjustments into adjust and splits blur into a layer-blur effect", () => {
    const res = normalizeDesignDocument(rect({ filter: "brightness(1.2) contrast(0.9) blur(4px)" }));
    const el = getActivePage(res.document).children[0] as any;
    expect(el.adjust).toEqual({ brightness: 1.2, contrast: 0.9 });
    const blurEffect = el.effects?.find((e: any) => e.type === "layer-blur");
    // CSS's blur(4px) is a sigma; the DSL stores a radius.
    expect(blurEffect).toMatchObject({ type: "layer-blur", blur: 8, enabled: true });
  });

  it("routes drop-shadow() into effects as a drop-shadow", () => {
    const res = normalizeDesignDocument(
      rect({ filter: "drop-shadow(2px 3px 4px rgba(0,0,0,0.5))" })
    );
    const el = getActivePage(res.document).children[0] as any;
    const shadow = el.effects?.find((e: any) => e.type === "drop-shadow");
    expect(shadow).toMatchObject({
      type: "drop-shadow",
      color: "rgba(0,0,0,0.5)",
      offset: { x: 2, y: 3 },
      blur: 4
    });
  });

  it("records unsupported functions (e.g. sepia) as a repair and skips them", () => {
    const res = normalizeDesignDocument(rect({ filter: "sepia(0.5) blur(2px)" }));
    const el = getActivePage(res.document).children[0] as any;
    // sepia has no DSL spelling, so the structured filter object is empty.
    expect(el.adjust).toBeUndefined();
    const blurEffect = el.effects?.find((e: any) => e.type === "layer-blur");
    expect(blurEffect).toMatchObject({ blur: 4 });
    const repair = res.repairs.find((r) => r.path.endsWith("/adjust"));
    expect(repair).toBeDefined();
    expect(repair!.message).toMatch(/sepia/);
  });
});

describe("CSS background shorthand → fills stack", () => {
  it("splits layered backgrounds and reverses so the CSS top layer is last", () => {
    const res = normalizeDesignDocument(
      rect({ background: "linear-gradient(180deg, #222 0%, #111 100%), #181818" })
    );
    const el = getActivePage(res.document).children[0] as any;
    // backgroundLayers → [gradient, "#181818"]; reversed push →
    // [solid #181818 (bottom), gradient (top)].
    expect(el.fills).toHaveLength(2);
    expect(el.fills[0]).toMatchObject({ type: "solid", color: "#181818" });
    expect(el.fills[1].type).toBe("linear-gradient");
  });

  it("reports a multi-layer absorption repair", () => {
    const res = normalizeDesignDocument(
      rect({ background: "linear-gradient(180deg, #222 0%, #111 100%), #181818" })
    );
    const repair = res.repairs.find((r) => r.path.endsWith("/background"));
    expect(repair).toBeDefined();
    expect(repair!.message).toMatch(/background.*fills.*2 layers/i);
  });

  it("absorbs a single colour background as a one-layer solid fill", () => {
    const res = normalizeDesignDocument(rect({ background: "#334455" }));
    const el = getActivePage(res.document).children[0] as any;
    expect(el.fills).toEqual([{ type: "solid", color: "#334455" }]);
  });

  it("absorbs a structured paint object on a fallback alias", () => {
    const res = normalizeDesignDocument(rect({ background: { type: "solid", color: "#123456" } }));
    const el = getActivePage(res.document).children[0] as any;
    expect(el.fills).toEqual([{ type: "solid", color: "#123456" }]);
  });

  it("leaves an existing fills[] array untouched (no background override)", () => {
    const res = normalizeDesignDocument(
      rect({ fills: [{ type: "solid", color: "#ABCDEF" }], background: "#000000" })
    );
    const el = getActivePage(res.document).children[0] as any;
    expect(el.fills).toEqual([{ type: "solid", color: "#ABCDEF" }]);
  });
});
