import { VNode } from "preact";
import { DesignElement, DropShadowEffect, InnerShadowEffect, LayerBlurEffect, BlendMode } from "../../core/dsl/types";
import { InstanceBox } from "../../core/interactions/instance-inherit";
import { computeFilterRegion } from "./filter-region";
import { isNeutralColorFilter } from "../../core/dsl/color-filter";
import { appendColorFilterNodes } from "./color-filter-nodes";
import { cssPaintOrder } from "../../core/dsl/paint-stack";
import { parseBlendFlood } from "../../core/geometry/color-utils";
import { hasBackdropSurface, hasBlendOnlyFills, hasOwnInteriorFills, shadowSilhouette } from "./shadow-silhouette";
import { pushInnerShadow, pushMorphology, pushSilhouetteImage } from "./shadow-defs";
import { elementStrokes } from "./def-geometry";

/**
 * Render filter effects for an element that declares them.
 *
 * Backdrop effects are CSS backdrop-filter on the element <g>
 * (SvgElementRenderer) and must NOT produce SVG filter primitives.
 * A colour adjustment rides the same <filter> and runs first, so the
 * effect passes composite onto already-adjusted pixels.
 *
 * A plain function rather than a component: the defs passes return raw
 * `<filter>` vnodes, and the vnode shape is what the unit tests inspect.
 */
export function renderEffectFilterDef(
  el: DesignElement,
  box: InstanceBox | null,
  pixelScale: number
): VNode | null {
  const activeEffects = (box?.effects ?? el.effects ?? []).filter(
    (ef) => ef.enabled !== false &&
      // A break is geometry around the artwork; it has no filter primitive.
      ef.type !== "tear"
  );
  const colorFilter = isNeutralColorFilter(el.adjust) ? undefined : el.adjust;
  if (activeEffects.length === 0 && !colorFilter) return null;

  // Computed up front: a spread's silhouette is built to BE this rectangle.
  // In the element's OWN space — the renderer puts the element's translate
  // on a child `<g>`, so the filter (on the parent) works in the space the
  // element's x/y are expressed in, and the region has to move with them.
  const strokes = elementStrokes(el, box);
  let maxStrokeW = 0;
  for (const s of strokes) {
    if (!s || s.enabled === false) continue;
    if (typeof s.width === "number" && s.width > maxStrokeW) maxStrokeW = s.width;
  }
  // Frame titles live outside the element's filter (see
  // `FrameTitleOverlay`), so the region only has to cover the artwork.
  const region = computeFilterRegion(
    box?.width ?? el.width ?? 100,
    box?.height ?? el.height ?? 100,
    activeEffects,
    Math.max(16, maxStrokeW * 2)
  );
  const placed = { x: el.x + region.x, y: el.y + region.y, width: region.width, height: region.height };

  let input = "SourceGraphic";
  const primitives: any[] = [];
  if (colorFilter) {
    input = appendColorFilterNodes(primitives, colorFilter, input, `cf-${el.id}`);
  }

  const hasInterior = hasOwnInteriorFills(el);

  // Render effects from top to bottom (UI row order: top-most first)
  const uiEffects = cssPaintOrder(activeEffects);
  const innerIndices = uiEffects
    .map((e, i) => (e.type === "inner-shadow" ? i : -1))
    .filter((i) => i !== -1);

  uiEffects.forEach((ef, idx) => {
    // backdrop-blur is pure backdrop-filter (no SVG primitives);
    // liquid-glass keeps its rim-light primitives here.
    if (ef.type === "backdrop-blur") return;
    if (el.type === "text" && ef.type === "drop-shadow") return;
    if (ef.type === "drop-shadow") {
      const shadow = ef as DropShadowEffect;
      const blurResult = `fx-${idx}-drop-blur`;
      const offsetResult = `fx-${idx}-drop-offset`;
      const floodResult = `fx-${idx}-drop-flood`;
      const colorResult = `fx-${idx}-drop-color`;
      const mergeResult = `fx-${idx}-drop-merge`;
      const { floodColor, floodOpacity, effectiveBlendMode } = parseBlendFlood(shadow.color, shadow.blendMode);
      const blurVal = Math.max(0, shadow.blur ?? 4);
      const spread = shadow.spread ?? 0;
      const knockOutInterior =
        hasBackdropSurface(el) ||
        hasBlendOnlyFills(el) ||
        Boolean(shadow.blendMode && shadow.blendMode !== "normal");
      const silhouette =
        spread === 0 && (!knockOutInterior || hasInterior)
          ? null
          : shadowSilhouette(el, spread, !knockOutInterior, region, el);
      const spreadSource = silhouette
        ? pushSilhouetteImage(primitives, `fx-${idx}-drop-sil`, silhouette)
        : spread === 0
        ? "SourceAlpha"
        : pushMorphology(
            primitives,
            idx,
            "drop-spread",
            spread > 0 ? "dilate" : "erode",
            Math.abs(spread),
            "SourceAlpha",
            pixelScale
          );

      const useAlphaCut = knockOutInterior && spread === 0 && hasInterior;
      const reuseSpreadSilForCut = Boolean(knockOutInterior && spread === 0 && silhouette);
      const baseSil =
        knockOutInterior && !useAlphaCut && !reuseSpreadSilForCut
          ? shadowSilhouette(el, 0, false, region, el)
          : null;
      const needsCut = useAlphaCut || reuseSpreadSilForCut || Boolean(baseSil);
      const rawColorResult = needsCut ? `fx-${idx}-drop-raw-color` : colorResult;

      primitives.push(
        <feGaussianBlur
          key={blurResult}
          in={spreadSource}
          stdDeviation={blurVal / 2}
          result={blurResult}
        />,
        <feOffset
          key={offsetResult}
          in={blurResult}
          dx={shadow.offset?.x ?? 0}
          dy={shadow.offset?.y ?? 4}
          result={offsetResult}
        />,
        <feFlood key={floodResult} floodColor={floodColor} floodOpacity={floodOpacity} result={floodResult} />,
        <feComposite key={rawColorResult} in={floodResult} in2={offsetResult} operator="in" result={rawColorResult} />
      );

      if (useAlphaCut) {
        const alphaCutResult = `fx-${idx}-drop-cut-alpha`;
        primitives.push(
          <feComponentTransfer key={alphaCutResult} in="SourceAlpha" result={alphaCutResult}>
            <feFuncA type="linear" slope="255" intercept="0" />
          </feComponentTransfer>,
          <feComposite
            key={colorResult}
            in={rawColorResult}
            in2={alphaCutResult}
            operator="out"
            result={colorResult}
          />
        );
      } else if (reuseSpreadSilForCut) {
        primitives.push(
          <feComposite
            key={colorResult}
            in={rawColorResult}
            in2={spreadSource}
            operator="out"
            result={colorResult}
          />
        );
      } else if (baseSil) {
        const baseSilResult = pushSilhouetteImage(primitives, `fx-${idx}-drop-cut`, baseSil);
        primitives.push(
          <feComposite
            key={colorResult}
            in={rawColorResult}
            in2={baseSilResult}
            operator="out"
            result={colorResult}
          />
        );
      }

      if (effectiveBlendMode === "plus-lighter") {
        primitives.push(
          <feComposite
            key={mergeResult}
            in={input}
            in2={colorResult}
            operator="arithmetic"
            k2="1"
            k3="1"
            result={mergeResult}
          />
        );
      } else if (effectiveBlendMode && effectiveBlendMode !== "normal") {
        primitives.push(
          <feBlend
            key={mergeResult}
            in={input}
            in2={colorResult}
            mode={effectiveBlendMode as BlendMode}
            result={mergeResult}
          />
        );
      } else {
        primitives.push(
          <feMerge key={mergeResult} result={mergeResult}>
            <feMergeNode in={colorResult} />
            <feMergeNode in={input} />
          </feMerge>
        );
      }
      input = mergeResult;
    } else if (ef.type === "inner-shadow") {
      const innerPos = innerIndices.indexOf(idx);
      // Multiple inner shadows composite bottom-up so the top-most in UI renders on top
      const targetIdx = innerPos >= 0 ? innerIndices[innerIndices.length - 1 - innerPos] : idx;
      const inner = uiEffects[targetIdx] as InnerShadowEffect;
      const baseSil =
        hasBackdropSurface(el) && !hasInterior
          ? shadowSilhouette(el, 0, false, region, el)
          : null;
      input = pushInnerShadow(
        primitives,
        idx,
        "in",
        input,
        inner.color,
        inner.offset?.x ?? 0,
        inner.offset?.y ?? 4,
        Math.max(0, inner.blur ?? 4),
        inner.spread ?? 0,
        "SourceAlpha",
        inner.blendMode,
        pixelScale,
        (inner.spread ?? 0) === 0 ? null : shadowSilhouette(el, -(inner.spread ?? 0), false, region, el),
        baseSil
      );
    } else if (ef.type === "layer-blur") {
      const layer = ef as LayerBlurEffect;
      const blurResult = `fx-${idx}-blur`;
      primitives.push(
        <feGaussianBlur
          key={blurResult}
          in={input}
          stdDeviation={Math.max(0, layer.blur ?? 4) / 2}
          result={blurResult}
        />
      );
      input = blurResult;
    } else if (ef.type === "liquid-glass") {
      // The rim, the dark edge and the fill plate are all painted by the
      // renderer as real shapes; nothing about this effect belongs in an
      // `feInnerShadow`. It used to fake a specular with two offset inner
      // shadows, which drew a highlight all the way round and read as a
      // bevel — the mark of a raised button, not of a surface.
    }
  });

  if (primitives.length === 0) return null;

  return (
    <filter
      key={el.id}
      id={`filter_${el.id}`}
      filterUnits="userSpaceOnUse"
      x={placed.x}
      y={placed.y}
      width={placed.width}
      height={placed.height}
      /* ALWAYS sRGB, never the SVG default. A filter's working space is
         linearRGB unless told otherwise, and the source graphic passes THROUGH
         it: a photograph under a drop shadow is decoded, linearised, blended and
         re-encoded at 8 bits, which lands ±1–2 levels of error laid out in
         CONTOURS along its smooth gradients — a dark backdrop goes blotchy while
         the same photograph beside it, unfiltered, stays clean. sRGB pass-through
         measured 0.06/255 mean error against the unfiltered copy, linearRGB
         0.61 with visible banding. It is also the space CSS composites in, so
         blend modes and the colour-adjust chain agree with the CSS the effects
         are modelled on. */
      colorInterpolationFilters="sRGB"
    >
      {primitives}
    </filter>
  );
}
