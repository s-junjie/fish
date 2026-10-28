import { DesignElement } from "../../core/dsl/types";
import { isGradientPaint } from "../../core/geometry/gradient-utils";
import { strokeDashAttrs } from "../../core/geometry/stroke-utils";
import { CANVAS_ON_SELECT } from "./canvas-colors";
import { NodeRenderContext } from "./NodeRenderContext";

export interface SvgLineArrowNodeProps {
  el: DesignElement;
  isArrow: boolean;
  activeStrokes: any[];
  strokeLayerIndex: (s: any, fallback: number) => number;
  ctx: NodeRenderContext;
  onDoubleClick: (e: MouseEvent) => void;
}

export function SvgLineArrowNode({
  el,
  isArrow,
  activeStrokes,
  strokeLayerIndex,
  ctx,
  onDoubleClick
}: SvgLineArrowNodeProps) {
  const lineEl = el as any;
  const strokesToRender =
    activeStrokes.length > 0
      ? activeStrokes
      : [{ color: lineEl.strokes?.[0]?.color || CANVAS_ON_SELECT, width: 2 }];

  const x1 = el.x;
  const y1 = el.y;
  const x2 = x1 + lineEl.dx;
  const y2 = y1 + lineEl.dy;

  return (
    <g
      onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
      onDblClick={onDoubleClick}
    >
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="transparent"
        data-hit="true"
        strokeWidth={activeStrokes[0]?.width || lineEl.strokes?.[0]?.width || 2}
        style={{ "--hit-stroke": `${activeStrokes[0]?.width || lineEl.strokes?.[0]?.width || 2}px` }}
        pointerEvents="stroke"
      />
      {strokesToRender.map((s: any, idx: number) => {
        const rawColor = s.color || (s.paint?.type === "solid" ? s.paint.color : undefined) || CANVAS_ON_SELECT;
        let strokeColorAttr = rawColor;
        if (s.paint && isGradientPaint(s.paint)) {
          strokeColorAttr = `url(#grad_stroke_${el.id}_${strokeLayerIndex(s, idx)})`;
        } else if (s.paint?.type === "pattern") {
          strokeColorAttr = `url(#pat_stroke_${el.id}_${strokeLayerIndex(s, idx)})`;
        }
        const strokeWidth = s.width || 2;
        const strokeCapJoin = strokeDashAttrs(s);
        const strokeOpacity = typeof s.opacity === "number" ? s.opacity : 1;
        const markerEnd =
          isArrow && idx === strokesToRender.length - 1
            ? "url(#arrowhead)"
            : undefined;

        return (
          <line
            key={idx}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={strokeColorAttr}
            strokeWidth={strokeWidth}
            markerEnd={markerEnd}
            strokeOpacity={strokeOpacity}
            {...strokeCapJoin}
          />
        );
      })}
    </g>
  );
}
