import { describe, expect, it } from "vitest";
import type { Paint } from "../src/core/dsl/types";
import { borderWidthsOf, textStyleOf, visualStyleOf } from "../src/core/import/html-style";
import { horizontalAlignOf, inlineMergeable } from "../src/core/import/html-text";
import { parseObjectPosition } from "../src/core/import/css-values";

/**
 * `borderWidthsOf` reads a `CSSStyleDeclaration`, but every value it wants is a
 * plain string, so a stub with the camelCase fields the DOM exposes is enough —
 * `sideValue` falls back to them when `getPropertyValue` has nothing.
 */
function style(fields: Record<string, string>): CSSStyleDeclaration {
  return { getPropertyValue: () => "", ...fields } as unknown as CSSStyleDeclaration;
}

const side = (width: number, style_: string, color: string, which: string) => ({
  [`border${which}Width`]: `${width}px`,
  [`border${which}Style`]: style_,
  [`border${which}Color`]: color
});

const all = (width: number, style_: string, color: string) => ({
  ...side(width, style_, color, "Top"),
  ...side(width, style_, color, "Right"),
  ...side(width, style_, color, "Bottom"),
  ...side(width, style_, color, "Left")
});

describe("borderWidthsOf", () => {
  it("calls a border on all four sides uniform", () => {
    const b = borderWidthsOf(style(all(1, "solid", "rgb(36, 36, 40)")));
    expect(b.uniform).toBe(true);
    expect([b.top, b.right, b.bottom, b.left]).toEqual([1, 1, 1, 1]);
    expect(b.color).toBe("#242428");
  });

  /**
   * One drawn side agrees with itself, which is how `border-bottom: 1px solid
   * var(--acc)` came back uniform and was written as a full outline — a tab's
   * underline arrived as a box around the tab. Uniform is all four sides.
   */
  it("does not call a one-sided border uniform", () => {
    const b = borderWidthsOf(style({ ...all(0, "none", "rgb(242, 242, 242)"), ...side(1, "solid", "rgb(217, 180, 65)", "Bottom") }));
    expect(b.uniform).toBe(false);
    expect([b.top, b.right, b.bottom, b.left]).toEqual([0, 0, 1, 0]);
    expect(b.color).toBe("#D9B441");
  });

  it("does not call an uneven four-sided border uniform", () => {
    const b = borderWidthsOf(style({ ...all(1, "solid", "rgb(36, 36, 40)"), ...side(2, "solid", "rgb(36, 36, 40)", "Left") }));
    expect(b.uniform).toBe(false);
    expect([b.top, b.right, b.bottom, b.left]).toEqual([1, 1, 1, 2]);
  });

  it("ignores a side that carries a width but no border-style", () => {
    const b = borderWidthsOf(style({ ...all(1, "solid", "rgb(36, 36, 40)"), ...side(3, "none", "rgb(217, 180, 65)", "Right") }));
    expect(b.right).toBe(0);
    // Three drawn sides are not a uniform border, and must not be written as one:
    // a full outline would put a stroke where the page has none.
    expect(b.uniform).toBe(false);
  });
});

describe("visualStyleOf background-clip: text", () => {
  const gradient = "linear-gradient(180deg, rgb(255, 255, 255), rgb(207, 211, 220))";

  /**
   * The layers are the GLYPHS' ink. Left on the box they paint the whole
   * rectangle, which is how a gradient headline imported as a blank slab with
   * the words underneath it.
   */
  it("hands the layers to the text and leaves the box unpainted", () => {
    const vs = visualStyleOf(
      style({ backgroundImage: gradient, backgroundColor: "rgba(0, 0, 0, 0)", backgroundClip: "text", boxShadow: "none" }),
      { width: 400, height: 60 },
      () => {}
    );
    expect(vs.fills).toBeUndefined();
    expect(vs.textFills).toHaveLength(1);
    expect(vs.textFills?.[0].type).toBe("linear-gradient");
  });

  it("still paints the box when the background is not clipped to the text", () => {
    const vs = visualStyleOf(
      style({ backgroundImage: gradient, backgroundColor: "rgba(0, 0, 0, 0)", backgroundClip: "border-box", boxShadow: "none" }),
      { width: 400, height: 60 },
      () => {}
    );
    expect(vs.fills).toHaveLength(1);
    expect(vs.textFills).toBeUndefined();
  });
});

describe("visualStyleOf box-shadow spread", () => {
  it("carries spread through onto drop-shadow and inner-shadow", () => {
    const cs = style({
      boxShadow: "0px 4px 12px 2px rgba(0, 0, 0, 0.2), inset 0px 2px 4px 1px rgba(0, 0, 0, 0.5)",
      backgroundImage: "none",
      backgroundColor: "rgb(255, 255, 255)"
    });
    const vs = visualStyleOf(cs, { width: 100, height: 100 }, () => {});
    expect(vs.effects).toHaveLength(2);
    expect(vs.effects?.[0]).toMatchObject({
      type: "drop-shadow",
      offset: { x: 0, y: 4 },
      blur: 12,
      spread: 2
    });
    expect(vs.effects?.[1]).toMatchObject({
      type: "inner-shadow",
      offset: { x: 0, y: 2 },
      blur: 4,
      spread: 1
    });
  });
});

/** Every property `textStyleOf` reads that the stub does not name answers `""`. */
function computed(fields: Record<string, string>): CSSStyleDeclaration {
  const base: Record<string, unknown> = {
    getPropertyValue: () => "",
    textDecorationLine: "",
    textAlign: "left",
    direction: "ltr",
    ...fields
  };
  return new Proxy(base, {
    get: (target, key) => (typeof key === "string" && key in target ? target[key] : "")
  }) as unknown as CSSStyleDeclaration;
}

describe("textStyleOf paint", () => {
  /**
   * A text's fill stack is what the canvas and the export both read, so the
   * colour's alpha belongs on it. Dropped, every `rgba(255,255,255,.55)` label
   * imported at full strength — the muted half of a dark poster went white.
   */
  it("keeps the colour's alpha on the stack", () => {
    const result = textStyleOf(computed({ color: "rgba(255, 255, 255, 0.55)", fontSize: "15px" }), () => {});
    expect(result.fills).toEqual([{ type: "solid", color: "#FFFFFF", opacity: 0.55 }]);
  });

  it("reports no gap for a colour it carried exactly", () => {
    const gaps: string[] = [];
    textStyleOf(computed({ color: "rgba(255, 255, 255, 0.55)", fontSize: "15px" }), (p) => gaps.push(p));
    expect(gaps).not.toContain("color-opacity");
  });

  it("prefers the clipped background over the (transparent) colour", () => {
    const fills: Paint[] = [
      {
        type: "linear-gradient",
        from: "#FFFFFF",
        to: "#FF7A5C",
        angle: 180,
        stops: [
          { offset: 0, color: "#FFFFFF" },
          { offset: 1, color: "#FF7A5C" }
        ]
      }
    ];
    const result = textStyleOf(computed({ color: "rgba(0, 0, 0, 0)", fontSize: "132px" }), () => {}, fills);
    expect(result.fills).toEqual(fills);
  });
});

describe("parseObjectPosition", () => {
  it("reads percentages, keywords and the one-value form", () => {
    expect(parseObjectPosition("50% 62%")).toEqual({ x: 0.5, y: 0.62 });
    expect(parseObjectPosition("0% 100%")).toEqual({ x: 0, y: 1 });
    expect(parseObjectPosition("center")).toEqual({ x: 0.5, y: 0.5 });
    expect(parseObjectPosition("top right")).toEqual({ x: 1, y: 0 });
  });

  it("declines a length it cannot resolve without the overflow", () => {
    expect(parseObjectPosition("12px 4px")).toBeUndefined();
  });
});

describe("textStyleOf horizontal alignment", () => {
  it("infers center alignment from row flex justify-content: center", () => {
    const result = textStyleOf(computed({ display: "flex", flexDirection: "row", justifyContent: "center" }), () => {});
    expect(result.style.align).toBe("center");
  });

  it("infers center alignment from column flex align-items: center", () => {
    const result = textStyleOf(computed({ display: "flex", flexDirection: "column", alignItems: "center" }), () => {});
    expect(result.style.align).toBe("center");
  });

  it("infers right alignment from row flex justify-content: flex-end", () => {
    const result = textStyleOf(computed({ display: "flex", flexDirection: "row", justifyContent: "flex-end" }), () => {});
    expect(result.style.align).toBe("right");
  });

  it("infers center alignment from grid justify-items: center", () => {
    const result = textStyleOf(computed({ display: "grid", justifyItems: "center" }), () => {});
    expect(result.style.align).toBe("center");
  });

  it("respects explicit text-align over flex alignment", () => {
    const result = textStyleOf(computed({ display: "flex", justifyContent: "center", textAlign: "right" }), () => {});
    expect(result.style.align).toBe("right");
  });
});

describe("horizontalAlignOf", () => {
  it("detects centered ink within content box", () => {
    const content = { x: 0, y: 0, width: 72, height: 22 };
    const ink = { x: 16, y: 5, width: 40, height: 12 };
    expect(horizontalAlignOf(ink, content, "left")).toBe("center");
  });

  it("detects right-aligned ink within content box", () => {
    const content = { x: 0, y: 0, width: 72, height: 22 };
    const ink = { x: 32, y: 5, width: 40, height: 12 };
    expect(horizontalAlignOf(ink, content, "left")).toBe("right");
  });

  it("preserves fallback when content box tightly fits ink", () => {
    const content = { x: 0, y: 0, width: 42, height: 22 };
    const ink = { x: 1, y: 5, width: 40, height: 12 };
    expect(horizontalAlignOf(ink, content, "left")).toBe("left");
  });
});

describe("inlineMergeable", () => {
  it("rejects replaced elements such as img, svg, input, button even when display is inline", () => {
    const defaultCs = computed({ display: "inline" });
    const img = { tagName: "IMG" } as unknown as Element;
    const svg = { tagName: "SVG" } as unknown as Element;
    const input = { tagName: "INPUT" } as unknown as Element;
    const button = { tagName: "BUTTON" } as unknown as Element;
    expect(inlineMergeable(img, defaultCs)).toBe(false);
    expect(inlineMergeable(svg, defaultCs)).toBe(false);
    expect(inlineMergeable(input, defaultCs)).toBe(false);
    expect(inlineMergeable(button, defaultCs)).toBe(false);
  });

  it("permits standard inline text wrappers like span", () => {
    const defaultCs = computed({ display: "inline" });
    const span = { tagName: "SPAN" } as unknown as Element;
    expect(inlineMergeable(span, defaultCs)).toBe(true);
  });
});

describe("visualStyleOf rotation", () => {
  it("maps rotation from matrix even with non-centered transform-origin (e.g. 0px 0px)", () => {
    const unmapped: string[] = [];
    const cs = computed({
      transform: "matrix(0, -1, 1, 0, 0, 0)",
      transformOrigin: "0px 0px"
    });
    const vs = visualStyleOf(cs, { width: 100, height: 20 }, (prop) => {
      unmapped.push(prop);
    });
    expect(vs.rotation).toBe(-90);
    expect(unmapped).not.toContain("transform");
  });
});

