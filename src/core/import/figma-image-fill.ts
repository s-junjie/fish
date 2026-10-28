/**
 * A bitmap turned inside its own layer, written as a DSL crop framing.
 *
 * Figma places a fill's image in two different places, and which one is live
 * depends on the scale mode: `imageTransform` for CROP — where the image may be
 * moved, scaled and turned freely — and `rotation` for FILL / FIT / TILE, which
 * is only ever a quarter turn. Both are the DSL's `ImageCrop`, so neither needs a
 * new case in the renderer; what they need is to be read in the right space.
 *
 * `rotation` is worth its own conversion because the two compose with the layer's
 * own angle in opposite directions — a layer turned a quarter turn with a bitmap
 * turned back the other way reads as square on screen, and reading the layer's
 * angle alone puts it a quarter turn out.
 */

import type { ImageCrop } from "../dsl/types";
import { coverScale, type CropBox as FillSize } from "../geometry/image-crop";
import type { FigmaPaint } from "./figma-types";

/** Whole quarter turns, in Figma's counter-clockwise degrees. */
type QuarterTurn = 0 | 90 | 180 | 270;

/**
 * How far the bitmap is turned inside the layer, snapped to a quarter turn.
 *
 * CROP answers 0 because its turn is already inside `imageTransform`, which
 * `figmaFillCrop` reads directly; TILE answers 0 because the DSL has no paint for
 * a turned bitmap to sit in, and the caller names that gap rather than
 * half-applying it here.
 *
 * Snapped rather than validated because the API guarantees multiples of 90 and a
 * writer that says 90.000001 means 90; a refusal would silently drop a turn.
 */
function quarterTurn(paint: FigmaPaint): QuarterTurn {
  if (paint.scaleMode === "CROP" || paint.scaleMode === "TILE") return 0;
  const raw = paint.rotation;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const snapped = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
  return snapped as QuarterTurn;
}

/** Whether the paint names a turned bitmap at all. */
export function figmaFillIsTurned(paint: FigmaPaint): boolean {
  return quarterTurn(paint) !== 0;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isSize = (size: FillSize | null | undefined): size is FillSize =>
  !!size && size.width > 0 && size.height > 0;
const isNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * How far the two axes may disagree and still be one uniform scale.
 *
 * Figma's crop can be SQUASHED — resizing a layer whose fill is CROP stretches
 * the image with it, which is the documented difference from FILL — and the DSL's
 * crop paints the bitmap at one `paintScale` and has no stretch to spend. The
 * residue in a real export is under a percent (the layer was resized after the
 * crop was set, and the matrix carries the difference); a deliberate squash is
 * ten times that. So a small mismatch is averaged away and a large one falls back
 * to a cover with the gap naming why.
 */
const UNEVEN_TOLERANCE = 0.1;

/**
 * CROP's framing, read out of the transform Figma stores it in.
 *
 * `imageTransform` is a 2×3 matrix that maps the LAYER's unit square onto the
 * IMAGE's: `[[a, b, tx], [c, d, ty]]` reads as "the layer shows the image from
 * `(tx, ty)`, `a` of its width and `d` of its height". The layer is the crop
 * WINDOW; the matrix says which part of the picture is behind it.
 *
 * It is easy to read the other way round — as "where the bitmap is painted" —
 * and the failure that produces is not subtle but is easy to misdiagnose: the
 * matrix then has to describe the bitmap's size, so the two axes only agree when
 * the picture is exactly the layer's aspect, and every ordinary crop reads as an
 * enormous squash and falls out to a cover. (Which is where this started: a
 * 1172×641 layer over a 606×523 photograph implied a 150 % stretch, and the
 * "crop is in the wrong place" was really "there is no crop".)
 *
 * The DSL's crop is the same object from the other side — the bitmap painted at
 * one `paintScale` with its top-left at a fraction of the box — so the framing is
 * the INVERSE map, and the inverse of a normalize-space matrix is a plain 2×2
 * inverse scaled by the box. In the unrotated case that collapses to something
 * worth remembering: `crop.x === -tx / a`.
 *
 * Null when there is nothing to solve — no transform, a degenerate or mirrored
 * one, an uneven squash, or a bitmap whose recorded size is missing — and the
 * caller names the fallback rather than painting a cover as if it were the design.
 */
function cropFromImageTransform(
  paint: FigmaPaint,
  box: FillSize,
  natural: FillSize
): ImageCrop | null {
  const m = paint.imageTransform;
  if (!Array.isArray(m) || m.length < 2) return null;
  const [a, b, tx] = m[0] ?? [];
  const [c, d, ty] = m[1] ?? [];
  if (![a, b, tx, c, d, ty].every(isNumber)) return null;
  const det = a * d - b * c;
  if (!(Math.abs(det) > 1e-9)) return null;
  // A negative determinant is a mirror, which the DSL's crop has no term for.
  if (det < 0) return null;

  // The image's own axes as the LAYER sees them, i.e. the inverse of the linear
  // part — one image unit, in layer-normalized units.
  const toLayerX = { x: d / det, y: -c / det };
  const toLayerY = { x: -b / det, y: a / det };
  // …and in the box's px, which is the space a crop is written in.
  const axisX = { x: toLayerX.x * box.width, y: toLayerX.y * box.height };
  const axisY = { x: toLayerY.x * box.width, y: toLayerY.y * box.height };
  const scaleX = Math.hypot(axisX.x, axisX.y) / natural.width;
  const scaleY = Math.hypot(axisY.x, axisY.y) / natural.height;
  if (!(scaleX > 0) || !(scaleY > 0)) return null;
  if (Math.abs(scaleX - scaleY) > UNEVEN_TOLERANCE * Math.max(scaleX, scaleY)) return null;

  // The two axes carry their own scale, and one `paintScale` has to serve both.
  // The mean splits the residue instead of spending it on one axis: on a real
  // export, where the disagreement is 0.6 %, that puts every edge within half a
  // percent of where the matrix says it is.
  const paintScale = (scaleX + scaleY) / 2;
  const width = natural.width * paintScale;
  const height = natural.height * paintScale;
  // The bitmap's own origin, which is where the visible region's top-left sits in
  // the image — negative when the window opens inside the picture, which is the
  // ordinary case and is why the framing is a translate and not an offset.
  const originX = -(toLayerX.x * tx + toLayerY.x * ty) * box.width;
  const originY = -(toLayerX.y * tx + toLayerY.y * ty) * box.height;
  // The painted rect's centre, which is what the framing has to land — the corner
  // is derived from it rather than the other way round, because the DSL turns the
  // rect about this same point.
  const centerX = originX + (axisX.x + axisY.x) / 2;
  const centerY = originY + (axisX.y + axisY.y) / 2;
  const rotation = round4((((Math.atan2(axisX.y, axisX.x) * 180) / Math.PI) % 360 + 360) % 360);

  return {
    x: round4((centerX - width / 2) / box.width),
    y: round4((centerY - height / 2) / box.height),
    scale: round4(paintScale / coverScale(box, natural)),
    ...(rotation !== 0 ? { rotation } : {})
  };
}

/**
 * The crop framing that reproduces a turned FILL/FIT bitmap, or `null` when it
 * cannot be solved — no turn to place, or a box / bitmap size that is missing.
 *
 * `null` is a degradation the caller names, never a silent one: the bitmap then
 * keeps the plain cover, which is a quarter turn out.
 *
 * The framing is the one the DSL's crop already means — the bitmap painted at
 * `coverScale(box) × scale`, centred in the box, turned about its own middle —
 * so a turn of 90° or 270° also re-solves the base: the turned bitmap's extents
 * are the source's swapped, and covering with it means covering with those.
 * Handing back the plain `coverScale` would leave two empty bands where the
 * designer sees photograph, which is exactly the difference between FILL and FIT.
 */
export function figmaFillCrop(
  paint: FigmaPaint,
  box: FillSize | null | undefined,
  natural: FillSize | null | undefined
): ImageCrop | null {
  if (paint.scaleMode === "CROP") {
    return isSize(box) && isSize(natural) ? cropFromImageTransform(paint, box, natural) : null;
  }
  const turn = quarterTurn(paint);
  if (turn === 0) return null;
  if (!isSize(box) || !isSize(natural)) return null;

  // Figma measures counter-clockwise; the DSL's `ImageCrop.rotation` is degrees
  // clockwise, the same sense as the SVG `rotate()` it renders through.
  const rotation = (360 - turn) % 360;
  const swapped = turn === 90 || turn === 270;
  const cover = coverScale(box, natural);
  const paintScale = swapped
    ? Math.max(box.width / natural.height, box.height / natural.width)
    : cover;
  const width = natural.width * paintScale;
  const height = natural.height * paintScale;

  // The painted centre has to land on the box centre: `x` is a fraction of the
  // box, and the painter adds the painted size's own half back on top of it.
  return {
    x: round4((box.width - width) / (2 * box.width)),
    y: round4((box.height - height) / (2 * box.height)),
    scale: round4(paintScale / cover),
    rotation
  };
}
