import { useState } from "preact/hooks";
import { SmartSelectionInfo, SmartDotHandle } from "../../core/geometry/smart-selection";
import { CANVAS_CORAL, CANVAS_ON_SELECT } from "./canvas-colors";
import { SpacingBandView } from "./SpacingBandView";
import { t } from "../../i18n";

interface SmartSelectionOverlayProps {
  smartSelection: SmartSelectionInfo | null;
  zoom: number;
  onGapDragStart: (e: any, handleId: string) => void;
  onTidySpacing?: (axis: "x" | "y") => void;
  onDotDragStart?: (e: any, dot: SmartDotHandle) => void;
  gapDragActive?: boolean;
}

/**
 * How far the tidy-up badges reach past the selection's right edge, in screen
 * pixels — the clear gap, plus every badge and the pitch between them.
 *
 * Exported because the badges have to sit INSIDE whatever the canvas uses to
 * decide the pointer is over the selection: they are controls you have to be able
 * to move onto, and they are drawn outside the box the gap pills are measured
 * from, so a gate that stopped at the edge would take them away as the pointer
 * arrived.
 */
export function tidyBadgeReach(count: number): number {
  if (count <= 0) return 0;
  return TIDY_BADGE_GAP + count * TIDY_BADGE_D + (count - 1) * TIDY_BADGE_PITCH;
}

/**
 * The badge, the clear space past the box it hangs off, and the pitch between two.
 *
 * Proportioned against the 8px corner resize handle it sits beside: 20 is two and
 * a half handles, which is the size Figma's distribute mark reads at. No drop
 * shadow either — the mark is flat paint on the canvas, and a shadow turns a chip
 * that states a fact into a control that appears to be floating above the work.
 */
const TIDY_BADGE_D = 20;
/** Enough to clear the corner resize handle with a hairline to spare. */
const TIDY_BADGE_GAP = 9;
const TIDY_BADGE_PITCH = 5;
/** Inset and corner radius of the mark inside the badge. */
const TIDY_MARK_INSET = 4.5;
const TIDY_MARK_RADIUS = 4.5;

export function SmartSelectionOverlay({
  smartSelection,
  zoom,
  onGapDragStart,
  onTidySpacing,
  onDotDragStart,
  gapDragActive
}: SmartSelectionOverlayProps) {
  const [hoveredDotId, setHoveredDotId] = useState<string | null>(null);

  if (!smartSelection) return null;

  const { handles, dots, gapsEven, unevenAxes } = smartSelection;
  if (handles.length === 0 && (!dots || dots.length === 0)) return null;

  const CORAL = CANVAS_CORAL;
  const strokeW = 1 / zoom;

  // Pill handle dimensions (Figma-style horizontal or vertical rounded-ctl pill)
  const pillLength = 11 / zoom;
  const pillThickness = 3.5 / zoom;
  const pillRadius = pillThickness / 2;

  // Center reorder dot dimensions (Figma: default hollow ring, hover/active solid pink)
  const dotR = 3.5 / zoom;

  /**
   * The row chrome — gap pills AND reorder dots — is one set for one state: this
   * selection is a row or a grid, and its spacing is a thing you can grab.
   *
   * The dots go with the pills because they rest on the same premise. A dot drag
   * moves one element and rides the pointer while everything between it and the
   * slot it is leaving shifts along; both halves are written from the boxes the row
   * has NOW. On an even row that lands on an even row. On a ragged one it lands on
   * a differently ragged row, and the only evidence anything happened is that the
   * dots came back — which they do not, because the row is still ragged. Offering
   * one set half the time is worse than offering none: it says the selection has a
   * spacing you can manipulate, and then refuses to let you finish the gesture.
   */
  const rowChrome = gapsEven;

  // Uneven spacing: a tidy-up badge per ragged direction instead — Figma's
  // distribute control is a mark per axis too, and on a grid the two directions are
  // two separate questions.
  const badgeD = TIDY_BADGE_D / zoom;
  const badgeR = TIDY_MARK_RADIUS / zoom;
  const mark = (TIDY_BADGE_D - TIDY_MARK_INSET * 2) / zoom;
  const barW = mark / 5;
  // A corner badge: the first one clears the box's right edge, and each further
  // one steps right by its own width. Bottom edges line up, so a second badge
  // reads as a second badge rather than as the selection having moved.
  const badgeY = smartSelection.bounds.y + smartSelection.bounds.height - badgeD / 2;
  const badgeX0 = smartSelection.bounds.x + smartSelection.bounds.width + TIDY_BADGE_GAP / zoom;
  const tidyLabel = (axis: "x" | "y") =>
    t(axis === "x" ? "smart.tidySpacingHorizontal" : "smart.tidySpacingVertical");

  return (
    <g className="select-none">
      {/* 1. Element Center Reorder/Swap Dots */}
      {!gapDragActive && rowChrome && dots?.map((d) => {
        const isHovered = hoveredDotId === d.id;

        return (
          <g
            key={d.id}
            data-smart-dot={d.elementId}
            transform={`translate(${d.x}, ${d.y})`}
            style={{ cursor: "move" }}
            onPointerEnter={() => setHoveredDotId(d.id)}
            onPointerLeave={() => {
              if (hoveredDotId === d.id) {
                setHoveredDotId(null);
              }
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              setHoveredDotId(d.id);
              if (onDotDragStart) {
                onDotDragStart(e, d);
              }
            }}
          >
            {/* Precise hit area so normal dragging of element is not hijacked */}
            <circle r={dotR * 1.3} fill="transparent" />

            {/* Base circle:
                - Default: Hollow ring (white background + vibrant pink stroke)
                - Hover / Dragging: Solid vibrant pink fill (#FF007A) with white border
            */}
            <circle
              r={dotR}
              fill={isHovered ? CORAL : CANVAS_ON_SELECT}
              stroke={isHovered ? CANVAS_ON_SELECT : CORAL}
              strokeWidth={strokeW * 1.5}
              style={{
                filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))",
                transition: "fill 0.15s ease, stroke 0.15s ease"
              }}
            />

            {/* Solid core indicator when hovered for extra crispness */}
            {isHovered && (
              <circle
                r={dotR * 0.4}
                fill={CANVAS_ON_SELECT}
                pointerEvents="none"
              />
            )}
          </g>
        );
      })}

      {/* 2. Gap Scrubbing Pill Handles — replaced by the full gap read-out while dragging,
           and withheld entirely while the gaps are uneven (see the tidy-up button in 4). */}
      {!gapDragActive && rowChrome && handles.map((h) => {
        const isHorizontal = h.axis === "x";
        const cursor = isHorizontal ? "ew-resize" : "ns-resize";

        // For horizontal row, pill is oriented vertically across the gap; for vertical column, pill is horizontal
        const w = isHorizontal ? pillThickness : pillLength;
        const hDim = isHorizontal ? pillLength : pillThickness;

        return (
          <g
            key={h.id}
            data-smart-gap={h.id}
            transform={`translate(${h.x}, ${h.y})`}
            style={{ cursor }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              onGapDragStart(e, h.id);
            }}
          >
            {/* Transparent enlarged hit area */}
            <rect
              x={-w / 2 - 4 / zoom}
              y={-hDim / 2 - 4 / zoom}
              width={w + 8 / zoom}
              height={hDim + 8 / zoom}
              fill="transparent"
            />

            {/* Figma-style coral rounded-ctl pill */}
            <rect
              x={-w / 2}
              y={-hDim / 2}
              width={w}
              height={hDim}
              rx={pillRadius}
              ry={pillRadius}
              fill={CORAL}
              stroke={CANVAS_ON_SELECT}
              strokeWidth={strokeW}
              style={{
                filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))"
              }}
            />
          </g>
        );
      })}

      {/* 3. Gap read-out: every gap band tinted coral with its live pixel size.
          Drawn by the same component the inspector's spacing scrub uses — see
          `SpacingBandView`. */}
      {gapDragActive && handles.map((h) => (
        <SpacingBandView
          key={`band_${h.id}`}
          band={{ x: h.box.x, y: h.box.y, width: h.box.width, height: h.box.height, cx: h.x, cy: h.y, label: String(Math.round(h.gap)), tone: "coral" }}
          zoom={zoom}
        />
      ))}

      {/* 4. Tidy Up: the way an unevenly spaced selection becomes a spaced one.
           Figma's mark — a rounded badge with three bars in it, the bars running
           along the axis being evened out — in coral, the geometry accent the gap
           pill already wears. One badge per ragged direction, hung off the bottom
           right corner.
           It does NOT invert on hover: the mark is the one thing on the canvas
           whose whole meaning is "these three gaps are not equal", and a badge
           that swaps to white ink stops looking like the thing it offers. */}
      {onTidySpacing &&
        unevenAxes.map((axis, i) => (
          <g
            key={`tidy_${axis}`}
            data-smart-tidy={axis}
            role="button"
            aria-label={tidyLabel(axis)}
            transform={`translate(${badgeX0 + i * (badgeD + TIDY_BADGE_PITCH / zoom) + badgeD / 2}, ${badgeY})`}
            style={{ cursor: "pointer" }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              onTidySpacing(axis);
            }}
          >
            <title>{tidyLabel(axis)}</title>
            <rect
              x={-badgeD / 2}
              y={-badgeD / 2}
              width={badgeD}
              height={badgeD}
              rx={badgeR}
              ry={badgeR}
              fill={CORAL}
            />
            {[-1, 0, 1].map((step) =>
              axis === "x" ? (
                <rect
                  key={step}
                  x={(step * mark) / 2 - barW / 2}
                  y={-mark / 2}
                  width={barW}
                  height={mark}
                  fill={CANVAS_ON_SELECT}
                  pointerEvents="none"
                />
              ) : (
                <rect
                  key={step}
                  x={-mark / 2}
                  y={(step * mark) / 2 - barW / 2}
                  width={mark}
                  height={barW}
                  fill={CANVAS_ON_SELECT}
                  pointerEvents="none"
                />
              )
            )}
          </g>
        ))}
    </g>
  );
}
