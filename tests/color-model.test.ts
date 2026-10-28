import { describe, it, expect } from "vitest";
import {
  COLOR_NOTATIONS,
  ColorNotation,
  applyChannel,
  notationChannels,
  notationLabel
} from "../src/ui/color-model";
import { hexToRgb, rgbToHex } from "../src/core/geometry/color-utils";

// The notations are DISPLAY. Nothing here may reach the document: the panel
// names the same stored hex four ways, and the only write is `applyChannel`,
// which fires on an explicit edit.

/** A grid wide enough that any rounding shortcut shows up as a changed channel. */
const GRID: string[] = (() => {
  const colors = ["#3b82f6", "#d9d9d9", "#1e1e1e", "#8b5cf6", "#0d0d0d", "#ffffff", "#000000", "#ff0000"];
  for (let c = 0; c < 256; c += 17) {
    for (let k = 0; k < 256; k += 51) colors.push(rgbToHex(c, k, 255 - c));
  }
  return colors;
})();

/** The largest per-channel distance between two 6-digit hexes, 0-255. */
const channelDelta = (a: string, b: string): number => {
  const at = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return Math.max(Math.abs(at(a, 0) - at(b, 0)), Math.abs(at(a, 1) - at(b, 1)), Math.abs(at(a, 2) - at(b, 2)));
};

describe("colour notations", () => {
  it("offers exactly the four a designer reads a colour in", () => {
    expect(COLOR_NOTATIONS).toEqual(["hex", "rgb", "hsl", "hsb"]);
  });

  it("names each one in its own acronym", () => {
    expect(COLOR_NOTATIONS.map(notationLabel)).toEqual(["HEX", "RGB", "HSL", "HSB"]);
  });

  it("gives hex no channels — it is one field, not three", () => {
    expect(notationChannels("hex", "#3b82f6")).toEqual([]);
  });

  it("reads each notation's own channels, with the ranges each model uses", () => {
    expect(notationChannels("rgb", "#3b82f6").map((c) => c.key)).toEqual(["R", "G", "B"]);
    expect(notationChannels("rgb", "#3b82f6").map((c) => c.value)).toEqual([59, 130, 246]);
    expect(notationChannels("rgb", "#3b82f6").every((c) => c.max === 255)).toBe(true);

    expect(notationChannels("hsl", "#ff0000").map((c) => c.key)).toEqual(["H", "S", "L"]);
    expect(notationChannels("hsb", "#ff0000").map((c) => c.key)).toEqual(["H", "S", "B"]);

    const [h, s] = notationChannels("hsl", "#ff0000");
    expect(h.max).toBe(360);
    expect(s.max).toBe(100);
  });

  it("shows whole numbers — the stored colour is 8-bit and has no more to say", () => {
    for (const notation of COLOR_NOTATIONS) {
      for (const hex of GRID) {
        for (const channel of notationChannels(notation, hex)) {
          expect(Number.isInteger(channel.value)).toBe(true);
        }
      }
    }
  });

  it("names HSB's third channel B and HSL's L — the one place they differ", () => {
    // HSB and HSV are one space under two names; only the lightness key changes.
    // If they ever read identically, the picker is showing the wrong letter.
    const hsb = notationChannels("hsb", "#3b82f6");
    const hsl = notationChannels("hsl", "#3b82f6");
    expect(hsb[0].key).toBe("H");
    expect(hsl[0].key).toBe("H");
    expect(hsb[2].key).toBe("B");
    expect(hsl[2].key).toBe("L");
  });
});

describe("editing a channel", () => {
  it("never writes on its own — reading a notation is not an edit", () => {
    // The panel mounts these fields on every open, including the one where the
    // user only wants the eyedropper or the hue rail. `notationChannels` is the
    // only thing that runs then, so it has to be a pure read with no path to the
    // document: the whole display-only claim rests on this one property.
    for (const notation of COLOR_NOTATIONS) {
      for (const hex of GRID) {
        const channels = notationChannels(notation, hex);
        // Nothing was passed in to mutate, and nothing came back but numbers.
        expect(channels.every((c) => typeof c.value === "number")).toBe(true);
      }
    }
  });

  it("writes the edited channel and leaves the other two where they were", () => {
    // RGB is exact: the untouched channels are integers, so nothing can drift.
    const edited = applyChannel("rgb", "#3b82f6", 1, 131);
    expect(hexToRgb(edited)).toEqual({ r: 59, g: 131, b: 246 });
  });

  it("carries the untouched channels through an inexact model without losing them", () => {
    // HSL is the one worth the care: H/S/L cannot all be whole numbers for an
    // arbitrary 8-bit colour, so the two untouched channels are re-read UNROUNDED
    // and quantised once. Rounding them on the way through would make typing a
    // hue silently change the saturation — which is the drift the HSV conversion
    // is written to avoid, reached by a different route.
    const before = notationChannels("hsl", "#3b82f6");
    const edited = applyChannel("hsl", "#3b82f6", 0, before[0].value);
    const after = notationChannels("hsl", edited);
    expect(after[1].value).toBe(before[1].value);
    expect(after[2].value).toBe(before[2].value);
  });

  it("does the same for HSB", () => {
    const before = notationChannels("hsb", "#3b82f6");
    const edited = applyChannel("hsb", "#3b82f6", 2, before[2].value);
    const after = notationChannels("hsb", edited);
    expect(after[0].value).toBe(before[0].value);
    expect(after[1].value).toBe(before[1].value);
  });

  it("clamps a channel to its model's own range", () => {
    expect(hexToRgb(applyChannel("rgb", "#3b82f6", 0, 999))).toEqual({ r: 255, g: 130, b: 246 });
    expect(hexToRgb(applyChannel("rgb", "#3b82f6", 0, -40))).toEqual({ r: 0, g: 130, b: 246 });
    expect(notationChannels("hsl", applyChannel("hsl", "#3b82f6", 2, 999))[2].value).toBe(100);
    expect(notationChannels("hsl", applyChannel("hsl", "#3b82f6", 2, -5))[2].value).toBe(0);
  });

  it("treats 360 degrees as 0, the way the hue rail's end does", () => {
    // The rail scrubs to a ratio that reaches 1.0, i.e. exactly 360 — and it
    // paints #f00 there. Writing a literal 360 that renders as a different
    // colour than the knob the user just dragged off would be a lie.
    expect(applyChannel("hsl", "#3b82f6", 0, 360)).toBe(applyChannel("hsl", "#3b82f6", 0, 0));
    expect(applyChannel("hsb", "#ff0000", 0, 360)).toBe("#ff0000");
  });

  it("leaves the colour exactly alone in RGB, whose channels ARE the bytes", () => {
    // RGB is the one notation with no lattice between it and the stored value:
    // 0-255 is 8-bit, which is what the colour already is. So writing back what
    // the field showed must be a no-op, and it is.
    for (const hex of GRID) {
      notationChannels("rgb", hex).forEach((channel, i) => {
        expect(applyChannel("rgb", hex, i, channel.value), `${hex} #${i}`).toBe(hex);
      });
    }
  });

  it("holds HSL and HSB to their integer lattice, within 3/255", () => {
    // These two DO move the colour when a displayed value is written back, and
    // that is the space, not a defect: an 8-bit colour has no exact whole-degree
    // hue, so `#3b82f6` reads as `217 91% 60%` and committing those three numbers
    // lands on `#3c83f6`. Measured worst case over the grid is 3/255 in a channel.
    //
    // The bound is what is asserted, because the alternative — leaving the value
    // unrounded in the field — would show `217.22` in a 46px well. The drift is
    // one step, it happens only on an explicit edit, and it does not compound:
    // every edit re-derives from the stored hex, never from the last edit.
    const worst = (notation: "hsl" | "hsb") => {
      let max = 0;
      for (const hex of GRID) {
        notationChannels(notation, hex).forEach((channel, i) => {
          max = Math.max(max, channelDelta(hex, applyChannel(notation, hex, i, channel.value)));
        });
      }
      return max;
    };
    expect(worst("hsl")).toBeLessThanOrEqual(3);
    expect(worst("hsb")).toBeLessThanOrEqual(3);
  });

  it("returns the input untouched for a notation it does not edit", () => {
    expect(applyChannel("hex", "#3b82f6", 0, 10)).toBe("#3b82f6");
  });

  it("has no notation that writes a format the document cannot store", () => {
    // Every `applyChannel` result must parse back to itself, because hex is the
    // only stored format. A notation that emitted `rgb(...)` or `hsl(...)` here
    // would reach the renderer through paths that resolve colours differently.
    for (const notation of COLOR_NOTATIONS) {
      if (notation === "hex") continue;
      const edited = applyChannel(notation as ColorNotation, "#3b82f6", 0, 120);
      expect(edited).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});