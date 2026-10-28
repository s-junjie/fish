import { MeasureResult } from "../../core/geometry/measure-guides";
import { CANVAS_CORAL, CANVAS_ON_SELECT, CANVAS_SELECT } from "./canvas-colors";
import { CANVAS_CHROME_TEXT } from "./canvas-text";

interface MeasurementOverlayProps {
  measurement: MeasureResult | null;
  zoom: number;
}

export function MeasurementOverlay({ measurement, zoom }: MeasurementOverlayProps) {
  if (!measurement) return null;

  const { lines, targetBox, referenceBox } = measurement;
  const strokeW = 1.25 / zoom;
  const strokeColor = CANVAS_CORAL;
  const badgeBg = CANVAS_CORAL;
  const fontSize = 11 / zoom;

  return (
    <g data-measure-overlay="true" className="pointer-events-none select-none">
      {/* The selection the distances leave from. The selection chrome stands
          down while measuring, so this is the only thing that says where the
          numbers start — and for a multi-selection it is the union box, which
          no member's own outline would show. Blue, because it is still the
          chosen thing; coral belongs to the target and the gaps. */}
      <rect
        x={referenceBox.x}
        y={referenceBox.y}
        width={referenceBox.width}
        height={referenceBox.height}
        fill="none"
        stroke={CANVAS_SELECT}
        strokeWidth={strokeW}
      />
      {/* Target Element Outline (Red highlight) */}
      <rect
        x={targetBox.x}
        y={targetBox.y}
        width={targetBox.width}
        height={targetBox.height}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeW}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
      />

      {/* Measurement Distance Lines */}
      {lines.map((l, idx) => {
        const text = `${Math.round(l.distance)}`;
        // Estimate pill width
        const pillW = Math.max(18 / zoom, (text.length * 7 + 8) / zoom);
        const pillH = 16 / zoom;

        return (
          <g key={`measure_line_${idx}`}>
            {/* The distance line */}
            <line
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={strokeColor}
              strokeWidth={strokeW}
            />

            {/* End caps */}
            {l.axis === "y" ? (
              <>
                <line
                  x1={l.x1 - 4 / zoom}
                  y1={l.y1}
                  x2={l.x1 + 4 / zoom}
                  y2={l.y1}
                  stroke={strokeColor}
                  strokeWidth={strokeW}
                />
                <line
                  x1={l.x2 - 4 / zoom}
                  y1={l.y2}
                  x2={l.x2 + 4 / zoom}
                  y2={l.y2}
                  stroke={strokeColor}
                  strokeWidth={strokeW}
                />
              </>
            ) : (
              <>
                <line
                  x1={l.x1}
                  y1={l.y1 - 4 / zoom}
                  x2={l.x1}
                  y2={l.y1 + 4 / zoom}
                  stroke={strokeColor}
                  strokeWidth={strokeW}
                />
                <line
                  x1={l.x2}
                  y1={l.y2 - 4 / zoom}
                  x2={l.x2}
                  y2={l.y2 + 4 / zoom}
                  stroke={strokeColor}
                  strokeWidth={strokeW}
                />
              </>
            )}

            {/* Numeric Badge Pill */}
            <rect
              x={l.labelX - pillW / 2}
              y={l.labelY - pillH / 2}
              width={pillW}
              height={pillH}
              rx={3 / zoom}
              fill={badgeBg}
            />
            <text
              x={l.labelX}
              y={l.labelY + 3.5 / zoom}
              fill={CANVAS_ON_SELECT}
              fontSize={fontSize}
              fontWeight={600}
              fontFamily={CANVAS_CHROME_TEXT}
              textAnchor="middle"
            >
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}
