import type { DesignDocument, Paint } from "../../core/dsl/types";
import { buildCssGradient, isGradientPaint } from "../../core/geometry/gradient-utils";
import { patternCssBackground } from "../../core/geometry/pattern-tile";
import { gradientKindLabel, isGradientKind } from "../paint-kind";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";

/**
 * What a paint row shows: the swatch behind the checkerboard, and the text beside
 * it. Fill and Stroke each derived both inline and drifted — three different
 * fallbacks for "a paint I cannot paint", and one hardcoded "Gradient" suffix
 * spelled three ways. These are the derivations, once.
 */

/**
 * What a paint row's swatch paints, over the checkerboard.
 *
 * `imageUri` is what an image layer needs: the row was handed a flat fallback
 * and drew a grey square for a fill that paints a photo, which is a row whose
 * only colour is the answer it refuses to show.
 */
export function paintSwatchBackground(
  paint: Paint | undefined,
  fallback: string,
  imageUri?: (paint: Paint) => string | undefined
): string {
  if (!paint) return fallback;
  if (paint.type === "solid") return paint.color;
  if (paint.type === "pattern") return patternCssBackground(paint);
  if (isGradientPaint(paint)) {
    return buildCssGradient(paint);
  }
  if (paint.type === "image") {
    const uri = imageUri?.(paint);
    return uri ? `url("${uri}") center / cover no-repeat` : fallback;
  }
  return fallback;
}

/**
 * What a paint with no colour of its own puts behind the checkerboard.
 *
 * It lives here, not beside one of its callers: Fill, Stroke and the style
 * editor all need it, and it is the same question they were each answering
 * inline with a literal of their own.
 */
export const IMAGE_SWATCH_FALLBACK = "#333333";

/**
 * The bitmap an image paint names, as the URI a preview can paint.
 *
 * Four surfaces previewed an image layer by reaching into `doc.assets`
 * themselves, and the fifth (the style editor's banner and its cards) forgot to
 * — so an image fill saved as a colour style previewed as an empty
 * checkerboard. The lookup lives here so a preview cannot be written without
 * one: `paintStackLayers` skips an image layer it cannot resolve, silently.
 */
export function paintImageUri(doc: DesignDocument | undefined): (paint: Paint) => string | undefined {
  const assets = doc?.assets ?? [];
  return (paint) =>
    paint.type === "image" ? assets.find((asset) => asset.id === paint.assetId)?.uri : undefined;
}

/** The row's name for a paint that has no hex to show. */
export function paintRowLabel(paint: Paint, imageName?: string): string {
  if (paint.type === "image") return imageName || t("paint.image");
  if (paint.type === "pattern") return t(`pattern.${paint.motif}`);
  if (isGradientKind(paint.type)) return gradientKindLabel(paint.type);
  return paint.type;
}

/** What the drag ghost carries: the hex when there is one, the name otherwise. */
export function paintGhostLabel(paint: Paint, imageName?: string): string {
  if (paint.type === "solid") return parseColorAlpha(paint.color).hex6.toUpperCase();
  return paintRowLabel(paint, imageName);
}
