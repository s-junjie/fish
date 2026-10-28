import { describe, expect, it } from "vitest";
import {
  backgroundImageUrls,
  backgroundLayers,
  isCentredTransformOrigin,
  paintFromBackgroundImage,
  parseBoxShadows,
  parseCssColor,
  parseFilterValue,
  rotationFromTransform,
  sidewaysTextBox,
  unrotateBox
} from "../src/core/import/css-values";
import { verticalTextRotation } from "../src/core/import/html-text";

describe("parseCssColor", () => {
  it("reads the rgb() form computed style actually reports", () => {
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual({ color: "#FF0000" });
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual({ color: "#000000", opacity: 0.5 });
  });

  it("keeps a fully transparent colour as an absence rather than black", () => {
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });

  it("expands the short hex form", () => {
    expect(parseCssColor("#0f0")).toEqual({ color: "#00FF00" });
  });
});

describe("backgroundLayers", () => {
  it("splits layers without cutting a gradient in half", () => {
    const layers = backgroundLayers("linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255)), radial-gradient(rgb(1, 2, 3), rgb(4, 5, 6))");
    expect(layers).toHaveLength(2);
    expect(layers[0]).toContain("linear-gradient");
  });

  it("reads nothing out of `none`", () => {
    expect(backgroundLayers("none")).toEqual([]);
    expect(backgroundImageUrls("url(\"a.png\"), url(b.png)")).toEqual(["a.png", "b.png"]);
  });
});

const stops0 = (css: string, w: number, h: number) =>
  (paintFromBackgroundImage(css, w, h) as { stops: Array<{ offset?: number }> }).stops.map((s) => s.offset);

describe("paintFromBackgroundImage", () => {
  it("carries the angle and the end colours across", () => {
    const paint = paintFromBackgroundImage("linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))", 100, 100);
    expect(paint).toMatchObject({ type: "linear-gradient", angle: 90, from: "#FF0000", to: "#0000FF" });
  });

  it("maps the side keywords CSS uses instead of an angle", () => {
    expect(paintFromBackgroundImage("linear-gradient(to right, rgb(0, 0, 0), rgb(255, 255, 255))", 10, 10)).toMatchObject({
      angle: 90
    });
  });

  /**
   * Tailwind v4's palette is oklch, so an oklch ramp is the COMMON case for an
   * imported page. Each stop's colour was resolved and then re-read through a
   * hex-only parser, which answered `#000000` — so a whole gradient arrived as a
   * black ramp, and `gradientIsFlat` could then collapse it to a black solid.
   */
  it("resolves oklch stops instead of importing a black ramp", () => {
    expect(
      paintFromBackgroundImage("linear-gradient(135deg, oklch(0.75 0.15 70), oklch(0.6 0.2 250))", 200, 100)
    ).toMatchObject({ type: "linear-gradient", from: "#E99B2A", to: "#0081F1" });
  });

  it("keeps a ramp that fades to a Color 4 zero alpha — the same colour as `transparent`", () => {
    // Neither read as an absence nor reported as a gap: the stop was dropped, and
    // with one stop left the whole gradient came back as unmappable.
    const paint = paintFromBackgroundImage(
      "linear-gradient(90deg, rgb(255 255 255), rgb(255 255 255 / 0))",
      100,
      100
    ) as { stops: Array<{ color: string }> };
    expect(paint.stops.map((s) => s.color)).toEqual(["#FFFFFF", "#00000000"]);
  });

  it("reads a `%` percent-channel stop, which the numeric path threw away", () => {
    // `Number("100%")` is NaN, so the colour fell out of `parseCssColor` before the
    // wide parser could answer it and the stop was reported as unmappable.
    expect(paintFromBackgroundImage("linear-gradient(90deg, rgb(100% 0% 0%), rgb(0% 0% 100%))", 100, 100)).toMatchObject(
      { type: "linear-gradient", from: "#FF0000", to: "#0000FF" }
    );
  });
  it("keeps a translucent hsla() stop translucent", () => {
    const paint = paintFromBackgroundImage(
      "linear-gradient(90deg, rgba(255, 0, 0, 0.5), hsla(210, 100%, 50%, 0.25))",
      100,
      100
    ) as { stops: Array<{ color: string }> };
    expect(paint.stops.map((s) => s.color)).toEqual(["#FF000080", "#0080FF40"]);
  });

  /**
   * A px stop is a fraction of the gradient LINE, and the line is
   * `|w·sinθ| + |h·cosθ|` — not the box's longer edge. On a 200×20 box at
   * `180deg` the line runs 20px, so a stop at 10px is the midpoint; measuring
   * against 200 puts it at 5% and the ramp is a tenth as long as the page drew
   * it. The old answer agrees with this one only at 90deg on a landscape box,
   * which is why it looked right nearly everywhere.
   */
  it("measures a px stop against the gradient line, not the longer edge", () => {
    const stops = (css: string, w: number, h: number) =>
      (paintFromBackgroundImage(css, w, h) as { stops: Array<{ offset?: number }> }).stops;
    const near = (got: Array<number | undefined>, want: number[]) => {
      expect(got).toHaveLength(want.length);
      want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 6));
    };
    // CSS measures 0deg as "to top", so on a 200x20 box the vertical angles
    // (0 and 180) run along the 20px height and a stop at 10px is the midpoint.
    near(stops("linear-gradient(180deg, rgb(255,0,0) 0px, rgb(0,0,255) 10px)", 200, 20).map((s) => s.offset), [0, 0.5]);
    near(stops("linear-gradient(0deg, rgb(255,0,0) 0px, rgb(0,0,255) 10px)", 200, 20).map((s) => s.offset), [0, 0.5]);
    // 90deg is horizontal, so it runs along the 200px width — and that is the
    // one case the longer edge already got right.
    near(stops("linear-gradient(90deg, rgb(255,0,0) 0px, rgb(0,0,255) 50px)", 200, 20).map((s) => s.offset), [0, 0.25]);
    // 45deg runs along the DIAGONAL, 200·√2 ≈ 282.84 — longer than either edge,
    // so the longer edge was wrong here too and put the stop at 50%.
    near(
      stops("linear-gradient(45deg, rgb(255,0,0) 0px, rgb(0,0,255) 100px)", 200, 200).map((s) => s.offset),
      [0, Math.round((100 / (200 * Math.SQRT2)) * 1e4) / 1e4]
    );
  });

  it("measures a radial px stop against the centre-to-corner line", () => {
    // A 300x100 box: the farthest corner is hypot(300,100)/2 = 158.11.
    const stops = (paintFromBackgroundImage("radial-gradient(rgb(255,0,0) 0px, rgb(0,0,255) 79.06px)", 300, 100) as {
      stops: Array<{ offset?: number }>;
    }).stops;
    expect(stops[0].offset).toBe(0);
    expect(stops[1].offset).toBeCloseTo(0.5, 1);
  });

  it("still reads a percentage stop as itself, whatever the line measures", () => {
    expect(stops0("linear-gradient(180deg, rgb(255,0,0) 0%, rgb(0,0,255) 50%)", 200, 20)).toEqual([0, 0.5]);
  });

  /**
   * A position-less stop is not at 0%. Reading them all as 0 puts two stops on
   * top of each other, and SVG then paints the whole box in the last colour with
   * a hard diagonal of the first left in a corner — which is what
   * `linear-gradient(135deg, #4C6EF5, #7048E8)`, the shape nearly every
   * two-colour fill is written in, came out as.
   */
  it("spaces stops that were written without a position", () => {
    expect(stops0("linear-gradient(135deg, rgb(76,110,245), rgb(112,72,232))", 250, 104)).toEqual([0, 1]);
    expect(stops0("linear-gradient(90deg, rgb(255,0,0), rgb(0,255,0), rgb(0,0,255))", 100, 100)).toEqual([0, 0.5, 1]);
  });

  it("spreads a position-less stop between its positioned neighbours", () => {
    expect(stops0("linear-gradient(90deg, rgb(255,0,0), rgb(0,255,0) 80%, rgb(0,0,255))", 100, 100)).toEqual([0, 0.8, 1]);
    expect(stops0("linear-gradient(90deg, rgb(255,0,0) 20%, rgb(0,255,0), rgb(0,0,255))", 100, 100)).toEqual([0.2, 0.6, 1]);
  });

  it("clamps an out-of-order pair instead of drawing a ramp the page never had", () => {
    expect(stops0("linear-gradient(90deg, rgb(255,0,0) 50%, rgb(0,0,255) 20%)", 100, 100)).toEqual([0.5, 0.5]);
  });

  it("returns nothing for a background it cannot model", () => {
    expect(paintFromBackgroundImage("url(a.png)", 10, 10)).toBeNull();
  });

  /**
   * A conic sweep is the dialect's own `angular-gradient`, with the same sense
   * (clockwise from top centre) and the same stop vector, so it is carried
   * rather than reported — it used to arrive as an unmappable layer and the pie
   * chart or colour wheel vanished.
   */
  it("carries a conic gradient as an angular one", () => {
    expect(paintFromBackgroundImage("conic-gradient(rgb(0, 0, 0), rgb(255, 255, 255))", 10, 10)).toEqual({
      type: "angular-gradient",
      from: "#000000",
      to: "#FFFFFF",
      angle: 0,
      stops: [
        { color: "#000000", offset: 0 },
        { color: "#FFFFFF", offset: 1 }
      ]
    });
    const centred = paintFromBackgroundImage(
      "conic-gradient(from 45deg at 30% 70%, rgb(0, 0, 0), rgb(255, 255, 255))",
      10,
      10
    ) as { type: string; angle: number; center: { x: number; y: number } };
    expect(centred.type).toBe("angular-gradient");
    expect(centred.angle).toBe(45);
    expect(centred.center).toEqual({ x: 0.3, y: 0.7 });
  });

  /**
   * Chrome serialises a corner direction horizontal-first — `to bottom right`
   * comes back as `to right bottom` — and neither order was the one being
   * matched, so every corner gradient fell through to `to bottom`. The angle is
   * also NOT 45° outside a square box: CSS aims the line at the far corner.
   */
  it("aims a corner gradient at the far corner of its own box", () => {
    const angleOf = (value: string, w: number, h: number): number =>
      (paintFromBackgroundImage(value, w, h) as { angle: number }).angle;
    expect(angleOf("linear-gradient(to right bottom, rgb(0,0,0), rgb(255,255,255))", 200, 60)).toBeCloseTo(106.7, 1);
    expect(angleOf("linear-gradient(to bottom right, rgb(0,0,0), rgb(255,255,255))", 200, 200)).toBeCloseTo(135, 1);
    expect(angleOf("linear-gradient(to left top, rgb(0,0,0), rgb(255,255,255))", 100, 100)).toBeCloseTo(315, 1);
    expect(angleOf("linear-gradient(to bottom, rgb(0,0,0), rgb(255,255,255))", 200, 60)).toBe(180);
  });

  it("keeps the position a radial gradient was centred on", () => {
    const paint = paintFromBackgroundImage(
      "radial-gradient(circle at 20% 80%, rgb(255,0,0), rgb(0,0,255))",
      200,
      60
    ) as { center?: { x: number; y: number } };
    expect(paint.center).toEqual({ x: 0.2, y: 0.8 });
  });

  it("keeps a ramp that fades to `transparent` — the spelling every hairline uses", () => {
    const paint = paintFromBackgroundImage("linear-gradient(90deg, rgb(51, 51, 56) 0%, rgba(0, 0, 0, 0) 100%)", 120, 8);
    expect(paint).toMatchObject({ type: "linear-gradient" });
    expect((paint as { stops: Array<{ color: string }> }).stops).toEqual([
      { color: "#333338", offset: 0 },
      { color: "#00000000", offset: 1 }
    ]);
  });

  it("carries a partial alpha in the stop rather than rounding it away", () => {
    const paint = paintFromBackgroundImage("linear-gradient(90deg, rgba(0, 0, 0, 0.5), rgb(255, 255, 255))", 10, 10);
    expect((paint as { stops: Array<{ color: string }> }).stops[0].color).toBe("#00000080");
  });

  it("reads a radial gradient whose colours have spaces in them", () => {
    const paint = paintFromBackgroundImage("radial-gradient(rgb(1, 2, 3), rgb(4, 5, 6))", 10, 10);
    expect(paint).toMatchObject({ type: "radial-gradient" });
    expect((paint as { stops: Array<{ color: string }> }).stops).toHaveLength(2);
  });
});

describe("parseBoxShadows", () => {
  it("keeps a functional colour in one piece", () => {
    const [shadow] = parseBoxShadows("rgba(0, 0, 0, 0.2) 0px 4px 12px 2px");
    expect(shadow).toEqual({
      inset: false,
      color: "rgba(0, 0, 0, 0.2)",
      offsetX: 0,
      offsetY: 4,
      blur: 12,
      spread: 2
    });
  });

  it("reads inset wherever it is written", () => {
    expect(parseBoxShadows("inset 0px 1px 0px rgba(255, 255, 255, 0.6)")[0]).toMatchObject({ inset: true, blur: 0 });
    expect(parseBoxShadows("rgba(0, 0, 0, 0.2) 0px 4px 12px, inset 0px 1px 2px rgb(1, 2, 3)")).toHaveLength(2);
  });
});

describe("parseFilterValue", () => {
  it("separates the colour filter from the layer blur and the unmodelled functions", () => {
    const parsed = parseFilterValue("brightness(1.2) contrast(0.9) blur(4px) sepia(0.5)");
    expect(parsed.filter).toEqual({ brightness: 1.2, contrast: 0.9 });
    // CSS's blur() argument is a sigma; the DSL stores a radius.
    expect(parsed.blur).toBe(8);
    expect(parsed.unsupported).toEqual(["sepia"]);
  });

  it("reads hue-rotate in degrees and percentages as ratios", () => {
    const parsed = parseFilterValue("hue-rotate(90deg) grayscale(50%) invert(1)");
    expect(parsed.filter).toEqual({ hueRotate: 90, grayscale: 0.5, invert: 1 });
  });
});

describe("rotationFromTransform", () => {
  it("recovers the angle from a pure rotation matrix", () => {
    expect(rotationFromTransform("matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0)")).toBeCloseTo(30, 2);
    expect(rotationFromTransform("none")).toBeUndefined();
  });

  it("refuses a scale or a skew, which have no DSL spelling", () => {
    expect(rotationFromTransform("matrix(1.2, 0, 0, 1.2, 0, 0)")).toBeUndefined();
    expect(rotationFromTransform("matrix(1, 0.2, 0, 1, 0, 0)")).toBeUndefined();
    expect(rotationFromTransform("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)")).toBeUndefined();
  });

  it("recognises the default transform origin", () => {
    expect(isCentredTransformOrigin("50% 50%")).toBe(true);
    expect(isCentredTransformOrigin("0px 0px")).toBe(false);
  });
});

describe("unrotateBox", () => {
  it("recovers the real box from the axis-aligned bound a rotation reports", () => {
    // A 100×50 box turned 90° measures 50×100 on screen.
    const box = unrotateBox({ x: 0, y: 0, width: 50, height: 100 }, 90);
    expect(box.width).toBeCloseTo(100, 4);
    expect(box.height).toBeCloseTo(50, 4);
    expect(box.x).toBeCloseTo(-25, 4);
    expect(box.y).toBeCloseTo(25, 4);
  });

  it("is the identity when nothing was rotated", () => {
    expect(unrotateBox({ x: 3, y: 4, width: 10, height: 20 }, 0)).toEqual({ x: 3, y: 4, width: 10, height: 20 });
  });
});

describe("sidewaysTextBox", () => {
  /**
   * A vertical line measures as one COLUMN — 12 wide and 240 tall. Laid out as
   * horizontal text it is 240 wide and 12 tall, turned a quarter turn clockwise
   * about the same centre; without the turn the label reads left-to-right, which
   * is the bug this whole path exists to prevent.
   */
  it("swaps the axes about the measured centre and carries the quarter turn", () => {
    expect(sidewaysTextBox({ x: 100, y: 40, width: 12, height: 240 })).toEqual({
      x: 100 + 6 - 120,
      y: 40 + 120 - 6,
      width: 240,
      height: 12,
      rotation: 90
    });
  });

  it("adds the element's own rotation to the quarter turn", () => {
    // The measured bound is the vertical column turned by the element's own
    // transform, so the column is recovered from it first; the box handed to the
    // DSL is the recovered column with its axes swapped.
    const angle = 30;
    const rad = (angle * Math.PI) / 180;
    const width = 100;
    const height = 200;
    const boundWidth = width * Math.abs(Math.cos(rad)) + height * Math.abs(Math.sin(rad));
    const boundHeight = width * Math.abs(Math.sin(rad)) + height * Math.abs(Math.cos(rad));
    const box = sidewaysTextBox({ x: -boundWidth / 2, y: -boundHeight / 2, width: boundWidth, height: boundHeight }, angle);
    expect(box.rotation).toBe(120);
    expect(box.width).toBeCloseTo(height, 4);
    expect(box.height).toBeCloseTo(width, 4);
    expect(box.x + box.width / 2).toBeCloseTo(0, 4);
    expect(box.y + box.height / 2).toBeCloseTo(0, 4);
  });
});

const css = (fields: Record<string, string>): CSSStyleDeclaration =>
  ({ getPropertyValue: (name: string) => fields[name] ?? "", ...fields }) as unknown as CSSStyleDeclaration;

describe("verticalTextRotation", () => {
  it("turns a sideways Latin line a quarter turn clockwise", () => {
    expect(verticalTextRotation(css({ writingMode: "vertical-rl" }), "SPECIMEN F-07")).toBe(90);
    expect(verticalTextRotation(css({ writingMode: "vertical-lr" }), "SPECIMEN F-07")).toBe(90);
  });

  it("leaves horizontal text alone", () => {
    expect(verticalTextRotation(css({ writingMode: "horizontal-tb" }), "SPECIMEN F-07")).toBeUndefined();
  });

  it("declines the type the browser keeps upright instead of turning", () => {
    expect(verticalTextRotation(css({ writingMode: "vertical-rl", "text-orientation": "upright" }), "AB")).toBeUndefined();
    // CJK under the default `mixed` is set upright too, so a turn would tip it.
    expect(verticalTextRotation(css({ writingMode: "vertical-rl" }), "標本 F-07")).toBeUndefined();
  });
});
