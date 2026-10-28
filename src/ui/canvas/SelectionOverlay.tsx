import { useMemo } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { DesignDocument, DesignElement, Paint, RectElement, TextElement } from "../../core/dsl/types";
import { cornerRadiiOf } from "../../core/geometry/shape-path";
import { GuideLine } from "../../core/geometry/snap-guides";
import { getRotateCursor, getScaleCursor } from "../../core/geometry/transforms";
import { isLineElement, elementAABB } from "../../core/geometry/element-bounds";
import { matrixRotationDeg, matrixToSvg } from "../../core/geometry/matrix";
import { getGradientStops, isGradientPaint, linearLeverEndpoints } from "../../core/geometry/gradient-utils";
import { useGradientEditTarget } from "../hooks/gradient-edit";
import { useImageCropTarget } from "../hooks/image-crop-edit";
import { cropPlacementOf } from "./ImageCropOverlay";
import type { GradientHandle } from "../hooks/canvas-gestures/gradient-gesture";
import type { MarqueeRect } from "../hooks/useCanvasGestures";
import { findParentById, findElementById } from "../../core/geometry/tree-ops";
import { worldMatrixOf } from "../../core/interactions/component-swap";
import { modifierResizesOwnBox, resolveAxis } from "../../core/geometry/resolve-axis";
import { scalableAxes } from "../../core/interactions/scale-ops";
import { SmartSelectionInfo } from "../../core/geometry/smart-selection";
import { SmartSelectionOverlay } from "./SmartSelectionOverlay";
import { isSelectingTool } from "../../core/geometry/shape-creation";
import type { ToolType } from "../../core/tools";
import {
  CANVAS_CORAL,
  CANVAS_GUIDE,
  CANVAS_PREVIEW,
  CANVAS_SELECT,
  CANVAS_COMPONENT,
  CANVAS_ON_SELECT,
  CANVAS_SMART_SELECT,
  withAlpha
} from "./canvas-colors";

/**
 * The handles that move both axes. Only these carry the Scale tool's corner arrow:
 * an edge handle cannot express a scale, so it keeps the axis cursor that describes
 * what dragging it will actually do.
 */
const CORNER_HANDLES: readonly string[] = ["tl", "tr", "br", "bl"];

type ResizeHandleType = "tl" | "tr" | "br" | "bl" | "tm" | "mr" | "bm" | "ml";
type RotateCorner = "tl" | "tr" | "br" | "bl";

/**
 * Cap individual dashed outlines when a large number of layers are selected:
 * drawing hundreds of individual dashed outlines creates visual noise (a blue mesh)
 * and severely degrades zoom/pan performance. Above this threshold, the joint bounding
 * box (`multiBounds`) and its 8 resize handles provide the selection chrome.
 */
export const MAX_INDIVIDUAL_SELECTION_OUTLINES = 80;

interface SelectionOverlayProps {
  doc: DesignDocument;
  primarySelected: DesignElement | null;
  selectedElements: DesignElement[];
  activeTool: string;
  zoom: number;
  /** Cmd/Ctrl held: a frame's handles resize the frame and leave its contents be. */
  frameResizeKey?: boolean;
  multiBounds: { minX: number; minY: number; width: number; height: number } | null;
  activeGuides: GuideLine[];
  marqueeRect: MarqueeRect | null;
  smartSelection?: SmartSelectionInfo | null;
  isEditingPath?: boolean;
  isEditingText?: boolean;
  transformLocked?: boolean;
  hideSmart?: boolean;
  smartHoverActive?: boolean;
  gapDragActive?: boolean;
  dropBox?: { x: number; y: number; width: number; height: number } | null;
  onGapDragStart?: (e: any, handleId: string) => void;
  onTidySpacing?: (axis: "x" | "y") => void;
  onDotDragStart?: (e: any, dot: any) => void;
  onResizePointerDown: (e: any, type: ResizeHandleType, el: DesignElement) => void;
  /**
   * Drag a handle on the multi-selection union. Receives the selected ids because the
   * union spans layers that share no parent, so there is no single element to steer.
   */
  onMultiResizePointerDown?: (e: any, type: ResizeHandleType, ids: Set<string>) => void;
  onRotatePointerDown: (e: any, corner: RotateCorner, el: DesignElement, angleOffset: number) => void;
  onEndpointPointerDown: (e: any, el: DesignElement, which: "start" | "end") => void;
  onRadiusPointerDown: (e: any, el: DesignElement) => void;
  onStartOffsetPointerDown?: (e: any, el: DesignElement) => void;
  onGradientHandlePointerDown?: (e: any, el: DesignElement, paintIndex: number, which: GradientHandle) => void;
}

export function SelectionOverlay({
  doc,
  primarySelected,
  selectedElements,
  activeTool,
  zoom,
  frameResizeKey,
  multiBounds,
  activeGuides,
  marqueeRect,
  smartSelection,
  isEditingPath,
  isEditingText,
  transformLocked,
  hideSmart,
  smartHoverActive,
  gapDragActive,
  dropBox,
  onGapDragStart,
  onTidySpacing,
  onDotDragStart,
  onResizePointerDown,
  onMultiResizePointerDown,
  onRotatePointerDown,
  onEndpointPointerDown,
  onRadiusPointerDown,
  onStartOffsetPointerDown,
  onGradientHandlePointerDown
}: SelectionOverlayProps) {
  // A hidden layer is not in the union, so it must not be in the id set that steers
  // it either — otherwise the group would scale by a selection nothing on screen is
  // part of. The dashed per-layer outlines below filter on the same predicate.
  const visibleSelected = useMemo(
    () => selectedElements.filter((el) => el.visible !== false),
    [selectedElements]
  );
  const multiSelectionIds = useMemo(
    () => new Set(visibleSelected.map((el) => el.id)),
    [visibleSelected]
  );
  // Memoized so zooming (which churns `zoom` at 60-120fps) never recomputes
  // `worldMatrixOf`, `elementAABB`, or `matrixToSvg` across the selection.
  const selectionBoxes = useMemo(() => {
    if (visibleSelected.length <= 1 || visibleSelected.length > MAX_INDIVIDUAL_SELECTION_OUTLINES) {
      return [];
    }
    return visibleSelected.map((el) => ({
      id: el.id,
      box: elementAABB(el),
      transform: matrixToSvg(worldMatrixOf(doc, el))
    }));
  }, [visibleSelected, doc]);
  // The component/instance purple belongs to a single layer's identity — it answers
  // "what is this", which a group has no one answer to. A group's handles stay the
  // plain selection blue rather than borrowing an accent that would claim otherwise.
  const handleStroke = 1.5 / zoom;
  const gradientEdit = useGradientEditTarget();
  const cropEdit = useImageCropTarget();
  return (
    <>
      {/* Transform Bounding Box & Handles for Single Selection */}
      {primarySelected && primarySelected.visible !== false && selectedElements.length === 1 && isSelectingTool(activeTool as ToolType) && !isEditingPath && (() => {
        const el = primarySelected;
        // A resolved clone's offsets live in the resolution, not in the tree: the
        // outermost instance alone is not its origin.
        //
        // The whole box hangs off ONE matrix rather than an origin plus this
        // layer's own `rotate(...)`. The two agree while every ancestor is
        // unrotated, which is why the arithmetic read as a translation all along
        // — but the renderer draws a child INSIDE its frame's turned group, so a
        // child of a turned frame paints at an angle and a place that no sum of
        // `x`/`y` names. Adding the ancestors' rotation into a translation
        // cannot express that; composing the matrices can, and it also carries
        // the layer's own turn in the same place, so the rect below still sits
        // at the coordinates it stores.
        const worldM = worldMatrixOf(doc, el);
        const worldX = el.x;
        const worldY = el.y;
        const strokeW = 1.5 / zoom;
        const isCompOrInst =
          el.type === "component" || el.type === "instance" || el.type === "componentSet";
        const accentColor = isCompOrInst ? CANVAS_COMPONENT : CANVAS_SELECT;

        // A locked layer, and a resolved instance child, are both selectable but
        // not transformable: keep the box — that is the feedback that they ARE
        // selected — and offer no handle, because every one of them would start a
        // gesture that either the lock or the missing stored geometry refuses.
        const lockedEl =
          el.locked === true || transformLocked === true;

        // Gradient edit mode: the fill row's color panel is open for THIS layer.
        // Figma parity — the transform box steps aside and the gradient lever is
        // the whole selection chrome, aimed at exactly the row being edited.
        const gradientTarget =
          gradientEdit && gradientEdit.elId === el.id && !lockedEl && !isEditingText
            ? gradientEdit
            : null;
        const gizmoPaint = gradientTarget ? el.fills?.[gradientTarget.paintIndex] : undefined;
        const gizmoGrad =
          gizmoPaint && gizmoPaint.enabled !== false && isGradientPaint(gizmoPaint) ? gizmoPaint : null;

        // Crop mode is the same bargain as gradient edit — the transform box
        // stands down and this layer's own chrome takes over — but for a
        // different reason: the box resizes the ELEMENT, and crop mode exists to
        // leave the element alone. Two boxes claiming the same four corners would
        // offer two different gestures at one point.
        //
        // Gated on the placement RESOLVING, not merely on the store naming this
        // layer: undoing the commit that entered crop leaves `fit: "cover"` with
        // the target still set, and an unconditional stand-down would then hand
        // the canvas to an overlay that has nothing to draw — no box, no handles.
        const cropTarget =
          cropEdit && cropEdit.elId === el.id && !lockedEl && !isEditingText && cropPlacementOf(doc, el, cropEdit.paintIndex)
            ? cropEdit
            : null;

        // Lines and arrows are edited by their two endpoints (Figma parity):
        // no resize box, no rotate corners — just a draggable node per end.
        if (isLineElement(el) && !lockedEl) {
          if (isEditingText) return null;
          const handleSize = 10 / zoom;
          const half = handleSize / 2;
          // In the element's OWN frame, like every other handle in this file, and
          // hung off the same world matrix as the box: `dx`/`dy` are the segment
          // in that frame and the render turns it, ancestors included. Placing
          // the dots in canvas space instead put them at the segment's unrotated
          // endpoints, a box-width away from the line they belong to on anything
          // but a level one.
          return (
            <g transform={matrixToSvg(worldM)}>
              {[
                { which: "start" as const, hx: el.x, hy: el.y },
                { which: "end" as const, hx: el.x + el.dx, hy: el.y + el.dy }
              ].map(({ which, hx, hy }) => (
                <circle
                  key={`endpoint_${which}`}
                  cx={hx}
                  cy={hy}
                  r={half}
                  fill={CANVAS_ON_SELECT}
                  stroke={CANVAS_SELECT}
                  strokeWidth={strokeW}
                  style={{ cursor: "crosshair" }}
                  onPointerDown={(e) => onEndpointPointerDown(e, el, which)}
                />
              ))}
            </g>
          );
        }

        // The angle the box actually faces on the canvas — its own turn plus
        // every ancestor's. `el.rotation` alone is what the rotate cursor used to
        // report, so on a child of a turned frame the cursor pointed along a
        // direction the box was not facing.
        const rot = matrixRotationDeg(worldM);
        const handleSize = 8 / zoom;
        const half = handleSize / 2;
        const rotOffset = 14 / zoom;

        // Chrome stays FLAT on a tilted layer, on purpose: the handles' drag
        // math reads the stored geometry, and the projected-chrome experiment
        // sheared under scaled viewports. The box therefore shows the geometry
        // the gestures act on, not the pixels the artwork paints.

        // Figma parity: a blue diamond pinned to the path where the glyph run
        // begins; dragging it slides the run. The guide path is baked with the
        // target's own offset (`translate(target.x, target.y)` in `CanvasDefs`),
        // so the sampled point is in the TEXT's parent space — the same space the
        // handles below are drawn in, which is why no origin is added to it.
        let offsetHandle: { x: number; y: number } | null = null;
        if (el.type === "text" && (el as TextElement).onPath?.pathId && !isEditingText && !lockedEl) {
          const onPath = (el as TextElement).onPath!;
          const target = findElementById(getActivePage(doc).children, onPath.pathId);
          const guide = target ? (document.getElementById(`guide_path_${el.id}`) as SVGPathElement | null) : null;
          if (target && guide) {
            try {
              const total = guide.getTotalLength();
              if (total > 0) {
                const p = guide.getPointAtLength(
                  (total * Math.max(0, Math.min(100, onPath.startOffset || 0))) / 100
                );
                offsetHandle = { x: p.x + target.x, y: p.y + target.y };
              }
            } catch {
              // Path geometry not measurable yet; skip the handle this frame.
            }
          }
        }

        const sizingParent = findParentById(getActivePage(doc).children, el.id);
        // In the Scale tool an instance's axes are its own even where a hug owns
        // them for a resize — the drag writes a factor, not a box. Same rule as
        // `scale-ops`, so the handles drawn here are exactly the ones the drag
        // handler will honour.
        const scaleAxes = activeTool === "scale" ? scalableAxes(el, sizingParent) : null;
        const wLocked = scaleAxes ? !scaleAxes.x : resolveAxis(el, sizingParent, "width") !== "fixed";
        const hLocked = scaleAxes ? !scaleAxes.y : resolveAxis(el, sizingParent, "height") !== "fixed";
        // Cmd/Ctrl turns every engine-owned axis into a handle: the drag pins that
        // axis to a fixed size, so the handle is the only way to give a hugging
        // element a size of its own. Shared with the drag handler on purpose —
        // see `modifierResizesOwnBox`.
        const frameOnly = Boolean(frameResizeKey) && modifierResizesOwnBox(el);
        const canResize = frameOnly || !wLocked || !hLocked;
        const edgeVisible = (locked: boolean) => frameOnly || !locked;
        // The big scale cursor is the corner's own diagonal, so `tl` must not
        // inherit `tr`'s arrow: pointing at the wrong corner promises a scale
        // that pulls the wrong way. A locked axis is the exception — one side
        // cannot grow, so there is no corner to point along and the plain
        // per-axis cursor is the truthful one.
        const cornerCursor = (base: string) => {
          if (wLocked && !hLocked) return "ns-resize";
          if (hLocked && !wLocked) return "ew-resize";
          if (activeTool !== "scale") return base;
          return getScaleCursor(base === "nwse-resize" ? "nwse" : "nesw");
        };

        return (
          <g
            data-frame-resize={frameOnly ? "true" : undefined}
            transform={matrixToSvg(worldM)}
          >
            {!gradientTarget && !cropTarget && (
              <rect
                data-transform-locked={transformLocked ? "true" : undefined}
                x={worldX}
                y={worldY}
                width={el.width}
                height={el.height}
                fill="none"
                stroke={accentColor}
                strokeWidth={strokeW}
                strokeDasharray={
                  frameOnly || wLocked || hLocked || transformLocked ? `${4 / zoom} ${3 / zoom}` : undefined
                }
                pointerEvents="none"
              />
            )}

            {/* Corner Resize Handles — hidden when layout-controlled or editing text */}
            {!isEditingText && canResize && !lockedEl && !gradientTarget && !cropTarget && [
              { type: "tl" as const, hx: worldX, hy: worldY, cursor: "nwse-resize" },
              { type: "tr" as const, hx: worldX + el.width, hy: worldY, cursor: "nesw-resize" },
              { type: "br" as const, hx: worldX + el.width, hy: worldY + el.height, cursor: "nwse-resize" },
              { type: "bl" as const, hx: worldX, hy: worldY + el.height, cursor: "nesw-resize" }
            ].map(({ type, hx, hy, cursor }) => (
              <rect
                key={`corner_${type}`}
                data-resize-handle={type}
                x={hx - half}
                y={hy - half}
                width={handleSize}
                height={handleSize}
                fill={CANVAS_ON_SELECT}
                stroke={accentColor}
                strokeWidth={strokeW}
                rx={1}
                ry={1}
                style={{ cursor: cornerCursor(cursor) }}
                onPointerDown={(e) => onResizePointerDown(e, type, el)}
              />
            ))}

            {/* Edge Resize Handles — per-axis: hidden when that axis is layout-controlled or editing text */}
            {!isEditingText && !lockedEl && !gradientTarget && !cropTarget && ([
              { type: "tm" as const, hx: worldX + el.width / 2, hy: worldY, cursor: "ns-resize", locked: hLocked },
              { type: "mr" as const, hx: worldX + el.width, hy: worldY + el.height / 2, cursor: "ew-resize", locked: wLocked },
              { type: "bm" as const, hx: worldX + el.width / 2, hy: worldY + el.height, cursor: "ns-resize", locked: hLocked },
              { type: "ml" as const, hx: worldX, hy: worldY + el.height / 2, cursor: "ew-resize", locked: wLocked }
            ] as const)
              .filter((h) => edgeVisible(h.locked))
              .map(({ type, hx, hy, cursor }) => (
                <rect
                  key={`edge_${type}`}
                  data-resize-handle={type}
                  x={hx - half}
                  y={hy - half}
                  width={handleSize}
                  height={handleSize}
                  fill={CANVAS_ON_SELECT}
                  stroke={accentColor}
                  strokeWidth={strokeW}
                  rx={1}
                  ry={1}
                  style={{ cursor }}
                  onPointerDown={(e) => onResizePointerDown(e, type, el)}
                />
              ))}

            {/* 4 Corner Rotate Hot Zones — hidden while editing text */}
            {!isEditingText && !lockedEl && !gradientTarget && !cropTarget && [
              { corner: "tl" as const, hx: worldX - rotOffset, hy: worldY - rotOffset, angle: 0 },
              { corner: "tr" as const, hx: worldX + el.width + rotOffset, hy: worldY - rotOffset, angle: 90 },
              { corner: "br" as const, hx: worldX + el.width + rotOffset, hy: worldY + el.height + rotOffset, angle: 180 },
              { corner: "bl" as const, hx: worldX - rotOffset, hy: worldY + el.height + rotOffset, angle: 270 }
            ].map(({ corner, hx, hy, angle }) => (
                <circle
                  key={`rot_${corner}`}
                  data-rotate-handle={corner}
                  cx={hx}
                cy={hy}
                r={half * 2.2}
                fill="transparent"
                style={{ cursor: getRotateCursor(rot + angle) }}
                onPointerDown={(e) => onRotatePointerDown(e, corner, el, angle)}
              />
            ))}

            {/* Corner radius handle — Figma parity: a dot tucked inside the
                top-left corner; dragging it retunes the corner radius. Rendered
                last so it wins the hit test where it nears the resize handle. */}
            {!isEditingText && !lockedEl && !gradientTarget && !cropTarget && el.type === "rect" && (() => {
              const [tl] = cornerRadiiOf((el as RectElement).borderRadius, el.width, el.height);
              // Keep the dot grabbable when the radius is zero; track the arc
              // centre once the radius grows past that minimum inset.
              const inset = Math.min(Math.max(tl, 10 / zoom), Math.min(el.width, el.height) / 2);
              const radiusCursor = { cursor: "nwse-resize" };
              const startRadiusDrag = (e: any) => onRadiusPointerDown(e, el);
              return (
                <g style={radiusCursor} onPointerDown={startRadiusDrag}>
                  <circle
                    data-radius-handle="tl"
                    cx={worldX + inset}
                    cy={worldY + inset}
                    r={9 / zoom}
                    fill="transparent"
                  />
                  <circle
                    cx={worldX + inset}
                    cy={worldY + inset}
                    r={3.5 / zoom}
                    fill={CANVAS_ON_SELECT}
                    stroke={accentColor}
                    strokeWidth={strokeW}
                  />
                </g>
              );
            })()}

            {/* On-path start handle — rendered last so it wins the hit test. */}
            {offsetHandle && onStartOffsetPointerDown && !gradientTarget && !cropTarget && (
              <g data-offset-handle="true" style={{ cursor: "grab" }} onPointerDown={(e) => onStartOffsetPointerDown(e, el)}>
                <circle cx={offsetHandle.x} cy={offsetHandle.y} r={9 / zoom} fill="transparent" />
                <rect
                  x={offsetHandle.x - 3.5 / zoom}
                  y={offsetHandle.y - 3.5 / zoom}
                  width={7 / zoom}
                  height={7 / zoom}
                  rx={1 / zoom}
                  fill={accentColor}
                  stroke={CANVAS_ON_SELECT}
                  strokeWidth={strokeW}
                  transform={`rotate(45 ${offsetHandle.x} ${offsetHandle.y})`}
                />
              </g>
            )}

            {/* Gradient lever — Figma parity: active only while the fill row's
                color panel is open, which is also when the transform box stands
                down. Rendered after the resize corners so it wins the hit test
                wherever the two could overlap. */}
            {gradientTarget && gizmoGrad && el.type !== "text" && onGradientHandlePointerDown && (() => {
              const grad = gizmoGrad;
              const found = { paint: grad, index: gradientTarget.paintIndex };
              const stops = getGradientStops(grad);
              const hitR = 9 / zoom;
              const knob = 5 / zoom;
              const drag = (which: GradientHandle) => (e: any) =>
                onGradientHandlePointerDown(e, el, found.index, which);

              if (grad.type === "linear-gradient") {
                // Explicit endpoints win over the symmetric angle shorthand —
                // the two handles sit on the axis the renderer actually paints.
                const lever = linearLeverEndpoints(grad.angle ?? 90, el.width, el.height);
                const sf = grad.start ?? { x: lever.start.x / el.width, y: lever.start.y / el.height };
                const ef = grad.end ?? { x: lever.end.x / el.width, y: lever.end.y / el.height };
                const sx = worldX + sf.x * el.width;
                const sy = worldY + sf.y * el.height;
                const ex = worldX + ef.x * el.width;
                const ey = worldY + ef.y * el.height;
                return (
                  <g data-gradient-gizmo="linear">
                    <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={accentColor} strokeWidth={strokeW} pointerEvents="none" />
                    <g data-gradient-handle="start" style={{ cursor: "crosshair" }} onPointerDown={drag("start")}>
                      <circle cx={sx} cy={sy} r={hitR} fill="transparent" />
                      <circle cx={sx} cy={sy} r={knob} fill={stops[0]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                    </g>
                    <g data-gradient-handle="end" style={{ cursor: "crosshair" }} onPointerDown={drag("end")}>
                      <circle cx={ex} cy={ey} r={hitR} fill="transparent" />
                      <rect x={ex - knob} y={ey - knob} width={knob * 2} height={knob * 2} fill={stops[stops.length - 1]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                    </g>
                  </g>
                );
              }

              if (grad.type === "angular-gradient") {
                const ag = grad as Extract<Paint, { type: "angular-gradient" }>;
                const ccx = worldX + (ag.center?.x ?? 0.5) * el.width;
                const ccy = worldY + (ag.center?.y ?? 0.5) * el.height;
                // The sweep is a circle in px (the sectors fan out from
                // `dirFromTop`), so the guide is an inscribed one: it shows the
                // centre and the turn without leaving the box. Its radius is
                // chrome — the paint has no extent to drag.
                const rr = Math.min(el.width, el.height) / 2;
                const rad = ((ag.angle ?? 0) * Math.PI) / 180;
                const hx = ccx + rr * Math.sin(rad);
                const hy = ccy - rr * Math.cos(rad);
                return (
                  <g data-gradient-gizmo="angular">
                    <circle cx={ccx} cy={ccy} r={rr} fill="none" stroke={CANVAS_GUIDE} strokeWidth={strokeW} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />
                    {/* A tick at 0°: an aimed sweep is unreadable without it. */}
                    <line x1={ccx} y1={ccy - rr} x2={ccx} y2={ccy - rr * 1.18} stroke={CANVAS_GUIDE} strokeWidth={strokeW} pointerEvents="none" />
                    <line x1={ccx} y1={ccy} x2={hx} y2={hy} stroke={accentColor} strokeWidth={strokeW} pointerEvents="none" />
                    <g data-gradient-handle="center" style={{ cursor: "crosshair" }} onPointerDown={drag("center")}>
                      <circle cx={ccx} cy={ccy} r={hitR} fill="transparent" />
                      <circle cx={ccx} cy={ccy} r={knob} fill={stops[0]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                    </g>
                    <g data-gradient-handle="sweep" style={{ cursor: "crosshair" }} onPointerDown={drag("sweep")}>
                      <circle cx={hx} cy={hy} r={hitR} fill="transparent" />
                      <circle cx={hx} cy={hy} r={knob} fill={stops[stops.length - 1]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                    </g>
                  </g>
                );
              }

              if (grad.type === "diamond-gradient") {
                const dg = grad as Extract<Paint, { type: "diamond-gradient" }>;
                const ccx = worldX + (dg.center?.x ?? 0.5) * el.width;
                const ccy = worldY + (dg.center?.y ?? 0.5) * el.height;
                // Semi-axes in px, rotating about the centre in px — the same
                // space `rotate(φ, c)` turns the four quadrant rects in. The
                // vertex formulas are that rotation applied to (a, 0) and (0, b).
                const ax = (dg.rx ?? dg.radius ?? 0.75) * el.width;
                const by = (dg.ry ?? dg.radius ?? 0.75) * el.height;
                const rad = ((dg.angle ?? 0) * Math.PI) / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const v1 = { x: ccx + ax * cos, y: ccy + ax * sin };
                const v2 = { x: ccx - by * sin, y: ccy + by * cos };
                const v3 = { x: ccx - ax * cos, y: ccy - ax * sin };
                const v4 = { x: ccx + by * sin, y: ccy - by * cos };
                return (
                  <g data-gradient-gizmo="diamond">
                    <path
                      d={`M${v1.x} ${v1.y}L${v2.x} ${v2.y}L${v3.x} ${v3.y}L${v4.x} ${v4.y}Z`}
                      fill="none"
                      stroke={CANVAS_GUIDE}
                      strokeWidth={strokeW}
                      strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                      pointerEvents="none"
                    />
                    <line x1={ccx} y1={ccy} x2={v1.x} y2={v1.y} stroke={accentColor} strokeWidth={strokeW} pointerEvents="none" />
                    <g data-gradient-handle="center" style={{ cursor: "crosshair" }} onPointerDown={drag("center")}>
                      <circle cx={ccx} cy={ccy} r={hitR} fill="transparent" />
                      <circle cx={ccx} cy={ccy} r={knob} fill={stops[0]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                    </g>
                    <g data-gradient-handle="rimX" style={{ cursor: "crosshair" }} onPointerDown={drag("rimX")}>
                      <circle cx={v1.x} cy={v1.y} r={hitR} fill="transparent" />
                      <rect x={v1.x - knob} y={v1.y - knob} width={knob * 2} height={knob * 2} fill={stops[stops.length - 1]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                    </g>
                    <g data-gradient-handle="rimY" style={{ cursor: "crosshair" }} onPointerDown={drag("rimY")}>
                      <circle cx={v2.x} cy={v2.y} r={hitR} fill="transparent" />
                      <rect x={v2.x - knob} y={v2.y - knob} width={knob * 2} height={knob * 2} fill={stops[stops.length - 1]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                    </g>
                  </g>
                );
              }

              const radial = grad as Extract<Paint, { type: "radial-gradient" }>;
              const cxf = radial.center?.x ?? 0.5;
              const cyf = radial.center?.y ?? 0.5;
              const rxf = radial.rx ?? radial.radius ?? 0.75;
              const ryf = radial.ry ?? radial.radius ?? 0.75;
              const ang = ((radial.angle ?? 0) * Math.PI) / 180;
              const ccx = worldX + cxf * el.width;
              const ccy = worldY + cyf * el.height;
              // Ellipse geometry lives in the box's FRACTION space (rotated
              // there, then stretched to px), so the guide is sampled from the
              // parametric curve rather than drawn as a px-space ellipse — a
              // non-square box would bend the axis.
              const semi = (t: number) => ({
                x: rxf * Math.cos(t) * Math.cos(ang) - ryf * Math.sin(t) * Math.sin(ang),
                y: rxf * Math.cos(t) * Math.sin(ang) + ryf * Math.sin(t) * Math.cos(ang)
              });
              let rimPath = "";
              for (let i = 0; i <= 64; i++) {
                const o = semi((i / 64) * Math.PI * 2);
                rimPath += `${i === 0 ? "M" : "L"}${(worldX + (cxf + o.x) * el.width).toFixed(2)} ${(worldY + (cyf + o.y) * el.height).toFixed(2)}`;
              }
              const e1x = worldX + (cxf + rxf * Math.cos(ang)) * el.width;
              const e1y = worldY + (cyf + rxf * Math.sin(ang)) * el.height;
              const e2x = worldX + (cxf - ryf * Math.sin(ang)) * el.width;
              const e2y = worldY + (cyf + ryf * Math.cos(ang)) * el.height;
              return (
                <g data-gradient-gizmo="radial">
                  <path d={rimPath} fill="none" stroke={CANVAS_GUIDE} strokeWidth={strokeW} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />
                  <line x1={ccx} y1={ccy} x2={e1x} y2={e1y} stroke={accentColor} strokeWidth={strokeW} pointerEvents="none" />
                  <g data-gradient-handle="center" style={{ cursor: "crosshair" }} onPointerDown={drag("center")}>
                    <circle cx={ccx} cy={ccy} r={hitR} fill="transparent" />
                    <circle cx={ccx} cy={ccy} r={knob} fill={stops[0]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                  </g>
                  <g data-gradient-handle="rimX" style={{ cursor: "crosshair" }} onPointerDown={drag("rimX")}>
                    <circle cx={e1x} cy={e1y} r={hitR} fill="transparent" />
                    <rect x={e1x - knob} y={e1y - knob} width={knob * 2} height={knob * 2} fill={stops[stops.length - 1]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                  </g>
                  <g data-gradient-handle="rimY" style={{ cursor: "crosshair" }} onPointerDown={drag("rimY")}>
                    <circle cx={e2x} cy={e2y} r={hitR} fill="transparent" />
                    <rect x={e2x - knob} y={e2y - knob} width={knob * 2} height={knob * 2} fill={stops[stops.length - 1]?.color ?? CANVAS_ON_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW} />
                  </g>
                </g>
              );
            })()}
          </g>
        );
      })()}

      {/* Multi-Selection Joint Bounds & Bounding Rects */}
      {visibleSelected.length > 1 && (
        <>
          {selectionBoxes.length > 0 && (
            <g
              stroke={CANVAS_SELECT}
              strokeWidth={1 / zoom}
              strokeDasharray="2 2"
              fill="none"
              pointerEvents="none"
            >
              {selectionBoxes.map(({ id, box, transform }) => (
                <rect
                  key={`sel_${id}`}
                  transform={transform}
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                />
              ))}
            </g>
          )}
          {multiBounds && (
            <>
              <rect
                x={multiBounds.minX}
                y={multiBounds.minY}
                width={multiBounds.width}
                height={multiBounds.height}
                fill="none"
                stroke={CANVAS_PREVIEW}
                strokeWidth={1.5 / zoom}
                pointerEvents="none"
              />
              {/* A group is sized by dragging its box like a single layer is sized by
                  dragging its own. Without these the union was a picture of a
                  capability: drawn, outlined, and not something the pointer could
                  reach, so a multi-selection could only be resized by typing W and H
                  into the inspector. The corners carry the Scale tool's arrow for the
                  same reason a single layer's do — it has to point along the corner
                  under it, so a group needs one handle per corner too. */}
              {onMultiResizePointerDown &&
                ([
                  { type: "tl" as const, hx: multiBounds.minX, hy: multiBounds.minY, cursor: "nwse-resize" },
                  { type: "tr" as const, hx: multiBounds.minX + multiBounds.width, hy: multiBounds.minY, cursor: "nesw-resize" },
                  { type: "br" as const, hx: multiBounds.minX + multiBounds.width, hy: multiBounds.minY + multiBounds.height, cursor: "nwse-resize" },
                  { type: "bl" as const, hx: multiBounds.minX, hy: multiBounds.minY + multiBounds.height, cursor: "nesw-resize" },
                  { type: "tm" as const, hx: multiBounds.minX + multiBounds.width / 2, hy: multiBounds.minY, cursor: "ns-resize" },
                  { type: "mr" as const, hx: multiBounds.minX + multiBounds.width, hy: multiBounds.minY + multiBounds.height / 2, cursor: "ew-resize" },
                  { type: "bm" as const, hx: multiBounds.minX + multiBounds.width / 2, hy: multiBounds.minY + multiBounds.height, cursor: "ns-resize" },
                  { type: "ml" as const, hx: multiBounds.minX, hy: multiBounds.minY + multiBounds.height / 2, cursor: "ew-resize" }
                ] as const).map(({ type, hx, hy, cursor }) => {
                  const size = 8 / zoom;
                  return (
                    <rect
                      key={`multi_handle_${type}`}
                      data-multi-resize-handle={type}
                      x={hx - size / 2}
                      y={hy - size / 2}
                      width={size}
                      height={size}
                      fill={CANVAS_ON_SELECT}
                      stroke={CANVAS_SELECT}
                      strokeWidth={handleStroke}
                      rx={1}
                      ry={1}
                      style={{
                        cursor:
                          activeTool === "scale" && CORNER_HANDLES.includes(type)
                            ? getScaleCursor(cursor === "nwse-resize" ? "nwse" : "nesw")
                            : cursor
                      }}
                      onPointerDown={(e) => onMultiResizePointerDown(e, type, multiSelectionIds)}
                    />
                  );
                })}
            </>
          )}
        </>
      )}

      {/* Smart Alignment Guides */}
      {!hideSmart && activeGuides.map((guide, idx) => (
        <line
          key={`guide_line_${idx}`}
          x1={guide.orientation === "vertical" ? guide.position : guide.start}
          y1={guide.orientation === "horizontal" ? guide.position : guide.start}
          x2={guide.orientation === "vertical" ? guide.position : guide.end}
          y2={guide.orientation === "horizontal" ? guide.position : guide.end}
          stroke={CANVAS_SMART_SELECT}
          strokeWidth={1 / zoom}
          strokeDasharray="3 3"
          pointerEvents="none"
        />
      ))}

      {/* Marquee Drag Box */}
      {/* Marquee Drag Box — coral when the box SUBTRACTS.
          The band is the one piece of canvas chrome that states what the gesture
          it belongs to is about to DO, so it has to wear the verb: blue is the
          selection being made, and a band that stayed blue while Option turned the
          gesture into a removal showed the user one thing and did another. Coral is
          the geometry accent the gap pills already wear, and the only other
          meaning the canvas has. */}
      {marqueeRect && (
        <rect
          x={marqueeRect.x}
          y={marqueeRect.y}
          width={marqueeRect.width}
          height={marqueeRect.height}
          data-marquee-subtract={marqueeRect.subtract ? "true" : undefined}
          fill={withAlpha(marqueeRect.subtract ? CANVAS_CORAL : CANVAS_SELECT, 0.15)}
          stroke={marqueeRect.subtract ? CANVAS_CORAL : CANVAS_SELECT}
          strokeWidth={1 / zoom}
          strokeDasharray="3 3"
          pointerEvents="none"
        />
      )}

      {/* Swap Landing Placeholder */}
      {dropBox && (
        <rect
          data-smart-drop-box="1"
          x={dropBox.x}
          y={dropBox.y}
          width={dropBox.width}
          height={dropBox.height}
          fill={withAlpha(CANVAS_SELECT, 0.1)}
          stroke={CANVAS_SELECT}
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${3 / zoom}`}
          pointerEvents="none"
        />
      )}

      {/* Smart Selection Gap Handles */}
      {(gapDragActive || (!hideSmart && smartHoverActive)) && smartSelection && (onGapDragStart || onTidySpacing) && (
        <SmartSelectionOverlay
          smartSelection={smartSelection}
          zoom={zoom}
          onGapDragStart={onGapDragStart ?? (() => {})}
          onTidySpacing={onTidySpacing}
          onDotDragStart={onDotDragStart}
          gapDragActive={gapDragActive}
        />
      )}
    </>
  );
}
