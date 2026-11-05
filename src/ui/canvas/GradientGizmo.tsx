import type { JSX } from "preact";
import type { DesignElement, Paint } from "../../core/dsl/types";
import { getGradientStops } from "../../core/geometry/gradient-utils";
import { t } from "../../i18n";
import type { GradientHandle } from "../hooks/canvas-gestures/gradient-gesture";
import { CANVAS_GUIDE, CANVAS_ON_SELECT, CANVAS_SELECT } from "./canvas-colors";
import { GradientKnob } from "./GradientKnob";
import { stopAxisOf } from "./gradient-stop-axis";

type GradientPaint = Extract<
  Paint,
  { type: "linear-gradient" | "radial-gradient" | "angular-gradient" | "diamond-gradient" }
>;

interface KnobSpec {
  handle: GradientHandle;
  x: number;
  y: number;
  shape: "circle" | "square";
  fill: string;
  cursor: string;
  title: string;
}

export interface BuildGradientGizmoArgs {
  el: DesignElement;
  paint: GradientPaint;
  paintIndex: number;
  stack: "fills" | "strokes";
  /** Which stop the editor is on — the one the knobs and markers ring in blue. */
  selectedStop: number;
  /** Top-left of the element's own box, in the overlay's coordinate space. */
  x: number;
  y: number;
  zoom: number;
  strokeW: number;
  accentColor: string;
  onSelectStop: (index: number) => void;
  onPointerDown: (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    which: GradientHandle,
    stack: "fills" | "strokes"
  ) => void;
  onStopPointerDown: (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    stopIndex: number,
    stack: "fills" | "strokes"
  ) => void;
  onStopInsert: (e: PointerEvent, el: DesignElement, paintIndex: number, stack: "fills" | "strokes") => void;
  onStopDelete: (
    el: DesignElement,
    paintIndex: number,
    stopIndex: number,
    stack: "fills" | "strokes"
  ) => boolean;
}

const pct = (offset: number) => Math.round(offset * 100);

/**
 * The lever, as a node.
 *
 * Every dialect gets the same three layers, in this order: the guides the
 * renderer already draws, the stop markers (plus one "add" grip), and the end
 * knobs. Order is hit-test order — a marker always beats the guide it sits on,
 * and a knob always beats the marker it may overlap.
 */
export function buildGradientGizmo({
  el,
  paint: grad,
  paintIndex,
  stack,
  selectedStop,
  x: originX,
  y: originY,
  zoom,
  strokeW,
  accentColor,
  onSelectStop,
  onPointerDown,
  onStopPointerDown,
  onStopInsert,
  onStopDelete
}: BuildGradientGizmoArgs): JSX.Element {
  const stops = getGradientStops(grad);
  const radius = 5 / zoom;
  const hitRadius = 12 / zoom;
  const axis = stopAxisOf(el, grad, { x: originX, y: originY });
  const drag = (which: GradientHandle) => (e: PointerEvent) => onPointerDown(e, el, paintIndex, which, stack);

  const knob = (spec: KnobSpec) => (
    <GradientKnob
      key={spec.handle}
      handle={spec.handle}
      cx={spec.x}
      cy={spec.y}
      radius={radius}
      shape={spec.shape}
      fill={spec.fill}
      hitRadius={hitRadius}
      strokeWidth={strokeW}
      cursor={spec.cursor}
      title={spec.title}
      onPointerDown={drag(spec.handle)}
    />
  );

  /**
   * The stops that are not ends, plus one grip that adds another.
   *
   * The add grip sits in the WIDEST GAP, offset off the axis so it never eats
   * the drag that translates the gradient — a press on the line must keep
   * meaning "move", and an invisible double-click target is not a way to add
   * anything. It is the visible answer to "how do I get another stop?".
   */
  const stopLayer = axis ? (
    <>
      {stops
        .map((stop, i) => ({ stop, i }))
        // Skip only what the end grips already mark: a stop INSET from the ends
        // (the first colour at 30%, say) is a stop like any other and must be
        // visible and draggable, even when it is `stops[0]`.
        .filter(({ stop }) => stop.offset > 0.001 && stop.offset < 0.999)
        .map(({ stop, i }) => {
          const point = axis.pointAt(stop.offset);
          const selected = i === selectedStop;
          const half = (selected ? 5 : 3.5) / zoom;
          return (
            <g
              key={`stop_${i}`}
              data-gradient-stop={i}
              data-gradient-stop-offset={String(stop.offset)}
              data-gradient-stop-selected={selected ? "true" : undefined}
              tabIndex={0}
              role="slider"
              aria-label={`${t("paint.stop")} ${i + 1}/${stops.length}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct(stop.offset)}
              style={{ cursor: "move" }}
              onPointerDown={(e) => {
                (e.currentTarget as SVGGElement).focus?.({ preventScroll: true });
                onSelectStop(i);
                onStopPointerDown(e, el, paintIndex, i, stack);
              }}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.isComposing || (e as any).keyCode === 229) return;
                if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  e.stopPropagation();
                  onStopDelete(el, paintIndex, i, stack);
                }
              }}
            >
              <title>{`${pct(stop.offset)}%`}</title>
              <circle cx={point.x} cy={point.y} r={10 / zoom} fill="transparent" />
              {selected ? (
                <rect
                  x={point.x - half - 2 / zoom}
                  y={point.y - half - 2 / zoom}
                  width={(half + 2 / zoom) * 2}
                  height={(half + 2 / zoom) * 2}
                  rx={2 / zoom}
                  fill="none"
                  stroke={CANVAS_SELECT}
                  strokeWidth={strokeW}
                  pointerEvents="none"
                />
              ) : null}
              <rect
                x={point.x - half}
                y={point.y - half}
                width={half * 2}
                height={half * 2}
                rx={1 / zoom}
                fill={stop.color}
                stroke={CANVAS_ON_SELECT}
                strokeWidth={(selected ? 2 : 1) / zoom}
                pointerEvents="none"
              />
            </g>
          );
        })}
    </>
  ) : null;

  if (grad.type === "linear-gradient") {
    // Explicit endpoints win over the symmetric angle shorthand — the two
    // handles sit on the axis the renderer actually paints.
    const sx = axis!.pointAt(0).x;
    const sy = axis!.pointAt(0).y;
    const ex = axis!.pointAt(1).x;
    const ey = axis!.pointAt(1).y;
    return (
      <g data-gradient-gizmo="linear">
        <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={accentColor} strokeWidth={strokeW} pointerEvents="none" />
        {/* The line BODY is a grip: it translates both ends at once. A 12px
            invisible stroke is the target — the visible line is 1.5px and `none`
            for the pointer, because a hairline you must hit exactly is not an
            affordance. Knobs render after it, so they win wherever they overlap. */}
        <line
          x1={sx}
          y1={sy}
          x2={ex}
          y2={ey}
          data-gradient-axis="1"
          stroke="transparent"
          strokeWidth={12 / zoom}
          pointerEvents="stroke"
          style={{ cursor: "copy" }}
          onPointerDown={drag("axis")}
        >
          <title>{t("paint.lever.line")}</title>
        </line>
        {stopLayer}
        {knob({
          handle: "start",
          x: sx,
          y: sy,
          shape: "circle",
          fill: CANVAS_ON_SELECT,
          cursor: "grab",
          title: t("paint.lever.start")
        })}
        {knob({
          handle: "end",
          x: ex,
          y: ey,
          shape: "square",
          fill: CANVAS_ON_SELECT,
          cursor: "grab",
          title: t("paint.lever.end")
        })}
      </g>
    );
  }

  if (grad.type === "angular-gradient") {
    const ccx = originX + (grad.center?.x ?? 0.5) * el.width;
    const ccy = originY + (grad.center?.y ?? 0.5) * el.height;
    // The sweep is a circle in px (the sectors fan out from `dirFromTop`), so the
    // guide is an inscribed one: it shows the centre and the turn without leaving
    // the box. Its radius is chrome — the paint has no extent to drag.
    const rr = Math.min(el.width, el.height) / 2;
    const rad = ((grad.angle ?? 0) * Math.PI) / 180;
    const hx = ccx + rr * Math.sin(rad);
    const hy = ccy - rr * Math.cos(rad);
    return (
      <g data-gradient-gizmo="angular">
        <circle cx={ccx} cy={ccy} r={rr} fill="none" stroke={CANVAS_GUIDE} strokeWidth={strokeW} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />
        <circle
          cx={ccx}
          cy={ccy}
          r={rr}
          data-gradient-axis="1"
          fill="none"
          stroke="transparent"
          strokeWidth={12 / zoom}
          pointerEvents="stroke"
          style={{ cursor: "copy" }}
          onPointerDown={(e) => onStopInsert(e as unknown as PointerEvent, el, paintIndex, stack)}
        >
          <title>{t("paint.lever.addStop")}</title>
        </circle>
        {/* A tick at 0°: an aimed sweep is unreadable without it. */}
        <line x1={ccx} y1={ccy - rr} x2={ccx} y2={ccy - rr * 1.18} stroke={CANVAS_GUIDE} strokeWidth={strokeW} pointerEvents="none" />
        <line x1={ccx} y1={ccy} x2={hx} y2={hy} stroke={accentColor} strokeWidth={strokeW} pointerEvents="none" />
        {stopLayer}
        {knob({
          handle: "center",
          x: ccx,
          y: ccy,
          shape: "circle",
          fill: CANVAS_ON_SELECT,
          cursor: "grab",
          title: t("paint.lever.center")
        })}
        {knob({
          handle: "sweep",
          x: hx,
          y: hy,
          shape: "circle",
          fill: CANVAS_ON_SELECT,
          cursor: "grab",
          title: t("paint.lever.sweep")
        })}
      </g>
    );
  }

  if (grad.type === "diamond-gradient") {
    const ccx = originX + (grad.center?.x ?? 0.5) * el.width;
    const ccy = originY + (grad.center?.y ?? 0.5) * el.height;
    // Semi-axes in px, rotating about the centre in px — the same space
    // `rotate(φ, c)` turns the four quadrant rects in. The vertex formulas are
    // that rotation applied to (a, 0) and (0, b).
    const ax = (grad.rx ?? grad.radius ?? 0.75) * el.width;
    const by = (grad.ry ?? grad.radius ?? 0.75) * el.height;
    const rad = ((grad.angle ?? 0) * Math.PI) / 180;
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
        <line
          x1={ccx}
          y1={ccy}
          x2={v1.x}
          y2={v1.y}
          data-gradient-axis="1"
          stroke="transparent"
          strokeWidth={12 / zoom}
          pointerEvents="stroke"
          style={{ cursor: "copy" }}
          onPointerDown={(e) => onStopInsert(e as unknown as PointerEvent, el, paintIndex, stack)}
        >
          <title>{t("paint.lever.addStop")}</title>
        </line>
        {stopLayer}
        {knob({
          handle: "center",
          x: ccx,
          y: ccy,
          shape: "circle",
          fill: CANVAS_ON_SELECT,
          cursor: "grab",
          title: t("paint.lever.center")
        })}
        {knob({
          handle: "rimX",
          x: v1.x,
          y: v1.y,
          shape: "square",
          fill: CANVAS_ON_SELECT,
          cursor: "grab",
          title: t("paint.lever.axis")
        })}
        {knob({
          handle: "rimY",
          x: v2.x,
          y: v2.y,
          shape: "square",
          fill: CANVAS_ON_SELECT,
          cursor: "grab",
          title: t("paint.lever.axisWidth")
        })}
      </g>
    );
  }

  const cxf = grad.center?.x ?? 0.5;
  const cyf = grad.center?.y ?? 0.5;
  const rxf = grad.rx ?? grad.radius ?? 0.75;
  const ryf = grad.ry ?? grad.radius ?? 0.75;
  const ang = ((grad.angle ?? 0) * Math.PI) / 180;
  const ccx = originX + cxf * el.width;
  const ccy = originY + cyf * el.height;
  // Ellipse geometry lives in the box's FRACTION space (rotated there, then
  // stretched to px), so the guide is sampled from the parametric curve rather
  // than drawn as a px-space ellipse — a non-square box would bend the axis.
  const semi = (t: number) => ({
    x: rxf * Math.cos(t) * Math.cos(ang) - ryf * Math.sin(t) * Math.sin(ang),
    y: rxf * Math.cos(t) * Math.sin(ang) + ryf * Math.sin(t) * Math.cos(ang)
  });
  let rimPath = "";
  for (let i = 0; i <= 64; i++) {
    const o = semi((i / 64) * Math.PI * 2);
    rimPath += `${i === 0 ? "M" : "L"}${(originX + (cxf + o.x) * el.width).toFixed(2)} ${(originY + (cyf + o.y) * el.height).toFixed(2)}`;
  }
  const e1x = originX + (cxf + rxf * Math.cos(ang)) * el.width;
  const e1y = originY + (cyf + rxf * Math.sin(ang)) * el.height;
  const e2x = originX + (cxf - ryf * Math.sin(ang)) * el.width;
  const e2y = originY + (cyf + ryf * Math.cos(ang)) * el.height;
  return (
    <g data-gradient-gizmo="radial">
      <path d={rimPath} fill="none" stroke={CANVAS_GUIDE} strokeWidth={strokeW} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />
      <line x1={ccx} y1={ccy} x2={e1x} y2={e1y} stroke={accentColor} strokeWidth={strokeW} pointerEvents="none" />
        <line
          x1={ccx}
          y1={ccy}
          x2={e1x}
          y2={e1y}
          data-gradient-axis="1"
          stroke="transparent"
          strokeWidth={12 / zoom}
          pointerEvents="stroke"
          style={{ cursor: "copy" }}
          onPointerDown={(e) => onStopInsert(e as unknown as PointerEvent, el, paintIndex, stack)}
        >
          <title>{t("paint.lever.addStop")}</title>
        </line>
      {stopLayer}
      {knob({
        handle: "center",
        x: ccx,
        y: ccy,
        shape: "circle",
        fill: CANVAS_ON_SELECT,
        cursor: "grab",
        title: t("paint.lever.center")
      })}
      {knob({
        handle: "rimX",
        x: e1x,
        y: e1y,
        shape: "square",
        fill: CANVAS_ON_SELECT,
        cursor: "grab",
        title: t("paint.lever.axis")
      })}
      {knob({
        handle: "rimY",
        x: e2x,
        y: e2y,
        shape: "square",
        fill: CANVAS_ON_SELECT,
        cursor: "grab",
        title: t("paint.lever.axisWidth")
      })}
    </g>
  );
}
