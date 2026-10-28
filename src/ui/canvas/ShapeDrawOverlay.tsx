import { ShapeDraftGeometry } from "../../core/geometry/shape-creation";
import { polygonToPathData, starToPathData } from "../../core/compile";
import { PolygonElement, StarElement } from "../../core/dsl/types";
import { CANVAS_BADGE_INK, CANVAS_BADGE_RIDGE, CANVAS_BADGE_SURFACE, CANVAS_SELECT, CANVAS_COMPONENT, CANVAS_ON_SELECT } from "./canvas-colors";
import { CANVAS_CHROME_TEXT } from "./canvas-text";

interface ShapeDrawOverlayProps {
  draft: ShapeDraftGeometry | null;
  zoom: number;
}

export function ShapeDrawOverlay({ draft, zoom }: ShapeDrawOverlayProps) {
  if (!draft) return null;

  const strokeW = 1 / zoom;
  const isLine = draft.kind === "line";

  // Pill badge calculation
  let badgeText = "";
  let badgeX = 0;
  let badgeY = 0;

  if (isLine) {
    const dx = draft.x2 - draft.x;
    const dy = draft.y2 - draft.y;
    const len = Math.round(Math.hypot(dx, dy));
    const deg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
    badgeText = `${len}px, ${deg}°`;
    badgeX = draft.x2 + 10 / zoom;
    badgeY = draft.y2 + 14 / zoom;
  } else {
    badgeText = `${draft.width} × ${draft.height}`;
    badgeX = draft.x + draft.width / 2;
    badgeY = draft.y + draft.height + 14 / zoom;
  }

  const badgeW = (badgeText.length * 6.5 + 12) / zoom;
  const badgeH = 18 / zoom;

  return (
    <g className="pointer-events-none select-none">
      {/* Draft Shape Rendering */}
      {draft.kind === "box" && (
        <>
          {(draft.tool === "rect" || draft.tool === "frame") && (
            <rect
              x={draft.x}
              y={draft.y}
              width={draft.width}
              height={draft.height}
              fill="none"
              stroke={CANVAS_SELECT}
              strokeWidth={strokeW}
            />
          )}

          {draft.tool === "ellipse" && (
            <ellipse
              cx={draft.x + draft.width / 2}
              cy={draft.y + draft.height / 2}
              rx={draft.width / 2}
              ry={draft.height / 2}
              fill="none"
              stroke={CANVAS_SELECT}
              strokeWidth={strokeW}
            />
          )}

          {draft.tool === "polygon" && (
            <g transform={`translate(${draft.x}, ${draft.y})`}>
              <path
                d={polygonToPathData({
                  id: "draft_poly",
                  type: "polygon",
                  width: draft.width,
                  height: draft.height,
                  sides: 5,
                  x: 0,
                  y: 0
                } as PolygonElement)}
                fill="none"
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
            </g>
          )}

          {draft.tool === "star" && (
            <g transform={`translate(${draft.x}, ${draft.y})`}>
              <path
                d={starToPathData({
                  id: "draft_star",
                  type: "star",
                  width: draft.width,
                  height: draft.height,
                  points: 5,
                  innerRadius: 0.382,
                  cornerSmoothing: 0,
                  x: 0,
                  y: 0
                } as StarElement)}
                fill="none"
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
            </g>
          )}

          {draft.tool === "text" && (
            <rect
              x={draft.x}
              y={draft.y}
              width={draft.width}
              height={draft.height}
              fill="none"
              stroke={CANVAS_SELECT}
              strokeWidth={strokeW}
              strokeDasharray="4 4"
            />
          )}
        </>
      )}

      {draft.kind === "line" && (
        <line
          x1={draft.x}
          y1={draft.y}
          x2={draft.x2}
          y2={draft.y2}
          stroke={CANVAS_SELECT}
          strokeWidth={Math.max(1.5, 2 / zoom)}
          markerEnd={draft.tool === "arrow" ? "url(#arrowhead)" : undefined}
        />
      )}

      {/* Floating Dimension Pill Badge */}
      <g transform={`translate(${badgeX - badgeW / 2}, ${badgeY})`}>
        <rect
          width={badgeW}
          height={badgeH}
          rx={3 / zoom}
          fill={CANVAS_BADGE_SURFACE}
          stroke={CANVAS_BADGE_RIDGE}
          strokeWidth={strokeW}
        />
        <text
          x={badgeW / 2}
          y={badgeH / 2 + 0.5 / zoom}
          fill={CANVAS_BADGE_INK}
          fontSize={10 / zoom}
          fontFamily={CANVAS_CHROME_TEXT}
          fontWeight={500}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {badgeText}
        </text>
      </g>
    </g>
  );
}
