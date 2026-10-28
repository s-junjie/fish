import { describe, expect, it } from "vitest";
import { cssBlurFilter, cssLineHeight } from "../src/core/css-encode";
import { parseFilterValue } from "../src/core/import/css-values";
import { resolveDynamicLineHeight } from "../src/core/compile";

const blurRadiusFromCss = (sigma: number): number => parseFilterValue(`blur(${sigma}px)`).blur ?? 0;

describe("css-encode", () => {
  // CSS's blur() argument is a Gaussian sigma; the DSL's is a radius. Rendering
  // the radius through unchanged paints every backdrop twice as strong as the
  // SVG path does with the same number.
  it("maps a DSL blur radius onto CSS blur() as sigma = radius / 2", () => {
    expect(cssBlurFilter(20)).toBe("blur(10px)");
    expect(cssBlurFilter(0)).toBe("blur(0px)");
    expect(cssBlurFilter(-8)).toBe("blur(0px)");
  });

  it("round-trips a CSS blur() through the DSL and back", () => {
    for (const sigma of [1, 4, 12, 40]) {
      expect(cssBlurFilter(blurRadiusFromCss(sigma))).toBe(`blur(${sigma}px)`);
    }
  });

  it("keeps ratio line heights unitless and absolute ones in px", () => {
    expect(cssLineHeight(14, 1.5)).toBe("1.5");
    expect(cssLineHeight(24, "24px")).toBe("24px");
  });

  // The canvas measures text with resolveDynamicLineHeight; a CSS line-height that
  // disagrees by even a fraction makes exported text wrap onto a different line.
  it("reproduces the engine's resolved px at every font-size tier", () => {
    for (const fontSize of [11, 14, 24, 36, 48, 72, 96]) {
      for (const lh of [undefined, 0.92, 1, 1.25, 1.5, 3.5, "20px", "40px"] as const) {
        const css = cssLineHeight(fontSize, lh);
        const rendered = css.endsWith("px") ? parseFloat(css) : parseFloat(css) * fontSize;
        expect(Math.abs(rendered - resolveDynamicLineHeight(fontSize, lh))).toBeLessThan(0.01);
      }
    }
  });
});
