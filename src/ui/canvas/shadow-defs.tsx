import { BlendMode, InnerShadowEffect } from "../../core/dsl/types";
import { parseBlendFlood } from "../../core/geometry/color-utils";
import { shadowSilhouette, SilhouetteImage } from "./shadow-silhouette";

const MORPHOLOGY_MAX_DEVICE_PX = 256;

/** Appends the dilate/erode chain for `radius`, returns the new chain output. */
export function pushMorphology(
  primitives: any[],
  idx: number,
  tag: string,
  operator: "dilate" | "erode",
  radius: number,
  input: string,
  pixelScale: number
): string {
  const chunk = Math.max(1, MORPHOLOGY_MAX_DEVICE_PX / Math.max(1, pixelScale));
  const count = Math.max(1, Math.ceil(radius / chunk));
  const each = radius / count;
  let source = input;
  for (let i = 0; i < count; i++) {
    const result = `fx-${idx}-${tag}-morph${i}`;
    primitives.push(<feMorphology key={result} in={source} operator={operator} radius={each} result={result} />);
    source = result;
  }
  return source;
}

/**
 * Pushes an `feImage` for a spread's silhouette and returns its result id.
 *
 * Preferred over `pushMorphology` for every reason in `shadow-silhouette`: an
 * exact rounded offset, no 256-device-pixel cap, and no per-pixel cost in the
 * radius. The caller falls back to the primitive when the outline is unknown.
 */
export function pushSilhouetteImage(primitives: any[], result: string, image: SilhouetteImage): string {
  primitives.push(
    <feImage
      key={result}
      href={image.uri}
      x={image.x}
      y={image.y}
      width={image.width}
      height={image.height}
      preserveAspectRatio="none"
      result={result}
    />
  );
  return result;
}

/** Appends the standard inner-shadow primitive chain, returns the new chain output. */
export function pushInnerShadow(
  primitives: any[],
  idx: number,
  tag: string,
  input: string,
  color: string,
  dx: number,
  dy: number,
  blurRadius: number,
  spread = 0,
  alphaSource = "SourceAlpha",
  blendMode?: BlendMode,
  pixelScale = 1,
  silhouette?: SilhouetteImage | null,
  baseSilhouette?: SilhouetteImage | null
): string {
  const alphaResult = `fx-${idx}-${tag}-alpha`;
  const offsetResult = `fx-${idx}-${tag}-offset`;
  const blurResult = `fx-${idx}-${tag}-blur`;
  const inverseResult = `fx-${idx}-${tag}-inverse`;
  const colorResult = `fx-${idx}-${tag}-color`;
  const shadowResult = `fx-${idx}-${tag}-shadow`;
  const overResult = `fx-${idx}-${tag}-over`;
  const { floodColor, floodOpacity, effectiveBlendMode } = parseBlendFlood(color, blendMode);

  if (baseSilhouette) {
    pushSilhouetteImage(primitives, alphaResult, baseSilhouette);
  } else {
    primitives.push(
      /* The silhouette has to be OPAQUE, and `SourceAlpha` is not. An element whose
         own fill is a tint — `rgba(217,180,65,.12)`, a hairline inset ring — is
         mostly transparent, so the largest alpha in its subtree is on its opaque
         CHILDREN: every glyph and every bordered chip. `alpha out shiftedAlpha` is
         then near 1 over each of them and the flood paints the shadow's colour on
         top, so a `.row` with `box-shadow: inset 2px 0 0 <accent>` turned its own
         label and its size chip the accent colour. Saturating first makes the
         silhouette 1 wherever anything in the element covers, which is the
         assumption the rest of the recipe is written against. */
      <feComponentTransfer key={alphaResult} in={alphaSource} result={alphaResult}>
        <feFuncA type="linear" slope="255" intercept="0" />
      </feComponentTransfer>
    );
  }

  /* A positive `spread` pulls the un-shadowed hole in by that much, which is what
     turns `inset 0 0 0 1px <colour>` into a 1px ring: with nothing eroding the
     silhouette the hole is the whole shape and the shadow has nowhere to land.
     Erosion happens before the offset and the blur, so the band is inset, then
     displaced, then softened — the order CSS defines.
     The hole is the element's own outline moved by `-spread`, which is exact
     when that outline is known; the primitive is the fallback. */
  let hole = alphaResult;
  if (spread !== 0) {
    hole = silhouette
      ? pushSilhouetteImage(primitives, `fx-${idx}-${tag}-sil`, silhouette)
      : pushMorphology(
        primitives,
        idx,
        tag,
        spread > 0 ? "erode" : "dilate",
        Math.abs(spread),
        alphaResult,
        pixelScale
      );
  }

  primitives.push(
    <feOffset key={offsetResult} in={hole} dx={dx} dy={dy} result={offsetResult} />,
    <feGaussianBlur
      key={blurResult}
      in={offsetResult}
      stdDeviation={Math.max(0, blurRadius) / 2}
      result={blurResult}
    />,
    <feComposite key={inverseResult} in={alphaResult} in2={blurResult} operator="out" result={inverseResult} />,
    <feFlood key={colorResult} floodColor={floodColor} floodOpacity={floodOpacity} result={colorResult} />,
    <feComposite key={shadowResult} in={colorResult} in2={inverseResult} operator="in" result={shadowResult} />
  );

  if (effectiveBlendMode === "plus-lighter") {
    primitives.push(
      <feComposite
        key={overResult}
        in={shadowResult}
        in2={input}
        operator="arithmetic"
        k2="1"
        k3="1"
        result={overResult}
      />
    );
  } else if (effectiveBlendMode && effectiveBlendMode !== "normal") {
    primitives.push(
      <feBlend
        key={overResult}
        in={shadowResult}
        in2={input}
        mode={effectiveBlendMode as BlendMode}
        result={overResult}
      />
    );
  } else {
    primitives.push(
      <feComposite key={overResult} in={shadowResult} in2={input} operator="over" result={overResult} />
    );
  }
  return overResult;
}
