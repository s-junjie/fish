import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_FAMILY,
  SUBSTITUTE_STACK,
  cssFamilyName,
  declaresFallback,
  firstNamedFamily,
  resolveStack,
  splitFontStack
} from "../src/core/font-stack";
import { normalizeTextStyle } from "../src/core/dsl/normalize/text-sizing";

describe("resolveStack", () => {
  it("completes a bare family with the documented substitute", () => {
    expect(resolveStack("Inter")).toBe("Inter, system-ui, sans-serif");
    expect(resolveStack("PingFang SC")).toBe("PingFang SC, system-ui, sans-serif");
  });

  it("is idempotent — resolving twice cannot double the fallback", () => {
    const once = resolveStack("Inter");
    expect(resolveStack(once)).toBe(once);
    expect(resolveStack(resolveStack(once))).toBe(once);
  });

  it("leaves a stack that names its own generic alone", () => {
    // Every document authored before the split stores one of these, and a second
    // fallback appended here would both change the paint and re-file the measure
    // cache under a key nothing renders.
    expect(resolveStack("Inter, sans-serif")).toBe("Inter, sans-serif");
    expect(resolveStack("Menlo, Monaco, monospace")).toBe("Menlo, Monaco, monospace");
    expect(resolveStack('"Helvetica Neue", Arial, sans-serif')).toBe("Helvetica Neue, Arial, sans-serif");
    expect(resolveStack("system-ui")).toBe("system-ui");
  });

  it("answers the substitute for a missing value", () => {
    expect(resolveStack(undefined)).toBe(SUBSTITUTE_STACK);
    expect(resolveStack("")).toBe(SUBSTITUTE_STACK);
    expect(resolveStack("  ,  ")).toBe(SUBSTITUTE_STACK);
  });

  it("quotes a family whose name is not a CSS identifier", () => {
    // What the picker stores: the name already spelled the way CSS needs it, so
    // unquoting it here would turn one family into three tokens.
    expect(resolveStack(cssFamilyName('Heavy "Impact" Cut'))).toBe(
      '"Heavy \\"Impact\\" Cut", system-ui, sans-serif'
    );
    expect(resolveStack("思源黑体")).toBe('"思源黑体", system-ui, sans-serif');
  });

  it("splits on commas outside quotes only", () => {
    expect(splitFontStack('"Heavy, Impact", serif')).toEqual(["Heavy, Impact", "serif"]);
    expect(splitFontStack("var(--brand), Inter")).toEqual(["Inter"]);
    expect(cssFamilyName("Times New Roman")).toBe("Times New Roman");
  });
});

describe("declaresFallback", () => {
  it("separates a stack the author wrote from a name the menu wrote", () => {
    // The whole reason the menu stopped storing a fallback: a stack that carries
    // one is exempt from detection, so every family picked from it was invisible.
    expect(declaresFallback("Inter, sans-serif")).toBe(true);
    expect(declaresFallback("Menlo, monospace")).toBe(true);
    expect(declaresFallback("Inter")).toBe(false);
    expect(declaresFallback("")).toBe(false);
  });
});

describe("firstNamedFamily", () => {
  it("skips generic keywords, which name no face to report on", () => {
    expect(firstNamedFamily("Inter, sans-serif")).toBe("Inter");
    expect(firstNamedFamily("system-ui, -apple-system, sans-serif")).toBe("");
    expect(firstNamedFamily("")).toBe("");
  });
});

describe("the default family", () => {
  const style = (raw: Record<string, unknown>) =>
    normalizeTextStyle(raw, {}, "/0/style").fontFamily;

  it("is a generic, so a new text layer can never open as `missing`", () => {
    expect(DEFAULT_FONT_FAMILY).toBe("system-ui");
    expect(style({ fontSize: 16 })).toBe(DEFAULT_FONT_FAMILY);
    expect(style({ fontSize: 16, fontFamily: "" })).toBe(DEFAULT_FONT_FAMILY);
  });

  it("keeps whatever an existing document stored", () => {
    expect(style({ fontFamily: "Inter, sans-serif" })).toBe("Inter, sans-serif");
    expect(style({ fontFamily: "Inter" })).toBe("Inter");
  });
});
