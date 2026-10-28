import { afterEach, describe, expect, it, vi } from "vitest";
import {
  figmaColor,
  figmaGradientAngle,
  mapFigmaCornerRadius,
  mapFigmaEffects,
  mapFigmaFills,
  mapFigmaPaint,
  figmaBlendMode,
  mapFigmaStrokes
} from "../src/core/import/figma-paint";
import { importFigmaFile } from "../src/core/import/figma-import";
import { extractFigmaRoot, shiftTree } from "../src/core/import/figma-document";
import { mapFigmaAutoLayout, mapFigmaNode, type NodeWalkState } from "../src/core/import/figma-node";
import { sanitizeElementId } from "../src/core/id";
import { figmaFillCrop, figmaFillIsTurned } from "../src/core/import/figma-image-fill";
import { fillTextElement } from "../src/core/import/figma-text";
import { blobsFromImageFills, collectFigmaImageRefs } from "../src/core/import/figma-assets";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { normalizeTextDecoration } from "../src/core/dsl/text-decoration";
import { imageCropPlacement } from "../src/core/geometry/image-crop";
import type { AssetRef, DesignElement, ImagePaint, Page, Paint } from "../src/core/dsl/types";
import { layoutOf } from "../src/core/dsl/layout-flat";
import type { FigmaFileResponse, FigmaNode } from "../src/core/import/figma-types";

const rgb = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });

/** An asset store that resolved every ref to one id — the "bytes arrived" case. */
const resolvedImages = (
  id = "asset-9",
  assets: AssetRef[] = []
): NonNullable<NodeWalkState["images"]> => ({
  idFor: () => id,
  reason: () => "",
  assets,
  skipped: [],
  failed: [],
  uris: {}
});

const freshState = (): NodeWalkState => ({
  measured: new Map(),
  gaps: [],
  imageRefs: [],
  elementCount: 0,
  maxElements: 1000,
  usedIds: new Set()
});

const frame = (id: string, children: FigmaNode[] = [], extra: Partial<FigmaNode> = {}): FigmaNode => ({
  id,
  name: id,
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  children,
  ...extra
});

const walkOne = (node: FigmaNode, state = freshState()) => {
  const el = mapFigmaNode(node, 0, 0, state);
  return { el, state };
};

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

describe("figmaColor", () => {
  it("turns Figma's 0..1 floats into a hex triplet", () => {
    expect(figmaColor(rgb(1, 0, 0))).toBe("#ff0000");
    expect(figmaColor(rgb(0, 1, 0))).toBe("#00ff00");
    expect(figmaColor(rgb(1 / 3, 1 / 3, 1 / 3))).toBe("#555555");
  });

  it("multiplies the node's alpha by the paint's own opacity", () => {
    // They are two separate fields in Figma and both apply; a paint drawn at 50%
    // over a 50% fill is 25%, not 50%.
    expect(figmaColor(rgb(0, 0, 0, 0.5), 0.5)).toBe("rgba(0, 0, 0, 0.25)");
  });

  it("clamps rather than emitting an out-of-gamut byte", () => {
    expect(figmaColor(rgb(2, -1, 0.5))).toBe("#ff0080");
  });
});

describe("figmaGradientAngle", () => {
  // The DSL measures `angle` the way CSS does — 0° points at top-centre, growing
  // clockwise — so left-to-right is 90 and top-to-bottom is 180.
  it("reads Figma's identity transform as a left-to-right gradient", () => {
    expect(figmaGradientAngle([[1, 0, 0], [0, 1, 0]])).toBe(90);
  });

  it("reads the transform Figma writes for a top-to-bottom ramp", () => {
    // A real matrix, not a symmetric stand-in: `gradientTransform` maps the
    // element INTO gradient space, so the ramp's direction is the first column
    // of the INVERSE. Read off the matrix itself this lands on 0° — the ramp
    // runs, backwards, and a two-stop brand ramp arrives as its own negative.
    expect(figmaGradientAngle([[0, 1, 0], [-1, 0, 1]])).toBe(180);
  });

  it("reads a diagonal ramp as the diagonal it is, not its mirror", () => {
    // 45° down-right. The mirror-image answer (45) is what reading the matrix
    // directly gives, and no axis-aligned case can tell the two apart.
    expect(figmaGradientAngle([[0.707, 0.707, 0], [-0.707, 0.707, 0]])).toBe(135);
  });

  it("keeps a reversed gradient reversed", () => {
    expect(figmaGradientAngle([[-1, 0, 0], [0, -1, 0]])).toBe(270);
  });

  it("turns a mirrored gradient round rather than keeping its own x axis", () => {
    // A negative determinant means gradient space itself is flipped, so the two
    // ends of the ramp swap: `u = -x` puts the `0` stop on the right.
    expect(figmaGradientAngle([[-1, 0, 0], [0, 1, 0]])).toBe(270);
    expect(figmaGradientAngle([[1, 0, 0], [0, -1, 0]])).toBe(90);
  });

  it("stays in 0..359 rather than going negative", () => {
    const angle = figmaGradientAngle([[0, -1, 0], [-1, 0, 0]]);
    expect(angle).toBeGreaterThanOrEqual(0);
    expect(angle).toBeLessThan(360);
  });

  it("falls back to 0 for a missing or degenerate transform", () => {
    expect(figmaGradientAngle(undefined)).toBe(0);
    expect(figmaGradientAngle([[0, 0], [0, 0]])).toBe(0);
  });
});

describe("a text carries the glyph outline Figma already measured", () => {
  const draft = () => ({ id: "t", x: 0, y: 0, width: 68, height: 28 } as never);
  const textNode = (extra: Partial<FigmaNode> = {}): FigmaNode =>
    ({
      id: "t",
      name: "Label",
      type: "TEXT",
      characters: "Tab 1",
      style: { fontFamily: "SF Pro", fontSize: 10 },
      fillGeometry: [{ path: "M0 0 H68 V28 H0 Z", windingRule: "NONZERO" }],
      ...extra
    }) as unknown as FigmaNode;

  it("reads `fillGeometry`, in the node's own coordinates", () => {
    // A mask can only carry a path: a text node paints through a foreignObject,
    // which a mask renders as nothing. Dropping this left Figma's tinted-icon
    // idiom with nothing to clip to and a coloured block over the icon instead.
    const el = fillTextElement(draft(), textNode()) as unknown as DesignElement;

    expect((el as { outline?: { d: string } }).outline).toEqual({ d: "M0 0 H68 V28 H0 Z" });
  });

  it("carries the winding rule, which is what makes the counters holes", () => {
    const el = fillTextElement(
      draft(),
      textNode({ fillGeometry: [{ path: "M0 0 H8 V8 H0 Z", windingRule: "EVENODD" }] })
    ) as unknown as { outline?: { fillRule?: string } };

    expect(el.outline?.fillRule).toBe("evenodd");
  });

  it("carries every glyph region, the same way a vector does", () => {
    const el = fillTextElement(
      draft(),
      textNode({
        fillGeometry: [
          { path: "M0 0 H8 V8 H0 Z", windingRule: "EVENODD" },
          { path: "M12 0 H20 V8 H12 Z", windingRule: "EVENODD" }
        ]
      })
    ) as unknown as { outline?: { d: string } };

    expect(el.outline?.d).toBe("M0 0 H8 V8 H0 Z M12 0 H20 V8 H12 Z");
  });

  it("reports a text too long to outline, rather than dropping it silently", () => {
    // The cost is per character and a paragraph is not an icon: a 200-character
    // run is tens of kilobytes of path data for something no mask uses.
    const state = freshState();
    const long = textNode({ characters: "x".repeat(200) });
    const el = fillTextElement(draft(), long, state) as unknown as { outline?: unknown };

    expect(el.outline).toBeUndefined();
    expect(state.gaps.map((g) => g.property)).toContain("text:outline:tooLong");
    // Named, because a mask holding that text now clips to its box instead —
    // which is a different picture, and the designer is the one who can tell.
    expect(state.gaps[0].value).toMatch(/mask/);
  });

  it("leaves a text with no geometry alone", () => {
    expect((fillTextElement(draft(), textNode({ fillGeometry: undefined })) as { outline?: unknown }).outline).toBeUndefined();
  });
});

describe("mapFigmaPaint", () => {
  it("applies a paint's opacity ONCE, on the layer that has a slot for it", () => {
    // Figma carries the opacity twice over — `color.a` and `paint.opacity` — and
    // the DSL carries it twice over too: the colour's own alpha and the layer's
    // `opacity`, which the renderer multiplies in. Folding Figma's opacity into
    // the colour AND onto the layer squared it: a 25% black wash painted at
    // 6.25%, and the iOS tab bar's four-layer sheen composited to #555555 where
    // Figma paints #888888.
    expect(mapFigmaPaint({ type: "SOLID", color: rgb(0, 0, 0), opacity: 0.25 })).toMatchObject({
      type: "solid",
      color: "#000000",
      opacity: 0.25
    });
    // A colour that is itself translucent keeps that alpha — it is the colour's,
    // not the paint's, and the two multiply rather than replacing each other.
    expect(mapFigmaPaint({ type: "SOLID", color: rgb(0, 0, 0, 0.5), opacity: 0.5 })).toMatchObject({
      color: "rgba(0, 0, 0, 0.5)",
      opacity: 0.5
    });
    expect(mapFigmaPaint({ type: "SOLID", color: rgb(0, 0, 0, 0.5) })).toMatchObject({ color: "rgba(0, 0, 0, 0.5)" });
  });

  it("maps the additive dodge onto CSS's additive mode, not the one that divides", () => {
    // Figma's LINEAR_DODGE is `Cb + Cs`; `color-dodge` is `Cb / (1 - Cs)`, so a
    // translucent dodge layer over a transparent backdrop resolved to black and
    // darkened whatever it was meant to sheen. `plus-lighter` is the same
    // function CSS spells.
    expect(figmaBlendMode("LINEAR_DODGE")).toBe("plus-lighter");
    expect(figmaBlendMode("COLOR_DODGE")).toBe("color-dodge");
    // Linear burn has no CSS counterpart at all, so the nearest name stays and
    // the paint is not reported as lost.
    expect(figmaBlendMode("LINEAR_BURN")).toBe("color-burn");
  });

  it("keeps Figma's bottom-first stack order without reversing it", () => {
    const fills = mapFigmaFills([
      { type: "SOLID", color: rgb(1, 0, 0) },
      { type: "SOLID", color: rgb(0, 0, 1) }
    ]);
    expect(fills?.[0]).toMatchObject({ type: "solid", color: "#ff0000" });
    expect(fills?.[1]).toMatchObject({ type: "solid", color: "#0000ff" });
  });

  it("drops a hidden layer rather than painting it", () => {
    expect(mapFigmaPaint({ type: "SOLID", color: rgb(1, 0, 0), visible: false })).toBeNull();
    expect(mapFigmaFills([{ type: "SOLID", color: rgb(1, 0, 0), visible: false }])).toBeUndefined();
  });

  it("carries a gradient's real stops, not just its endpoints", () => {
    const paint = mapFigmaPaint({
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        { color: rgb(1, 0, 0), position: 0 },
        { color: rgb(0, 0, 1, 0.5), position: 0.4 },
        { color: rgb(1, 1, 1), position: 1 }
      ]
    });
    expect(paint).toMatchObject({ type: "linear-gradient", angle: 90, from: "#ff0000", to: "#ffffff" });
    expect(paint && "stops" in paint && paint.stops).toHaveLength(3);
  });

  it("paints a linear ramp in the direction Figma draws it", () => {
    // The reported case: Figma's own top-to-bottom matrix, which used to import
    // bottom-to-top — the ramp reversed, with the report saying nothing.
    const paint = mapFigmaPaint({
      type: "GRADIENT_LINEAR",
      gradientTransform: [[0, 1, 0], [-1, 0, 1]],
      gradientStops: [
        { color: rgb(1, 0, 0), position: 0 },
        { color: rgb(0, 0, 1), position: 1 }
      ]
    });
    expect(paint).toMatchObject({ type: "linear-gradient", angle: 180, from: "#ff0000", to: "#0000ff" });
  });

  it("refuses a gradient with fewer than two stops", () => {
    expect(mapFigmaPaint({ type: "GRADIENT_LINEAR", gradientStops: [{ color: rgb(0, 0, 0), position: 0 }] })).toBeNull();
  });

  it("refuses a paint type the DSL cannot express, so the caller reports it", () => {
    expect(mapFigmaPaint({ type: "VIDEO", imageRef: "abc" })).toBeNull();
    expect(mapFigmaPaint({ type: "EMBEDDED_IMAGE" })).toBeNull();
  });
});

describe("a bitmap turned inside its layer", () => {
  // The reported case, to scale: a landscape card whose photograph sits in a
  // portrait box that the layer turns a quarter turn. The bitmap is turned back
  // inside it, so it reads upright on screen — and reading only the layer's angle
  // is what landed it a quarter turn out.
  const box = { width: 323, height: 174 };
  const natural = { width: 1344, height: 896 };
  const turned = (rotation: number, scaleMode = "FILL") => ({
    type: "IMAGE",
    imageRef: "r",
    scaleMode,
    rotation
  });

  // `x` / `y` are stored as box fractions rounded to four decimals, so a framing
  // is exact to a hundredth of a pixel. Stating the tolerance in px is the honest
  // way to say that — an exact-equality assertion would be testing `round4`.
  const SLACK = 0.05;

  it("keeps the bitmap covering the box after the turn, which is what FILL promises", () => {
    const crop = figmaFillCrop(turned(90), box, natural);
    // Figma measures counter-clockwise; the DSL's `ImageCrop.rotation` is degrees
    // clockwise, the sense its SVG `rotate()` renders through.
    expect(crop?.rotation).toBe(270);

    const placed = imageCropPlacement(box, natural, crop ?? { x: 0, y: 0, scale: 1 });
    expect(placed).not.toBeNull();
    // A quarter turn swaps the painted rect's extents, so "covers the box" has to
    // be read with them swapped — handing back the plain cover scale would leave
    // two empty bands where the designer sees photograph.
    const halfWidth = (placed?.height ?? 0) / 2;
    const halfHeight = (placed?.width ?? 0) / 2;
    expect(Math.abs((placed?.centerX ?? 0) - box.width / 2)).toBeLessThan(SLACK);
    expect(Math.abs((placed?.centerY ?? 0) - box.height / 2)).toBeLessThan(SLACK);
    expect((placed?.centerX ?? 0) - halfWidth).toBeLessThan(SLACK);
    expect((placed?.centerX ?? 0) + halfWidth).toBeGreaterThan(box.width - SLACK);
    expect((placed?.centerY ?? 0) - halfHeight).toBeLessThan(SLACK);
    expect((placed?.centerY ?? 0) + halfHeight).toBeGreaterThan(box.height - SLACK);
  });

  it("re-centres a half turn without re-scaling, its extents being unchanged", () => {
    const crop = figmaFillCrop(turned(180), box, natural);
    expect(crop?.rotation).toBe(180);
    expect(crop?.scale).toBe(1);
    const placed = imageCropPlacement(box, natural, crop ?? { x: 0, y: 0, scale: 1 });
    expect(Math.abs((placed?.centerX ?? 0) - box.width / 2)).toBeLessThan(SLACK);
    expect(Math.abs((placed?.centerY ?? 0) - box.height / 2)).toBeLessThan(SLACK);
  });

  it("gives a mirrored quarter turn the opposite angle, not the same one", () => {
    expect(figmaFillCrop(turned(-90), box, natural)?.rotation).toBe(90);
    expect(figmaFillIsTurned(turned(-90))).toBe(true);
  });

  it("snaps a rotation that is a quarter turn to within a rounding error", () => {
    // The API promises multiples of 90; refusing 90.000001 would drop the turn.
    expect(figmaFillCrop(turned(90.000001), box, natural)?.rotation).toBe(270);
  });

  it("leaves an unturned bitmap to the plain cover, which needs no framing", () => {
    expect(figmaFillCrop({ type: "IMAGE", imageRef: "r", scaleMode: "FILL" }, box, natural)).toBeNull();
    expect(figmaFillCrop(turned(360), box, natural)).toBeNull();
    expect(figmaFillIsTurned(turned(0))).toBe(false);
    // A CROP's turn is already folded into its `imageTransform`, and TILE has no
    // DSL paint for a turned bitmap to sit in — both are the caller's gap to name.
    expect(figmaFillCrop(turned(90, "CROP"), box, natural)).toBeNull();
    expect(figmaFillCrop(turned(90, "TILE"), box, natural)).toBeNull();
  });

  it("refuses when the box or the bitmap's size is unknown, rather than guessing", () => {
    expect(figmaFillCrop(turned(90), box, null)).toBeNull();
    expect(figmaFillCrop(turned(90), null, natural)).toBeNull();
    expect(figmaFillCrop(turned(90), { width: 0, height: 174 }, natural)).toBeNull();
  });
});

describe("a CROP shows the region of the image the matrix names", () => {
  const box = { width: 200, height: 100 };
  const natural = { width: 400, height: 400 };
  const cropPaint = (imageTransform: number[][]) => ({ type: "IMAGE", imageRef: "r", scaleMode: "CROP", imageTransform });

  /**
   * The matrix Figma would store for a placement, derived from the placement
   * SEMANTICS rather than from the mapper.
   *
   * The placement paints the bitmap at `paintScale`, turned about its centre at
   * `(centerX, centerY)`, and the matrix has to be the map that undoes it: a
   * layer point, back through the turn and the scale, normalized by the bitmap's
   * size. Writing it here — from the DSL's own definition of where the bitmap is,
   * to the normalized pair Figma stores — is what makes the round trip below a
   * check of the reading and not a restatement of it.
   */
  const matrixOf = (crop: { x: number; y: number; scale: number; rotation?: number }): number[][] => {
    const p = imageCropPlacement(box, natural, crop as never)!;
    const th = ((p.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    // layer-normalized → box px → (turn back, recentre, unscale) → image-normalized.
    const toImage = (X: number, Y: number) => {
      const dx = X * box.width - p.centerX;
      const dy = Y * box.height - p.centerY;
      const ix = (cos * dx + sin * dy + p.width / 2) / p.paintScale;
      const iy = (-sin * dx + cos * dy + p.height / 2) / p.paintScale;
      return [ix / natural.width, iy / natural.height];
    };
    const o = toImage(0, 0);
    const ex = toImage(1, 0);
    const ey = toImage(0, 1);
    return [
      [ex[0] - o[0], ey[0] - o[0], o[0]],
      [ex[1] - o[1], ey[1] - o[1], o[1]]
    ];
  };

  const expectSame = (a: { x: number; y: number; scale: number; rotation?: number }, b: typeof a) => {
    expect(a.x).toBeCloseTo(b.x, 3);
    expect(a.y).toBeCloseTo(b.y, 3);
    expect(a.scale).toBeCloseTo(b.scale, 3);
    expect(a.rotation ?? 0).toBeCloseTo(b.rotation ?? 0, 3);
  };

  it("frames the region the matrix names, corner for corner", () => {
    // The layer shows 60 % of the picture's width and 30 % of its height, from
    // 25 % in and 10 % down. The DSM framing has to put that region's corners on
    // the box's corners — asserted from the matrix's own claim, not from the
    // mapper's arithmetic, so reading the matrix backwards cannot pass.
    const m = [
      [0.6, 0, 0.25],
      [0, 0.3, 0.1]
    ];
    const crop = figmaFillCrop(cropPaint(m), box, natural)!;
    const placed = imageCropPlacement(box, natural, crop)!;
    const corner = (u: number, v: number) => ({
      x: placed.x + u * natural.width * placed.paintScale,
      y: placed.y + v * natural.height * placed.paintScale
    });
    const topLeft = corner(0.25, 0.1);
    const bottomRight = corner(0.85, 0.4);
    expect(Math.abs(topLeft.x)).toBeLessThan(0.05);
    expect(Math.abs(topLeft.y)).toBeLessThan(0.05);
    expect(Math.abs(bottomRight.x - box.width)).toBeLessThan(0.05);
    expect(Math.abs(bottomRight.y - box.height)).toBeLessThan(0.05);

    // And the closed form, which for an unturned crop is worth knowing: the
    // corner is `-tx / a`, not `tx`. The negative is the whole difference.
    expect(crop.x).toBeCloseTo(-0.25 / 0.6, 3);
    expect(crop.y).toBeCloseTo(-0.1 / 0.3, 3);
  });

  it("round-trips a turned placement, about the region's centre", () => {
    // The DSL turns the painted rect about its CENTRE, which is why the mapper
    // solves the centre and derives the corner from it — solving the corner first
    // swings a turned crop out of frame.
    const wanted = { x: -0.2, y: -0.15, scale: 1.4, rotation: 90 };
    expectSame(figmaFillCrop(cropPaint(matrixOf(wanted)), box, natural)!, wanted);
  });

  it("reads the export this was found on: 1172×641 over a 606×523 photograph", () => {
    // The real file. Read as "where the bitmap is painted" this matrix implies a
    // 150 % vertical stretch, which is how a perfectly ordinary crop came to be
    // called an uneven one and thrown away to a cover — the picture then lands
    // centred, and the white band the designer had cropped off comes back.
    const real = { width: 1172, height: 641 };
    const photo = { width: 606, height: 523 };
    const m = [
      [0.9537854194641113, 0, 0.013498800806701183],
      [0, 0.60085129737854, 0.3798803687095642]
    ];
    const crop = figmaFillCrop(cropPaint(m), real, photo);
    expect(crop).not.toBeNull();

    // The two axes disagree by 0.6 % in this file, so one `paintScale` cannot
    // frame both exactly; what matters is that the region the matrix names is the
    // region painted, and that is asserted here rather than the corner px.
    const placed = imageCropPlacement(real, photo, crop!)!;
    expect(-placed.x / (photo.width * placed.paintScale)).toBeCloseTo(0.0135, 2);
    expect(-placed.y / (photo.height * placed.paintScale)).toBeCloseTo(0.3799, 2);
    // Which is the image pushed 405 px up: the 38 % of it that was cropped away.
    expect(placed.y).toBeCloseTo(-404, -1);
  });

  it("refuses a crop squashed along one axis, which the DSL cannot write down", () => {
    // Ten times the residue a real file carries: the layer was resized
    // non-proportionally after its crop was set. One `paintScale` cannot say it,
    // so the caller falls back to a cover and says so.
    expect(figmaFillCrop(cropPaint([[0.6, 0, 0], [0, 0.9, 0]]), box, natural)).toBeNull();
  });

  it("refuses a mirrored crop, and a crop with no transform to read", () => {
    expect(figmaFillCrop(cropPaint([[0.6, 0, 0], [0, -0.3, 0]]), box, natural)).toBeNull();
    expect(figmaFillCrop({ type: "IMAGE", imageRef: "r", scaleMode: "CROP" }, box, natural)).toBeNull();
    expect(figmaFillCrop(cropPaint([[0.6, 0, Number.NaN], [0, 0.3, 0]]), box, natural)).toBeNull();
    expect(figmaFillCrop(cropPaint([[0.6, 0, 0], [0, 0.3, 0]]), null, natural)).toBeNull();
  });
});

describe("mapFigmaStrokes — one stroke", () => {
  it("carries the dash lengths rather than falling back to the default pattern", () => {
    const strokes = mapFigmaStrokes({
      id: "1:1",
      type: "RECTANGLE",
      strokes: [{ type: "SOLID", color: rgb(0, 0, 0) }],
      strokeWeight: 2,
      strokeDashes: [10, 5]
    });
    expect(strokes?.strokes?.[0]).toMatchObject({ width: 2, style: "dashed", dashArray: [10, 5] });
  });

  it("maps Figma's stroke alignment onto the DSL's own three", () => {
    for (const [figma, ours] of [["INSIDE", "inside"], ["CENTER", "center"], ["OUTSIDE", "outside"]] as const) {
      const strokes = mapFigmaStrokes({
        id: "1:1",
        type: "RECTANGLE",
        strokes: [{ type: "SOLID", color: rgb(0, 0, 0) }],
        strokeAlign: figma
      });
      expect(strokes?.strokes?.[0]?.align).toBe(ours);
    }
  });

  it("returns nothing for a node with no strokes", () => {
    expect(mapFigmaStrokes({ id: "1:1", type: "RECTANGLE", strokes: [] })).toBeUndefined();
    expect(mapFigmaStrokes({ id: "1:1", type: "RECTANGLE" })).toBeUndefined();
  });
});

describe("mapFigmaEffects", () => {
  it("maps a shadow's spread directly to DSL spread without distorting offset", () => {
    const effects = mapFigmaEffects([
      { type: "DROP_SHADOW", color: rgb(0, 0, 0, 0.25), offset: { x: 0, y: 2 }, radius: 8, spread: 3 }
    ]);
    expect(effects?.[0]).toMatchObject({ type: "drop-shadow", offset: { x: 0, y: 2 }, blur: 8, spread: 3 });
  });

  it("maps an inner shadow's spread directly to DSL spread", () => {
    const effects = mapFigmaEffects([
      { type: "INNER_SHADOW", color: rgb(0, 0, 0, 0.5), offset: { x: 0, y: 2 }, radius: 4, spread: 2 }
    ]);
    expect(effects?.[0]).toMatchObject({ type: "inner-shadow", offset: { x: 0, y: 2 }, blur: 4, spread: 2 });
  });

  it("carries the two blur kinds, which the DSL keeps apart", () => {
    expect(mapFigmaEffects([{ type: "LAYER_BLUR", radius: 3 }])?.[0]).toMatchObject({ type: "layer-blur", blur: 3 });
    expect(mapFigmaEffects([{ type: "BACKGROUND_BLUR", radius: 3 }])?.[0]).toMatchObject({ type: "backdrop-blur", blur: 3 });
  });

  it("carries blendMode on shadow effects and maps Figma blend modes", () => {
    const effects = mapFigmaEffects([
      { type: "GLASS", radius: 0, depth: 7, refraction: 0.8 },
      { type: "INNER_SHADOW", color: rgb(0.9, 0.9, 0.9), offset: { x: 0, y: 40 }, radius: 30, spread: -40, blendMode: "LINEAR_BURN" },
      { type: "INNER_SHADOW", color: rgb(0.15, 0.15, 0.15), offset: { x: 0, y: -40 }, radius: 10, spread: -40, blendMode: "LINEAR_DODGE" },
      { type: "DROP_SHADOW", color: rgb(0, 0, 0, 0.5), offset: { x: 0, y: 4 }, radius: 8, blendMode: "MULTIPLY" }
    ]);
    expect(effects).toHaveLength(4);
    expect(effects?.[0]).toMatchObject({ type: "liquid-glass", depth: 7 });
    expect(effects?.[1]).toMatchObject({ type: "inner-shadow", blur: 30, blendMode: "color-burn" });
    expect(effects?.[2]).toMatchObject({ type: "inner-shadow", blur: 10, blendMode: "plus-lighter" });
    expect(effects?.[3]).toMatchObject({ type: "drop-shadow", blur: 8, blendMode: "multiply" });
  });

  it("returns nothing rather than an empty array for a node with no effects", () => {
    expect(mapFigmaEffects([])).toBeUndefined();
    expect(mapFigmaEffects(undefined)).toBeUndefined();
  });
});

describe("mapFigmaCornerRadius", () => {
  it("passes the four corners through in the DSL's own TL/TR/BR/BL order", () => {
    expect(mapFigmaCornerRadius({ id: "1:1", type: "RECTANGLE", rectangleCornerRadii: [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
  });

  it("prefers the four over the single value when Figma sends both", () => {
    expect(mapFigmaCornerRadius({ id: "1:1", type: "RECTANGLE", cornerRadius: 8, rectangleCornerRadii: [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
  });

  it("omits a zero radius rather than storing a no-op", () => {
    expect(mapFigmaCornerRadius({ id: "1:1", type: "RECTANGLE", cornerRadius: 0 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

describe("sanitizeElementId", () => {
  it("turns Figma's `1:23` into a string that is also a valid CSS selector", () => {
    expect(sanitizeElementId("1:23")).toBe("1_23");
  });
});

describe("mapFigmaAutoLayout", () => {
  it("maps Figma's auto-layout field for field", () => {
    const layout = mapFigmaAutoLayout({
      id: "1:1",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      itemSpacing: 12,
      paddingTop: 8,
      paddingRight: 16,
      paddingBottom: 8,
      paddingLeft: 16,
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "CENTER"
    });
    expect(layout).toEqual({
      mode: "flex",
      direction: "row",
      gap: 12,
      padding: [8, 16, 8, 16],
      justify: "space-between",
      align: "center"
    });
  });

  it("reads a column layout's wrap gap as the column gap, not the row gap", () => {
    const layout = mapFigmaAutoLayout({
      id: "1:1",
      type: "FRAME",
      layoutMode: "VERTICAL",
      itemSpacing: 4,
      counterAxisSpacing: 20
    });
    expect(layout?.columnGap).toBe(20);
    expect(layout?.rowGap).toBeUndefined();
  });

  it("carries wrapping, which the DSL would otherwise reflow onto one line", () => {
    expect(mapFigmaAutoLayout({ id: "1:1", type: "FRAME", layoutMode: "HORIZONTAL", layoutWrap: "WRAP" })?.wrap).toBe("wrap");
  });

  it("carries every alignment the DSL has, including ones ahead of the published enum", () => {
    // An unknown key falls through to `start`, not to "leave it alone" — so a
    // missing alignment packs a row left rather than degrading visibly.
    for (const [figma, ours] of [
      ["MIN", "start"],
      ["CENTER", "center"],
      ["MAX", "end"],
      ["SPACE_BETWEEN", "space-between"],
      ["SPACE_AROUND", "space-around"],
      ["SPACE_EVENLY", "space-evenly"]
    ] as const) {
      expect(mapFigmaAutoLayout({ id: "1:1", type: "FRAME", layoutMode: "HORIZONTAL", primaryAxisAlignItems: figma })?.justify).toBe(ours);
    }
  });

  it("returns nothing for a frame Figma never laid out", () => {
    expect(mapFigmaAutoLayout({ id: "1:1", type: "FRAME", layoutMode: "NONE" })).toBeUndefined();
    expect(mapFigmaAutoLayout({ id: "1:1", type: "FRAME" })).toBeUndefined();
  });
});

describe("vector geometry", () => {
  it("stores Figma's path VERBATIM, because it is already node-local", () => {
    // `fillGeometry` is documented as "paths representing the object fill
    // relative to the node", and `d` is drawn inside a `translate(el.x, el.y)` of
    // that same box — so any displacement at all is a displacement too many.
    const { el } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 100, y: 50, width: 40, height: 20 },
      fillGeometry: [{ path: "M0 0 L40 0 L40 20 Z" }]
    });
    expect((el as { d: string }).d).toBe("M0 0 L40 0 L40 20 Z");
  });

  it("carries EVERY geometry region, not just the first", () => {
    // The iPad lock screen's clock is `Ticks` ×48, `Ticks` ×12 and `Hands` ×4.
    // Reading `[0]` left one tick mark and one hand — and reported nothing, so
    // the file opened looking plausible with a third of its geometry gone.
    const { el, state } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 },
      fillGeometry: [
        { path: "M0 0 L4 0 L4 4 Z", windingRule: "NONZERO" },
        { path: "M10 0 L14 0 L14 4 Z", windingRule: "NONZERO" },
        { path: "M20 0 L24 0 L24 4 Z", windingRule: "NONZERO" }
      ]
    });
    expect((el as { d: string }).d).toBe("M0 0 L4 0 L4 4 Z M10 0 L14 0 L14 4 Z M20 0 L24 0 L24 4 Z");
    expect(state.gaps.map((g) => g.property)).not.toContain("path:geometry");
  });

  it("takes one rule for all regions, and names the pick when they disagree", () => {
    // `evenodd` wins because a hole is only expressible that way; a `nonzero`
    // pick would fill a donut in. Regions that do not overlap render the same
    // either way, which is every case seen — so the conflict is reported, not
    // refused.
    const { el, state } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 },
      fillGeometry: [
        { path: "M0 0 h20 v20 h-20 Z", windingRule: "EVENODD" },
        { path: "M10 10 h5 v5 h-5 Z", windingRule: "NONZERO" }
      ]
    });
    expect((el as { fillRule?: string }).fillRule).toBe("evenodd");
    const gap = state.gaps.find((g) => g.property === "path:geometry:mixedWinding");
    expect(gap?.value).toContain("winding rules");
  });

  it("keeps a unanimous `evenodd` region set evenodd", () => {
    const { el, state } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 },
      fillGeometry: [
        { path: "M0 0 h20 v20 h-20 Z", windingRule: "EVENODD" },
        { path: "M10 10 h5 v5 h-5 Z", windingRule: "EVENODD" }
      ]
    });
    expect((el as { fillRule?: string }).fillRule).toBe("evenodd");
    expect(state.gaps.map((g) => g.property)).not.toContain("path:geometry:mixedWinding");
  });

  it("does not offset a nested vector by its parent's origin", () => {
    // The bug this pins: the offset used to be computed as `rect - parent`, so an
    // icon inside a frame at (300, 400) moved by (300, 400) — a displacement
    // whose size depended on how deep in the tree it sat.
    const { el } = walkOne(
      frame("1:1", [
        {
          id: "1:2",
          type: "VECTOR",
          absoluteBoundingBox: { x: 312, y: 409, width: 12, height: 11 },
          fillGeometry: [{ path: "M0 5 L6 0 L12 5 L6 11 Z" }]
        }
      ], { absoluteBoundingBox: { x: 300, y: 400, width: 100, height: 100 } })
    );
    const icon = (el as { children: DesignElement[] }).children[0];
    expect(icon.x).toBe(12);
    expect(icon.y).toBe(9);
    expect((icon as { d: string }).d).toBe("M0 5 L6 0 L12 5 L6 11 Z");
  });

  it("keeps a path the engine's own model could not parse", () => {
    // The renderer emits `d` verbatim, so a path the editor's model cannot
    // represent still draws. Emptying it would lose the glyph instead.
    const { el } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      fillGeometry: [{ path: "M0 0 A5 5 0 0 1 10 10" }]
    });
    expect((el as { d: string }).d).toBe("M0 0 A5 5 0 0 1 10 10");
  });

  it("names a vector with no geometry, and says what to ask for", () => {
    const { el, state } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      fills: [{ type: "SOLID", color: rgb(1, 0, 0) }]
    });
    const gap = state.gaps.find((g) => g.property === "path:geometry");
    expect(gap?.value).toContain("no vector geometry");
    expect((el as { d: string }).d).toBe("");
  });

  it("draws a stroke-only vector from `strokeGeometry`, where its artwork actually is", () => {
    // An outline icon carries strokes and no visible fill, and Figma's
    // `fillGeometry` for one is NOT the drawing: it is a degenerate sliver. Taking
    // `fillGeometry` whenever it existed flattened every line-art icon in a real
    // file to that sliver — the pill tabs' glyphs arrived as a bare vertical line.
    // `strokeGeometry` is the stroke already expanded to a region, so it is painted
    // as a FILL with the stroke's own paint; there is no centreline left to stroke.
    const { el } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 38 },
      fillGeometry: [
        { path: "M12.07 0.63 L12.07 8.72 Z" },
        { path: "M14.90 8.67 L14.90 0.58 Z" }
      ],
      strokeGeometry: [{ path: "M4.37 24.79 C4.47 24.53 4.34 24.24 4.09 24.14 Z" }],
      strokes: [{ type: "SOLID", color: rgb(0, 0, 0) }],
      strokeWeight: 1
    });
    expect((el as { d: string }).d).toBe("M4.37 24.79 C4.47 24.53 4.34 24.24 4.09 24.14 Z");
    expect(el?.fills).toMatchObject([{ type: "solid", color: "#000000" }]);
    expect(el?.strokes?.[0]).toBeUndefined();
  });

  it("still reads `fillGeometry` when there IS a visible fill", () => {
    // The control for the rule above: a filled shape's drawing is its fill region,
    // and its stroke stays a stroke.
    const { el } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
      fillGeometry: [{ path: "M0 0 L20 0 L20 20 Z" }],
      strokeGeometry: [{ path: "M-1 -1 L21 -1 L21 21 Z" }],
      fills: [{ type: "SOLID", color: rgb(1, 0, 0) }],
      strokes: [{ type: "SOLID", color: rgb(0, 0, 0) }],
      strokeWeight: 1
    });
    expect((el as { d: string }).d).toBe("M0 0 L20 0 L20 20 Z");
    expect(el?.strokes?.[0]).toMatchObject({ width: 1 });
  });

  it("gives a rotated leaf its own size, not the inflated box around it", () => {
    // Figma's `absoluteBoundingBox` is the bound of the shape AFTER rotation, so a
    // 50×50 square turned 45° reports 70.7×70.7. `size` is the node's own, and the
    // centre of the two is the same point.
    const { el } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 100, y: 100, width: 70.710678, height: 70.710678 },
      size: { x: 50, y: 50 },
      // Figma counts its `rotation` the other way round from the DSL — see
      // `declaredRotationDeg` — so the layer a document turns +45 is the layer
      // Figma reports at −45.
      rotation: -45,
      fillGeometry: [{ path: "M0 0 L50 0 L50 50 L0 50 Z" }]
    });
    expect(el?.width).toBe(50);
    expect(el?.height).toBe(50);
    // Centred on the same point the rotated shape was centred on.
    expect(el?.x).toBeCloseTo(110.36, 1);
    expect(el?.y).toBeCloseTo(110.36, 1);
    expect(el?.rotation).toBe(45);
  });

  it("leaves an unrotated leaf on its bounding box", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 20, y: 30, width: 40, height: 25 },
      size: { x: 40, y: 25 },
      rotation: 0
    });
    expect(el).toMatchObject({ x: 20, y: 30, width: 40, height: 25 });
  });
});

describe("mapFigmaNode", () => {
  it("stores a child at its offset from its parent, not at its canvas position", () => {
    const { el } = walkOne(
      frame("1:1", [
        {
          id: "1:2",
          name: "Label",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 40, y: 60, width: 20, height: 10 }
        }
      ])
    );
    const child = (el as { children: DesignElement[] }).children[0];
    expect(child.x).toBe(40);
    expect(child.y).toBe(60);
  });

  it("records the ABSOLUTE box as ground truth, which is what verifyImport replays against", () => {
    const { state } = walkOne(
      frame("1:1", [
        {
          id: "1:2",
          name: "Label",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 40, y: 60, width: 20, height: 10 }
        }
      ])
    );
    expect(state.measured.get("1_2")).toEqual({ x: 40, y: 60, width: 20, height: 10 });
  });

  it("gives a hidden node nothing rather than an invisible box", () => {
    expect(walkOne({ ...frame("1:1"), visible: false }).el).toBeNull();
  });

  it("names an unknown node type instead of dropping it silently", () => {
    const { el, state } = walkOne({ id: "9:9", type: "STICKY", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } });
    expect(el).toBeNull();
    expect(state.gaps.some((g) => g.property === "node:type:STICKY")).toBe(true);
  });

  it("stops at the element budget and says so", () => {
    const state = freshState();
    state.maxElements = 2;
    const el = mapFigmaNode(
      frame("1:1", [
        { id: "1:2", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } },
        { id: "1:3", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } },
        { id: "1:4", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } }
      ]),
      0,
      0,
      state
    );
    expect((el as { children: DesignElement[] }).children).toHaveLength(1);
    expect(state.gaps.some((g) => g.property === "document:maxElements")).toBe(true);
  });

  it("carries a text node's px line height as the DSL's absolute \"<n>px\" value", () => {
    const { el } = walkOne({
      id: "1:2",
      name: "Heading",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 48 },
      characters: "Hello",
      style: { fontFamily: "Inter", fontSize: 24, fontWeight: 600, lineHeightPx: 28.8, textAlignHorizontal: "CENTER" },
      fills: [{ type: "SOLID", color: rgb(1, 1, 1) }]
    });
    const text = el as unknown as { content: string; style: Record<string, unknown> };
    expect(text.content).toBe("Hello");
    expect(text.style).toMatchObject({ fontFamily: "Inter", fontSize: 24, fontWeight: 600, lineHeight: "28.8px", align: "center", color: "#ffffff" });
  });

  it("carries a strikethrough through as the line CSS calls it, not as Figma's name", () => {
    // The failure this pins is silent rather than loud: Figma spells the line
    // `STRIKETHROUGH`, CSS spells it `line-through`, and anything else is not a
    // member of the DSL's union — it used to be cast into the field anyway and
    // then dropped by the document normalizer with nothing recorded, so a
    // struck-through label imported as a plain one. Asserting through
    // `normalizeTextDecoration` is what makes the drop observable: the old
    // spelling normalises to `undefined`, so a passing assertion cannot be
    // satisfied by any string that merely looks like a decoration.
    const { el } = walkOne({
      id: "1:2",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
      characters: "Sold out",
      style: { fontFamily: "Inter", fontSize: 16, textDecoration: "STRIKETHROUGH" }
    });
    const style = (el as unknown as { style: Record<string, unknown> }).style;
    expect(style.textDecoration).toEqual(["line-through"]);
    expect(normalizeTextDecoration(style.textDecoration)).toEqual(["line-through"]);

    const underline = walkOne({
      id: "1:3",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
      characters: "Terms",
      style: { fontFamily: "Inter", fontSize: 16, textDecoration: "UNDERLINE" }
    });
    const underlined = (underline.el as unknown as { style: Record<string, unknown> }).style;
    expect(normalizeTextDecoration(underlined.textDecoration)).toEqual(["underline"]);
  });

  it("leaves a text node undecorated when Figma says NONE, rather than storing an empty list", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
      characters: "Plain",
      style: { fontFamily: "Inter", fontSize: 16, textDecoration: "NONE" }
    });
    const style = (el as unknown as { style: Record<string, unknown> }).style;
    expect(style.textDecoration).toBeUndefined();
  });

  it("carries Figma's per-run text overrides as spans", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
      characters: "Bold rest",
      style: { fontFamily: "Inter", fontSize: 16 },
      characterStyleOverrides: [0, 0, 4, 4, 4, 4, 4, 4],
      styleOverrideTable: { "4": { fontFamily: "Inter", fontSize: 16, fontWeight: 700 } }
    });
    const spans = (el as { spans?: Array<{ text: string; style?: Record<string, unknown> }> }).spans;
    expect(spans?.map((s) => s.text).join("")).toBe("Bold rest");
    expect(spans?.find((s) => s.style)?.style?.fontWeight).toBe(700);
  });

  it("records a diagonal line's direction rather than guessing which way it runs", () => {
    const { el, state } = walkOne({
      id: "1:2",
      type: "LINE",
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 }
    });
    expect((el as { dx: number; dy: number }).dx).toBe(30);
    expect(state.gaps.some((g) => g.property === "line:direction")).toBe(true);
  });

  it("keeps an axis-aligned line exact and does not report a gap", () => {
    const { el, state } = walkOne({
      id: "1:2",
      type: "LINE",
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 0 }
    });
    expect((el as { dx: number; dy: number })).toMatchObject({ dx: 30, dy: 0 });
    expect(state.gaps).toHaveLength(0);
  });

  it("keeps a vector's path in the element's own box rather than at its canvas position", () => {
    const { el, state } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 100, y: 50, width: 40, height: 20 },
      fillGeometry: [{ path: "M0 0 L40 0 L40 20 Z" }]
    });
    expect((el as { d: string }).d).toBe("M0 0 L40 0 L40 20 Z");
    expect(state.gaps).toHaveLength(0);
  });

  it("names a rotated container rather than placing its children outside its own bound", () => {
    const { state } = walkOne(frame("1:1", [], { rotation: 30 }));
    expect(state.gaps.some((g) => g.property === "node:rotation")).toBe(true);
  });

  it("marks a Figma instance for promotion rather than inventing a master id", () => {
    const { el } = walkOne({ ...frame("1:1", []), type: "INSTANCE", componentId: "5:6" });
    expect((el as { metadata: Record<string, string> }).metadata.figmaComponentId).toBe("5_6");
  });

  it("gives an IMAGE layer with nothing resolved its box, and says why", () => {
    const { el, state } = walkOne({
      id: "1:2",
      name: "Hero photo",
      type: "IMAGE",
      absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
      fills: [{ type: "IMAGE", imageRef: "ref-abc" }]
    });
    expect(el?.type).toBe("rect");
    expect(el?.width).toBe(800);
    expect(el?.fills).toBeUndefined();
    expect(state.gaps.some((g) => g.property === "fills:IMAGE")).toBe(true);
  });

  it("paints a clip's poster frame, which is the only thing a video can bring", () => {
    // A clip's bytes cannot be read from a plugin, so the export carries a still
    // of the layer under the clip's own ref and the layer is painted from that.
    // It resolves through the same lookup an image does — which is why the walk
    // that collects refs has to ask for `videoRef` too.
    const state = freshState();
    state.images = resolvedImages("asset-poster");
    const { el, state: after } = walkOne(
      {
        id: "1:2",
        name: "Clip",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 },
        fills: [{ type: "VIDEO", videoRef: "vid-abc", scaleMode: "FILL" }]
      },
      state
    );
    expect(el?.fills).toEqual([{ type: "image", assetId: "asset-poster", fit: "cover", enabled: true }]);
    expect(after.gaps.some((g) => g.property === "fills:VIDEO")).toBe(false);
  });

  it("keeps a video fill's box and names the one whose poster never came", () => {
    // No poster in the export, so there is nothing to paint. What must not happen
    // is arriving as a bare `fills:VIDEO` with nothing to explain it: the reason
    // is a limit of Figma's API, not of this mapper, and the sentence is the only
    // place that is said.
    const { el, state } = walkOne({
      id: "1:2",
      name: "Clip",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 },
      fills: [{ type: "VIDEO", videoRef: "vid-abc", scaleMode: "FILL" }]
    });
    expect(el?.width).toBe(320);
    expect(el?.fills).toBeUndefined();
    const gap = state.gaps.find((g) => g.property === "fills:VIDEO");
    expect(gap?.value).toContain("no poster frame");
  });

  it("asks for a clip's ref when collecting the pictures an export carries", () => {
    // A ref the collector never asks for is a poster the asset store never
    // registers — so the bytes would sit in the export while the layer lost its
    // picture, which is the worst of both.
    expect(collectFigmaImageRefs({ fills: [{ type: "VIDEO", videoRef: "vid-abc" }] })).toEqual(["vid-abc"]);
    expect(
      collectFigmaImageRefs({ fills: [{ type: "IMAGE", imageRef: "img-1" }, { type: "VIDEO", videoRef: "vid-1" }] })
    ).toEqual(["img-1", "vid-1"]);
  });

  it("still reports an unmapped paint with no sentence of its own", () => {
    const { state } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      fills: [{ type: "UNKNOWN_PAINT" }]
    });
    const gap = state.gaps.find((g) => g.property === "fills:UNKNOWN_PAINT");
    expect(gap).toBeTruthy();
    expect(gap?.value).toBeUndefined();
  });

  it("names why a Figma pattern fill cannot travel", () => {
    const { state } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      fills: [{ type: "PATTERN", sourceNodeId: "1:9" }]
    });
    const gap = state.gaps.find((g) => g.property === "fills:PATTERN");
    expect(gap?.value).toContain("source node");
  });

  it("paints an image fill on an ordinary rectangle, which is how most pictures arrive", () => {
    // The common case is not a bare IMAGE node — it is a rectangle with an image
    // paint. Reading only IMAGE nodes left every such picture with no bytes.
    const state = freshState();
    state.images = resolvedImages();
    const { el } = walkOne(
      {
        id: "1:3",
        name: "Photo",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
        fills: [{ type: "IMAGE", imageRef: "r", scaleMode: "FIT" }]
      },
      state
    );
    expect(el?.fills).toEqual([{ type: "image", assetId: "asset-9", fit: "contain", enabled: true }]);
  });

  it("binds resolved bytes as an image fill and maps Figma's scale modes onto fits", () => {
    const withImages = (scaleMode: string): DesignElement | null => {
      const state = freshState();
      state.images = resolvedImages("asset-1");
      return walkOne(
        {
          id: "1:2",
          type: "IMAGE",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          fills: [{ type: "IMAGE", imageRef: "r", scaleMode }]
        },
        state
      ).el;
    };
    // Figma's `FILL` means COVER — scale up until the box is filled and crop
    // what overflows — and the DSL's `fill` is CSS's `object-fit: fill`, a
    // stretch. Mapping the two together distorted every photograph whose box
    // aspect differed from the bitmap's, and no measurement can see it: a
    // stretched bitmap still occupies the box it was given.
    expect(withImages("FIT")).toMatchObject({ fills: [{ fit: "contain" }] });
    expect(withImages("FILL")).toMatchObject({ fills: [{ fit: "cover" }] });
    expect(withImages("STRETCH")).toMatchObject({ fills: [{ fit: "fill" }] });
    // Every other mode falls back to a cover rather than a stretch, and says so:
    // `TILE` has no DSL paint at all, and `CROP`'s framing is `imageTransform`.
    expect(withImages("TILE")).toMatchObject({ fills: [{ fit: "cover" }] });
    expect(withImages("CROP")).toMatchObject({ fills: [{ fit: "cover" }] });
  });

  it("names a CROP's unframed fallback, which used to import as a silent stretch", () => {
    const state = freshState();
    state.images = resolvedImages("asset-1");
    const { state: after } = walkOne(
      {
        id: "1:2",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        fills: [{ type: "IMAGE", imageRef: "r", scaleMode: "CROP", imageTransform: [[1, 0, 0.2], [0, 1, 0.1], [0, 0, 1]] }]
      },
      state
    );
    expect(after.gaps.some((g) => g.property === "image:scaleMode:CROP")).toBe(true);
  });

  it("paints a CROP's own framing, and names only the one it cannot write", () => {
    const photo = { id: "asset-1", name: "photo", uri: "data:image/png;base64,AA", width: 400, height: 400 };
    const crop = (imageTransform: number[][]) => {
      const state = freshState();
      state.images = resolvedImages("asset-1", [photo]);
      return walkOne(
        {
          id: "1:2",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
          fills: [{ type: "IMAGE", imageRef: "r", scaleMode: "CROP", imageTransform }]
        },
        state
      );
    };

    // A square photo, 60 % of its width and 30 % of its height showing from a
    // quarter of the way in: the region's corners are the box's corners.
    const placed = crop([
      [0.6, 0, 0.25],
      [0, 0.3, 0.1]
    ]);
    const paint = (placed.el?.fills as ImagePaint[])[0];
    expect(paint).toMatchObject({ type: "image", fit: "crop" });
    expect(paint.crop?.x).toBeCloseTo(-0.25 / 0.6, 3);
    expect(paint.crop?.y).toBeCloseTo(-0.1 / 0.3, 3);
    expect(placed.state.gaps.some((g) => g.property === "image:scaleMode:CROP")).toBe(false);

    // The picture is stretched along one axis and scaled down along the other: no
    // DSL crop can say it, so the bitmap keeps a cover and the gap says which of
    // the reasons it was.
    const squashed = crop([
      [0.6, 0, 0],
      [0, 0.1, 0]
    ]);
    expect((squashed.el?.fills as ImagePaint[])[0]).toMatchObject({ fit: "cover" });
    expect((squashed.el?.fills as ImagePaint[])[0].crop).toBeUndefined();
    const gap = squashed.state.gaps.find((g) => g.property === "image:scaleMode:CROP");
    expect(gap?.value).toContain("unevenly");
  });

  it("names a tiled image fill instead of drawing one flat copy", () => {
    const state = freshState();
    state.images = resolvedImages("asset-1");
    const { state: after } = walkOne(
      {
        id: "1:2",
        type: "IMAGE",
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        fills: [{ type: "IMAGE", imageRef: "r", scaleMode: "TILE" }]
      },
      state
    );
    expect(after.gaps.some((g) => g.property === "image:scaleMode:TILE")).toBe(true);
  });

  it("places a bitmap turned inside its layer, and names the one it cannot place", () => {
    const withAssets = (assets: AssetRef[]) => {
      const state = freshState();
      state.images = resolvedImages("asset-1", assets);
      return walkOne(
        {
          id: "1:2",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 0, y: 0, width: 323, height: 174 },
          fills: [{ type: "IMAGE", imageRef: "r", scaleMode: "FILL", rotation: 90 }]
        },
        state
      );
    };
    const photo = { id: "asset-1", name: "photo", uri: "data:image/png;base64,AA", width: 1344, height: 896 };

    const placed = withAssets([photo]);
    expect((placed.el?.fills as Paint[])[0]).toMatchObject({ type: "image", fit: "crop" });
    expect((placed.el?.fills as ImagePaint[])[0].crop?.rotation).toBe(270);
    expect(placed.state.gaps.some((g) => g.property === "image:fillRotation")).toBe(false);

    // No recorded size means nothing to solve against, so the bitmap keeps the
    // plain cover — a quarter turn out — and says so rather than looking solved.
    const unsized = withAssets([]);
    expect((unsized.el?.fills as Paint[])[0]).toMatchObject({ fit: "cover" });
    expect(unsized.state.gaps.some((g) => g.property === "image:fillRotation")).toBe(true);
  });

  it("reads a mask from `isMask`, which is the field the API actually sends", () => {
    // `mask` matches nothing in a real response, so every mask layer imported as
    // an ordinary one — and masking is what the layer was FOR.
    const { el } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      isMask: true,
      maskType: "ALPHA"
    });
    expect(el?.isMask).toBe(true);
    expect(el?.maskMode).toBe("alpha");
  });

  it("accepts BOTH constraint spellings, because the API has used both", () => {
    // Current OpenAPI says LEFT/RIGHT/LEFT_RIGHT and TOP/BOTTOM/TOP_BOTTOM; older
    // responses say MIN/MAX/STRETCH. A table with one matches neither the other's
    // keys, and an unmatched key pins the layer top-left rather than leaving it be.
    const legacy = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      constraints: { horizontal: "MAX", vertical: "STRETCH" }
    });
    expect(legacy.el?.constraints).toMatchObject({ horizontal: "right", vertical: "stretch" });

    const current = walkOne({
      id: "1:3",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      constraints: { horizontal: "RIGHT", vertical: "TOP_BOTTOM" }
    });
    expect(current.el?.constraints).toMatchObject({ horizontal: "right", vertical: "stretch" });
  });

  it("carries an explicit max-width, which the engine now resolves on resize", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 40 },
      maxWidth: 320
    });
    expect(el?.sizing).toMatchObject({ maxWidth: 320 });
  });

  it("ignores a zero minimum, which is Figma's way of saying there is none", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 40 },
      minWidth: 0
    });
    expect(el?.sizing?.minWidth).toBeUndefined();
  });

  it("makes a hugging container hug again after an edit", () => {
    // Figma spells hugging on the CONTAINER (`counterAxisSizingMode: AUTO`), not
    // on the child's `layoutSizing*`, so without this a hug frame arrives as a
    // fixed-height box that stops hugging the moment its text changes.
    const { el } = walkOne({
      id: "1:2",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      layoutMode: "HORIZONTAL",
      counterAxisSizingMode: "AUTO"
    });
    expect(el?.sizing).toMatchObject({ height: "fit-content" });
  });

  it("maps Figma's GRID auto-layout onto the DSL's grid, tracks and all", () => {
    // GRID is a third mode with its own cell model, not a flex column. Two 100px
    // cards in a 300px frame are two 100px COLUMNS — a count of 2 would make the
    // engine equal-divide them into 142px and move both cards, so the measurement
    // is what has to be written.
    const { el, state } = walkOne({
      id: "1:2",
      type: "FRAME",
      layoutMode: "GRID",
      gridColumnCount: 2,
      gridColumnGap: 16,
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 },
      children: [
        { id: "2:1", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } },
        { id: "2:2", type: "RECTANGLE", absoluteBoundingBox: { x: 116, y: 0, width: 100, height: 40 } }
      ]
    });
    const layout = layoutOf(el);
    expect(layout?.mode).toBe("grid");
    expect(layout?.columns).toBeUndefined();
    expect(layout?.columnSizes).toEqual([100, 100]);
    expect(layout?.columnGap).toBe(16);
    // The DSL's `cellAlign` defaults to `stretch`, which would stretch every
    // content-sized child and make `verifyImport` downgrade the container.
    expect(layout?.cellAlign).toBe("start");
    expect(state.gaps.some((g) => g.property === "layout:GRID")).toBe(false);
  });

  it("keeps Figma's authored fr tracks, and falls back to the measurement when they would resolve differently", () => {
    const grid = (sizing: string, widths: number[]): ReturnType<typeof walkOne> =>
      walkOne({
        id: "1:2",
        type: "FRAME",
        layoutMode: "GRID",
        gridColumnCount: 2,
        gridColumnGap: 20,
        gridColumnsSizing: sizing,
        absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 40 },
        children: widths.map((w, i) => ({
          id: `2:${i + 1}`,
          type: "RECTANGLE",
          absoluteBoundingBox: { x: i === 0 ? 0 : widths[0] + 20, y: 0, width: w, height: 40 }
        }))
      });

    // `1fr 3fr` in a 400px frame with a 20px gap is 95 / 285 — which is what
    // `resolveTracks` computes, so the RATIO is kept and the grid still
    // redistributes when the frame is resized.
    const kept = grid("1fr 3fr", [95, 285]);
    expect(layoutOf(kept.el)?.columnSizes).toEqual([{ fr: 1 }, { fr: 3 }]);

    // The same declared tracks against geometry they do not reproduce: the
    // measurement wins, because a ratio the engine resolves differently is a
    // container `verifyImport` downgrades (LESSON 137).
    const forced = grid("1fr 1fr", [95, 285]);
    expect(layoutOf(forced.el)?.columnSizes).toEqual([95, 285]);
  });

  it("carries a grid child's 0-based anchor and span onto the DSL's 1-based cell", () => {
    const { el } = walkOne({
      id: "2:1",
      type: "RECTANGLE",
      gridColumnAnchorIndex: 2,
      gridColumnSpan: 3,
      gridRowAnchorIndex: 1,
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }
    });
    expect((el as any)["grid-area"]).toEqual({
      column: 3,
      columnSpan: 3,
      row: 2
    });
  });

  it("leaves a flowed grid child with no cell at all", () => {
    // Figma's default anchor is 0, which means "place me in the flow" — and the
    // DSL auto-places a child with no `layoutCell` the same way, so writing one
    // would only pin a child the flow was free to move.
    const { el } = walkOne({
      id: "2:1",
      type: "RECTANGLE",
      gridColumnAnchorIndex: 0,
      gridRowAnchorIndex: 0,
      gridColumnSpan: 1,
      gridRowSpan: 1,
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }
    });
    expect((el as any)["grid-area"]).toBeUndefined();
  });

  it("names the grid it cannot express rather than dropping it silently", () => {
    const { state } = walkOne({
      id: "1:2",
      type: "FRAME",
      layoutMode: "GRID",
      gridColumnCount: 2,
      gridColumnSizes: [{ type: "HUG" }, { type: "FIXED", value: 100 }],
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 },
      children: [
        { id: "2:1", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } },
        { id: "2:2", type: "RECTANGLE", absoluteBoundingBox: { x: 116, y: 0, width: 100, height: 40 } }
      ]
    });
    expect(state.gaps.some((g) => g.property === "grid:track:HUG")).toBe(true);
  });

  it("rotates a leaf, whose box is its own", () => {
    const leaf = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      size: { x: 10, y: 10 },
      rotation: -45,
      fillGeometry: [{ path: "M 0 0 L 10 0" }]
    });
    expect(leaf.el?.rotation).toBe(45);
  });

  it("names a turned leaf it has no box to turn, rather than turning the bound", () => {
    // No `size`, so the only box in the response is the bound of the rotation.
    // Turning THAT is a second turn: the layer would be the bound of its own
    // rotation, rotated again, which is why the rotation is dropped and named.
    const { el, state } = walkOne({
      id: "1:2",
      type: "VECTOR",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      rotation: 45,
      fillGeometry: [{ path: "M 0 0 L 10 0" }]
    });
    expect(el?.rotation).toBeUndefined();
    expect(state.gaps.some((g) => g.property === "node:rotation")).toBe(true);
  });

  it("gives a rotated TEXT its own box, which the leaf list used to exclude", () => {
    // Only a list of shape types were eligible for their own box, so a turned
    // label kept the bound of its rotation AND was rotated on top of it: 34% too
    // large, about a pivot that was no longer its own centre.
    const { el } = walkOne({
      id: "1:2",
      type: "TEXT",
      absoluteBoundingBox: { x: 100, y: 100, width: 70.710678, height: 70.710678 },
      size: { x: 50, y: 50 },
      rotation: -45,
      characters: "Turned",
      style: { fontFamily: "Inter", fontSize: 12 }
    });
    expect(el?.width).toBe(50);
    expect(el?.height).toBe(50);
    expect(el?.rotation).toBe(45);
  });

  it("maps Figma's per-side stroke weights onto the DSL's `sides`", () => {
    // The DSL declares `side: "custom"` + `sides{}` precisely so a four-sided
    // border draws instead of averaging — the reason the HTML importer reads a
    // four-value `border`.
    const { el } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      strokes: [{ type: "SOLID", color: rgb(0, 0, 0) }],
      strokeWeight: 1,
      individualStrokeWeights: { top: 4, bottom: 1 }
    });
    expect(el?.strokes?.[0]).toMatchObject({ side: "custom", sides: { top: 4, bottom: 1 } });
  });

  it("keeps one uniform stroke out of the custom path", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      strokes: [{ type: "SOLID", color: rgb(0, 0, 0) }],
      strokeWeight: 1,
      individualStrokeWeights: { top: 1, right: 1, bottom: 1, left: 1 }
    });
    expect(el?.strokes?.[0]?.side).toBeUndefined();
  });

  it("truncates text the way Figma does, ellipsis only when Figma asked for one", () => {
    const truncated = walkOne({
      id: "1:2",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
      characters: "A very long label",
      textAutoResize: "TRUNCATE",
      style: { fontFamily: "Inter", fontSize: 14, maxLines: 1, textTruncation: "ENDING" }
    });
    expect((truncated.el as unknown as { style: Record<string, unknown> }).style).toMatchObject({
      maxLines: 1,
      textOverflow: "ellipsis"
    });

    const clipped = walkOne({
      id: "1:3",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
      characters: "A very long label",
      textAutoResize: "TRUNCATE",
      style: { fontFamily: "Inter", fontSize: 14, maxLines: 2, textTruncation: "DISABLED" }
    });
    expect((clipped.el as unknown as { style: Record<string, unknown> }).style).toMatchObject({
      maxLines: 2,
      textOverflow: "clip"
    });
  });

  it("maps the conic and diamond gradients the DSL already renders", () => {
    // These were reported as unmappable while the DSL carried both paint types
    // and a pattern-based renderer for them.
    const angular = mapFigmaPaint({
      type: "GRADIENT_ANGULAR",
      gradientStops: [
        { color: rgb(1, 0, 0), position: 0 },
        { color: rgb(0, 0, 1), position: 1 }
      ]
    });
    expect(angular).toMatchObject({ type: "angular-gradient" });
    const diamond = mapFigmaPaint({
      type: "GRADIENT_DIAMOND",
      gradientStops: [
        { color: rgb(1, 0, 0), position: 0 },
        { color: rgb(0, 0, 1), position: 1 }
      ]
    });
    expect(diamond).toMatchObject({ type: "diamond-gradient" });
  });

  it("carries a conic's own start angle and centre, measured in px", () => {
    const box = { width: 200, height: 100 };
    const conic = (gradientTransform: number[][]) =>
      mapFigmaPaint(
        {
          type: "GRADIENT_ANGULAR",
          gradientTransform,
          gradientStops: [
            { color: rgb(1, 0, 0), position: 0 },
            { color: rgb(0, 0, 1), position: 1 }
          ]
        },
        undefined,
        { box }
      );

    // The identity sweep starts along the element's +x and closes clockwise, so
    // its start is 3 o'clock — 90° in a convention that counts from 12.
    expect(conic([[1, 0, 0], [0, 1, 0]])).toMatchObject({ angle: 90, center: { x: 0.5, y: 0.5 } });

    // A conic is a true circle in px, so the same 45°-in-box-fractions matrix is
    // a DIFFERENT screen angle on a 2:1 box: 116.57°, not 135°. A square cannot
    // tell the two apart — LESSONS_LEARNED §114.
    expect(conic([[0.707, 0.707, 0], [-0.707, 0.707, 0]])).toMatchObject({ angle: 117 });
  });
});

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

describe("extractFigmaRoot", () => {
  it("reads a full file response", () => {
    const doc = { id: "0:0", type: "DOCUMENT", children: [] } as FigmaNode;
    expect(extractFigmaRoot({ document: doc } as FigmaFileResponse)).toBe(doc);
  });

  it("reads a single-node response, which nests the document under `nodes`", () => {
    const doc = { id: "1:2", type: "FRAME", children: [] } as FigmaNode;
    expect(extractFigmaRoot({ nodes: { "1:2": { document: doc } } } as unknown as FigmaFileResponse)).toBe(doc);
  });
});

describe("shiftTree", () => {
  it("moves a child with its parent, rather than twice", () => {
    // Children are stored LOCAL to their parent, so recursing here would add the
    // offset again and push the child out of the frame that contains it.
    const tree = [
      {
        id: "a",
        type: "frame",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        children: [{ id: "b", type: "rect", x: 10, y: 20, width: 1, height: 1 }]
      }
    ] as unknown as DesignElement[];
    const shifted = shiftTree(tree, 100, 200);
    expect(shifted[0].x).toBe(100);
    // The child's own x/y is unchanged — its parent carried it.
    expect((shifted[0] as { children: DesignElement[] }).children[0]).toMatchObject({ x: 10, y: 20 });
  });

  it("leaves a line's delta alone", () => {
    // `dx`/`dy` are already deltas; shifting them too would double-move the
    // second endpoint.
    const line = [{ id: "l", type: "line", x: 0, y: 0, width: 5, height: 0, dx: 5, dy: 0 }] as unknown as DesignElement[];
    expect(shiftTree(line, 10, 20)[0]).toMatchObject({ x: 10, y: 20, dx: 5, dy: 0 });
  });
});

describe("constraints", () => {
  it("maps Figma's edge pair onto the DSL's axis modes, in its own spelling", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      constraints: { horizontal: "MAX", vertical: "STRETCH" }
    });
    // "MAX" is pinned-right, not "no constraint" — passing Figma's caps through
    // leaves a value `resolveConstraints` rejects, which reads as pinned-left.
    expect(el?.constraints).toEqual({ horizontal: "right", vertical: "stretch" });
  });

  it("omits constraints entirely when Figma sent none", () => {
    const { el } = walkOne({ id: "1:2", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } });
    expect(el?.constraints).toBeUndefined();
  });
});

describe("a child stays inside its parent", () => {
  it("keeps every child's page position within the parent's bounds", () => {
    // The regression this exists for: shifting the whole tree double-shifted every
    // descendant, so a real file came back with half its design outside the frame
    // that contains it, and nothing downstream complained.
    const json = sampleFile();
    canvases(json)[0].children = [
      {
        id: "AbC123:50",
        name: "Outer",
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
        children: [
          {
            id: "AbC123:51",
            name: "Inner",
            type: "FRAME",
            absoluteBoundingBox: { x: 40, y: 30, width: 200, height: 100 },
            children: [
              {
                id: "AbC123:52",
                name: "Leaf",
                type: "RECTANGLE",
                absoluteBoundingBox: { x: 60, y: 50, width: 20, height: 20 }
              }
            ]
          }
        ]
      }
    ];
    const result = importFigmaFile(json as FigmaFileResponse);
    return result.then((r) => {
      const walk = (els: DesignElement[], ox: number, oy: number) => {
        for (const el of els) {
          const x = ox + el.x;
          const y = oy + el.y;
          const children = (el as { children?: DesignElement[] }).children;
          if (children?.length) {
            for (const child of children) {
              const cx = x + child.x;
              const cy = y + child.y;
              expect(cx).toBeGreaterThanOrEqual(x - 0.01);
              expect(cy).toBeGreaterThanOrEqual(y - 0.01);
              expect(cx + child.width).toBeLessThanOrEqual(x + el.width + 0.01);
              expect(cy + child.height).toBeLessThanOrEqual(y + el.height + 0.01);
            }
            walk(children, x, y);
          }
        }
      };
      walk(r.elements, 0, 0);
    });
  });
});

describe("collectFigmaImageRefs", () => {
  it("descends into `document`, or it walks an empty tree and finds nothing", () => {
    // A file response wraps the tree in `{ document: { children } }` and has no
    // `children` of its own, so descending only through `children` collects zero
    // refs and every image in the file silently loses its bytes.
    const refs = collectFigmaImageRefs({
      name: "File",
      document: {
        id: "0:0",
        children: [
          {
            id: "1:2",
            type: "IMAGE",
            fills: [{ type: "IMAGE", imageRef: "a" }],
            children: [{ id: "1:3", type: "IMAGE", fills: [{ type: "IMAGE", imageRef: "c" }] }]
          }
        ]
      }
    });
    expect(refs).toEqual(["a", "c"]);
  });

  it("collects a picture carried as a fill on an ordinary shape, at any depth", () => {
    const refs = collectFigmaImageRefs({
      document: {
        children: [
          { id: "1:1", type: "RECTANGLE", fills: [{ type: "IMAGE", imageRef: "rect" }] },
          {
            id: "1:2",
            type: "FRAME",
            fills: [{ type: "IMAGE", imageRef: "frame" }],
            children: [{ id: "1:4", type: "ELLIPSE", fills: [{ type: "IMAGE", imageRef: "nested" }] }]
          }
        ]
      }
    });
    expect(refs).toEqual(["rect", "frame", "nested"]);
  });
});

// ---------------------------------------------------------------------------
// End to end, and the document the result has to survive being read back as
// ---------------------------------------------------------------------------

/** The canvases of a fixture, typed so a test can edit a canvas's children. */
const canvases = (json: FigmaFileResponse): FigmaNode[] => (json.document.children ?? []) as FigmaNode[];

const sampleFile = (): FigmaFileResponse => ({
  name: "Design System",
  document: {
    id: "AbC123:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "AbC123:1",
        name: "Landing",
        type: "CANVAS",
        children: [
          {
            id: "AbC123:2",
            name: "Card",
            type: "FRAME",
            absoluteBoundingBox: { x: -30, y: -10, width: 320, height: 200 },
            layoutMode: "VERTICAL",
            itemSpacing: 8,
            paddingTop: 16,
            paddingRight: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            fills: [{ type: "SOLID", color: rgb(1, 1, 1) }],
            cornerRadius: 12,
            children: [
              {
                id: "AbC123:3",
                name: "Title",
                type: "TEXT",
                absoluteBoundingBox: { x: -14, y: 6, width: 288, height: 24 },
                characters: "Title",
                style: { fontFamily: "Inter", fontSize: 18, fontWeight: 600, lineHeightPx: 24 }
              },
              {
                id: "AbC123:4",
                name: "Body",
                type: "TEXT",
                absoluteBoundingBox: { x: -14, y: 38, width: 288, height: 120 },
                characters: "Body copy",
                style: { fontFamily: "Inter", fontSize: 14, lineHeightPx: 20 }
              }
            ]
          }
        ]
      }
    ]
  }
});

describe("importFigmaFile", () => {
  it("makes one page per Figma canvas", async () => {
    const result = await importFigmaFile(sampleFile());
    expect(result.pages[0].name).toBe("Landing");
    expect(result.report.pageCount).toBe(1);
  });

  it("pulls content off a negative Figma origin onto the page margin", async () => {
    // A real file's content routinely sits at negative coordinates; left alone it
    // renders off-canvas, which is indistinguishable from an import that failed.
    const result = await importFigmaFile(sampleFile());
    const card = result.elements[0];
    expect(card.x).toBe(40);
    expect(card.y).toBe(40);
  });

  it("reproduces Figma's own boxes within a pixel, because Figma is the ground truth here", async () => {
    const result = await importFigmaFile(sampleFile());
    // A container Figma laid out correctly must not be downgraded.
    expect(result.report.maxDelta).toBeLessThanOrEqual(1);
    expect(result.report.downgraded).toHaveLength(0);
  });

  it("carries auto-layout rather than flattening it to coordinates", async () => {
    const result = await importFigmaFile(sampleFile());
    expect(layoutOf(result.elements[0])).toMatchObject({ mode: "flex", direction: "column", gap: 8 });
  });

  it("uses the document name for the page when Figma gave the canvas no name", async () => {
    const json = sampleFile();
    delete canvases(json)[0].name;
    const result = await importFigmaFile(json);
    expect(result.pages[0].name).toBe("Page 1");
  });

  it("makes a page for an empty canvas when a sibling canvas has content", async () => {
    // A designer clears a board and leaves it in the file. It is still a page they
    // will look for after the import, and a page that vanished is a page they
    // have to go and re-create.
    const json = sampleFile();
    canvases(json).unshift({ id: "AbC123:99", name: "Scratch", type: "CANVAS", children: [] } as FigmaNode);
    const result = await importFigmaFile(json as FigmaFileResponse);
    expect(result.pages.map((p) => p.name)).toEqual(["Scratch", "Landing"]);
  });

  it("refuses a file whose every canvas is empty, rather than appending a blank page", async () => {
    const result = importFigmaFile({
      document: { id: "K:0", type: "DOCUMENT", children: [{ id: "K:1", name: "Scratch", type: "CANVAS", children: [] }] }
    } as FigmaFileResponse);
    await expect(result).rejects.toThrow(/no layers/i);
  });

  it("promotes an instance into a linked FISH instance with a real master behind it", async () => {
    const json = sampleFile();
    canvases(json)[0].children = [
      {
        id: "K:9",
        name: "Button",
        type: "INSTANCE",
        componentId: "K:100",
        absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
        children: [
          {
            id: "K:10",
            name: "Label",
            type: "TEXT",
            absoluteBoundingBox: { x: 8, y: 8, width: 104, height: 24 },
            characters: "Click",
            style: { fontFamily: "Inter", fontSize: 14 }
          }
        ]
      }
    ];
    const result = await importFigmaFile(json as FigmaFileResponse);
    const instance = result.elements[0] as { type: string; componentId: string };
    expect(instance.type).toBe("instance");
    const masterPage = result.pages[result.pages.length - 1];
    expect(masterPage.children[0].id).toBe(instance.componentId);
    expect(masterPage.name).toMatch(/Components/);
  });

  it("keeps a mirrored instance's mirror, which rebuilding it from `rotation` alone dropped", async () => {
    // Promotion swaps the instance's frame for a link to a synthesized master, and
    // an element rebuilt field by field is where the mirror went missing: `rotation`
    // on its own describes the UNmirrored layer, so the instance landed a half turn
    // from the angle Figma drew it at. The mirror lives in the transform's negative
    // determinant and nowhere else — see `figmaFlip`.
    const json = sampleFile();
    canvases(json)[0].children = [
      {
        id: "K:9",
        name: "Pill",
        type: "INSTANCE",
        componentId: "K:100",
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
        size: { x: 100, y: 50 },
        relativeTransform: [
          [-1, 0, 0],
          [0, 1, 0],
          [0, 0, 1]
        ],
        rotation: 180,
        children: [
          {
            id: "K:10",
            name: "Label",
            type: "TEXT",
            absoluteBoundingBox: { x: 8, y: 8, width: 84, height: 24 },
            size: { x: 84, y: 24 },
            relativeTransform: [
              [1, 0, 8],
              [0, 1, 8],
              [0, 0, 1]
            ],
            characters: "Snacks",
            style: { fontFamily: "Inter", fontSize: 14 }
          }
        ]
      }
    ];
    const result = await importFigmaFile(json as FigmaFileResponse);
    const instance = result.elements[0] as { type: string; rotation?: number; flipX?: boolean; flipY?: boolean };
    expect(instance.type).toBe("instance");
    expect(instance).toMatchObject({ rotation: 180, flipY: true });
    expect(instance.flipX).toBeUndefined();
  });

  it("never names a synthesized master as downgraded, because no master was ever measured", async () => {
    // `state.measured` is Figma's own canvas box per node, and it means nothing
    // once promotion has cloned instances onto a synthetic components page: every
    // clone then misses by the distance between the two pages. A real 984-instance
    // import reported 95 downgrades and a 26000px maxDelta, every row naming a
    // `cmp_*` id — a node Figma never had. The invariant is the cheap one that
    // catches it: a downgrade names a Figma node, because a downgrade is a
    // disagreement with Figma.
    const json = sampleFile();

    for (const at of [40, 9000, 15500]) {
      canvases(json)[0].children = [
        {
          id: "K:9",
          name: "Button",
          type: "INSTANCE",
          componentId: "K:100",
          absoluteBoundingBox: { x: at, y: at, width: 200, height: 400 },
          children: [
            {
              id: "K:11",
              name: "Stack",
              type: "FRAME",
              absoluteBoundingBox: { x: at, y: at, width: 200, height: 400 },
              layoutMode: "VERTICAL",
              itemSpacing: 40,
              children: [
                {
                  id: "K:10",
                  name: "Label",
                  type: "TEXT",
                  absoluteBoundingBox: { x: at + 8, y: at + 8, width: 104, height: 24 },
                  characters: "Click",
                  style: { fontFamily: "Inter", fontSize: 14 }
                }
              ]
            }
          ]
        }
      ];
      // Collected AFTER the fixture is in place: the ids are the point, and an
      // empty set would make the assertion below pass for the wrong reason.
      const ids = new Set<string>();
      (function walk(node: FigmaNode): void {
        ids.add(node.id.replace(/[^a-zA-Z0-9_-]/g, "_"));
        for (const child of node.children ?? []) walk(child);
      })(json.document as FigmaNode);
      expect(ids.size).toBeGreaterThan(3);

      const result = await importFigmaFile(json as FigmaFileResponse);
      for (const row of result.report.downgraded) {
        expect(ids, `${row.id} is not a node Figma gave us`).toContain(row.id);
      }
    }
  });

  it("groups instances by CONTENT, so an override does not share a master it does not match", async () => {
    const button = (id: string, label: string) => ({
      id,
      name: "Button",
      type: "INSTANCE",
      componentId: "K:100",
      absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
      children: [
        {
          id: `${id}c`,
          name: "Label",
          type: "TEXT",
          absoluteBoundingBox: { x: 8, y: 8, width: 104, height: 24 },
          characters: label,
          style: { fontFamily: "Inter", fontSize: 14 }
        }
      ]
    });
    const json = sampleFile();
    canvases(json)[0].children = [button("K:20", "Save"), button("K:21", "Delete")] as FigmaNode[];
    const result = await importFigmaFile(json as FigmaFileResponse);
    // Two different overrides of one component -> two masters, not one shared.
    expect(result.pages[result.pages.length - 1].children).toHaveLength(2);
  });

  it("reports a gap rather than dropping what it could not carry", async () => {
    const json = sampleFile();
    (canvases(json)[0].children ??= []).push({
      id: "K:50",
      type: "STICKY",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }
    } as FigmaNode);
    const result = await importFigmaFile(json as FigmaFileResponse);
    expect(result.report.unmapped.some((g) => g.property === "node:type:STICKY")).toBe(true);
  });

  it("counts how many layers one kind of gap hit, so the report says 'many' not 'many rows'", async () => {
    const json = sampleFile();
    (canvases(json)[0].children ??= []).push(
      { id: "K:60", type: "STICKY", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "K:61", type: "STICKY", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }
    );
    const result = await importFigmaFile(json as FigmaFileResponse);
    const gap = result.report.unmapped.find((g) => g.property === "node:type:STICKY");
    expect(gap?.count).toBe(2);
  });

  it("refuses a file with no document rather than importing an empty one", async () => {
    await expect(importFigmaFile({ name: "x" } as unknown as FigmaFileResponse)).rejects.toThrow();
  });

  it("produces a document the app can read back", async () => {
    // The real acceptance criterion: `normalize` is what every load path runs, so
    // an import that only typechecks still has to survive being read.
    const result = await importFigmaFile(sampleFile());
    const page = result.pages[0];
    const doc = normalizeDesignDocument({
      id: "d",
      name: "Imported",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas: page.canvas,
      pages: result.pages,
      activePageId: page.id,
      elements: page.children
    }).document;
    expect(doc.pages[0].children.length).toBeGreaterThan(0);
    expect(doc.repairs ?? []).toEqual([]);
  });
});

describe("pages stay addressable", () => {
  it("gives every page an id the layer panel can key on", async () => {
    const result = await importFigmaFile(sampleFile());
    for (const page of result.pages as Page[]) {
      expect(page.id).toBeTruthy();
      expect(page.name).toBeTruthy();
    }
    expect(new Set(result.pages.map((p) => p.id)).size).toBe(result.pages.length);
  });
});

/**
 * A geometry audit over the REAL fixtures, rather than the hand-written ones above.
 *
 * `NaN` and `undefined` reach a document silently: the renderer skips them, the
 * layer panel prints them, and nothing errors — so an import that produced one
 * looks like an import that dropped a layer. This is what a render check would
 * have caught.
 */
describe("the import says what it is waiting for", () => {
  // Resizing and re-encoding a bundle's photographs is the slow part of a Figma
  // import and it used to happen with nothing on screen: one export was 38
  // photographs and 99.6MB of bytes, and a dialog showing a spinner and no words
  // is indistinguishable from one that has hung. That is how the export side
  // failed twice, so it is asserted here rather than left to be noticed.
  it("reports each image as it is finished, not as it is started", async () => {
    const seen: Array<[number, number]> = [];
    // The store's own reporting, through the option the dialog hands down.
    const result = await importFigmaFile(
      {
        document: {
          id: "P:0",
          name: "Doc",
          type: "DOCUMENT",
          children: [
            {
              id: "P:1",
              name: "Page",
              type: "CANVAS",
              children: [
                {
                  id: "P:2",
                  name: "Photo",
                  type: "RECTANGLE",
                  absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
                  fills: [{ type: "IMAGE", imageRef: "r1", scaleMode: "FILL" }]
                }
              ]
            }
          ]
        }
      } as FigmaFileResponse,
      {
        imageBlobs: new Map([["r1", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })]]),
        onProgress: (stage, done, total) => seen.push([done, total])
      }
    );
    // The bytes are not a real image, so the asset fails — and that is the point:
    // progress is reported for an image that FAILED too, because a run that
    // stalls on the broken one is the run that looks hung.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual([1, 1]);
    expect(result.report.unmapped.some((g) => g.property === "image:unresolved")).toBe(true);
  });
});

describe("every imported element is well formed", () => {
  const fixtures = ["figma-real-sample.json", "figma-sample.json", "figma-sample-screen.json"];

  for (const fixture of fixtures) {
    it(`${fixture} has no NaN, no undefined and no duplicate id`, async () => {
      const { readFileSync } = await import("node:fs");
      const json = JSON.parse(readFileSync(new URL(`../scripts/fixtures/${fixture}`, import.meta.url), "utf8")) as FigmaFileResponse;
      const result = await importFigmaFile(json);

      const ids = new Set<string>();
      const problems: string[] = [];
      const walk = (els: DesignElement[], path: string) => {
        for (const el of els) {
          for (const key of ["x", "y", "width", "height"] as const) {
            const v = el[key];
            if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`${path}/${el.id}.${key} = ${String(v)}`);
          }
          if (ids.has(el.id)) problems.push(`${path}/${el.id} duplicate id`);
          ids.add(el.id);
          if (el.type === "text" && (el as { content?: string }).content === undefined) {
            problems.push(`${path}/${el.id} text with no content`);
          }
          if (el.type === "path" && (el as { d?: string }).d === undefined) {
            problems.push(`${path}/${el.id} path with no d`);
          }
          const children = (el as { children?: DesignElement[] }).children;
          if (children) walk(children, `${path}/${el.id}`);
        }
      };
      for (const page of result.pages) walk(page.children, page.name);

      expect(problems).toEqual([]);
      // `JSON.stringify` turning a NaN into `null` is the same defect one level down.
      expect(JSON.stringify(result.pages)).not.toContain(":null");
    });
  }
});
// ---------------------------------------------------------------------------
// Bytes the caller already has
// ---------------------------------------------------------------------------

describe("imageFills supplied by the caller", () => {
  afterEach(() => vi.unstubAllGlobals());

  const file: FigmaFileResponse = {
    document: {
      id: "0:0",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          type: "CANVAS",
          children: [
            {
              id: "1:1",
              name: "Photo",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
              fills: [{ type: "IMAGE", imageRef: "r1" }]
            }
          ]
        }
      ]
    }
  } as FigmaFileResponse;

  it("resolves images with nothing to fetch", async () => {
    // The point of the option: a test can assert a document's images without a
    // fixture that only exists on someone's laptop, and a saved bundle can be
    // imported again with nothing to hand.
    vi.stubGlobal("fetch", () => {
      throw new Error("the offline path must not make a request");
    });
    const r = await importFigmaFile(file, { imageFills: { r1: "data:image/png;base64,iVBORw==" } });

    expect(r.assets).toHaveLength(1);
    expect(r.imageFills).toEqual({ r1: "data:image/png;base64,iVBORw==" });
    const photo = r.elements[0] as { fills?: unknown[] };
    expect(photo.fills?.[0]).toMatchObject({ type: "image", assetId: r.assets[0].id });
  });

  it("hands back the map it resolved, so the next import needs nothing", async () => {
    const r = await importFigmaFile(file, { imageFills: { r1: "data:image/png;base64,iVBORw==" } });
    const again = await importFigmaFile(file, { imageFills: r.imageFills });
    expect(again.assets.map((a) => a.uri)).toEqual(r.assets.map((a) => a.uri));
  });

  it("names a ref the bundle has no bytes for, rather than importing a blank", async () => {
    const r = await importFigmaFile(file, { imageFills: {} });
    expect(r.assets).toEqual([]);
    const gap = r.report.unmapped.find((g) => g.property === "image:unresolved");
    expect(gap?.value).toMatch(/no bytes/i);
  });
});

/**
 * The inline form, unpacked.
 *
 * The clipboard copy can only be text, so its images ride as data URIs — and a
 * data URI registered verbatim is the one form that skips the app's image
 * policy. Unpacking it into bytes here is what lets a paste take the same blob
 * path a folder does.
 */
describe("blobsFromImageFills", () => {
  it("turns each data URI into typed bytes, and skips what is not one", async () => {
    const blobs = blobsFromImageFills({
      png: "data:image/png;base64,iVBORw0KGgo=",
      jpeg: "data:image/jpeg;base64,/9j/4AAQ",
      junk: "not a data uri at all"
    });

    expect([...blobs.keys()]).toEqual(["png", "jpeg"]);
    expect(blobs.get("png")?.type).toBe("image/png");
    expect(blobs.get("jpeg")?.type).toBe("image/jpeg");
    expect(new Uint8Array(await (blobs.get("png") as Blob).arrayBuffer())).toEqual(
      Uint8Array.from(atob("iVBORw0KGgo="), (ch) => ch.charCodeAt(0))
    );
  });
});

// ---------------------------------------------------------------------------
// The image path, end to end
// ---------------------------------------------------------------------------

// Rotation, sizing, strokes and text: the fields that were silently wrong
// ---------------------------------------------------------------------------

describe("a turned frame carries its rotation and its children's own space", () => {
  it("gives the frame its own box and takes the children from their transforms", () => {
    // 200×100 turned 90° reports a 100×200 canvas bound, so the bound is not the
    // frame: importing it at that size and dropping the rotation left the frame
    // flat and 100px off, with its children laid out in a box it never had.
    const { el, state } = walkOne({
      id: "1:1",
      name: "Turned",
      type: "FRAME",
      absoluteBoundingBox: { x: 100, y: 0, width: 100, height: 200 },
      size: { x: 200, y: 100 },
      // A quarter turn clockwise on screen, which is the direction Figma calls −90.
      rotation: -90,
      children: [
        {
          id: "1:2",
          name: "Plain",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 100, y: 0, width: 20, height: 30 },
          size: { x: 20, y: 30 },
          // Parent-relative: (10, 20) inside the frame, unrotated within it.
          relativeTransform: [
            [1, 0, 10],
            [0, 1, 20],
            [0, 0, 1]
          ]
        },
        {
          id: "1:3",
          name: "Turned",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 100, y: 0, width: 30, height: 20 },
          size: { x: 20, height: 30 } as unknown as { x: number; y: number },
          relativeTransform: [
            [0, -1, 60],
            [1, 0, 20],
            [0, 0, 1]
          ]
        }
      ]
    });

    const frame = el as unknown as { width: number; height: number; rotation?: number; x: number; y: number; children: DesignElement[] };
    expect(frame).toMatchObject({ width: 200, height: 100, rotation: 90, x: 50, y: 50 });
    // Its own box, turned 90° about its centre, is the bound Figma reported —
    // which is the check that both numbers came off the same shape.
    expect(frame.x + frame.width / 2).toBe(150);
    expect(frame.y + frame.height / 2).toBe(100);

    // (10, 20) in the frame's own space, unchanged box: no canvas bound involved.
    expect(frame.children[0]).toMatchObject({ x: 10, y: 20, width: 20, height: 30 });
    expect(frame.children[0].rotation).toBeUndefined();
    expect(state.gaps).toHaveLength(0);
  });

  it("keeps a counter-turned child level, the way a rotated pill's label is", () => {
    // The shape Figma really writes for a component rotated on the canvas: the
    // instance a quarter turn one way, every layer inside it a quarter turn back,
    // so the pair nets to level. Both matrices are read; `rotation` states neither
    // of them in the DSL's direction, and reading a mirror out of the difference
    // (which is what a comparison against it did) put half a turn into each box —
    // cancelling in the net, and surviving as a flip for anything that dropped it,
    // such as the instance promotion.
    const turn = (deg: number, tx: number, ty: number) => {
      const r = (deg * Math.PI) / 180;
      return [
        [Math.cos(r), -Math.sin(r), tx],
        [Math.sin(r), Math.cos(r), ty]
      ];
    };
    const { el } = walkOne({
      id: "1:1",
      name: "Bot-menu",
      type: "INSTANCE",
      absoluteBoundingBox: { x: 0, y: 0, width: 49, height: 75 },
      size: { x: 75, y: 49 },
      relativeTransform: turn(90, 0, 0),
      rotation: -90,
      children: [
        {
          id: "1:2",
          name: "Label",
          type: "TEXT",
          absoluteBoundingBox: { x: 0, y: 66, width: 49, height: 11 },
          size: { x: 49, y: 11 },
          relativeTransform: turn(-90, 66, 49),
          rotation: 90,
          characters: "Snacks",
          style: { fontFamily: "Inter", fontSize: 12 }
        }
      ]
    });
    const frame = el as unknown as { rotation?: number; flipX?: boolean; flipY?: boolean; children: Array<Record<string, unknown>> };
    const label = frame.children[0];
    expect(frame).toMatchObject({ width: 75, height: 49, rotation: 90 });
    expect(frame.flipX).toBeUndefined();
    expect(frame.flipY).toBeUndefined();
    // Placed in the pill's own space, from the transform's centre.
    expect(label).toMatchObject({ x: 47, y: 19, width: 49, height: 11, rotation: 270 });
    expect(label.flipX).toBeUndefined();
    expect(label.flipY).toBeUndefined();
    // The whole point: a level label, which is what Figma drew.
    expect(((frame.rotation ?? 0) + (label.rotation as number)) % 360).toBe(0);
  });

  it("places a layer inside a turned frame from its transform, not its canvas bound", () => {
    // The child is turned within the frame as well, so its box comes off the
    // transform's rotation about its own centre: (0,−1 / 1,0) is a quarter turn,
    // and its centre lands at (−5, 30) in the frame's space.
    const { el, state } = walkOne({
      id: "1:1",
      name: "Turned",
      type: "FRAME",
      absoluteBoundingBox: { x: 100, y: 0, width: 100, height: 200 },
      size: { x: 200, y: 100 },
      rotation: 90,
      children: [
        {
          id: "1:2",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 100, y: 0, width: 30, height: 20 },
          size: { x: 20, y: 30 },
          relativeTransform: [
            [0, -1, 10],
            [1, 0, 20],
            [0, 0, 1]
          ]
        }
      ]
    });
    const child = (el as unknown as { children: Array<Record<string, unknown>> }).children[0];
    expect(child).toMatchObject({ x: -15, y: 15, width: 20, height: 30, rotation: 90 });
    // The centre the DSL will turn it about is the centre the transform put it at.
    expect(Number(child.x) + 20 / 2).toBeCloseTo(-5, 5);
    expect(Number(child.y) + 30 / 2).toBeCloseTo(30, 5);
    expect(state.gaps).toHaveLength(0);
  });

  it("names a turned container the response gave no size for", () => {
    // Without `size` there is no unrotated box to turn, so the bound is all there
    // is — and the rotation is named rather than drawn onto the wrong box.
    const { el, state } = walkOne(frame("1:1", [], { rotation: 30 }));
    expect(el?.rotation).toBeUndefined();
    expect(state.gaps.some((g) => g.property === "node:rotation")).toBe(true);
  });

  it("names a layer inside a turned frame when there is no transform to place it by", () => {
    const { state } = walkOne({
      id: "1:1",
      name: "Turned",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      size: { x: 100, y: 100 },
      rotation: 30,
      children: [{ id: "1:2", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }]
    });
    expect(state.gaps.some((g) => g.property === "rotation:relativeTransform")).toBe(true);
  });

  it("does not downgrade an auto-layout frame for holding a turned child", () => {
    // `measured` holds the bound of the child's rotation while the element's box
    // is its own, so comparing them blamed the parent's layout and stripped an
    // auto-layout that was right — a downgrade nobody could act on. The row here
    // is otherwise exact: the label sits where a row with no gap puts it.
    return importFigmaFile(
      {
        document: {
          id: "9:9",
          name: "Doc",
          type: "DOCUMENT",
          children: [
            {
              id: "9:10",
              name: "Page",
              type: "CANVAS",
              children: [
                {
                  id: "1:1",
                  name: "Row",
                  type: "FRAME",
                  layoutMode: "HORIZONTAL",
                  primaryAxisAlignItems: "MIN",
                  counterAxisAlignItems: "MIN",
                  absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 100 },
                  children: [
                    {
                      id: "1:2",
                      name: "Badge",
                      type: "RECTANGLE",
                      // Figma lays a turned child out by the box it PAINTS, not
                      // by the one it stores: the 50x50 badge covers 70.71 here,
                      // and it is that width the row reserves for it — so the
                      // label below starts at 70.71 and not at 50. A fixture that
                      // put it at 50 encoded the opposite rule and read as a
                      // downgrade the moment the engine honoured the envelope.
                      absoluteBoundingBox: { x: 0, y: 0, width: 70.71, height: 70.71 },
                      size: { x: 50, y: 50 },
                      rotation: 45,
                      fills: []
                    },
                    {
                      id: "1:3",
                      name: "Label",
                      type: "RECTANGLE",
                      absoluteBoundingBox: { x: 70.71, y: 0, width: 350, height: 20 },
                      fills: []
                    }
                  ]
                }
              ]
            }
          ]
        }
      } as unknown as FigmaFileResponse,
      { imageFills: {} }
    ).then((r) => {
      expect(r.report.downgraded).toEqual([]);
      expect(layoutOf(r.elements[0])).toBeDefined();
    });
  });
});

describe("sizing", () => {
  it("lets the precise sizing fields win over a legacy `layoutGrow`", () => {
    // A row child that fills its width and hugs its height used to come out
    // `{ width: fill, height: fill }`: the grow rule read `FILL` on the
    // horizontal axis as "so the grow must be vertical" and overwrote the HUG.
    const { el } = walkOne(
      frame("1:1", [
        {
          id: "1:2",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 40 },
          layoutGrow: 1,
          layoutSizingHorizontal: "FILL",
          layoutSizingVertical: "HUG"
        }
      ])
    );
    const child = (el as unknown as { children: Array<Record<string, unknown>> }).children[0];
    expect(child.sizing).toMatchObject({ width: "fill", height: "fit-content" });
  });

  it("gives a bare `layoutGrow` the axis its parent lays out on", () => {
    const row = walkOne(
      frame(
        "1:1",
        [{ id: "1:2", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, layoutGrow: 1 }],
        { layoutMode: "HORIZONTAL" }
      )
    );
    const rowChild = (row.el as unknown as { children: Array<Record<string, unknown>> }).children[0];
    expect(rowChild.sizing).toMatchObject({ width: "fill" });

    const column = walkOne(
      frame("2:1", [{ id: "2:2", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, layoutGrow: 1 }], {
        layoutMode: "VERTICAL"
      })
    );
    const columnChild = (column.el as unknown as { children: Array<Record<string, unknown>> }).children[0];
    expect(columnChild.sizing).toMatchObject({ height: "fill" });
    expect(columnChild.sizing).not.toMatchObject({ width: "fill" });
  });

  it("names a grid child's grow, which has no axis to fill", () => {
    const { state } = walkOne(
      frame(
        "1:1",
        [{ id: "1:2", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, layoutGrow: 1 }],
        { layoutMode: "GRID", gridColumnCount: 1, gridRowCount: 1 }
      )
    );
    expect(state.gaps.some((g) => g.property === "layoutGrow:grid")).toBe(true);
  });
});

describe("strokes and text fields", () => {
  it("carries both of a node's strokes instead of only the bottom one", () => {
    // An inner outline plus an outer ring is how a real file draws a button, and
    // only the first paint used to survive — silently, with an empty report.
    const { el, state } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      strokes: [
        { type: "SOLID", color: rgb(1, 1, 1) },
        { type: "SOLID", color: rgb(0, 0, 0) }
      ],
      strokeWeight: 2,
      fills: []
    });
    const strokes = (el as unknown as { strokes?: Array<{ paint?: { color?: string } }> }).strokes;
    expect(strokes).toHaveLength(2);
    expect(strokes?.[0].paint?.color).toBe("#ffffff");
    expect(strokes?.[1].paint?.color).toBe("#000000");
    expect(state.gaps).toHaveLength(0);
  });

  it("writes a single stroke as a one-layer stack, and no second spelling of it", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      strokes: [{ type: "SOLID", color: rgb(0, 0, 0) }],
      strokeWeight: 1,
      fills: []
    });
    expect((el as unknown as { stroke?: unknown }).stroke).toBeUndefined();
    expect(el?.strokes).toHaveLength(1);
    expect(el?.strokes?.[0]).toMatchObject({ style: "solid", width: 1 });
  });

  it("keeps a percentage line height a multiplier, which the plugin door reports instead of px", () => {
    const { el } = walkOne({
      id: "1:2",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      characters: "Percent",
      style: { fontFamily: "Inter", fontSize: 20, lineHeightPercent: 150 }
    });
    expect((el as unknown as { style: Record<string, unknown> }).style.lineHeight).toBe(1.5);
  });

  it("reads truncation where the plugin API keeps it, on the node", () => {
    // REST carries `textTruncation` / `maxLines` in `TypeStyle`; the plugin API
    // carries them on the text node, and the shim transports them where its own
    // API has them. Reading only the style turned a two-line clamped label with
    // an ellipsis into one clipped line on that door, and said nothing.
    const { el } = walkOne({
      id: "1:2",
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      characters: "A very long label",
      textAutoResize: "TRUNCATE",
      textTruncation: "ENDING",
      maxLines: 2,
      style: { fontFamily: "Inter", fontSize: 14 }
    });
    expect((el as unknown as { style: Record<string, unknown> }).style).toMatchObject({ maxLines: 2, textOverflow: "ellipsis" });
  });

  it("derives clockwise rotation from relativeTransform, not inversing the angle", () => {
    // Figma plugin exports relativeTransform alongside counter-clockwise node.rotation.
    // In screen coordinates (Y down), a clockwise rotation has positive sin θ in column 0.
    const { el } = walkOne({
      id: "1:2",
      type: "RECTANGLE",
      size: { x: 80, y: 35 },
      rotation: -39.52,
      relativeTransform: [
        [0.77138, -0.63637, 46.27],
        [0.63637, 0.77138, 22]
      ],
      absoluteBoundingBox: { x: 24, y: 22, width: 83.98, height: 77.91 }
    });
    expect(el?.rotation).toBeCloseTo(39.52, 1);
  });
});

