import { Effect, DropShadowEffect, InnerShadowEffect, LayerBlurEffect } from "../../core/dsl/types";

export interface FilterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle a filter is computed over, in the element's own units.
 *
 * `userSpaceOnUse` rather than the `objectBoundingBox` percentages it used to
 * be, because the region is not only a clip: Chromium draws an `feImage` scaled
 * to FIT it (measured — an image placed at x/y/width/height still lands scaled
 * to the region, so a silhouette only lands 1:1 when the two are the same
 * rectangle). One spelling for the region and the image is what keeps them
 * equal, and it also makes the region independent of the element's real bbox,
 * which a stroke or an overflowing path can move.
 *
 * Every side keeps the floor the percentage spelling had — one whole box length
 * — so the region each element gets is the one it has always had.
 */
export function computeFilterRegion(
  width: number,
  height: number,
  activeEffects: Effect[],
  minPadFloor?: number
): FilterRegion {
  const w = Math.max(1, width || 100);
  const h = Math.max(1, height || 100);

  let padLeft = 0;
  let padRight = 0;
  let padTop = 0;
  let padBottom = 0;

  for (const ef of activeEffects) {
    if (ef.type === "drop-shadow") {
      const shadow = ef as DropShadowEffect;
      const dx = shadow.offset?.x ?? 0;
      const dy = shadow.offset?.y ?? 4;
      const blur = Math.max(0, shadow.blur ?? 4);
      const spread = (shadow as any).spread ?? 0;
      const radius = Math.max(0, spread) + blur * 3;
      padLeft = Math.max(padLeft, -dx + radius);
      padRight = Math.max(padRight, dx + radius);
      padTop = Math.max(padTop, -dy + radius);
      padBottom = Math.max(padBottom, dy + radius);
    } else if (ef.type === "inner-shadow") {
      // The hole the shadow is cut out of reaches `|spread|` past the box, and
      // the offset moves it while the blur spreads it. The RESULT is inside the
      // box, but the intermediates are not, and a hole clipped at the region's
      // edge would leave the shadow painting that edge solid.
      const inner = ef as InnerShadowEffect;
      const dx = inner.offset?.x ?? 0;
      const dy = inner.offset?.y ?? 4;
      const radius = Math.abs(inner.spread ?? 0) + Math.max(0, inner.blur ?? 4) * 3;
      padLeft = Math.max(padLeft, -dx + radius);
      padRight = Math.max(padRight, dx + radius);
      padTop = Math.max(padTop, -dy + radius);
      padBottom = Math.max(padBottom, dy + radius);
    } else if (ef.type === "layer-blur") {
      const layer = ef as LayerBlurEffect;
      const blur = Math.max(0, layer.blur ?? 4);
      const radius = blur * 3;
      padLeft = Math.max(padLeft, radius);
      padRight = Math.max(padRight, radius);
      padTop = Math.max(padTop, radius);
      padBottom = Math.max(padBottom, radius);
    }
  }

  const floorX = minPadFloor !== undefined ? minPadFloor : w;
  const floorY = minPadFloor !== undefined ? minPadFloor : h;
  const left = Math.ceil(Math.max(padLeft, floorX));
  const right = Math.ceil(Math.max(padRight, floorX));
  const top = Math.ceil(Math.max(padTop, floorY));
  const bottom = Math.ceil(Math.max(padBottom, floorY));

  return { x: -left, y: -top, width: w + left + right, height: h + top + bottom };
}

/**
 * How far the paint-level colour-adjustment region reaches past the shape's own
 * box. Kept as two named components rather than one number because they answer
 * different questions, and a region only ever answers right when both are read:
 *
 *   `PAINT_ADJUST_PAD_BOX` is a multiple of the box per side, so it scales with
 *   the artwork. Nothing in the chain needs it — every primitive an adjustment
 *   emits is pointwise, and a pointwise result at a pixel cannot depend on its
 *   neighbours — so shrinking it towards zero is pure saving.
 *
 *   `PAINT_ADJUST_PAD_PX` is what IS needed and does not scale: the antialiased
 *   edge of the fill the chain reads, which is a hair of the element, not a
 *   fraction of it.
 *
 * `scripts/probe-filter-region.mjs` reports the area these two multiply by.
 */
export const PAINT_ADJUST_PAD_BOX = 0;
export const PAINT_ADJUST_PAD_PX = 1;

/** See `paintAdjustRegion`: this one is fractions of the box, not units. */
export interface RegionFractions {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One paint layer's colour-adjustment region, as FRACTIONS of the artwork.
 *
 * Fractions rather than the user-space rectangle `computeFilterRegion` hands
 * back, because the two are read against different things: that one is placed by
 * hand next to a box the caller knows, this one resolves against whatever the
 * FILL's own bbox turns out to be — and for an imported path that is not always
 * the element's box. Keeping the percentages keeps the pad around the ARTWORK
 * when the two disagree, which a user-space rectangle cannot do: a tight region
 * computed from the wrong rectangle is a region that clips.
 *
 * A useful consequence for anyone measuring it: `width * height` of what this
 * returns IS the factor the region multiplies the artwork's area by, and the
 * arithmetic never needs a pixel in it.
 */
export function paintAdjustRegion(width: number, height: number): RegionFractions {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const padX = w * PAINT_ADJUST_PAD_BOX + PAINT_ADJUST_PAD_PX;
  const padY = h * PAINT_ADJUST_PAD_BOX + PAINT_ADJUST_PAD_PX;
  return {
    x: -padX / w,
    y: -padY / h,
    width: (w + padX * 2) / w,
    height: (h + padY * 2) / h
  };
}
