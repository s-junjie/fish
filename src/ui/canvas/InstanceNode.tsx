import type { VNode } from "preact";
import { BackdropBlurEffect, ComponentElement, DesignElement, Effect, InstanceElement, LiquidGlassEffect, RectElement } from "../../core/dsl/types";
import { paintLayerIndex } from "../../core/dsl/paint-stack";
import { isNeutralColorFilter } from "../../core/dsl/color-filter";
import { cssBlurFilter } from "../../core/css-encode";
import { rectToPathData } from "../../core/compile";
import { cornerRadiiOf } from "../../core/geometry/shape-path";
import { resolveStrokeWeights, strokeDashAttrs } from "../../core/geometry/stroke-utils";
import { resolveInstanceChildren } from "../../core/interactions/instance-resolve";
import { activeInstanceFills, InstanceBox } from "../../core/interactions/instance-inherit";
import { renderNonUniformStroke } from "./non-uniform-stroke";
import { shadowLodMarks } from "./shadow-lod";
// Type-only: erased at compile time, so this does not re-open the runtime edge
// SvgElementRenderer -> InstanceNode that would make the pair a module cycle.
import type { NodeRenderContext } from "./SvgElementRenderer";
import { bakeGlass, glassBackdropCss } from "./liquid-glass";
import { backdropShapeStyle } from "./backdrop-shape";
import { deviceScale } from "./device-scale";
import { isGradientPaint } from "../../core/geometry/gradient-utils";
import { resolveSolidPaintBlend } from "./SvgShapeNode";
import { CANVAS_MEASURE, CANVAS_ON_SELECT, withAlpha } from "./canvas-colors";

export interface InstanceNodeProps {
  el: InstanceElement;
  /** Null paints the missing-master placeholder instead of a body. */
  master: ComponentElement | null;
  /** The resolved box (`resolveInstanceBox`); null exactly when the master is. */
  box: InstanceBox | null;
  /**
   * The master's resolved subtree and the size its layout pass arrived at.
   * Supplied by the renderer so this pass and the `<defs>` pass cannot resolve
   * the same instance into two different trees.
   */
  content?: { children: DesignElement[]; width: number; height: number };
  isSelected: boolean;
  isMaskStencil: boolean;
  ctx: NodeRenderContext;
  onDoubleClick: (e: MouseEvent) => void;
  renderChildren: (els: DesignElement[]) => VNode[];
}

/**
 * Paints an instance: its own box (fills, strokes, effects, label) plus the
 * resolved clone of its master's children.
 *
 * Everything shown here comes from `resolveInstanceBox`, and so does the `<defs>`
 * pass in `CanvasDefs` — the two are separate render passes that must agree on
 * both the resolved stack and each layer's index in it (a gradient def emitted
 * from a different stack renders shifted). Never read `inst.fills` directly.
 */
export function InstanceNode({
  el,
  master,
  box,
  content,
  isSelected,
  isMaskStencil,
  ctx,
  onDoubleClick,
  renderChildren
}: InstanceNodeProps) {
  if (!master || !box) {
    return (
      <g transform={`translate(${el.x}, ${el.y})`} onMouseDown={(e) => ctx.onElementMouseDown(e, el)}>
        <rect
          x={0}
          y={0}
          width={el.width}
          height={el.height}
          fill={withAlpha(CANVAS_MEASURE, 0.08)}
          stroke={CANVAS_MEASURE}
          data-instance-placeholder="true"
        />
      </g>
    );
  }

  const resolvedChildren = content?.children ?? resolveInstanceChildren(el, master);
  const fillSource = box.fills;
  const effectiveFills = activeInstanceFills(box);
  const effectiveStrokes = box.strokes.filter((s: any) => {
    if (!s || s.enabled === false) return false;
    if (s.width > 0) return true;
    if (s.side === "custom" && s.sides) {
      return Object.values(s.sides).some((v: any) => typeof v === "number" && v > 0);
    }
    return false;
  });

  const boxLocalD = rectToPathData({
    width: box.width,
    height: box.height,
    borderRadius: box.borderRadius,
    cornerSmoothing: box.cornerSmoothing
  } as RectElement);

  // `resolveInstanceBox` already folds the master's effects in, so this is the
  // instance's OWN effects list too — an instance that declares `effects: []` to
  // suppress its master's shadow is honoured, and one that declares its own
  // shadow gets it. The `<filter>` itself is emitted by CanvasDefs from the same
  // resolved list, so referencing it by id is the only thing this pass owes.
  //
  // Without this the def existed and nothing pointed at it: a component with a
  // shadow painted flat the moment it was instantiated.
  const activeEffects = box.effects.filter((ef: Effect) => ef.enabled !== false);
  const svgFilterEffects = activeEffects.filter(
    (ef) => ef.type !== "backdrop-blur" && ef.type !== "liquid-glass"
  );
  const colorFilter = isNeutralColorFilter(el.adjust) ? undefined : el.adjust;
  const filterAttr =
    svgFilterEffects.length > 0 || colorFilter ? `url(#filter_${el.id})` : undefined;
  // The instance wraps itself in this chain, so it carries its own marks — see
  // `shadow-lod.ts`. `SvgNodeRenderer` deliberately does not apply the chain to
  // an instance too (that composited the shadow twice), and the marks follow it
  // for the same reason.
  const shadowMarks = shadowLodMarks(filterAttr, svgFilterEffects, colorFilter);

  /* The glass chain comes from the bake, the same one `CanvasDefs` builds the
     displacement filter from, so the two cannot disagree about whether a map
     exists. The resolved box is the space the backdrop div is clipped to, which
     is the space the map has to be laid out in. */
  const glass = isMaskStencil
    ? null
    : bakeGlass(el, activeEffects, { width: box.width, height: box.height }, ctx.rasterScale);
  const backdropParts: string[] = [];
  for (const ef of activeEffects) {
    if (ef.type === "backdrop-blur") {
      backdropParts.push(cssBlurFilter((ef as BackdropBlurEffect).blur));
    } else if (ef.type === "liquid-glass" && glass) {
      const chain = glassBackdropCss(el.id, glass);
      if (chain) backdropParts.push(chain);
    }
  }
  const backdropFilterCss = backdropParts.length > 0 ? backdropParts.join(" ") : undefined;

  const resolveAssetUri = (assetId: string): string | undefined =>
    (ctx.registry ? ctx.registry.getAsset(assetId) : ctx.docRef.current.assets?.find((a) => a.id === assetId))?.uri;

  return (
    <g filter={filterAttr} {...shadowMarks}>
      {backdropFilterCss && (
        <foreignObject
          data-backdrop-fo="true"
          x={el.x}
          y={el.y}
          width={Math.max(1, box.width)}
          height={Math.max(1, box.height)}
          // Decoration, and inert for the same reason as the one in
          // `SvgElementRenderer`: a transparent `<div>` does not make the
          // `foreignObject` stop hit-testing its own box, and this one is painted
          // BEFORE the instance's hit path, so it wins wherever the shape does not
          // cover the box (outside a rounded corner) and bubbles the press to the
          // canvas root instead of to the element.
          pointerEvents="none"
        >
          <div
            // `BACKDROP_CHAIN_ATTR` in `backdrop-lod.ts` — see the note on the
            // same attribute in `SvgNodeRenderer`.
            data-backdrop-chain={backdropFilterCss}
            style={{
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              backdropFilter: backdropFilterCss,
              WebkitBackdropFilter: backdropFilterCss,
              ...backdropShapeStyle(el, box.width, box.height, boxLocalD, box.borderRadius, box.cornerSmoothing)
            }}
          />
        </foreignObject>
      )}
      <g
        transform={`translate(${el.x}, ${el.y})`}
        onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
        onDblClick={onDoubleClick}
      >
        <path
          d={boxLocalD}
          fill={effectiveFills.length > 0 || isSelected ? "transparent" : "none"}
          data-hit="true"
          stroke="transparent"
          style={{ "--hit-stroke": `${effectiveStrokes[0]?.width || 0}px` }}
          pointerEvents="all"
        />
        {effectiveFills.map((f, idx) => {
          let fillVal = "none";
          let layerFilter: string | undefined;
          const resolved = resolveSolidPaintBlend(f, effectiveFills, Boolean(glass), isMaskStencil);
          if (f.type === "solid") {
            fillVal = resolved.fillVal ?? f.color;
          } else if (isGradientPaint(f)) {
            fillVal = `url(#grad_fill_${el.id}_${paintLayerIndex(fillSource, f, idx)})`;
          } else if (f.type === "image") {
            const uri = resolveAssetUri(f.assetId);
            if (uri) {
              const layerIdx = paintLayerIndex(fillSource, f, idx);
              fillVal = `url(#pat_${el.id}_${layerIdx})`;
              if (f.adjust && !isNeutralColorFilter(f.adjust)) {
                layerFilter = `url(#paintfilter_${el.id}_${layerIdx})`;
              }
            }
          } else if (f.type === "pattern") {
            fillVal = `url(#pat_${el.id}_${paintLayerIndex(fillSource, f, idx)})`;
          }
          return (
            <path
              key={idx}
              d={boxLocalD}
              fill={fillVal}
              filter={layerFilter}
              fillOpacity={resolved.opacity}
              style={resolved.blendMode ? { mixBlendMode: resolved.blendMode as any } : undefined}
            />
          );
        })}
        {effectiveStrokes.map((s: any, idx: number) => {
          const resolvedPaint = s.paint ? resolveSolidPaintBlend(s.paint, [s.paint], false, false) : null;
          const strokeColor =
            (s.paint?.type === "solid" ? resolvedPaint?.fillVal ?? s.paint.color : undefined) ||
            s.color ||
            CANVAS_ON_SELECT;
          const weights = resolveStrokeWeights(s);
          const align = (s.align || "center") as "inside" | "center" | "outside";
          const baseStrokeOpacity = typeof s.opacity === "number" ? s.opacity : 1;
          const strokeOpacity = resolvedPaint ? baseStrokeOpacity * resolvedPaint.opacity : baseStrokeOpacity;
          const strokeBlendStyle = resolvedPaint?.blendMode ? { mixBlendMode: resolvedPaint.blendMode as any } : undefined;
          if (!weights.isUniform) {
            return renderNonUniformStroke(
              weights,
              {
                width: box.width,
                height: box.height,
                radii: cornerRadiiOf(box.borderRadius, box.width, box.height)
              },
              strokeColor,
              align,
              strokeDashAttrs(s),
              strokeOpacity,
              `clip_stroke_in_${el.id}`,
              `mask_stroke_out_${el.id}`,
              idx
            );
          }
          // The master carries the align and the dashes the same way the
          // renderer does for a plain frame. Reading neither meant an instance
          // of a component with an inside-aligned dashed border drew it
          // centred and solid.
          if (align === "inside") {
            return (
              <path
                key={idx}
                d={boxLocalD}
                fill="none"
                stroke={strokeColor}
                strokeWidth={(s.width || 1) * 2}
                strokeOpacity={strokeOpacity}
                clipPath={`url(#clip_stroke_in_${el.id})`}
                style={strokeBlendStyle}
                {...strokeDashAttrs(s)}
              />
            );
          }
          if (align === "outside") {
            return (
              <path
                key={idx}
                d={boxLocalD}
                fill="none"
                stroke={strokeColor}
                strokeWidth={(s.width || 1) * 2}
                strokeOpacity={strokeOpacity}
                mask={`url(#mask_stroke_out_${el.id})`}
                style={strokeBlendStyle}
                {...strokeDashAttrs(s)}
              />
            );
          }
          return (
            <path
              key={idx}
              d={boxLocalD}
              fill="none"
              stroke={strokeColor}
              strokeWidth={s.width || 1}
              strokeOpacity={strokeOpacity}
              style={strokeBlendStyle}
              {...strokeDashAttrs(s)}
            />
          );
        })}
        {/* The rim, over the artwork — see `SvgElementRenderer` for why these are
            baked images rather than filter primitives. */}
        {glass?.dark && (
          <image
            href={glass.dark.uri}
            x={0}
            y={0}
            width={box.width}
            height={box.height}
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        )}
        {glass?.light && (
          <image
            href={glass.light.uri}
            x={0}
            y={0}
            width={box.width}
            height={box.height}
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        )}
      </g>
      <g
        transform={`translate(${el.x}, ${el.y})`}
        clipPath={box.clipContent ? `url(#clip_${el.id})` : undefined}
        data-clip-chain={box.clipContent ? `url(#clip_${el.id})` : undefined}
        data-clip-span={box.clipContent ? String(Math.max(box.width, box.height)) : undefined}
      >
        {renderChildren(resolvedChildren)}
      </g>
    </g>
  );
}
