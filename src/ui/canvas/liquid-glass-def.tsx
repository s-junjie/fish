import { VNode } from "preact";
import { DesignElement } from "../../core/dsl/types";
import { InstanceBox } from "../../core/interactions/instance-inherit";
import { bakeGlass, refractFilterId } from "./liquid-glass";

/**
 * Liquid Glass's edge lensing: a displacement map whose R/G channels carry the
 * shape's outward normal scaled by the deflection profile, so `feDisplacementMap`
 * bends the backdrop along the rim like a slab with a curved edge. Referenced by
 * the backdrop div as `backdrop-filter: blur(...) url(#lg_refract_<id>)`.
 *
 * Dispersion is a chromatic split, and `feDisplacementMap` has exactly one
 * scale — so the three channels are separated, thrown by three different
 * amounts and summed back together. The map is shared, because its magnitude is
 * normalised: only the scale differs between the passes.
 */
export function renderLiquidGlassDef(
  el: DesignElement,
  box: InstanceBox | null,
  viewScale: number
): VNode | null {
  const bake = bakeGlass(
    el,
    box?.effects ?? el.effects ?? [],
    undefined,
    viewScale
  );
  const field = bake?.field;
  if (!field) return null;
  const mapW = field.width + field.pad * 2;
  const mapH = field.height + field.pad * 2;
  /* The region is exactly the map's box, and that is load-bearing: a
     destination pixel outside the map reads channel 0, which is a shift of
     minus half the scale rather than no shift at all.

     The filter's user space is the backdrop div, which is the element's own
     box — it is NOT grown by the pad, because a grown box needs a
     `clip-path` and Chromium flattens that to a rectangle under any clipping
     frame (see `backdropShapeStyle`). So the region starts `pad` up and left
     of the origin; the backdrop filter region reaching past the div is what
     lets the rim sample the backdrop outside the panel. */
  const chromatic = bake.params.dispersion > 0;
  return (
    <filter
      key={`lg_${el.id}`}
      id={refractFilterId(el.id)}
      x={-field.pad}
      y={-field.pad}
      width={mapW}
      height={mapH}
      filterUnits="userSpaceOnUse"
      colorInterpolationFilters="sRGB"
    >
      <feImage
        href={field.uri}
        x={-field.pad}
        y={-field.pad}
        width={mapW}
        height={mapH}
        preserveAspectRatio="none"
        result="lg-map"
      />
      {chromatic ? (
        <>
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="lg-r-src"
          />
          <feDisplacementMap
            in="lg-r-src"
            in2="lg-map"
            scale={field.scaleR}
            xChannelSelector="R"
            yChannelSelector="G"
            result="lg-r"
          />
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="lg-g-src"
          />
          <feDisplacementMap
            in="lg-g-src"
            in2="lg-map"
            scale={field.scaleG}
            xChannelSelector="R"
            yChannelSelector="G"
            result="lg-g"
          />
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            result="lg-b-src"
          />
          <feDisplacementMap
            in="lg-b-src"
            in2="lg-map"
            scale={field.scaleB}
            xChannelSelector="R"
            yChannelSelector="G"
            result="lg-b"
          />
          {/* The three passes hold disjoint channels, so adding them is the
              merge. Their alphas would add to three, hence the final `in`
              against the untouched source: that restores antialiasing at
              the shape's own edge. */}
          <feComposite in="lg-r" in2="lg-g" operator="arithmetic" k2="1" k3="1" result="lg-rg" />
          <feComposite in="lg-rg" in2="lg-b" operator="arithmetic" k2="1" k3="1" result="lg-rgb" />
          <feComposite in="lg-rgb" in2="SourceGraphic" operator="in" />
        </>
      ) : (
        <feDisplacementMap
          in="SourceGraphic"
          in2="lg-map"
          scale={field.scaleG}
          xChannelSelector="R"
          yChannelSelector="G"
        />
      )}
    </filter>
  );
}
