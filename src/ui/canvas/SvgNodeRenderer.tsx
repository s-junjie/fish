import {
  DesignElement,
  InstanceElement,
  ContainerElement,
  ComponentSetElement,
  TextElement,
  VideoElement,
  HtmlEmbedElement,
  Paint,
  PaintStyle,
  BackdropBlurEffect
} from "../../core/dsl/types";
import { getShapeLocalPath } from "../../core/geometry/gradient-utils";
import { isNeutralColorFilter } from "../../core/dsl/color-filter";
import { isContainer } from "../../core/geometry/tree-ops";
import {
  resolveInstanceBox,
  resolveInstanceNumberMode,
  resolveInstanceTheme,
  type InstanceBox
} from "../../core/interactions/instance-inherit";
import { resolveInstanceContent } from "../../core/interactions/instance-resolve";
import { getActiveNumberMode, getActiveTheme } from "../../core/interactions/mode-ops";
import { styleTables } from "../../core/interactions/style-tables";
import { InstanceNode } from "./InstanceNode";
import { cssBlurFilter } from "../../core/css-encode";
import { shadowLodMarks } from "./shadow-lod";
import { cssPaintOrder, paintLayerIndex, topPaint } from "../../core/dsl/paint-stack";
import { bakeGlass, glassBackdropCss } from "./liquid-glass";
import { backdropShapeStyle } from "./backdrop-shape";
import { deviceScale } from "./device-scale";
import { subtreeBounds } from "../../core/geometry/element-bounds";
import { isElementInViewport, areViewportBoxesEqual } from "../../core/geometry/cull";
import { resolveFrameTitles, FrameTitleName } from "./frame-titles";
import { FrameTitleOverlay } from "./FrameTitleOverlay";
import { findMasterComponentFast } from "./reference-registry";
import { memo } from "../memo";
import { elementPivot, elementTransform, elementTransform3d } from "../../core/geometry/transforms";
import { ComponentSetFrame } from "./ComponentSetFrame";
import {
  CANVAS_SELECT,
  CANVAS_COMPONENT,
  CANVAS_ON_SELECT
} from "./canvas-colors";
import { NodeRenderContext, SvgNodeProps } from "./NodeRenderContext";
import { renderFills, renderStrokes, resolveSolidPaintBlend } from "./SvgShapeNode";
import { maskBackdropClip, maskIsClip } from "./mask-defs";
import { SvgLineArrowNode } from "./SvgLineArrowNode";
import { SvgVideoNode } from "./SvgVideoNode";
import { SvgHtmlEmbedNode } from "./SvgHtmlEmbedNode";
import { SvgTextNode } from "./SvgTextNode";
import { EdgeShell } from "./EdgeLayer";
import { selectionTouchesSubtree } from "./selection-scope";

export function areSvgNodePropsEqual(prev: SvgNodeProps, next: SvgNodeProps): boolean {
  if (prev.el !== next.el) return false;
  if (prev.isEditingPath !== next.isEditingPath) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.isDragOver !== next.isDragOver) return false;
  if (prev.isEditingText !== next.isEditingText) return false;
  // The edited id is a DESCENDANT's state, so a frame whose own `isEditingText`
  // is false in both props still looks unchanged when the editor closes on a
  // child — and the whitelist then skips the subtree, leaving the in-place
  // editor mounted after Escape or after a click that changes neither the
  // selection nor the document. Compared as an id, not a boolean: it is still
  // one re-render of the tree per edit start/stop, and none while typing.
  if (prev.ctx.editingCanvasTextId !== next.ctx.editingCanvasTextId) return false;
  if (prev.ctx.editingPathId !== next.ctx.editingPathId) return false;
  if (next.isEditingText && prev.ctx.canvasTextDraft !== next.ctx.canvasTextDraft) return false;
  if (prev.isMaskStencil !== next.isMaskStencil) return false;
  // A selection change reaches a node through its own `isSelected` — already
  // compared above — and through the children it renders. Only a node that has a
  // changed id INSIDE it has something new to pass down: an unrelated selection
  // leaves this node's markup byte-identical. Comparing the set itself made a
  // mousedown on one layer re-render all 1,841 nodes on Page 1.
  //
  // `selectionChangedIds` is built once per selection change and compared by
  // identity, so a drag — which does not touch the selection — pays nothing.
  const changedIds = next.ctx.selectionChangedIds;
  if (
    changedIds &&
    changedIds.size > 0 &&
    prev.ctx.selectionChangedIds !== changedIds &&
    selectionTouchesSubtree(next.el, changedIds)
  ) {
    return false;
  }
  // A guide only changes when its text element or its target does, so identity
  // is the cheap correct test — and it must be compared at all, because this is a
  // whitelist: a `side` edit rewrites the string with the element and leaves the
  // guide map to a new generation only when the tree does.
  if (prev.el.type === "text" && prev.ctx.onPathGuides !== next.ctx.onPathGuides) return false;
  // Deliberately NOT compared: `zoom`, and `viewportBox`.
  //
  // `viewportBox` decides what is MOUNTED, and that now happens in
  // `renderNodeList`, which is not memoized — so by the time a node is asked
  // whether to re-render, the mounted set is already right. Comparing it here is
  // what made every wheel tick rebuild the whole visible tree to no effect.
  //
  // `zoom` is not compared either, because NO node reads it. Everything that
  // holds a constant number of screen pixels — the 8px hit slop, the component
  // mark, a set's dashed border — is expressed in CSS against `--fish-zoom`,
  // which CanvasArea writes outside the node markup; frame titles are painted by
  // their own overlay, outside the node; everything that is a raster is built
  // from `rasterScale`, which is quantised. So a zoom tick produces byte-identical
  // markup and the whole visible tree is served from memory.
  //
  // This is the invariant to re-check first if a zoom ever stops re-sizing
  // something: a node that reads `ctx.zoom` (or drops a `style={{ ... }}` that
  // feeds a `--fish-` variable) puts zoom back into markup, and this comparator
  // will happily skip the update.
  if (prev.ctx.rasterScale !== next.ctx.rasterScale) return false;
  if (prev.ctx.theme !== next.ctx.theme) return false;
  if (prev.ctx.numberMode !== next.ctx.numberMode) return false;
  if (prev.ctx.activeTool !== next.ctx.activeTool) return false;
  if (prev.el.type === "instance") {
    const prevInst = prev.el as InstanceElement;
    const nextInst = next.el as InstanceElement;
    const prevMaster = findMasterComponentFast(prev.ctx.docRef.current, prevInst.componentId, prev.ctx.registry);
    const nextMaster = findMasterComponentFast(next.ctx.docRef.current, nextInst.componentId, next.ctx.registry);
    if (prevMaster !== nextMaster) return false;
  }
  return true;
}

// Exported for the double-application guard in tests/instance-effects.test.ts:
// `InstanceNode` is unit-tested as a plain function, and the wrapper that used to
// shadow it is only reachable through this one.
export function SvgNodeRenderer({
  el,
  isSelected,
  isDragOver,
  isEditingText,
  isMaskStencil,
  ctx
}: SvgNodeProps) {
  if (el.visible === false && !isMaskStencil) return null;

  // The master is resolved FIRST because it is part of the theme question: an
  // instance inherits its master's mode exactly as it inherits its fills, and a
  // page authored in dark under a light document only reads as dark while that
  // holds. Asking the element alone fell back to the document's active theme and
  // re-materialised every cloned child in the wrong one.
  const instanceMaster =
    el.type === "instance"
      ? findMasterComponentFast(ctx.docRef.current, (el as InstanceElement).componentId, ctx.registry)
      : null;
  const inheritedTheme = ctx.theme || getActiveTheme(ctx.docRef.current);
  const elementTheme =
    el.type === "instance"
      ? resolveInstanceTheme(el as InstanceElement, instanceMaster, inheritedTheme)
      : el.themeMode || inheritedTheme;

  // The NUMBER axis is resolved the same way and travels beside `theme`, never
  // inside it: a compact card inside a dark page keeps its spacing, and vice
  // versa. Falling back to the colour mode is what an element that declares
  // neither inherits.
  const inheritedNumberMode = ctx.numberMode || getActiveNumberMode(ctx.docRef.current);
  const elementNumberMode =
    el.type === "instance"
      ? resolveInstanceNumberMode(el as InstanceElement, instanceMaster, inheritedNumberMode)
      : el.numberMode || inheritedNumberMode;

  const themeCtx =
    elementTheme === ctx.theme && elementNumberMode === ctx.numberMode
      ? ctx
      : { ...ctx, theme: elementTheme, numberMode: elementNumberMode };

  const instanceTables = instanceMaster ? styleTables(ctx.docRef.current) : null;
  const instanceContent =
    el.type === "instance" && instanceMaster
      ? resolveInstanceContent(el as InstanceElement, instanceMaster, {
          theme: elementTheme,
          numberMode: elementNumberMode,
          tables: instanceTables!
        })
      : null;
  const instanceBox = instanceMaster
    ? resolveInstanceBox(el as InstanceElement, instanceMaster, instanceContent ?? undefined, {
        theme: elementTheme,
        numberMode: elementNumberMode,
        tables: instanceTables!
      })
    : null;

  // Effects inherit from the master too — otherwise a component that carries a
  // shadow or blur paints flat the moment it is instantiated. `activeEffects`
  // feeds both the SVG `<filter>` and the backdrop-filter path below.
  const activeEffects = isMaskStencil
    ? []
    : (instanceBox ? instanceBox.effects : el.effects || []).filter((ef) => ef.enabled !== false);
  const svgFilterEffects = activeEffects.filter(
    (ef) =>
      ef.type !== "backdrop-blur" &&
      ef.type !== "liquid-glass" &&
      // A break is geometry around the artwork, not a filter primitive over it.
      ef.type !== "tear" &&
      !(el.type === "text" && ef.type === "drop-shadow")
  );
  const edgeEffects = activeEffects.filter((ef) => ef.type === "tear");
  const colorFilter = isMaskStencil || isNeutralColorFilter(el.adjust) ? undefined : el.adjust;
  const filterAttr =
    svgFilterEffects.length > 0 || colorFilter ? `url(#filter_${el.id})` : undefined;
  /* Marks for the pass that turns this off when the zoom has shrunk the shadow
     below a pixel of reach — see `shadow-lod.ts`. Only a filter made ENTIRELY of
     drop shadows is eligible: anything else changes pixels that survive being
     small (its colour, its silhouette), and none of those have been measured. */
  const shadowMarks = shadowLodMarks(filterAttr, svgFilterEffects, colorFilter);

  /* Liquid Glass goes through the bake rather than being spelled out here: the
     chain has to know whether a displacement map exists at all, and the map's own
     filter region comes from the same numbers. `backdrop-blur` keeps its own
     blur — a frosted panel that is also lensed is a supported pair, and the two
     effects compose in the order they were declared.
     An INSTANCE resolves its own stack (see `ownsEffects` below), glass included,
     so this pass must not paint a second copy of the plate and the rim over the
     child's. */
  const glass =
    isMaskStencil || el.type === "instance"
      ? null
      : bakeGlass(el, activeEffects, undefined, ctx.rasterScale);
  let backdropFilterCss: string | undefined;
  if (activeEffects.length > 0) {
    const backdropFilterParts: string[] = [];
    for (const ef of cssPaintOrder(activeEffects)) {
      if (ef.type === "backdrop-blur" && el.type !== "text") {
        backdropFilterParts.push(cssBlurFilter((ef as BackdropBlurEffect).blur));
      } else if (ef.type === "liquid-glass" && glass) {
        const chain = glassBackdropCss(el.id, glass);
        if (chain) backdropFilterParts.push(chain);
      }
    }
    if (backdropFilterParts.length > 0) backdropFilterCss = backdropFilterParts.join(" ");
  }

  /* A mask layer is PAINTED as well as being a mask — Figma draws it, and a
     tinted icon cannot work without it: the glyphs are the mask and they are
     also what you see. The stencil fade exists only to hide the white silhouette
     a mask draws of itself, so it belongs on the element's OWN paint and never
     on a container's children — which is where it was, and which is why a mask
     frame's icon and label painted at 0.1% and vanished. An instance mask is
     untouched: its paint comes from `InstanceNode`, which has no group of its
     own to fade. */
  const stencilFadesSelf = isMaskStencil && !isContainer(el);
  const elOpacity = stencilFadesSelf ? 0.001 : typeof el.opacity === "number" ? el.opacity : 1;
  // `InstanceNode` resolves the inherited stack itself and wraps ITSELF in this
  // same `filter_<id>` (and emits its own backdrop-filter foreignObject). Applying
  // either here as well ran the chain twice: a drop-shadow composited over an
  // already-shadowed result, so every instance of a component with elevation read
  // about twice as dark as the master — and as the same box detached into a frame.
  const ownsEffects = el.type === "instance";

  const hasBackdrop =
    !ownsEffects && backdropFilterCss !== undefined && el.type !== "line" && el.type !== "arrow" && el.type !== "text";

  // The pivot follows the RESOLVED box, not the stored snapshot: an instance that
  // inherits a size from its master rotates around the size it is painted at.
  const { x: cx, y: cy } = elementPivot(el, instanceBox ? instanceBox.width : el.width, instanceBox ? instanceBox.height : el.height);
  const transform = elementTransform(el, cx, cy);
  const transform3d = elementTransform3d(el);

  let activeFills = isMaskStencil
    ? [{ type: "solid" as const, color: CANVAS_ON_SELECT }]
    : el.fillEnabled !== false
      ? (el.fills || []).filter((f) => f && f.enabled !== false)
      : [];

  if (
    !isMaskStencil &&
    el.fillEnabled !== false &&
    el.fillStyleId &&
    (activeFills.length === 0 || (activeFills.length === 1 && activeFills[0].type === "solid" && activeFills[0].color === "#000000"))
  ) {
    const bound = (ctx.registry?.getStyle(el.fillStyleId) ||
      ctx.docRef.current.styles?.find((s) => s.id === el.fillStyleId)) as PaintStyle | undefined;
    if (bound && bound.styleType === "paint" && bound.paints && bound.paints.length > 0) {
      const boundSolid = bound.paints.length === 1 && bound.paints[0].type === "solid" ? bound.paints[0].color : null;
      if (boundSolid !== "#000000") {
        activeFills = bound.paints.filter((f) => f && f.enabled !== false);
      }
    }
  }

  /* Whether the element paints its own interior, and so owns it for hit testing.
     A leaf shape with no fill is deliberately click-through — an outline is
     grabbable, its inside belongs to whatever is behind it — but a BACKDROP
     EFFECT paints the whole box: the lens (or the frosted plate) is what the user
     sees and aims at, so a press inside it must select the element instead of
     falling through and marquee-ing every layer under the point. Containers
     already take their whole box unconditionally; this is the leaf-shape side of
     the same rule. */
  const ownsInterior = activeFills.length > 0 || hasBackdrop;

  const allStrokes = (el as any).strokes || [];
  const activeStrokes = isMaskStencil
    ? []
    : allStrokes.filter((s: any) => {
      if (!s || s.enabled === false) return false;
      if (s.width > 0) return true;
      if (s.side === "custom" && s.sides) {
        return Object.values(s.sides).some((v: any) => typeof v === "number" && v > 0);
      }
      return false;
    });

  const shapeLocalD = getShapeLocalPath(el);
  // Only a path can carry an interior rule, and it is read on the fill layers
  // AND on the transparent hit target: with `evenodd` the hole is not part of
  // the shape, so a hit path that ignored the rule would swallow clicks on it.
  const fillRule = el.type === "path" ? (el as any).fillRule : undefined;

  const fillLayerIndex = (f: Paint, fallback: number): number =>
    paintLayerIndex(el.fills, f, fallback);
  const strokeLayerIndex = (s: any, fallback: number): number =>
    paintLayerIndex(allStrokes, s, fallback);

  const resolveAssetUri = (assetId: string): string | undefined =>
    (ctx.registry ? ctx.registry.getAsset(assetId) : ctx.docRef.current.assets?.find((a) => a.id === assetId))?.uri;

  const isOtherElementWhileEditing = Boolean(ctx.editingPathId && el.id !== ctx.editingPathId);

  const handleDoubleClickToSelect = (e: MouseEvent) => {
    e.stopPropagation();
    // Frame/component/instance double-click must NOT drill into a child: deep
    // frame selection is governed by click-count + parent-scope rules in
    // useCanvasGestures (single click moves a selected frame, double click
    // pierces in). Only plain shapes/leaves self-select here.
    if (isContainer(el) || el.type === "instance" || Boolean((el as any).__instanceId)) return;
    ctx.setSelectedIds(new Set([el.id]));
  };

  // The group is only ever here to carry `pointer-events: none` while ANOTHER
  // element is being path-edited. Emitted unconditionally it was a bare wrapper
  // on every painted element — one of the canvas's ~3,400 single-child groups,
  // and a vnode Preact creates, diffs and inserts again on every mount.
  const contentBody = (
    <>
      {(el.type === "rect" || el.type === "ellipse" || el.type === "polygon" || el.type === "star" || el.type === "path") && (
        <g
          transform={`translate(${el.x}, ${el.y})`}
          onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
          onDblClick={handleDoubleClickToSelect}
        >
          <path
            d={shapeLocalD}
            fill={ownsInterior ? "transparent" : "none"}
            data-hit="true"
            fillRule={fillRule}
            stroke="transparent"
            style={{ "--hit-stroke": `${activeStrokes[0]?.width || 0}px` }}
            pointerEvents={ownsInterior ? "all" : "stroke"}
          />
          {renderFills(el, activeFills, shapeLocalD, fillRule, fillLayerIndex, resolveAssetUri, isMaskStencil, Boolean(glass))}
          {renderStrokes(el, activeStrokes, shapeLocalD, strokeLayerIndex)}
        </g>
      )}

      {(el.type === "line" || el.type === "arrow") && (
        <SvgLineArrowNode
          el={el}
          isArrow={el.type === "arrow"}
          activeStrokes={activeStrokes}
          strokeLayerIndex={strokeLayerIndex}
          ctx={ctx}
          onDoubleClick={handleDoubleClickToSelect}
        />
      )}

      {el.type === "video" && (
        <SvgVideoNode
          el={el as VideoElement}
          shapeLocalD={shapeLocalD}
          resolveAssetUri={resolveAssetUri}
          ctx={ctx}
          onDoubleClick={handleDoubleClickToSelect}
        />
      )}

      {el.type === "html" && (
        <SvgHtmlEmbedNode
          el={el as HtmlEmbedElement}
          shapeLocalD={shapeLocalD}
          resolveAssetUri={resolveAssetUri}
          isSelected={isSelected}
          ctx={ctx}
          onDoubleClick={handleDoubleClickToSelect}
        />
      )}

      {(el.type === "frame" || el.type === "component") && (
        <>
          <g
            transform={`translate(${el.x}, ${el.y})`}
            onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
            onDblClick={handleDoubleClickToSelect}
            /* The container's own silhouette, and only that — see `stencilFadesSelf`. */
            opacity={isMaskStencil ? 0.001 : undefined}
          >
            <path
              d={shapeLocalD}
              fill={activeFills.length > 0 ? "transparent" : "none"}
              data-hit="true"
              fillRule={fillRule}
              stroke="transparent"
              style={{ "--hit-stroke": `${activeStrokes[0]?.width || 0}px` }}
              pointerEvents="all"
            />
            {renderFills(el, activeFills, shapeLocalD, fillRule, fillLayerIndex, resolveAssetUri, isMaskStencil, Boolean(glass))}
            {renderStrokes(el, activeStrokes, shapeLocalD, strokeLayerIndex)}
          </g>

          {isDragOver && (
            <rect
              data-overlay="true"
              data-drag-over-ring="true"
              x={el.x}
              y={el.y}
              width={el.width}
              height={el.height}
              fill="none"
              stroke={el.type === "component" ? CANVAS_COMPONENT : CANVAS_SELECT}
              pointerEvents="none"
            />
          )}

          <g
            transform={`translate(${el.x}, ${el.y})`}
            clipPath={(el as ContainerElement).clipContent ? `url(#clip_${el.id})` : undefined}
            data-clip-chain={(el as ContainerElement).clipContent ? `url(#clip_${el.id})` : undefined}
            data-clip-span={(el as ContainerElement).clipContent ? String(Math.max(el.width, el.height)) : undefined}
          >
            {renderNodeList((el as ContainerElement).children || [], themeCtx, false)}
          </g>
        </>
      )}

      {el.type === "componentSet" && (
        <ComponentSetFrame
          set={el as ComponentSetElement}
          ctx={themeCtx}
          isDragOver={isDragOver}
        />
      )}

      {el.type === "instance" && (
        <InstanceNode
          el={el as InstanceElement}
          master={instanceMaster}
          content={instanceContent ?? undefined}
          box={instanceBox}
          isSelected={isSelected}
          isMaskStencil={isMaskStencil}
          ctx={themeCtx}
          onDoubleClick={handleDoubleClickToSelect}
          renderChildren={(els) => renderNodeList(els, themeCtx, false)}
        />
      )}

      {el.type === "text" && (
        <SvgTextNode
          el={el as TextElement}
          isEditingText={isEditingText}
          activeFills={activeFills}
          activeStrokes={activeStrokes}
          fillLayerIndex={fillLayerIndex}
          strokeLayerIndex={strokeLayerIndex}
          ctx={ctx}
        />
      )}
    </>
  );

  const content = isOtherElementWhileEditing ? (
    <g style={{ pointerEvents: "none" }}>{contentBody}</g>
  ) : (
    contentBody
  );

  /**
   * The torn silhouette is a clip in the element's LOCAL space, which is what the
   * flat branch draws in. A tilted layer paints inside a `foreignObject` whose
   * nested `svg` carries its own viewBox, so its user space is not this one — the
   * break is left off there rather than clipped against the wrong coordinates.
   */
  const flatContent = edgeEffects.length && !transform3d ? (
    <EdgeShell
      el={el}
      edges={edgeEffects}
      w={instanceBox ? instanceBox.width : el.width}
      h={instanceBox ? instanceBox.height : el.height}
      fills={activeFills}
    >
      {content}
    </EdgeShell>
  ) : (
    content
  );

  /**
   * Liquid Glass's own paint, as real shapes: the plate UNDER the artwork and the
   * rim OVER it.
   *
   * Both used to be filter primitives. A pair of offset inner shadows can only
   * make a highlight that runs all the way round, which reads as a bevel — the
   * mark of a raised button — and neither a directional light with a spread nor a
   * dark edge that fades inward is expressible as one. Baked images are.
   */
  const glassRim = glass ? (
    <>
      {[glass.dark, glass.light].filter(Boolean).map((img, i) => (
        <image
          key={i}
          href={img!.uri}
          x={el.x}
          y={el.y}
          width={img!.width}
          height={img!.height}
          preserveAspectRatio="none"
          pointerEvents="none"
        />
      ))}
    </>
  ) : null;

  /**
   * The perspective tilt renders through a foreignObject + HTML div, NOT a
   * `<g style>`. Chromium computes CSS 3D transforms on SVG elements in a
   * space that mishandles ancestor transforms and viewport scale — the further
   * the element sits from the view-box origin, the more the projection shears
   * and flattens (measured: a 30°-tilted card at x=2400 under a 0.47x viewport
   * painted as a parallelogram). An HTML div's 3D pipeline is spec-conformant
   * and lands the projected quad to a tenth of a user unit. The nested svg
   * carries the element's box as its viewBox, so every child keeps its stored
   * coordinates, and `overflow: visible` lets strokes and shadows leave the
   * box. Export unwraps this wrapper (`convertForeignObjectsToSvg`) — static
   * SVG cannot carry the projection — degrading to the flat artwork.
   */
  const tiltBody = transform3d ? (() => {
    const w = Math.max(1, instanceBox ? instanceBox.width : el.width);
    const h = Math.max(1, instanceBox ? instanceBox.height : el.height);
    // The filter rides INSIDE the nested svg, not the outer group. The filter
    // region is laid out for the FLAT box, so a projection that widens the near
    // edge past it clips the artwork with straight vertical cuts. Filtering
    // pre-projection draws the shadow in flat space and lets the div's
    // transform carry it along — which is also what a tilted shadow should do.
    return (
      <foreignObject
        data-tilt-fo="true"
        x={el.x}
        y={el.y}
        width={w}
        height={h}
        style={{ overflow: "visible" }}
      >
        <div style={{ width: w, height: h, transform: transform3d }}>
          <svg width={w} height={h} viewBox={`${el.x} ${el.y} ${w} ${h}`} style={{ display: "block", overflow: "visible" }}>
            <g filter={ownsEffects ? undefined : filterAttr} {...(ownsEffects ? {} : shadowMarks)}>
              {content}
              {glassRim}
            </g>
          </svg>
        </div>
      </foreignObject>
    );
  })() : (
    <>
      {flatContent}
      {glassRim}
    </>
  );

  if (hasBackdrop) {
    return (
      <g
        key={el.id}
        data-element-id={el.id}
        data-link={el.link || undefined}
        data-locked={el.locked ? "true" : undefined}
        transform={transform}
      >
        <foreignObject
          data-backdrop-fo="true"
          x={el.x}
          y={el.y}
          width={Math.max(1, el.width)}
          height={Math.max(1, el.height)}
          // The backdrop is decoration: `backdrop-filter` has no shape of its own,
          // and the `<div>` inside carries `pointer-events: none` — but that does
          // NOT make the `foreignObject` inert, because the element itself still
          // hit-tests its own box. Left hittable it outranked a fill-less shape's
          // stroke-only hit area, so a press inside a glass panel reached the
          // canvas root and started a marquee, selecting every layer under the
          // point (the panel included) and refusing every drag.
          pointerEvents="none"
        >
          <div
            // `BACKDROP_CHAIN_ATTR` in `backdrop-lod.ts`. Written as a literal to
            // stay greppable, like every other marker on the canvas; the pass
            // that disables this blur reads the authored chain back off it.
            data-backdrop-chain={backdropFilterCss}
            style={{
              // Not grown by the lens pad: growing it would force a `clip-path`,
              // which Chromium flattens to a rectangle under a clipping frame
              // (see `backdropShapeStyle`). `lg_refract_<id>` is offset by `-pad`
              // to match this box instead.
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              backdropFilter: backdropFilterCss,
              WebkitBackdropFilter: backdropFilterCss,
              ...backdropShapeStyle(el, el.width, el.height, shapeLocalD)
            }}
          />
        </foreignObject>
        <g
          opacity={elOpacity}
          filter={transform3d ? undefined : filterAttr}
          {...(transform3d ? {} : shadowMarks)}
          style={{ mixBlendMode: el.blendMode || "normal" }}
        >
          {tiltBody}
        </g>
      </g>
    );
  }

  return (
    <g
      key={el.id}
      data-element-id={el.id}
      // A link rides the element's own group so a click anywhere inside it —
      // including a resolved instance child, whose id the document cannot look
      // up — resolves to the nearest layer that declared one. Absent when there
      // is no link, so a document that uses none is byte-for-byte what it was.
      data-link={el.link || undefined}
      // Consumed by one stylesheet rule that makes the whole locked subtree
      // transparent to the pointer (style.css, `[data-locked]`). `locked` is
      // materialized onto every descendant, so marking the node is enough —
      // the selector reaches the children without them carrying it too.
      data-locked={el.locked ? "true" : undefined}
      transform={transform}
      filter={!transform3d && !ownsEffects ? filterAttr : undefined}
      {...(!transform3d && !ownsEffects ? shadowMarks : {})}
      opacity={elOpacity}
      style={{ mixBlendMode: (isMaskStencil ? "normal" : el.blendMode || "normal") as any }}
    >
      {tiltBody}
    </g>
  );
}

function isZeroAlphaMask(el: DesignElement): boolean {
  if (!el.isMask) return false;
  if (typeof el.opacity === "number" && el.opacity <= 0) return true;
  const fills = (el.fills || []).filter((f) => f && f.enabled !== false);
  return fills.length > 0 && fills.every((f) => typeof f.opacity === "number" && f.opacity <= 0);
}

/**
 * Whether a TOP-LEVEL element stays out of the mounted set.
 *
 * This lives in `renderNodeList` and not in the node for a reason that is the
 * whole point of the function: the node is memoized, and a memoized component
 * that returns null on one tick and a tree on the next has to be re-run to say so.
 * Comparing `viewportBox` in the comparator forced exactly that — every wheel tick
 * rebuilt and re-diffed every visible element (measured: 51 ms per tick on a
 * 3120-element page at 6 % zoom) to produce, for all but a ring at the edge, the
 * same markup. Deciding the mounted set OUTSIDE the memo keeps the set identical
 * and lets the node ignore the viewport entirely.
 *
 * Top-level only, which is what the renderer has always done: a visible frame
 * paints its whole subtree. That is why the defs pass culls at the same
 * granularity (`computeVisibleElementIds`) — the two must agree, or a nested
 * element loses its gradient while its geometry stays.
 *
 * The exemptions are not negotiable. A selected element, a mask stencil, and an
 * on-path text all paint outside their own box: the first two are deliberate, and
 * on-path glyphs run along a target path that can be nowhere near the stored
 * bounds — cull those on their box and the text vanishes, and can then never be
 * measured back into existence.
 */
function isCulledTopLevel(el: DesignElement, ctx: NodeRenderContext, isSelected: boolean, isMaskStencil: boolean): boolean {
  if (!ctx.viewportBox) return false;
  if (isSelected || isMaskStencil) return false;
  if ((el as TextElement).onPath?.pathId) return false;
  // A resolved clone is not in the document tree, so it has no world box. "No
  // opinion" has to mean "keep it" — the alternative is an empty box culling
  // live content.
  const box = ctx.worldBounds.get(el.id);
  if (!box) return false;
  return !isElementInViewport(box, ctx.viewportBox);
}

/**
 * The name a frame's label would say, before it is truncated to fit.
 *
 * An instance may have no name of its own and be wearing its master's, so the
 * answer has to be the same one `InstanceNode` paints — resolved here rather
 * than there because the truncation needs the string before the node runs.
 */
function titleNameOf(ctx: NodeRenderContext): FrameTitleName {
  return (el) => {
    if (el.type !== "instance") return el.name || "";
    const inst = el as InstanceElement;
    const master = findMasterComponentFast(ctx.docRef.current, inst.componentId, ctx.registry);
    return inst.name || master?.name || "Instance";
  };
}

export const MemoizedSvgNode = memo(SvgNodeRenderer, areSvgNodePropsEqual);

export function renderNodeList(
  list: DesignElement[],
  ctx: NodeRenderContext,
  isTopLevel = false
): preact.VNode[] {
  // Titles are the cull's twin: a screen-space measurement that moves with the
  // zoom and decides what gets PAINTED, so it is answered here — in the pass that
  // is not memoized — and painted as its own layer, outside every element's
  // effects, transform and blend mode.
  const titles =
    isTopLevel && ctx.frameTitles !== false
      ? resolveFrameTitles(list, ctx.zoom, titleNameOf(ctx))
      : null;

  const groups: Array<{ maskEl: DesignElement | null; items: DesignElement[] }> = [];
  let currentMask: DesignElement | null = null;
  let currentItems: DesignElement[] = [];

  for (const item of list) {
    if (item.isMask) {
      if (currentMask || currentItems.length > 0) {
        groups.push({ maskEl: currentMask, items: currentItems });
      }
      currentMask = item;
      currentItems = [];
    } else {
      currentItems.push(item);
    }
  }
  if (currentMask || currentItems.length > 0) {
    groups.push({ maskEl: currentMask, items: currentItems });
  }

  const rendered = groups.map((grp, gIdx) => {
    const renderNode = (item: DesignElement, isMaskStencil: boolean, key = item.id) => (
      <MemoizedSvgNode
        key={key}
        el={item}
        isSelected={ctx.selectedIds.has(item.id)}
        isDragOver={ctx.dragOverFrameId === item.id}
        isEditingText={ctx.editingCanvasTextId === item.id}
        isEditingPath={ctx.editingPathId === item.id}
        isMaskStencil={isMaskStencil}
        ctx={ctx}
      />
    );

    const renderedItems = grp.items
      .filter((item) => !isTopLevel || !isCulledTopLevel(item, ctx, ctx.selectedIds.has(item.id), false))
      .map((item) => renderNode(item, false));

    if (grp.maskEl) {
      const maskNode = renderNode(grp.maskEl, true, `mask_${grp.maskEl.id}`);
      if (isZeroAlphaMask(grp.maskEl)) {
        return <g key={`mask_grp_${grp.maskEl.id}`}>{maskNode}</g>;
      }
      const maskBox = maskLayerBox(grp.maskEl, ctx);
      /* A mask that is pure geometry is stated as a CLIP, because a `<mask>`
         ancestor is a backdrop root and blanks the backdrop blur of everything it
         covers — see `maskIsClip`. The two are the same coverage; only the one
         that leaves `backdrop-filter` working is usable here. */
      if (maskIsClip(grp.maskEl, maskBox)) {
        return (
          <g key={`mask_grp_${grp.maskEl.id}`}>
            {maskNode}
            <g clipPath={`url(#clip_mask_${grp.maskEl.id})`}>{renderedItems}</g>
          </g>
        );
      }
      const maskedBackdrops = renderMaskedBackdrops(grp.maskEl, grp.items, maskBox, ctx);
      return (
        <g key={`mask_grp_${grp.maskEl.id}`}>
          {maskNode}
          {maskedBackdrops}
          <g data-masked-group="true" mask={`url(#mask_layer_${grp.maskEl.id})`}>{renderedItems}</g>
        </g>
      );
    }
    return <g key={`grp_${grp.items[0]?.id ?? gIdx}`}>{renderedItems}</g>;
  });

  if (!titles) return rendered;

  const titled = list.filter(
    (item) =>
      titles.has(item.id) &&
      !isCulledTopLevel(item, ctx, ctx.selectedIds.has(item.id), false)
  );
  if (titled.length === 0) return rendered;
  return [
    ...rendered,
    <FrameTitleOverlay key="frame-titles" items={titled} titles={titles} ctx={ctx} />
  ];
}

/** The resolved box of an instance used as a mask, or null for anything else. */
function maskLayerBox(el: DesignElement, ctx: NodeRenderContext): InstanceBox | null {
  if (el.type !== "instance") return null;
  const inst = el as InstanceElement;
  const master = findMasterComponentFast(ctx.docRef.current, inst.componentId, ctx.registry);
  if (!master) return null;
  return resolveInstanceBox(inst, master, resolveInstanceContent(inst, master) ?? undefined);
}

/**
 * Emits backdrop-filter `<foreignObject>` hosts outside `<g mask="...">` when a
 * soft mask (such as a `LAYER_BLUR` feathered mask) covers siblings that carry
 * `backdrop-blur` or `liquid-glass`.
 *
 * In Chromium, `<g mask="url(#...)">` is a backdrop root that blanks every
 * `backdrop-filter` inside it, and applying CSS `mask-image` to a backdrop
 * `<div>` inside `<foreignObject>` detaches its compositor RenderSurface at high
 * zoom. Clipping the backdrop `<foreignObject>` to the mask's `clip-path`
 * silhouette outside `<g mask>` while the sibling's SVG fills remain masked by
 * `<g mask="url(#mask_layer_...)">` preserves both the live backdrop blur and
 * the feathered mask edge without compositor surface corruption.
 */
function renderMaskedBackdrops(
  maskEl: DesignElement,
  items: DesignElement[],
  maskBox: InstanceBox | null,
  ctx: NodeRenderContext
): preact.VNode[] | null {
  const bdClip = maskBackdropClip(maskEl, maskBox);
  if (!bdClip) return null;
  const out: preact.VNode[] = [];
  for (const el of items) {
    if (el.visible === false || el.type === "line" || el.type === "arrow" || el.type === "text") continue;
    const activeEffects = (el.effects || []).filter((ef) => ef.enabled !== false);
    if (activeEffects.length === 0) continue;
    const glass = el.type === "instance" ? null : bakeGlass(el, activeEffects, undefined, ctx.rasterScale);
    const parts: string[] = [];
    for (const ef of cssPaintOrder(activeEffects)) {
      if (ef.type === "backdrop-blur") {
        parts.push(cssBlurFilter((ef as BackdropBlurEffect).blur));
      } else if (ef.type === "liquid-glass" && glass) {
        const chain = glassBackdropCss(el.id, glass);
        if (chain) parts.push(chain);
      }
    }
    if (parts.length === 0) continue;
    const backdropFilterCss = parts.join(" ");
    out.push(
      <foreignObject
        key={`masked_bd_${el.id}`}
        x={bdClip.x}
        y={bdClip.y}
        width={bdClip.width}
        height={bdClip.height}
        transform={bdClip.transform}
        pointerEvents="none"
      >
        <div
          data-backdrop-chain={backdropFilterCss}
          style={{
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            backdropFilter: backdropFilterCss,
            WebkitBackdropFilter: backdropFilterCss,
            clipPath: `path('${bdClip.clipD}') margin-box`
          }}
        />
      </foreignObject>
    );
  }
  return out.length > 0 ? out : null;
}
