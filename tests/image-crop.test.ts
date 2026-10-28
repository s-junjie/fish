import { describe, it, expect } from "vitest";
import {
  assetNaturalSize,
  canPlaceCrop,
  clampCrop,
  containScale,
  coverCrop,
  coverScale,
  cropCorners,
  cropFramePoints,
  cropFromFraming,
  cropFromMove,
  cropFromPosition,
  cropFromRotate,
  cropHandleToResize,
  cropPinnedToBox,
  cropRotateZones,
  croppedPlacement,
  imageCropPlacement,
  CROP_MAX_SCALE,
  CROP_MIN_SCALE,
  MAX_OFFSET,
  type CropHandle
} from "../src/core/geometry/image-crop";
import { focalAnchor, imagePreserveAspectRatio } from "../src/core/geometry/image-fit";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { normalizeImageCrop } from "../src/core/dsl/normalize/paint";
import { imagePaintImage } from "../src/ui/canvas/image-paint-attrs";
import type { DesignDocument, DesignElement, ImageCrop, ImagePaint } from "../src/core/dsl/types";

const BOX = { width: 300, height: 200 };
/** 400×400 source: the probe's four quadrants, as a natural size. */
const SQUARE = { width: 400, height: 400 };

describe("coverScale / containScale", () => {
  it("covers on the demanding axis, contains on the slack one", () => {
    expect(coverScale(BOX, SQUARE)).toBe(0.75);
    expect(containScale(BOX, SQUARE)).toBe(0.5);
    expect(coverScale({ width: 400, height: 400 }, SQUARE)).toBe(1);
  });

  it("refuses a framing it cannot solve", () => {
    expect(canPlaceCrop({ width: 0, height: 10 }, SQUARE)).toBe(false);
    expect(canPlaceCrop(BOX, { width: 400, height: 0 })).toBe(false);
    expect(canPlaceCrop(BOX, null)).toBe(false);
    expect(canPlaceCrop(BOX, SQUARE)).toBe(true);
  });
});

describe("cropFromFraming", () => {
  it("reproduces what `cover` already paints, for every focal bucket", () => {
    // The same three buckets `imagePreserveAspectRatio` uses, read from the one
    // function that defines them.
    for (const fp of [undefined, { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }]) {
      const crop = cropFromFraming({ box: BOX, natural: SQUARE, fit: "cover", focalPoint: fp });
      const placement = imageCropPlacement(BOX, SQUARE, crop)!;
      const anchor = focalAnchor(fp);
      // A cover framing overflows on one axis only; the other is flush.
      expect(placement.width).toBe(300);
      expect(placement.height).toBe(300);
      expect(placement.x).toBeCloseTo((BOX.width - placement.width) * anchor.x, 6);
      expect(placement.y).toBeCloseTo((BOX.height - placement.height) * anchor.y, 6);
      expect(placement.transform).toContain("scale(0.75)");
    }
  });

  it("keeps a `contain` framing letterboxed, at the same place it was", () => {
    const crop = cropFromFraming({ box: BOX, natural: SQUARE, fit: "contain" });
    const placement = imageCropPlacement(BOX, SQUARE, crop)!;
    expect(placement.width).toBeCloseTo(200, 1);
    expect(placement.height).toBeCloseTo(200, 1);
    expect(placement.x).toBeCloseTo(50, 1);
    expect(placement.y).toBeCloseTo(0, 1);
  });

  it("normalizes a stretched `fill` onto cover, the one visible transition", () => {
    const stretched = cropFromFraming({ box: BOX, natural: SQUARE, fit: "fill" });
    expect(stretched).toEqual(coverCrop(BOX, SQUARE));
  });

  it("still enters crop mode with no natural size to solve", () => {
    expect(cropFromFraming({ box: BOX, natural: { width: 0, height: 0 } })).toEqual({
      x: 0,
      y: 0,
      scale: 1
    });
  });
});

describe("cropFromPosition", () => {
  /**
   * `object-position: 50% 62%` is a fraction of the OVERFLOW, which the focal
   * point's three buckets cannot say — 0.62 lands in the middle bucket and the
   * imported photo comes back centred.
   */
  it("places the bitmap at the continuous fraction, not the nearest bucket", () => {
    const crop = cropFromPosition({ box: BOX, natural: SQUARE, position: { x: 0.5, y: 0.62 }, fit: "cover" });
    const placement = imageCropPlacement(BOX, SQUARE, crop)!;
    expect(placement.y).toBeCloseTo((BOX.height - 300) * 0.62, 6);
    expect(placement.x).toBeCloseTo((BOX.width - 300) * 0.5, 6);
  });

  it("matches `cropFromFraming` wherever the two agree", () => {
    const centred = cropFromPosition({ box: BOX, natural: SQUARE, position: { x: 0.5, y: 0.5 }, fit: "cover" });
    expect(centred).toEqual(cropFromFraming({ box: BOX, natural: SQUARE, fit: "cover" }));
  });

  it("letterboxes a `contain` framing instead of covering", () => {
    const crop = cropFromPosition({ box: BOX, natural: SQUARE, position: { x: 0, y: 0 }, fit: "contain" });
    const placement = imageCropPlacement(BOX, SQUARE, crop)!;
    expect(placement.width).toBeCloseTo(200, 1);
    expect(placement.x).toBeCloseTo(0, 1);
  });
});

describe("imageCropPlacement", () => {
  it("paints the bitmap at its natural ratio, so nothing can stretch", () => {
    const placement = imageCropPlacement(BOX, SQUARE, { x: -0.5, y: -0.5, scale: 2 })!;
    expect(placement.width / placement.height).toBe(SQUARE.width / SQUARE.height);
    expect(placement.transform).toBe("translate(-150 -100) scale(1.5)");
    expect(placement.centerX).toBe(150);
    expect(placement.centerY).toBe(200);
  });

  it("returns nothing for a box or bitmap that has no size", () => {
    expect(imageCropPlacement({ width: 0, height: 0 }, SQUARE, { x: 0, y: 0, scale: 1 })).toBeNull();
    expect(
      imageCropPlacement(BOX, { width: 0, height: 0 }, { x: 0, y: 0, scale: 1 })
    ).toBeNull();
  });

  it("turns the bitmap about its own centre", () => {
    const placement = imageCropPlacement(BOX, SQUARE, { x: 0, y: 0, scale: 1, rotation: 30 })!;
    // The pivot is the PAINTED centre — the middle of the rect the transform's
    // own `scale` produces — not the natural centre: a transform list applies
    // right to left, so `rotate` never sees natural coordinates. Here the bitmap
    // is painted at 0.75, i.e. 300px wide, so the pivot is 150 and not 200.
    expect(placement.transform).toBe("translate(0 0) rotate(30 150 150) scale(0.75)");
    expect(placement.centerX).toBe(150);
    expect(placement.centerY).toBe(150);

    // …and it is the painted rect's own centre, not the box's: slide the framing
    // and the pivot must not follow the box along with the translate.
    const offset = imageCropPlacement(BOX, SQUARE, { x: 0.5, y: 0, scale: 1, rotation: 30 })!;
    expect(offset.transform).toBe("translate(150 0) rotate(30 150 150) scale(0.75)");
    expect(offset.centerX).toBe(300);
  });
});

describe("cropFromMove", () => {
  it("follows the pointer in box fractions", () => {
    const moved = cropFromMove({ x: 0, y: 0, scale: 1 }, BOX, 30, -20);
    expect(moved.x).toBeCloseTo(0.1, 6);
    expect(moved.y).toBeCloseTo(-0.1, 6);
  });

  it("refuses to divide by a collapsed box", () => {
    const start = { x: 0, y: 0, scale: 1 };
    expect(cropFromMove(start, { width: 0, height: 100 }, 10, 10)).toEqual(start);
  });
});

describe("cropFromRotate", () => {
  it("adds the pointer's turn about the centre", () => {
    const center = { x: 150, y: 150 };
    const turned = cropFromRotate({ x: 0, y: 0, scale: 1 }, center, { x: 300, y: 150 }, { x: 150, y: 300 });
    expect(turned.rotation).toBeCloseTo(90, 4);
  });

  it("accumulates from the framing it started at", () => {
    const center = { x: 150, y: 150 };
    const turned = cropFromRotate(
      { x: 0, y: 0, scale: 1, rotation: 45 },
      center,
      { x: 300, y: 150 },
      { x: 150, y: 300 }
    );
    expect(turned.rotation).toBeCloseTo(135, 4);
  });
});

describe("clampCrop", () => {
  it("keeps a framing finite and in range", () => {
    expect(clampCrop({ x: NaN, y: Infinity, scale: 0 }).scale).toBe(CROP_MIN_SCALE);
    expect(clampCrop({ x: 1e9, y: -1e9, scale: 1e9 })).toEqual({
      x: MAX_OFFSET,
      y: -MAX_OFFSET,
      scale: CROP_MAX_SCALE
    });
    expect(clampCrop({ x: 0, y: 0, scale: 1, rotation: -90 }).rotation).toBe(270);
    expect(clampCrop({ x: 0, y: 0, scale: 1, rotation: 0 }).rotation).toBeUndefined();
  });
});

describe("assetNaturalSize", () => {
  it("answers a complete pair", () => {
    expect(assetNaturalSize({ width: 400, height: 200 })).toEqual({ width: 400, height: 200 });
  });

  it("refuses rather than inventing the half a record is missing", () => {
    // The two fields are all-or-nothing: a record with one of them is corrupt,
    // not a square, and a framing solved from a guessed side is worse than a
    // crop that refuses and says why.
    expect(assetNaturalSize({ width: 400 })).toBeNull();
    expect(assetNaturalSize({ height: 200 })).toBeNull();
    expect(assetNaturalSize({ width: 0, height: 200 })).toBeNull();
    expect(assetNaturalSize({ width: 400, height: Number.NaN })).toBeNull();
    expect(assetNaturalSize(null)).toBeNull();
    expect(assetNaturalSize(undefined)).toBeNull();
  });
});

describe("overlay geometry", () => {
  it("puts the four corners where the paint is, after the rotation", () => {
    const placement = imageCropPlacement({ width: 100, height: 100 }, { width: 100, height: 100 }, {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 90
    })!;
    const corners = cropCorners(placement);
    const at = (id: string) => corners.find((c) => c.id === id)!;
    // A quarter turn about the centre swaps each corner with its neighbour.
    expect(at("nw").x).toBeCloseTo(100, 4);
    expect(at("nw").y).toBeCloseTo(0, 4);
    expect(at("se").x).toBeCloseTo(0, 4);
    expect(at("se").y).toBeCloseTo(100, 4);
  });

  it("puts the four rotate zones just outside the frame's corners", () => {
    const square = { width: 100, height: 100 };
    const at = (id: string) => cropRotateZones(square, 10).find((z) => z.id === id)!;
    expect(at("nw")).toEqual({ id: "nw", x: -10, y: -10, angle: 0 });
    expect(at("se")).toEqual({ id: "se", x: 110, y: 110, angle: 180 });
  });
});

describe("cropFramePoints", () => {
  it("names the box's own eight points, corners and edges, in render order", () => {
    // The frame IS the element's box, so these are the transform box's own
    // handles — the eight the resize solver already knows how to drag.
    const pts = cropFramePoints({ width: 200, height: 100 });
    expect(pts.map((p) => p.id)).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
    const at = (id: CropHandle) => pts.find((p) => p.id === id)!;
    expect(at("nw")).toEqual({ id: "nw", x: 0, y: 0 });
    expect(at("se")).toEqual({ id: "se", x: 200, y: 100 });
    expect(at("n")).toEqual({ id: "n", x: 100, y: 0 });
    expect(at("e")).toEqual({ id: "e", x: 200, y: 50 });
    expect(at("w")).toEqual({ id: "w", x: 0, y: 50 });
  });
});

describe("cropHandleToResize", () => {
  it("joins the frame's vocabulary to the transform box's, one to one", () => {
    expect(cropHandleToResize("nw")).toBe("tl");
    expect(cropHandleToResize("ne")).toBe("tr");
    expect(cropHandleToResize("se")).toBe("br");
    expect(cropHandleToResize("sw")).toBe("bl");
    expect(cropHandleToResize("n")).toBe("tm");
    expect(cropHandleToResize("e")).toBe("mr");
    expect(cropHandleToResize("s")).toBe("bm");
    expect(cropHandleToResize("w")).toBe("ml");

    // Eight handles in, eight distinct resize handles out: a collision would make
    // two different corners drag the same edge.
    const all: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    expect(new Set(all.map(cropHandleToResize)).size).toBe(8);
  });
});

describe("cropPinnedToBox", () => {
  const FROM_BOX = { width: 200, height: 120 };
  const ORIGIN = { x: 0, y: 0 };
  const COVER = coverCrop(FROM_BOX, SQUARE);

  /** Rotates `(dx, dy)` about the origin, matching the module's own convention. */
  const rot = (dx: number, dy: number, deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { x: dx * Math.cos(r) - dy * Math.sin(r), y: dx * Math.sin(r) + dy * Math.cos(r) };
  };

  /**
   * Where a framing puts the bitmap's centre on the CANVAS — the box's origin,
   * the box centre, and the bitmap's own offset from it, all turned by the
   * element's rotation. This is the quantity the pin has to hold constant, so it
   * is what the assertions below compare.
   */
  const canvasCentre = (
    box: { width: number; height: number },
    origin: { x: number; y: number },
    crop: ImageCrop,
    rotation = 0
  ) => {
    const p = imageCropPlacement(box, SQUARE, crop)!;
    const v = rot(p.centerX - box.width / 2, p.centerY - box.height / 2, rotation);
    return { x: origin.x + box.width / 2 + v.x, y: origin.y + box.height / 2 + v.y };
  };

  const held = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.5);
    expect(Math.abs(a.y - b.y)).toBeLessThan(0.5);
  };

  const pin = (
    to: { box: { width: number; height: number }; origin: { x: number; y: number } },
    rotation?: number
  ) =>
    cropPinnedToBox({
      crop: COVER,
      natural: SQUARE,
      from: { box: FROM_BOX, origin: ORIGIN },
      to,
      rotation
    });

  it("holds the bitmap still when an edge drag widens the box", () => {
    // An `e` drag pins the left edge and grows the width alone, so only the box
    // grows and the origin does not move.
    const to = { box: { width: 240, height: 120 }, origin: { x: 0, y: 0 } };
    const next = pin(to);
    held(canvasCentre(FROM_BOX, ORIGIN, COVER), canvasCentre(to.box, to.origin, next));
    // `scale` is a reading of the box, so a wider box needs a smaller multiple
    // of it to paint the same pixels — that is the whole "give ground" move.
    expect(next.scale).toBeLessThan(COVER.scale);
  });

  it("holds it when a corner drag moves the origin too", () => {
    // A `nw` drag pins the far corner: the box grows AND its top-left moves, so
    // holding the bitmap means re-reading its centre through both changes.
    const to = { box: { width: 240, height: 160 }, origin: { x: 40, y: 40 } };
    const next = pin(to);
    held(canvasCentre(FROM_BOX, ORIGIN, COVER), canvasCentre(to.box, to.origin, next));
    expect(next).not.toEqual(COVER);
  });

  it("holds it through the element's own rotation", () => {
    // The bitmap's canvas position is measured in the element's ROTATED frame, so
    // a box change under a turned layer has to be undone in that same frame.
    const rotation = 30;
    const to = { box: { width: 260, height: 140 }, origin: { x: -20, y: 15 } };
    const next = pin(to, rotation);
    held(canvasCentre(FROM_BOX, ORIGIN, COVER, rotation), canvasCentre(to.box, to.origin, next, rotation));
  });

  it("carries the bitmap's own angle over untouched", () => {
    // The element's rotation is not the bitmap's: the pin may not fold one into
    // the other, so a framed rotation survives a box change verbatim.
    const turned: ImageCrop = { ...COVER, rotation: 45 };
    const next = cropPinnedToBox({
      crop: turned,
      natural: SQUARE,
      from: { box: FROM_BOX, origin: ORIGIN },
      to: { box: { width: 240, height: 120 }, origin: { x: 0, y: 0 } }
    });
    expect(next.rotation).toBe(45);
  });

  it("degrades to a clamped framing rather than refusing when the box collapses", () => {
    // A box with no area has nothing to solve against, and the drag that produced
    // it is still in flight — so this returns a bounded framing, never null.
    const next = pin({ box: { width: 0, height: 120 }, origin: { x: 0, y: 0 } });
    expect(Number.isFinite(next.scale)).toBe(true);
    expect(next.scale).toBeGreaterThanOrEqual(CROP_MIN_SCALE);
  });
});

describe("imagePaintImage", () => {
  const naturalPaint: ImagePaint = { type: "image", assetId: "a", fit: "crop", crop: { x: 0, y: 0, scale: 2 } };
  const asset = { uri: "data:image/png;base64,x", width: 400, height: 400 };

  it("paints the crop at natural size and moves it with transform", () => {
    const img = imagePaintImage(naturalPaint, BOX, asset)!;
    expect(img).toEqual({
      href: asset.uri,
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      preserveAspectRatio: "none",
      transform: "translate(0 0) scale(1.5)"
    });
  });

  it("falls back to the browser's own framing for every other mode", () => {
    const cover: ImagePaint = { type: "image", assetId: "a", fit: "cover" };
    expect(imagePaintImage(cover, BOX, asset)).toEqual({
      href: asset.uri,
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      preserveAspectRatio: "xMidYMid slice"
    });
  });

  it("falls back when the bitmap's size was never recorded", () => {
    const unknown = { uri: asset.uri };
    const img = imagePaintImage(naturalPaint, BOX, unknown)!;
    expect(img.transform).toBeUndefined();
    expect(img.preserveAspectRatio).toBe("xMidYMid slice");
  });

  it("paints nothing without a source", () => {
    expect(imagePaintImage(naturalPaint, BOX, { uri: "" })).toBeNull();
  });
});

describe("croppedPlacement", () => {
  it("is only reachable through the crop mode and a solved size", () => {
    expect(croppedPlacement({ fit: "crop", crop: { x: 0, y: 0, scale: 1 } }, BOX, SQUARE)).not.toBeNull();
    expect(croppedPlacement({ fit: "cover", crop: { x: 0, y: 0, scale: 1 } }, BOX, SQUARE)).toBeNull();
    expect(croppedPlacement({ fit: "crop" }, BOX, SQUARE)).toBeNull();
    expect(croppedPlacement({ fit: "crop", crop: { x: 0, y: 0, scale: 1 } }, BOX, null)).toBeNull();
  });
});

describe("normalizeImageCrop", () => {
  it("keeps a complete framing", () => {
    expect(normalizeImageCrop({ x: 0.25, y: -0.5, scale: 2 })).toEqual({
      x: 0.25,
      y: -0.5,
      scale: 2
    });
  });

  it("reads the alias spellings", () => {
    expect(normalizeImageCrop({ x: 0, y: 0, zoom: 3, angle: 45 })).toEqual({
      x: 0,
      y: 0,
      scale: 3,
      rotation: 45
    });
  });

  it("defaults a missing scale to the cover framing", () => {
    expect(normalizeImageCrop({ x: 0, y: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("refuses an incomplete or impossible framing, with a reason", () => {
    const repairs: { kind: string; path: string; message: string }[] = [];
    expect(normalizeImageCrop({ y: 0, scale: 1 }, "/p", repairs as never)).toBeUndefined();
    expect(normalizeImageCrop({ x: 0, y: 0, scale: 0 }, "/p", repairs as never)).toBeUndefined();
    expect(normalizeImageCrop("big", "/p", repairs as never)).toBeUndefined();
    expect(repairs.map((r) => r.kind)).toEqual(["image", "image", "image"]);
    expect(repairs.every((r) => r.path === "/p/crop")).toBe(true);
  });

  it("clamps a runaway framing rather than dropping it", () => {
    expect(normalizeImageCrop({ x: 1e6, y: 0, scale: 1e6 })).toEqual({
      x: MAX_OFFSET,
      y: 0,
      scale: CROP_MAX_SCALE
    });
  });

  it("passes nothing at all through untouched", () => {
    expect(normalizeImageCrop(undefined)).toBeUndefined();
  });
});

describe("a crop survives a load", () => {
  const doc = (element: unknown): DesignDocument =>
    ({
      docId: "d",
      version: "0.1",
      name: "n",
      canvas: { width: 1440, height: 900, background: { type: "solid", color: "#FFFFFF" } },
      pages: [{ id: "p1", name: "P1", children: [element] }]
    }) as unknown as DesignDocument;

  const only = (d: DesignDocument): DesignElement => d.pages[0].children[0] as DesignElement;
  const fillOf = (d: DesignDocument) => (only(d) as { fills: ImagePaint[] }).fills[0];

  it("keeps fit crop and the framing on the fill layer", () => {
    const { document } = normalizeDesignDocument(
      doc({
        type: "rect",
        width: 300,
        height: 200,
        fills: [{ type: "image", assetId: "a", fit: "crop", crop: { x: 0.1, y: 0.2, scale: 1.5 } }]
      })
    );
    expect(fillOf(document).fit).toBe("crop");
    expect(fillOf(document).crop).toEqual({ x: 0.1, y: 0.2, scale: 1.5 });
  });

  it("drops a broken framing and says so", () => {
    const { document, repairs } = normalizeDesignDocument(
      doc({
        type: "rect",
        width: 300,
        height: 200,
        fills: [{ type: "image", assetId: "a", fit: "crop", crop: { x: 0, y: 0, scale: -2 } }]
      })
    );
    expect(fillOf(document).crop).toBeUndefined();
    expect(repairs.some((r) => r.kind === "image" && r.message.includes("crop"))).toBe(true);
  });
});
