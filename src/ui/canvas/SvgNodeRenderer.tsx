import { Fragment } from "preact";
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
import { clipsContent } from "../../core/dsl/overflow";
import { getShapeLocalPath } from "../../core/geometry/gradient-utils";
import { isNeutralColorFilter } from "../../core/dsl/color-filter";
import { isContainer } from "../../core/geometry/tree-ops";
import { childScrollOffset } from "../../core/geometry/scroll-bounds";
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
  // Compared as ids so closing an editor on a descendant still re-renders the ancestor subtree.
  if (prev.ctx.editingCanvasTextId !== next.ctx.editingCanvasTextId) return false;
  if (prev.ctx.editingPathId !== next.ctx.editingPathId) return false;
  if (next.isEditingText && prev.ctx.canvasTextDraft !== next.ctx.canvasTextDraft) return false;
  if (prev.isMaskStencil !== next.isMaskStencil) return false;
  const changedIds = next.ctx.selectionChangedIds;
  if (
    changedIds &&
    changedIds.size > 0 &&
    prev.ctx.selectionChangedIds !== changedIds &&
    selectionTouchesSubtree(next.el, changedIds)
  ) {
    return false;
  }
  if (prev.el.type === "text" && prev.ctx.onPathGuides !== next.ctx.onPathGuides) return false;
  // `zoom` and `viewportBox` are intentionally omitted: viewport culling runs in `renderNodeList`
  // and zoom-scaled chrome uses `--fish-zoom` CSS variables outside node markup.
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

const EMPTY_EFFECTS: any[] = [];
const EMPTY_FILLS: Paint[] = [];
const EMPTY_STROKES: any[] = [];
const EMPTY_SHADOW_MARKS: Record<string, string | undefined> = {};
const MASK_STENCIL_FILLS: Paint[] = [{ type: "solid", color: CANVAS_ON_SELECT }];

function buildBackdropFilterCss(
  el: DesignElement,
  activeEffects: any[],
  glass: ReturnType<typeof bakeGlass>
): string | undefined {
  if (activeEffects.length === 0) return undefined;
  const parts: string[] = [];
  for (const ef of cssPaintOrder(activeEffects)) {
    if (ef.type === "backdrop-blur" && el.type !== "text") {
      parts.push(cssBlurFilter((ef as BackdropBlurEffect).blur));
    } else if (ef.type === "liquid-glass" && glass) {
      const chain = glassBackdropCss(el.id, glass);
      if (chain) parts.push(chain);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function resolveElementEffects(
  el: DesignElement,
  rawEffects: any[],
  isMaskStencil: boolean,
  rasterScale?: number
) {
  if (isMaskStencil || rawEffects.length === 0) {
    return {
      svgFilterEffects: EMPTY_EFFECTS,
      edgeEffects: EMPTY_EFFECTS,
      glass: null as ReturnType<typeof bakeGlass>,
      backdropFilterCss: undefined as string | undefined
    };
  }
  const activeEffects: any[] = [];
  const svgFilterEffects: any[] = [];
  const edgeEffects: any[] = [];
  let hasGlass = false;
  let hasBackdropEffect = false;
  for (let i = 0; i < rawEffects.length; i++) {
    const ef = rawEffects[i];
    if (ef.enabled === false) continue;
    activeEffects.push(ef);
    if (ef.type === "tear") {
      edgeEffects.push(ef);
    } else if (ef.type === "backdrop-blur") {
      hasBackdropEffect = true;
    } else if (ef.type === "liquid-glass") {
      hasGlass = true;
      hasBackdropEffect = true;
    } else if (!(el.type === "text" && ef.type === "drop-shadow")) {
      svgFilterEffects.push(ef);
    }
  }
  if (activeEffects.length === 0) {
    return {
      svgFilterEffects: EMPTY_EFFECTS,
      edgeEffects: EMPTY_EFFECTS,
      glass: null as ReturnType<typeof bakeGlass>,
      backdropFilterCss: undefined as string | undefined
    };
  }
  const glass =
    hasGlass && el.type !== "instance"
      ? bakeGlass(el, activeEffects, undefined, rasterScale)
      : null;
  const backdropFilterCss = hasBackdropEffect
    ? buildBackdropFilterCss(el, activeEffects, glass)
    : undefined;
  return { svgFilterEffects, edgeEffects, glass, backdropFilterCss };
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

  const instanceMaster =
    el.type === "instance"
      ? findMasterComponentFast(ctx.docRef.current, (el as InstanceElement).componentId, ctx.registry)
      : null;
  const inheritedTheme = ctx.theme || getActiveTheme(ctx.docRef.current);
  const elementTheme =
    el.type === "instance"
      ? resolveInstanceTheme(el as InstanceElement, instanceMaster, inheritedTheme)
      : el.themeMode || inheritedTheme;

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

  const rawEffects = instanceBox ? instanceBox.effects : el.effects || EMPTY_EFFECTS;
  const { svgFilterEffects, edgeEffects, glass, backdropFilterCss } = resolveElementEffects(
    el,
    rawEffects,
    isMaskStencil,
    ctx.rasterScale
  );
  const colorFilter = isMaskStencil || isNeutralColorFilter(el.adjust) ? undefined : el.adjust;
  const filterAttr =
    svgFilterEffects.length > 0 || colorFilter ? `url(#filter_${el.id})` : undefined;
  const shadowMarks = filterAttr
    ? shadowLodMarks(filterAttr, svgFilterEffects, colorFilter)
    : EMPTY_SHADOW_MARKS;

  // Fade only leaf mask stencils; container stencils fade their own frame group so children keep alpha.
  const stencilFadesSelf = isMaskStencil && !isContainer(el);
  const elOpacity = stencilFadesSelf ? 0.001 : typeof el.opacity === "number" ? el.opacity : 1;
  // `InstanceNode` applies its own filter/backdrop stack; applying it here would double-composite.
  const ownsEffects = el.type === "instance";

  const hasBackdrop =
    !ownsEffects && backdropFilterCss !== undefined && el.type !== "line" && el.type !== "arrow" && el.type !== "text";

  const { x: cx, y: cy } = elementPivot(el, instanceBox ? instanceBox.width : el.width, instanceBox ? instanceBox.height : el.height);
  const transform = elementTransform(el, cx, cy);
  const transform3d = elementTransform3d(el);

  let activeFills = isMaskStencil
    ? MASK_STENCIL_FILLS
    : el.fillEnabled !== false && el.fills && el.fills.length > 0
      ? el.fills.filter((f) => f && f.enabled !== false)
      : EMPTY_FILLS;

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

  const ownsInterior = activeFills.length > 0 || hasBackdrop;

  const allStrokes = (el as any).strokes || EMPTY_STROKES;
  const activeStrokes =
    isMaskStencil || allStrokes.length === 0
      ? EMPTY_STROKES
      : allStrokes.filter((s: any) => {
          if (!s || s.enabled === false) return false;
          if (s.width > 0) return true;
          if (s.side === "custom" && s.sides) {
            return Object.values(s.sides).some((v: any) => typeof v === "number" && v > 0);
          }
          return false;
        });

  const needsShapePath =
    hasBackdrop ||
    (el.type !== "text" &&
      el.type !== "line" &&
      el.type !== "arrow" &&
      el.type !== "instance" &&
      el.type !== "componentSet");
  const shapeLocalD = needsShapePath ? getShapeLocalPath(el) : "";
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

  const renderShapePaintGroup = (hitFill: string, pointerEvents: "all" | "stroke", opacity?: number) => (
    <g
      transform={`translate(${el.x}, ${el.y})`}
      onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
      onDblClick={handleDoubleClickToSelect}
      opacity={opacity}
    >
      <path
        d={shapeLocalD}
        fill={hitFill}
        data-hit="true"
        fillRule={fillRule}
        stroke="transparent"
        style={{ "--hit-stroke": `${activeStrokes[0]?.width || 0}px` }}
        pointerEvents={pointerEvents}
      />
      {renderFills(el, activeFills, shapeLocalD, fillRule, fillLayerIndex, resolveAssetUri, isMaskStencil, Boolean(glass))}
      {renderStrokes(el, activeStrokes, shapeLocalD, strokeLayerIndex)}
    </g>
  );

  // Only wrap when another element is path-editing to avoid an extra <g> on every node.
  const contentBody = (
    <>
      {(el.type === "rect" || el.type === "ellipse" || el.type === "polygon" || el.type === "star" || el.type === "path") &&
        renderShapePaintGroup(ownsInterior ? "transparent" : "none", ownsInterior ? "all" : "stroke")}

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
          {renderShapePaintGroup(activeFills.length > 0 ? "transparent" : "none", "all", isMaskStencil ? 0.001 : undefined)}

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

          {(() => {
            const containerEl = el as ContainerElement;
            const sx = containerEl.scrollX || 0;
            const sy = containerEl.scrollY || 0;
            const clipped = clipsContent(containerEl);
            const clipUrl = clipped ? `url(#clip_${el.id})` : undefined;
            const hasScroll = (sx !== 0 || sy !== 0) && clipped;
            return (
              <g
                transform={`translate(${el.x}, ${el.y})`}
                clipPath={clipUrl}
                data-clip-chain={clipUrl}
                data-clip-span={clipped ? String(Math.max(el.width, el.height)) : undefined}
              >
                {(() => {
                  const children = containerEl.children || [];
                  if (!hasScroll) {
                    return renderNodeList(children, themeCtx, false);
                  }
                  const hasPinned = children.some((c) => {
                    const { offsetX, offsetY } = childScrollOffset(c, el as any, sx, sy);
                    return offsetX !== -sx || offsetY !== -sy;
                  });
                  if (!hasPinned) {
                    return (
                      <g transform={`translate(${-sx}, ${-sy})`}>
                        {renderNodeList(children, themeCtx, false)}
                      </g>
                    );
                  }
                  return children.map((c, i) => {
                    const { offsetX, offsetY } = childScrollOffset(c, el as any, sx, sy);
                    if (offsetX === 0 && offsetY === 0) {
                      return renderNodeList([c], themeCtx, false);
                    }
                    return (
                      <g key={c.id || i} transform={`translate(${offsetX}, ${offsetY})`}>
                        {renderNodeList([c], themeCtx, false)}
                      </g>
                    );
                  });
                })()}
              </g>
            );
          })()}
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

  // Tear clip uses flat local coordinates; skip on 3D-tilted foreignObject layers.
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

  // CSS 3D runs on an HTML div inside foreignObject because Chromium mis-projects 3D transforms on SVG <g>.
  const tiltBody = transform3d ? (() => {
    const w = Math.max(1, instanceBox ? instanceBox.width : el.width);
    const h = Math.max(1, instanceBox ? instanceBox.height : el.height);
    // Filter inside the nested svg so the projection transforms the shadow instead of clipping against flat bounds.
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
      data-link={el.link || undefined}
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

// Keep in sync with `computeVisibleElementIds` in defs culling.
function isCulledTopLevel(el: DesignElement, ctx: NodeRenderContext, isSelected: boolean, isMaskStencil: boolean): boolean {
  if (!ctx.viewportBox) return false;
  if (isSelected || isMaskStencil) return false;
  if ((el as TextElement).onPath?.pathId) return false;
  const box = ctx.worldBounds.get(el.id);
  if (!box) return false;
  return !isElementInViewport(box, ctx.viewportBox);
}

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
    const renderNode = (
      item: DesignElement,
      isMaskStencil: boolean,
      isSelected = ctx.selectedIds.has(item.id),
      key = item.id
    ) => (
      <MemoizedSvgNode
        key={key}
        el={item}
        isSelected={isSelected}
        isDragOver={ctx.dragOverFrameId === item.id}
        isEditingText={ctx.editingCanvasTextId === item.id}
        isEditingPath={ctx.editingPathId === item.id}
        isMaskStencil={isMaskStencil}
        ctx={ctx}
      />
    );

    const renderedItems: preact.VNode[] = [];
    for (let i = 0; i < grp.items.length; i++) {
      const item = grp.items[i];
      const isSelected = ctx.selectedIds.has(item.id);
      if (isTopLevel && isCulledTopLevel(item, ctx, isSelected, false)) continue;
      renderedItems.push(renderNode(item, false, isSelected));
    }

    if (grp.maskEl) {
      const maskNode = renderNode(grp.maskEl, true, ctx.selectedIds.has(grp.maskEl.id), `mask_${grp.maskEl.id}`);
      if (isZeroAlphaMask(grp.maskEl)) {
        return maskNode;
      }
      const maskBox = maskLayerBox(grp.maskEl, ctx);
      // Pure-geometry masks use clipPath because `<mask>` acts as a backdrop root and blanks backdrop-filter.
      if (maskIsClip(grp.maskEl, maskBox)) {
        return (
          <Fragment key={`mask_grp_${grp.maskEl.id}`}>
            {maskNode}
            <g clipPath={`url(#clip_mask_${grp.maskEl.id})`}>{renderedItems}</g>
          </Fragment>
        );
      }
      const maskedBackdrops = renderMaskedBackdrops(grp.maskEl, grp.items, maskBox, ctx);
      return (
        <Fragment key={`mask_grp_${grp.maskEl.id}`}>
          {maskNode}
          {maskedBackdrops}
          <g data-masked-group="true" mask={`url(#mask_layer_${grp.maskEl.id})`}>{renderedItems}</g>
        </Fragment>
      );
    }
    return <Fragment key={`grp_${grp.items[0]?.id ?? gIdx}`}>{renderedItems}</Fragment>;
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

// Emit backdrop-filter hosts outside `<g mask>` so soft masks don't blank backdrop blur in Chromium.
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
    const rawEffects = el.effects;
    if (!rawEffects || rawEffects.length === 0) continue;
    const activeEffects = rawEffects.filter((ef) => ef.enabled !== false);
    if (activeEffects.length === 0) continue;
    const glass = el.type === "instance" ? null : bakeGlass(el, activeEffects, undefined, ctx.rasterScale);
    const backdropFilterCss = buildBackdropFilterCss(el, activeEffects, glass);
    if (!backdropFilterCss) continue;
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
