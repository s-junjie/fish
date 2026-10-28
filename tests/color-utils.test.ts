import { describe, it, expect } from "vitest";
import {
  parseColorAlpha,
  composeColorAlpha,
  isValidHex,
  parseFloodColor,
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  hexToHsv,
  hsvToHex,
  rgbToHsl,
  hslToRgb,
  hexToHsl,
  hslToHex,
  toCssRgba
} from "../src/core/geometry/color-utils";

describe("Color & Alpha Utilities", () => {
  it("parses 6-digit hex color correctly", () => {
    const res = parseColorAlpha("#3b82f6");
    expect(res.hex6).toBe("#3b82f6");
    expect(res.alphaPct).toBe(100);
  });

  it("parses bare 6-digit hex color correctly without hash", () => {
    const res = parseColorAlpha("3b82f6");
    expect(res.hex6).toBe("#3b82f6");
    expect(res.alphaPct).toBe(100);
  });

  it("parses 3-digit and 4-digit hex color correctly", () => {
    const res3 = parseColorAlpha("#f00");
    expect(res3.hex6).toBe("#ff0000");
    expect(res3.alphaPct).toBe(100);

    const res4 = parseColorAlpha("#f008");
    expect(res4.hex6).toBe("#ff0000");
    expect(res4.alphaPct).toBe(53);
  });

  it("validates hex strings correctly with isValidHex", () => {
    expect(isValidHex("#3b82f6")).toBe(true);
    expect(isValidHex("3b82f6")).toBe(true);
    expect(isValidHex("#fff")).toBe(true);
    expect(isValidHex("fff")).toBe(true);
    expect(isValidHex("#ffff")).toBe(true);
    expect(isValidHex("#3b82f680")).toBe(true);
    expect(isValidHex("3b82f680")).toBe(true);
    expect(isValidHex("invalid")).toBe(false);
    expect(isValidHex("#12345")).toBe(false);
    expect(isValidHex("")).toBe(false);
    expect(isValidHex(undefined)).toBe(false);
  });

  it("parses 8-digit hex color with alpha correctly", () => {
    // 80 hex is 128 / 255 ≈ 50%
    const res = parseColorAlpha("#3b82f680");
    expect(res.hex6).toBe("#3b82f6");
    expect(res.alphaPct).toBe(50);
  });

  it("parses rgba colors correctly", () => {
    const res = parseColorAlpha("rgba(255, 0, 0, 0.5)");
    expect(res.hex6).toBe("#ff0000");
    expect(res.alphaPct).toBe(50);
  });

  it("composes hex8 when alpha is below 100", () => {
    const comp = composeColorAlpha("#3b82f6", 50);
    expect(comp).toBe("#3b82f680");
  });

  it("composes hex6 when alpha is 100", () => {
    const comp = composeColorAlpha("#3b82f6", 100);
    expect(comp).toBe("#3b82f6");
  });

  it("parses flood color and flood opacity for SVG filters", () => {
    const flood = parseFloodColor("#ff000080");
    expect(flood.floodColor).toBe("#ff0000");
    expect(flood.floodOpacity).toBe(0.5);
  });
});

// Tailwind v4's palette is oklch and Chrome serializes those computed values as
// themselves, so these spellings arrive through the importer and an author may
// write one directly. Reading them as `#000000` was a WRONG answer rather than a
// missing one: the canvas painted the real colour while every readout, swatch,
// picker and contrast check saw black.
describe("Color 4 function spellings", () => {
  it("resolves oklch to the hex the browser rasterizes", () => {
    // Cross-checked against a Chrome raster of the same string: 233,155,42.
    expect(parseColorAlpha("oklch(0.75 0.15 70)")).toEqual({ hex6: "#e99b2a", alphaPct: 100 });
  });

  it("reads the same colour through either polar or rectangular oklab", () => {
    expect(parseColorAlpha("oklab(0.75 0.0513 0.1411)").hex6).toBe("#e99b2a");
  });

  it("carries the alpha of a slash form", () => {
    expect(parseColorAlpha("oklch(0.75 0.15 70 / 0.5)").alphaPct).toBe(50);
  });

  it("carries the alpha of the legacy comma form", () => {
    // The fourth comma argument is the alpha; a slash-only split dropped it and
    // made every translucent `hsla()` opaque.
    expect(parseColorAlpha("hsla(210, 100%, 50%, 0.25)")).toEqual({ hex6: "#0080ff", alphaPct: 25 });
  });

  it("resolves the other spaces it names", () => {
    expect(parseColorAlpha("hsl(210, 100%, 50%)").hex6).toBe("#0080ff");
    expect(parseColorAlpha("lab(70% 30 40)").hex6).toBe("#eb9564");
    expect(parseColorAlpha("lch(70% 50 30)").hex6).toBe("#fb8980");
    expect(parseColorAlpha("color(srgb 0.1 0.2 0.3)").hex6).toBe("#1a334d");
  });

  it("clips an out-of-gamut colour rather than mapping it", () => {
    // `oklch(0.6 0.3 30)` is past sRGB red; Chrome's raster of it is 255,0,0,
    // which is the number this must agree with — an author who asked for the
    // reddest red gets the reddest red.
    expect(parseColorAlpha("oklch(0.6 0.3 30)").hex6).toBe("#ff0000");
    expect(parseColorAlpha("color(display-p3 1 0 0)").hex6).toBe("#ff0000");
  });

  it("leaves the spellings it cannot read as the neutral fallback", () => {
    // `color-mix()` has no single colour to fold and named colours are a table
    // the engine does not carry. These stay gaps the importer reports, not
    // guesses — pinning them here is what stops one being read as "supported".
    expect(parseColorAlpha("color-mix(in oklch, red, blue)").hex6).toBe("#000000");
    expect(parseColorAlpha("rebeccapurple").hex6).toBe("#000000");
  });

  it("reads rgb()'s Color 4 syntax, which its comma-only regex never saw", () => {
    // Space-separated channels, `%` channels and a slash alpha reached this
    // reader as black with their alpha dropped — while `hsl(120 50% 50%)`, the
    // same syntax in another function, was already read. One reader disagreeing
    // with itself, not a declared gap.
    expect(parseColorAlpha("rgb(255 255 255)")).toEqual({ hex6: "#ffffff", alphaPct: 100 });
    expect(parseColorAlpha("rgb(255 255 255 / 0.5)")).toEqual({ hex6: "#ffffff", alphaPct: 50 });
    expect(parseColorAlpha("rgb(100% 0% 0%)")).toEqual({ hex6: "#ff0000", alphaPct: 100 });
  });

  it("reads `transparent` as the colour it is, not as opaque black", () => {
    // The engine's OWN spelling for "no fill" (`normalize/element.ts`). Read as
    // opaque black it put a black swatch on every no-fill layer, seeded the picker
    // black, and reported transparent ink as a contrast failure — while
    // `#00000000`, the same colour, read correctly.
    expect(parseColorAlpha("transparent")).toEqual({ hex6: "#000000", alphaPct: 0 });
    expect(parseColorAlpha("transparent")).toEqual(parseColorAlpha("#00000000"));
  });

  it("does not change the formats it already read", () => {
    expect(parseColorAlpha("#3b82f6")).toEqual({ hex6: "#3b82f6", alphaPct: 100 });
    expect(parseColorAlpha("rgba(255, 0, 0, 0.5)")).toEqual({ hex6: "#ff0000", alphaPct: 50 });
  });
});

describe("RGB / HSV conversions", () => {
  it("splits a hex string into channels", () => {
    expect(hexToRgb("#3b82f6")).toEqual({ r: 59, g: 130, b: 246 });
    expect(hexToRgb("#3b82f680")).toEqual({ r: 59, g: 130, b: 246 });
    expect(hexToRgb("rgba(255, 0, 0, 0.5)")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("clamps and pads channels when composing hex", () => {
    expect(rgbToHex(59, 130, 246)).toBe("#3b82f6");
    expect(rgbToHex(-10, 300, 8)).toBe("#00ff08");
  });

  it("maps primaries to the expected hue", () => {
    expect(hexToHsv("#ff0000").h).toBeCloseTo(0, 6);
    expect(hexToHsv("#00ff00").h).toBeCloseTo(120, 6);
    expect(hexToHsv("#0000ff").h).toBeCloseTo(240, 6);
    expect(hexToHsv("#ffffff").s).toBeCloseTo(0, 6);
    expect(hexToHsv("#ffffff").v).toBeCloseTo(100, 6);
    expect(hexToHsv("#000000").v).toBeCloseTo(0, 6);
  });

  it("round-trips every channel step without drift", () => {
    // The picker re-derives HSV from the stored hex on every render, so any
    // rounding inside the conversion would walk the colour away from the value
    // the user picked. Exhaustive over a coarse grid, plus the full red ramp.
    const colors: string[] = ["#3b82f6", "#d9d9d9", "#1e1e1e", "#8b5cf6", "#0d0d0d", "#ffffff"];
    for (let c = 0; c < 256; c += 17) {
      for (let k = 0; k < 256; k += 51) {
        colors.push(rgbToHex(c, k, 255 - c));
      }
    }
    for (let r = 0; r < 256; r++) colors.push(rgbToHex(r, 130, 246));

    for (const hex of colors) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("round-trips HSV values back through rgb", () => {
    // Tolerance is 1 percentage point: rgb channels are 8-bit, so the way back
    // is quantised even though the conversions themselves are not.
    for (let h = 0; h < 360; h += 15) {
      const hsv = { h, s: 73.5, v: 41.25 };
      const back = rgbToHsv(hsvToRgb(hsv));
      expect(back.h).toBeCloseTo(h, 0);
      expect(back.s).toBeCloseTo(hsv.s, 0);
      expect(back.v).toBeCloseTo(hsv.v, 0);
    }
  });

  it("emits a css rgba string from any stored color format", () => {
    expect(toCssRgba("#3b82f6")).toBe("rgba(59, 130, 246, 1)");
    expect(toCssRgba("#3b82f680")).toBe("rgba(59, 130, 246, 0.5)");
    expect(toCssRgba("#3b82f6", 0)).toBe("rgba(59, 130, 246, 0)");
    expect(toCssRgba("#3b82f6", 5)).toBe("rgba(59, 130, 246, 1)");
  });
});

describe("RGB / HSL conversions", () => {
  it("maps primaries to the expected hue", () => {
    expect(hexToHsl("#ff0000").h).toBeCloseTo(0, 6);
    expect(hexToHsl("#00ff00").h).toBeCloseTo(120, 6);
    expect(hexToHsl("#0000ff").h).toBeCloseTo(240, 6);
    // A grey has no hue, so S must be 0 rather than NaN — the picker reads all
    // three channels to fill its fields, and a NaN in a ScrubInput is a dead
    // field that cannot be dragged or typed into.
    expect(hexToHsl("#ffffff").s).toBe(0);
    expect(hexToHsl("#ffffff").l).toBeCloseTo(100, 6);
    expect(hexToHsl("#000000").s).toBe(0);
    expect(hexToHsl("#000000").l).toBeCloseTo(0, 6);
  });

  it("round-trips every channel step without drift", () => {
    // Same invariant as the HSV suite above, and for the same reason: the panel
    // derives the displayed channels from the stored hex on every render, so a
    // rounding inside the conversion walks the colour away from the value the
    // user picked — here by up to a step per field, per keystroke.
    const colors: string[] = ["#3b82f6", "#d9d9d9", "#1e1e1e", "#8b5cf6", "#0d0d0d", "#ffffff"];
    for (let c = 0; c < 256; c += 17) {
      for (let k = 0; k < 256; k += 51) {
        colors.push(rgbToHex(c, k, 255 - c));
      }
    }
    for (let r = 0; r < 256; r++) colors.push(rgbToHex(r, 130, 246));

    for (const hex of colors) {
      expect(hslToHex(hexToHsl(hex))).toBe(hex);
    }
  });

  it("round-trips HSL values back through rgb", () => {
    // 8-bit channels quantise the way back even though the conversions do not.
    for (let h = 0; h < 360; h += 15) {
      const hsl = { h, s: 73.5, l: 41.25 };
      const back = rgbToHsl(hslToRgb(hsl));
      expect(back.h).toBeCloseTo(h, 0);
      expect(back.s).toBeCloseTo(hsl.s, 0);
      expect(back.l).toBeCloseTo(hsl.l, 0);
    }
  });

  it("clamps out-of-range channels instead of wrapping them", () => {
    expect(hslToHex({ h: 400, s: 50, l: 50 })).toBe(hslToHex({ h: 40, s: 50, l: 50 }));
    expect(hslToHex({ h: 200, s: 150, l: 50 })).toBe(hslToHex({ h: 200, s: 100, l: 50 }));
    expect(hslToHex({ h: 200, s: 50, l: -10 })).toBe("#000000");
  });
});
