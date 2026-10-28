import type { Paint } from "../dsl/types";

type ImagePaint = Extract<Paint, { type: "image" }>;

export interface FocalPointLike {
  x: number;
  y: number;
}

/** Where a focal point lands on each axis: start, middle or end. */
export interface FocalAnchor {
  x: 0 | 0.5 | 1;
  y: 0 | 0.5 | 1;
}

/**
 * The bucket a focal point resolves to, as a fraction of the overflow.
 *
 * Shared with `cropFromFraming` rather than re-derived there: a document framed
 * by `focalPoint` has to enter crop mode on the framing it already had, and a
 * second copy of the `0.34 / 0.66` boundaries is how the two drift apart.
 */
export function focalAnchor(fp: FocalPointLike | undefined): FocalAnchor {
  const axis = (v: number | undefined): 0 | 0.5 | 1 =>
    v === undefined ? 0.5 : v < 0.34 ? 0 : v > 0.66 ? 1 : 0.5;
  return { x: axis(fp?.x), y: axis(fp?.y) };
}

/**
 * `preserveAspectRatio` for an image layer: the fit mode picks meet/slice, the
 * focal point picks the alignment anchor. Shared by the canvas renderer and the
 * inspector preview so the two cannot disagree about framing.
 *
 * `crop` reads as `slice` here on purpose — a crop framing is not expressible as
 * a `preserveAspectRatio`. This is the fallback path, taken only when the
 * bitmap's natural size is unknown and `imageCropPlacement` cannot run.
 */
export function imagePreserveAspectRatio(img: Pick<ImagePaint, "fit" | "focalPoint">): string {
  if (img.fit === "fill") return "none";
  const anchor = focalAnchor(img.focalPoint);
  const x = anchor.x === 0 ? "xMin" : anchor.x === 1 ? "xMax" : "xMid";
  const y = anchor.y === 0 ? "YMin" : anchor.y === 1 ? "YMax" : "YMid";
  return `${x}${y} ${img.fit === "contain" ? "meet" : "slice"}`;
}
