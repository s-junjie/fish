import { describe, expect, it } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import {
  ADJUST_AXES,
  ADJUST_KEYS,
  COLOR_FILTER_PRESETS,
  TONE_SAMPLES,
  colorFilterPrimitives,
  isNeutralColorFilter,
  matchPreset,
  presetFilter,
  sliderNeutral,
  sliderToValue,
  toneCurveTable,
  valueToSlider,
  withAdjustValue
} from "../src/core/dsl/color-filter";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { DesignDocument, ColorFilter } from "../src/core/dsl/types";

const axis = (key: string) => ADJUST_AXES.find((a) => a.key === key)!;

describe("adjust axis units", () => {
  it("keeps exposure and brightness adjacent, because they are one gain", () => {
    // Which axes exist at all is graded against the schema, `dsl.md` and the
    // label table in `tests/version-consistency.test.ts`; what is asserted here is
    // the ORDER, which only the panel can be wrong about. The renderer folds the
    // two into a single linear gain (`2^exposure * brightness`), so a reader who
    // multiplies the two adjacent sliders is reading the gain the filter chain
    // applies.
    expect(ADJUST_KEYS.indexOf("brightness")).toBe(ADJUST_KEYS.indexOf("exposure") + 1);
  });

  it("gives every ColorFilter field a way in", () => {
    // A field that renders and has no way in is the same defect as a field that
    // does not render: the document accepts a value that only ever arrives from
    // outside the app.
    const slidable = new Set<string>(ADJUST_KEYS);
    // One representative value per declared field, so a field added to
    // `ColorFilter` without a decision here fails instead of going quietly
    // unreachable.
    const declared: Record<keyof ColorFilter, number> = {
      exposure: 0.2,
      brightness: 1.1,
      contrast: 1.1,
      saturation: 1.2,
      hueRotate: 40,
      grayscale: 0.4,
      invert: 0.3,
      temperature: 0.2,
      tint: 0.2,
      highlights: 0.2,
      shadows: 0.2
    };
    for (const key of Object.keys(declared)) {
      expect(slidable.has(key), `${key} renders but has no slider`).toBe(true);
    }
  });

  it("maps the slider range onto each axis's own units", () => {
    expect(sliderToValue(axis("exposure"), 100)).toBe(2);
    expect(sliderToValue(axis("exposure"), -100)).toBe(-2);
    expect(sliderToValue(axis("exposure"), 0)).toBe(0);
    expect(sliderToValue(axis("contrast"), 100)).toBe(2);
    expect(sliderToValue(axis("contrast"), -100)).toBe(0);
    expect(sliderToValue(axis("contrast"), 0)).toBe(1);
    expect(sliderToValue(axis("temperature"), 100)).toBe(1);
    expect(sliderToValue(axis("temperature"), -100)).toBe(-1);
  });

  it("round-trips every axis through the slider mapping", () => {
    for (const a of ADJUST_AXES) {
      for (let slider = -100; slider <= 100; slider += 5) {
        expect(valueToSlider(a, sliderToValue(a, slider)), `${a.key} @ ${slider}`).toBe(slider);
      }
    }
  });

  it("parks a one-way axis at the far left and spends the whole track on it", () => {
    // `invert` and `grayscale` have no negative half. A neutral knob sitting in
    // the middle left half the track inert — the renderer clamps every value
    // below neutral straight back to neutral, so dragging there did nothing.
    for (const key of ["invert", "grayscale"] as const) {
      expect(sliderNeutral(axis(key)), key).toBe(-100);
      expect(valueToSlider(axis(key), 0), key).toBe(-100);
      expect(valueToSlider(axis(key), 1), key).toBe(100);
      expect(valueToSlider(axis(key), 0.5), key).toBe(0);
      expect(sliderToValue(axis(key), -100), key).toBe(0);
      expect(sliderToValue(axis(key), -50), key).toBe(0.25);
      expect(sliderToValue(axis(key), 0), key).toBe(0.5);
      expect(sliderToValue(axis(key), 100), key).toBe(1);
    }
    // The two-way axes are untouched: their knob still starts where it did.
    expect(sliderNeutral(axis("exposure"))).toBe(0);
    expect(sliderNeutral(axis("contrast"))).toBe(0);
    expect(valueToSlider(axis("contrast"), 1)).toBe(0);
    expect(sliderToValue(axis("exposure"), -30)).toBe(-0.6);
  });

  it("clamps a slider position that arrives out of range", () => {
    expect(sliderToValue(axis("exposure"), 500)).toBe(2);
    expect(sliderToValue(axis("exposure"), -500)).toBe(-2);
  });

  it("keeps slider maths free of float noise", () => {
    expect(sliderToValue(axis("exposure"), 30)).toBe(0.6);
    expect(sliderToValue(axis("contrast"), 70)).toBe(1.7);
  });
});

describe("neutral detection and axis writes", () => {
  it("treats a missing or empty filter as neutral", () => {
    expect(isNeutralColorFilter(undefined)).toBe(true);
    expect(isNeutralColorFilter({})).toBe(true);
  });

  it("treats each axis's own neutral value as neutral", () => {
    expect(isNeutralColorFilter({ exposure: 0, temperature: 0, highlights: 0, shadows: 0 })).toBe(true);
    expect(isNeutralColorFilter({ contrast: 1, saturation: 1, brightness: 1 })).toBe(true);
  });

  it("does not call a real adjustment neutral", () => {
    expect(isNeutralColorFilter({ exposure: 0.5 })).toBe(false);
    expect(isNeutralColorFilter({ contrast: 0.9 })).toBe(false);
    expect(isNeutralColorFilter({ grayscale: 1 })).toBe(false);
    expect(isNeutralColorFilter({ hueRotate: 90 })).toBe(false);
    expect(isNeutralColorFilter({ invert: 1 })).toBe(false);
  });

  it("drops a key once the slider returns to neutral", () => {
    const warm = withAdjustValue(undefined, "temperature", 50);
    expect(warm).toEqual({ temperature: 0.5 });
    expect(withAdjustValue(warm, "temperature", 0)).toBeUndefined();
  });

  it("drops the whole filter when the last adjusted axis is reset", () => {
    const two = withAdjustValue(withAdjustValue(undefined, "exposure", 40), "shadows", -60);
    expect(two).toEqual({ exposure: 0.8, shadows: -0.6 });
    expect(withAdjustValue(two, "exposure", 0)).toEqual({ shadows: -0.6 });
    expect(withAdjustValue(withAdjustValue(two, "exposure", 0), "shadows", 0)).toBeUndefined();
  });

  it("never mutates the filter it was handed", () => {
    const before = { exposure: 1 };
    withAdjustValue(before, "tint", 30);
    expect(before).toEqual({ exposure: 1 });
  });
});

describe("colour filter chain", () => {
  it("emits nothing for a neutral filter", () => {
    expect(colorFilterPrimitives(undefined)).toEqual([]);
    expect(colorFilterPrimitives({})).toEqual([]);
    expect(colorFilterPrimitives({ contrast: 1, saturation: 1, exposure: 0 })).toEqual([]);
  });

  it("folds exposure into a gain of 2^stops", () => {
    expect(colorFilterPrimitives({ exposure: 1 })).toEqual([
      { kind: "linear-transfer", slope: 2, intercept: 0 }
    ]);
    expect(colorFilterPrimitives({ exposure: -1 })).toEqual([
      { kind: "linear-transfer", slope: 0.5, intercept: 0 }
    ]);
  });

  it("pivots contrast around mid grey", () => {
    expect(colorFilterPrimitives({ contrast: 2 })).toEqual([
      { kind: "linear-transfer", slope: 2, intercept: -0.5 }
    ]);
  });

  it("mirrors the channel for a full invert", () => {
    expect(colorFilterPrimitives({ invert: 1 })).toEqual([
      { kind: "linear-transfer", slope: -1, intercept: 1 }
    ]);
  });

  it("composes exposure, contrast and invert into one transfer", () => {
    const [first, ...rest] = colorFilterPrimitives({ exposure: 1, contrast: 2, invert: 1 });
    expect(rest).toEqual([]);
    expect(first.kind).toBe("linear-transfer");
    if (first.kind !== "linear-transfer") throw new Error("unreachable");
    // gain = 2 * 2 = 4, folded by the mirror; contrast's pivot also flips.
    expect(first.slope).toBe(-4);
    expect(first.intercept).toBe(1.5);
  });

  it("warms with more red and less blue, and keeps alpha at identity", () => {
    const [m] = colorFilterPrimitives({ temperature: 1 });
    expect(m.kind).toBe("channel-matrix");
    if (m.kind !== "channel-matrix") throw new Error("unreachable");
    expect(m.values.slice(0, 3)).toEqual([1.3, 0, 0]);
    expect(m.values.slice(5, 8)).toEqual([0, 1, 0]);
    expect(m.values.slice(10, 13)).toEqual([0, 0, 0.7]);
    expect(m.values.slice(15)).toEqual([0, 0, 0, 1, 0]);
  });

  it("greens with more green and less red/blue", () => {
    const [m] = colorFilterPrimitives({ tint: 1 });
    if (m.kind !== "channel-matrix") throw new Error("unreachable");
    expect(m.values[0]).toBeCloseTo(0.85, 6);
    expect(m.values[6]).toBeCloseTo(1.3, 6);
    expect(m.values[12]).toBeCloseTo(0.85, 6);
  });

  it("expresses grayscale as a desaturation", () => {
    expect(colorFilterPrimitives({ grayscale: 1 })).toEqual([{ kind: "saturate", value: 0 }]);
    expect(colorFilterPrimitives({ grayscale: 0.5 })).toEqual([{ kind: "saturate", value: 0.5 }]);
  });

  it("combines saturation and grayscale into one matrix", () => {
    expect(colorFilterPrimitives({ saturation: 2, grayscale: 0.25 })).toEqual([
      { kind: "saturate", value: 1.5 }
    ]);
  });

  it("ignores a full-turn hue rotation", () => {
    expect(colorFilterPrimitives({ hueRotate: 360 })).toEqual([]);
    expect(colorFilterPrimitives({ hueRotate: 0 })).toEqual([]);
    expect(colorFilterPrimitives({ hueRotate: 90 })).toEqual([
      { kind: "hue-rotate", degrees: 90 }
    ]);
  });

  it("orders the passes so tone shaping runs before white balance and colour", () => {
    const kinds = colorFilterPrimitives({
      exposure: 1,
      temperature: 1,
      highlights: 1,
      hueRotate: 90,
      saturation: 2
    }).map((p) => p.kind);
    expect(kinds).toEqual([
      "linear-transfer",
      "channel-matrix",
      "tone-curve",
      "hue-rotate",
      "saturate"
    ]);
  });
});

describe("highlights / shadows tone curve", () => {
  it("samples the full range with both endpoints pinned", () => {
    const table = toneCurveTable(1, 1);
    expect(table.length).toBe(TONE_SAMPLES);
    expect(table[0]).toBe(0);
    expect(table[TONE_SAMPLES - 1]).toBe(1);
  });

  it("is neutral when both axes are neutral", () => {
    // The table is quantised to 3 decimals — a filter lookup needs no more.
    toneCurveTable(0, 0).forEach((y, i) => {
      expect(y).toBeCloseTo(Math.round((i / (TONE_SAMPLES - 1)) * 1000) / 1000, 6);
    });
  });

  it("lifts highlights without moving black", () => {
    const table = toneCurveTable(1, 0);
    expect(table[0]).toBe(0);
    expect(table[Math.floor(TONE_SAMPLES * 0.75)]).toBeGreaterThan(0.75);
  });

  it("crushes highlights the other way", () => {
    const table = toneCurveTable(-1, 0);
    expect(table[Math.floor(TONE_SAMPLES * 0.75)]).toBeLessThan(0.75);
  });

  it("lifts shadows without moving white", () => {
    const table = toneCurveTable(0, 1);
    expect(table[TONE_SAMPLES - 1]).toBe(1);
    expect(table[Math.floor(TONE_SAMPLES * 0.25)]).toBeGreaterThan(0.25);
  });

  it("stays monotone so the curve can never invert", () => {
    for (const [h, s] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, -1]
    ]) {
      const table = toneCurveTable(h, s);
      for (let i = 1; i < table.length; i++) {
        expect(table[i]).toBeGreaterThanOrEqual(table[i - 1]);
      }
    }
  });
});

describe("filter presets", () => {
  it("matches a preset back from its own filter", () => {
    for (const p of COLOR_FILTER_PRESETS) {
      expect(matchPreset(presetFilter(p.id))).toBe(p.id);
    }
  });

  it("reports a hand-tuned filter as custom", () => {
    expect(matchPreset({ temperature: 0.13, exposure: 0.4 })).toBe("custom");
  });

  it("treats None as no filter at all", () => {
    expect(presetFilter("none")).toBeUndefined();
    expect(matchPreset(undefined)).toBe("none");
  });

  it("hands out a copy, so editing the result cannot poison the preset", () => {
    const first = presetFilter("vivid")!;
    first.saturation = 99;
    expect(presetFilter("vivid")!.saturation).toBe(1.35);
  });
});

describe("normalize", () => {
  const baseDoc = (elements: unknown[]): DesignDocument =>
    ({
      docId: "fish_t",
      id: "doc_t",
      version: "0.2",
      name: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
      pages: [
        {
          id: "p1",
          name: "Page 1",
          canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
          children: elements
        }
      ],
      activePageId: "p1",
      elements: []
    }) as DesignDocument;

  const docWithRectAdjust = (adjust: unknown): DesignDocument =>
    baseDoc([
      {
        id: "rect_1",
        type: "rect",
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        fills: [{ type: "solid", color: "#fff" }],
        adjust
      }
    ]);

  it("keeps the new axes through a normalize pass", () => {
    const { document } = normalizeDesignDocument(
      docWithRectAdjust({ exposure: 1.5, temperature: 0.5, tint: -0.25, highlights: 0.4, shadows: -0.6 })
    );
    expect(getActivePage(document).children[0].adjust).toEqual({
      exposure: 1.5,
      temperature: 0.5,
      tint: -0.25,
      highlights: 0.4,
      shadows: -0.6
    });
  });

  it("absorbs the legacy `filter` object into `adjust`", () => {
    const { document, repairs } = normalizeDesignDocument(
      baseDoc([
        {
          id: "rect_1",
          type: "rect",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          fills: [{ type: "solid", color: "#fff" }],
          filter: { invert: 1 }
        }
      ])
    );
    expect(getActivePage(document).children[0].adjust).toEqual({ invert: 1 });
    expect(repairs).toEqual([]);
  });

  it("clamps the new axes instead of trusting the file", () => {
    const { document } = normalizeDesignDocument(
      docWithRectAdjust({ exposure: 99, temperature: 5, tint: -5, highlights: 3, shadows: -3 })
    );
    expect(getActivePage(document).children[0].adjust).toEqual({
      exposure: 5,
      temperature: 1,
      tint: -1,
      highlights: 1,
      shadows: -1
    });
  });

  it("drops a filter that carries no usable number", () => {
    const { document } = normalizeDesignDocument(docWithRectAdjust({ exposure: "loud", tint: null }));
    expect(getActivePage(document).children[0].adjust).toBeUndefined();
  });

  /**
   * A layer filter is read on an image layer and nowhere else — an image fill is
   * the only one with a `paintfilter_*` def behind it. Anywhere else the value was
   * accepted, written to the document, and never applied, which is the one
   * outcome an author cannot detect: `fish check` said nothing and the render just
   * ignored it. `blendMode` is refused out loud for the same reason.
   */
  it("refuses a layer filter on a paint that cannot read it, and names it", () => {
    const { document, repairs } = normalizeDesignDocument(
      baseDoc([
        {
          id: "solid_1",
          type: "rect",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          fills: [{ type: "solid", color: "#fff", adjust: { invert: 1 } }]
        }
      ])
    );
    expect((getActivePage(document).children[0] as any).fills[0].adjust).toBeUndefined();
    expect(
      repairs.some((r) => r.path.endsWith("/adjust") && r.message.includes("image layer only"))
    ).toBe(true);
  });

  it("keeps a layer filter on the image fill that owns it", () => {
    const { document, repairs } = normalizeDesignDocument(
      baseDoc([
        {
          id: "img_1",
          type: "rect",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          fills: [{ type: "image", assetId: "a1", adjust: { invert: 1 } }]
        }
      ])
    );
    expect((getActivePage(document).children[0] as any).fills[0].adjust).toEqual({ invert: 1 });
    expect(repairs).toEqual([]);
  });

  it("reads a full turn of hue rotation as the neutral it is", () => {
    // 360° is 0°, and the renderer already emits nothing for it; a filter that is
    // visually neutral must not light the panel's reset button or name itself a
    // preset other than None.
    expect(isNeutralColorFilter({ hueRotate: 360 })).toBe(true);
    expect(isNeutralColorFilter({ hueRotate: 180 })).toBe(false);
  });
});

/**
 * `hueRotate`, `invert` and `grayscale` were rendered the whole time and had no
 * way in: no slider, no preset, nothing in the panel. `grayscale` could only be
 * had whole from the `bw` preset, which is one value out of a continuous range.
 *
 * They are here because a field the engine paints and only an external agent can
 * reach is the same defect as a field it ignores — the document accepts a value
 * and the app cannot produce one. `brightness` was the fourth of them: it was
 * rendered and reachable from nowhere, and the axis it now has is asserted with
 * the rest.
 */
describe("the axes that were rendered but unreachable", () => {
  const primitivesOf = (f: Parameters<typeof colorFilterPrimitives>[0]) =>
    colorFilterPrimitives(f).map((p) => p.kind);

  it("turns a hue rotation into a hue-rotate primitive", () => {
    expect(primitivesOf({ hueRotate: 40 })).toContain("hue-rotate");
    // Modulo 360: 360 of rotation is no rotation, and must not emit anything.
    expect(primitivesOf({ hueRotate: 360 })).toEqual([]);
    expect(primitivesOf({ hueRotate: 0 })).toEqual([]);
  });

  it("folds an invert into the linear transfer", () => {
    expect(primitivesOf({ invert: 0.5 })).toContain("linear-transfer");
    // slope 0 / intercept 0.5 IS the invert: every channel becomes 1 - itself.
    expect(colorFilterPrimitives({ invert: 0.5 })[0]).toMatchObject({ kind: "linear-transfer", slope: 0, intercept: 0.5 });
    // Partial invert is the point — 0.5 is a real image effect, not a filter on/off.
    expect(primitivesOf({ invert: 0 })).toEqual([]);
  });

  it("turns a partial grayscale into a desaturate, not just the bw preset", () => {
    // `grayscale` is saturate(1 - g), so a partial amount is a partial saturate.
    expect(primitivesOf({ grayscale: 0.4 })).toContain("saturate");
    expect(colorFilterPrimitives({ grayscale: 0.4 })[0]).toMatchObject({ kind: "saturate", value: 0.6 });
    expect(primitivesOf({ grayscale: 1 })).toContain("saturate");
    expect(primitivesOf({ grayscale: 0 })).toEqual([]);
  });

  it("reaches each of them from a slider, at a value the user could actually pick", () => {
    for (const key of ["hueRotate", "invert", "grayscale", "brightness"] as const) {
      const a = ADJUST_AXES.find((x) => x.key === key)!;
      expect(a, `${key} has no axis`).toBeDefined();
      // Every keyword has a value that is NOT neutral, or the slider is a no-op.
      const offNeutral = sliderToValue(a, 60);
      expect(Math.abs(offNeutral - a.neutral), `${key} cannot leave neutral`).toBeGreaterThan(1e-6);
      const filter = withAdjustValue(undefined, key, 60)!;
      expect(filter[key], `${key} did not land in the filter`).toBeDefined();
      // And neutral really is reachable, or the reset button cannot undo it.
      // An all-neutral filter is dropped entirely rather than kept as `{}`, which
      // is the shape the reset hands back.
      const reset = withAdjustValue(filter, key, valueToSlider(a, a.neutral));
      expect(reset?.[key], `${key} cannot be reset`).toBeUndefined();
    }
  });

  it("reaches brightness from a slider, and it drives the gain it always did", () => {
    // Both halves matter: the primitive must not change (it was always folded
    // into `exposure`'s linear transfer) and the value must now be one the app
    // can produce.
    expect(ADJUST_KEYS).toContain("brightness");
    expect(primitivesOf({ brightness: 2 })).toContain("linear-transfer");
    expect(colorFilterPrimitives({ brightness: 2 })[0]).toMatchObject({ slope: 2 });
  });
});
