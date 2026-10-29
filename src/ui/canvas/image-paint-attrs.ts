import type { AssetRef, ImagePaint } from "../../core/dsl/types";
import { croppedPlacement, type CropBox } from "../../core/geometry/image-crop";
import { imagePreserveAspectRatio } from "../../core/geometry/image-fit";

/** The attributes a bitmap layer paints with, in the box's own coordinate space. */
export interface ImagePaintImage {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
  preserveAspectRatio: string;
  transform?: string;
}

/**
 * One spelling of an image layer, for the canvas pattern, the inspector
 * thumbnail and (through the canvas) every export.
 *
 * A crop framing is emitted as a fixed natural-size `<image>` moved by
 * `transform`, so a crop drag changes one attribute and the browser keeps its
 * rasterization of the bitmap; every other mode keeps the browser's own
 * `preserveAspectRatio` framing, which is what those modes mean. The two cannot
 * drift because this is the only place either is written.
 */
export function imagePaintImage(
  paint: ImagePaint,
  box: CropBox,
  asset: Pick<AssetRef, "uri" | "width" | "height">,
  href: string = asset.uri
): ImagePaintImage | null {
  if (!asset.uri) return null;
  const natural =
    asset.width && asset.height ? { width: asset.width, height: asset.height } : null;
  const placement = croppedPlacement(paint, box, natural);
  if (placement && natural) {
    return {
      href,
      x: 0,
      y: 0,
      width: natural.width,
      height: natural.height,
      preserveAspectRatio: "none",
      transform: placement.transform
    };
  }
  return {
    href,
    x: 0,
    y: 0,
    width: box.width,
    height: box.height,
    preserveAspectRatio: imagePreserveAspectRatio(paint)
  };
}
