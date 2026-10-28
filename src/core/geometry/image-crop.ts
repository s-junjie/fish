import type { ImageCrop } from "../dsl/types";
import type { ResizeHandleType } from "./snap-guides";
import { focalAnchor } from "./image-fit";

export interface CropBox {
  width: number;
  height: number;
}

export interface CropNatural {
  width: number;
  height: number;
}

export type CropCorner = "nw" | "ne" | "se" | "sw";
export type CropEdge = "n" | "e" | "s" | "w";
/** Any of the frame's eight handles: the four corners and the four edge midpoints. */
export type CropHandle = CropCorner | CropEdge;

/**
 * Relative to the `cover` scale, so 1 is "exactly covers the box".
 *
 * Wide because the frame is a crop WINDOW: dragging its edge re-solves the
 * framing, and the size that comes out is divided by the box's own `cover`
 * scale — so a 2000px frame dragged down to the 10px resize floor multiplies
 * `scale` by 200 with nobody having touched the bitmap. These bounds are a net
 * for a broken writer, not a range the model works in.
 */
export const CROP_MIN_SCALE = 0.001;
export const CROP_MAX_SCALE = 1000;
/**
 * How far from the box's own origin a framing may place the bitmap, in box
 * widths.
 *
 * Also a consequence of the frame being the window: the offset is a fraction of
 * the box, so shrinking the box multiplies it — at the 10px drag floor one pixel
 * of bitmap offset is a tenth of a box width, and an honest framing reaches two
 * digits. A framing dragged past this is a runaway gesture, not a placement.
 */
export const MAX_OFFSET = 1000;

const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The scale at which the bitmap exactly covers the box — the base every crop
 * `scale` is a multiple of. `max` and not `min`: covering means no empty band,
 * so the box must be filled on its demanding axis.
 */
export function coverScale(box: CropBox, natural: CropNatural): number {
  return Math.max(box.width / natural.width, box.height / natural.height);
}

/** The scale at which the bitmap fits entirely inside the box (letterboxed). */
export function containScale(box: CropBox, natural: CropNatural): number {
  return Math.min(box.width / natural.width, box.height / natural.height);
}

/**
 * Whether a crop framing can be computed at all. A missing natural size (an
 * imported document, an asset that never decoded) or a collapsed box leaves
 * nothing to solve, and the renderer falls back to `preserveAspectRatio`.
 */
export function canPlaceCrop(box: CropBox, natural: CropNatural | undefined | null): boolean {
  return (
    !!natural &&
    isPositive(box.width) &&
    isPositive(box.height) &&
    isPositive(natural.width) &&
    isPositive(natural.height)
  );
}

/**
 * The bitmap's natural size, read off an asset record.
 *
 * `AssetRef.width` / `height` are optional — a document that was imported, or one
 * saved before the loader recorded a size, carries a `uri` and nothing else. The
 * two fields are all-or-nothing: a record with one of them is a corrupt record,
 * not a square, so it refuses rather than inventing the missing half.
 */
export function assetNaturalSize(
  asset: { width?: number; height?: number } | undefined | null
): CropNatural | null {
  return asset && isPositive(asset.width as number) && isPositive(asset.height as number)
    ? { width: asset.width as number, height: asset.height as number }
    : null;
}

export interface CropPlacement {
  /** The bitmap's top-left in the box's own space, px. */
  x: number;
  y: number;
  /** The bitmap's painted size, px. Its ratio IS the natural ratio: no stretch. */
  width: number;
  height: number;
  /** The multiple of the natural size the bitmap is painted at, px per source px. */
  paintScale: number;
  /** Degrees clockwise about the painted rect's centre. */
  rotation: number;
  /** That centre, in the box's own space. */
  centerX: number;
  centerY: number;
  /** The `transform` for an `<image width={natural.width} height={natural.height}>`. */
  transform: string;
}

/**
 * Where a crop framing paints, in the box's own space.
 *
 * The returned `transform` is applied to an `<image>` declared at the bitmap's
 * NATURAL size, which is what keeps a drag to one changing attribute: the
 * browser rasterizes the bitmap once and only re-places it per frame. The paint
 * itself carries `preserveAspectRatio="none"` — safe, because `width` and
 * `height` here are both derived from one `paintScale`, so they are the natural
 * ratio by construction and there is no aspect left for the browser to distort.
 *
 * `centerX` / `centerY` is where that transform lands the bitmap's middle, and
 * it is also the point the transform TURNS about. The two have to agree — a
 * rotation about the centre is only "turn in place" if the centre is the one
 * named in the string, which the note beside `rotate` below spells out.
 */
export function imageCropPlacement(
  box: CropBox,
  natural: CropNatural,
  crop: ImageCrop
): CropPlacement | null {
  if (!canPlaceCrop(box, natural)) return null;
  const paintScale = coverScale(box, natural) * crop.scale;
  const width = natural.width * paintScale;
  const height = natural.height * paintScale;
  const x = crop.x * box.width;
  const y = crop.y * box.height;
  const rotation = crop.rotation ?? 0;
  // The pivot is the PAINTED centre, not the natural one. A transform list is
  // applied right to left, so `rotate` acts on the already-scaled bitmap and its
  // centre has to be named in that same space; the natural centre is only the
  // right answer at `paintScale` 1. Anywhere else the bitmap turns about a point
  // that is not its own middle, which is why a turned image swings out of frame
  // — invisible on an opaque photo, because the tile clips the spill, and plain
  // as day on one with a transparent background.
  //
  // `width / 2` and not `centerX`: the translate has already carried the bitmap
  // to `x`, so the pivot is measured from the translated origin. The two numbers
  // differ by exactly `x`, which is nothing at all when the framing happens to
  // sit flush and everything when it does not.
  const rotate = rotation
    ? ` rotate(${round4(rotation)} ${round4(width / 2)} ${round4(height / 2)})`
    : "";
  return {
    x,
    y,
    width,
    height,
    paintScale,
    rotation,
    centerX: x + width / 2,
    centerY: y + height / 2,
    transform: `translate(${round4(x)} ${round4(y)})${rotate} scale(${round4(paintScale)})`
  };
}

export interface CropFromFramingInput {
  box: CropBox;
  natural: CropNatural;
  fit?: "cover" | "contain" | "fill" | "crop";
  focalPoint?: { x: number; y: number };
}

/**
 * The framing a fit mode already produces, written as a crop transform.
 *
 * This is what makes entering crop mode a pure UI change: for `cover` it
 * reproduces `preserveAspectRatio="… slice"` and for `contain` the letterbox it
 * already paints, so the first frame in crop mode is pixel-identical to the last
 * frame out of it. `fill` (a stretch) has no aspect-preserving equivalent — it
 * is normalized to `cover`, the one visible transition in this feature.
 *
 * Without a natural size there is nothing to solve, so the neutral framing (a
 * centred full-cover bitmap) is returned: entering crop still works, and the
 * moment the size is known the placement is right.
 */
export function cropFromFraming(input: CropFromFramingInput): ImageCrop {
  const { box, natural, focalPoint } = input;
  if (!canPlaceCrop(box, natural)) return { x: 0, y: 0, scale: 1 };
  const anchor = focalAnchor(focalPoint);
  return cropAt(box, natural, anchor, input.fit);
}

/**
 * The same framing, from a CONTINUOUS position rather than a focal anchor.
 *
 * CSS `object-position: 50% 62%` is a fraction of the overflow, and the focal
 * point's three buckets cannot say 62 — an imported photo framed on its
 * shoulders came back centred, 24px off on a 427px hero. `cover` / `contain`
 * read the position the same way, so one formula serves both.
 */
export function cropFromPosition(input: {
  box: CropBox;
  natural: CropNatural;
  position: { x: number; y: number };
  fit?: "cover" | "contain";
}): ImageCrop {
  const { box, natural, position, fit } = input;
  if (!canPlaceCrop(box, natural)) return { x: 0, y: 0, scale: 1 };
  return cropAt(box, natural, position, fit);
}

function cropAt(
  box: CropBox,
  natural: CropNatural,
  anchor: { x: number; y: number },
  fit?: "cover" | "contain" | "fill" | "crop"
): ImageCrop {
  const base = coverScale(box, natural);
  const scale = fit === "contain" ? containScale(box, natural) / base : 1;
  const width = natural.width * base * scale;
  const height = natural.height * base * scale;
  return {
    x: round4(((box.width - width) * anchor.x) / box.width),
    y: round4(((box.height - height) * anchor.y) / box.height),
    scale: round4(scale)
  };
}

/** A framing that covers the box centre-first: the Reset crop target. */
export function coverCrop(box: CropBox, natural: CropNatural): ImageCrop {
  return cropFromFraming({ box, natural, fit: "cover" });
}

export function clampCrop(crop: ImageCrop): ImageCrop {
  const scale = Number.isFinite(crop.scale)
    ? Math.min(CROP_MAX_SCALE, Math.max(CROP_MIN_SCALE, crop.scale))
    : 1;
  const clampOffset = (n: number) =>
    Number.isFinite(n) ? Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, n)) : 0;
  const rotation = crop.rotation
    ? ((Number.isFinite(crop.rotation) ? crop.rotation : 0) % 360 + 360) % 360
    : undefined;
  return {
    x: round4(clampOffset(crop.x)),
    y: round4(clampOffset(crop.y)),
    scale: round4(scale),
    ...(rotation ? { rotation: round4(rotation) } : {})
  };
}

/**
 * Where each of the eight handles sits on a rect, as a fraction of it: the four
 * corners and the four edge midpoints.
 *
 * One table for two rects, because these eight points name both — the frame's
 * handles and the bitmap's outline corners are the same points read against a
 * different rect.
 */
const HANDLE_FROM: Record<CropHandle, { x: number; y: number }> = {
  nw: { x: 0, y: 0 },
  ne: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  sw: { x: 0, y: 1 },
  n: { x: 0.5, y: 0 },
  e: { x: 1, y: 0.5 },
  s: { x: 0.5, y: 1 },
  w: { x: 0, y: 0.5 }
};

/** In render order, so a caller that draws them never has to sort them. */
const ALL_HANDLES: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The cursor's base angle per corner, in the canvas overlay's own convention. */
const CORNER_BASE_ANGLE: Record<CropCorner, number> = { nw: 0, ne: 90, se: 180, sw: 270 };

/** Rotates `(dx, dy)` about the origin, in px. */
function rotateVec(dx: number, dy: number, degrees: number): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/**
 * The eight handle points on the FRAME — the element's own box — in box space.
 *
 * The frame is the crop window, so these are the points a drag moves: the box's
 * own corners and edge midpoints, exactly the set the transform box offers. The
 * bitmap's outline is drawn from its own placement and is a REFERENCE — it is
 * what the window is aimed at, and it does not carry handles of its own.
 */
export function cropFramePoints(box: CropBox): { id: CropHandle; x: number; y: number }[] {
  return ALL_HANDLES.map((id) => ({
    id,
    x: HANDLE_FROM[id].x * box.width,
    y: HANDLE_FROM[id].y * box.height
  }));
}

/**
 * The transform-box resize handle a frame handle drags.
 *
 * A frame drag IS a resize — same solver, same 10px floor, same snapping — so
 * the two vocabularies have to be joined somewhere, and this is the join. Kept
 * as a name of its own rather than a rename of the crop handles, because the
 * crop overlay's handles are drawn and read by the crop vocabulary.
 */
const FRAME_RESIZE: Record<CropHandle, ResizeHandleType> = {
  nw: "tl",
  n: "tm",
  ne: "tr",
  e: "mr",
  se: "br",
  s: "bm",
  sw: "bl",
  w: "ml"
};

export function cropHandleToResize(handle: CropHandle): ResizeHandleType {
  return FRAME_RESIZE[handle];
}

export interface CropPinInput {
  /** The framing to hold. */
  crop: ImageCrop;
  natural: CropNatural;
  /** The box the framing was solved against, and where that box sat. */
  from: { box: CropBox; origin: { x: number; y: number } };
  /** The box it has to survive into, and where that box now sits. */
  to: { box: CropBox; origin: { x: number; y: number } };
  /** The element's own rotation about its box centre, in degrees. */
  rotation?: number;
}

/**
 * The framing that holds the bitmap still while the box moves under it.
 *
 * This is what makes the frame a crop WINDOW: the box is what changes, and the
 * bitmap keeps the canvas rect it already had — so dragging an edge reveals or
 * hides pixels instead of scaling them. Neither half of a framing survives the
 * box on its own, because both are statements ABOUT the box:
 *
 * 1. **Position.** `x` / `y` are box fractions, so the bitmap's centre is taken
 *    out to the space the element lives in — turned by the element's own
 *    rotation about the box centre, shifted by the box's origin — and read back
 *    into the new box. With no rotation it collapses to "the centre moves by the
 *    origin's own shift", which is the whole idea: the box slid out from under a
 *    bitmap that did not move.
 * 2. **Size.** The painted size is `natural × coverScale(box) × scale`, and
 *    `coverScale` is a reading of the box — so the old base is divided out and
 *    the new one divided in. `rotation` is carried over untouched: it is the
 *    bitmap's own angle, and the element's did not change.
 *
 * The result is clamped like any other framing, so an extreme drag degrades to a
 * bounded one instead of writing a document the loader would then have to repair.
 *
 * `flipX` / `flipY` are deliberately not read. The drag this compensates is
 * `resolveResizeBox`, which composes the rotation alone — so a pin that read the
 * mirror would be solving against a transform the drag itself never used. A
 * flipped layer is a hole in the transform box's resize too, and this is not the
 * place to close only half of it.
 */
export function cropPinnedToBox(input: CropPinInput): ImageCrop {
  const { crop, natural, from, to } = input;
  const before = imageCropPlacement(from.box, natural, crop);
  if (!before || !canPlaceCrop(to.box, natural)) return clampCrop(crop);
  const theta = input.rotation ?? 0;
  const pivotFrom = { x: from.box.width / 2, y: from.box.height / 2 };
  const pivotTo = { x: to.box.width / 2, y: to.box.height / 2 };

  const turned = rotateVec(before.centerX - pivotFrom.x, before.centerY - pivotFrom.y, theta);
  const onCanvas = {
    x: from.origin.x + pivotFrom.x + turned.x,
    y: from.origin.y + pivotFrom.y + turned.y
  };
  const back = rotateVec(
    onCanvas.x - to.origin.x - pivotTo.x,
    onCanvas.y - to.origin.y - pivotTo.y,
    -theta
  );
  const centre = { x: pivotTo.x + back.x, y: pivotTo.y + back.y };

  const baseFrom = coverScale(from.box, natural);
  const baseTo = coverScale(to.box, natural);
  const scale = baseTo > 0 ? (crop.scale * baseFrom) / baseTo : crop.scale;
  return clampCrop({
    ...crop,
    x: (centre.x - before.width / 2) / to.box.width,
    y: (centre.y - before.height / 2) / to.box.height,
    scale
  });
}

/** A body drag: the bitmap follows the pointer, the box does not move. */
export function cropFromMove(start: ImageCrop, box: CropBox, dx: number, dy: number): ImageCrop {
  if (!isPositive(box.width) || !isPositive(box.height)) return clampCrop(start);
  return clampCrop({ ...start, x: start.x + dx / box.width, y: start.y + dy / box.height });
}

/**
 * A rotate drag, degrees clockwise about the bitmap's own centre. The centre is
 * `x`/`y`/`scale` only, so rotation never has to re-solve the offset.
 */
export function cropFromRotate(
  start: ImageCrop,
  center: { x: number; y: number },
  from: { x: number; y: number },
  to: { x: number; y: number }
): ImageCrop {
  const angle = (p: { x: number; y: number }) =>
    (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
  const delta = angle(to) - angle(from);
  if (!Number.isFinite(delta)) return clampCrop(start);
  return clampCrop({ ...start, rotation: (start.rotation ?? 0) + delta });
}

/** A point on the bitmap, given as a fraction of it, in the box's own space. */
function pointOn(placement: CropPlacement, fx: number, fy: number): { x: number; y: number } {
  const turned = rotateVec(
    fx * placement.width - placement.width / 2,
    fy * placement.height - placement.height / 2,
    placement.rotation
  );
  return { x: placement.centerX + turned.x, y: placement.centerY + turned.y };
}

/** The bitmap's four corners in the box's own space, after its rotation. */
export function cropCorners(placement: CropPlacement): { id: CropCorner; x: number; y: number }[] {
  return (["nw", "ne", "se", "sw"] as CropCorner[]).map((id) => ({
    id,
    ...pointOn(placement, HANDLE_FROM[id].x, HANDLE_FROM[id].y)
  }));
}

/**
 * The four rotate hot zones: just outside each corner of the FRAME, along that
 * corner's own outward diagonal.
 *
 * This is the canvas's rotate interaction — hover just outside a corner, get the
 * rotate cursor, drag — rather than a grip on a leader line, so a bitmap is
 * turned the same way whether the layer or the fill inside it is what turns.
 * `angle` is the corner's base angle: it is what aims that cursor.
 *
 * They ride the FRAME rather than the bitmap because the frame is the box the
 * overlay draws and the box the pointer reads: the bitmap's own corners can be a
 * long way outside it, and a zone out there would be both unreachable and
 * ambiguous next to the frame's own handle.
 */
export function cropRotateZones(
  box: CropBox,
  distance: number
): { id: CropCorner; x: number; y: number; angle: number }[] {
  return (["nw", "ne", "se", "sw"] as CropCorner[]).map((id) => {
    const fx = HANDLE_FROM[id].x;
    const fy = HANDLE_FROM[id].y;
    return {
      id,
      x: fx * box.width + (fx === 1 ? distance : -distance),
      y: fy * box.height + (fy === 1 ? distance : -distance),
      angle: CORNER_BASE_ANGLE[id]
    };
  });
}

/** Whether a paint is in crop mode with a framing the renderer can honour. */
export function croppedPlacement(
  paint: { fit?: string; crop?: ImageCrop },
  box: CropBox,
  natural: CropNatural | undefined | null
): CropPlacement | null {
  if (paint.fit !== "crop") return null;
  if (!paint.crop || !natural) return null;
  return imageCropPlacement(box, natural, paint.crop);
}
