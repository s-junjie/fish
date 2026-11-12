import { JSX } from "preact";
import { useMemo } from "preact/hooks";
import type { ComponentElement, DesignDocument, FrameElement, LayoutGuide } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/document-ops";
import { flattenElements } from "../../core/geometry/tree-edit";
import { worldMatrixOf } from "../../core/interactions/component-swap";
import { matrixToSvg } from "../../core/geometry/matrix";
import {
  DEFAULT_GUIDE_COLOR,
  guideGeometry,
  guidePatternPaint,
  type GuideRect
} from "../../core/layout/layout-guides";
import { PatternPaintDef } from "./PatternPaintDef";

type GuidedFrame = (FrameElement | ComponentElement) & { layoutGuides: LayoutGuide[] };

const guided = (el: { type: string; visible?: boolean; layoutGuides?: LayoutGuide[] }): el is GuidedFrame =>
  (el.type === "frame" || el.type === "component") &&
  el.visible !== false &&
  Array.isArray(el.layoutGuides) &&
  el.layoutGuides.length > 0;

/** Bands may be inset out of the box by an alignment; the frame clips them, so this does too. */
function clippedToFrame(rect: GuideRect, width: number, height: number): GuideRect | null {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  if (right - x <= 0 || bottom - y <= 0) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Every layout guide on the page, drawn over the artwork.
 *
 * A guide belongs to the DRAWING, not to the selection: the columns you are
 * aligning to have to stay visible while you drag a card into them, which is
 * exactly when nothing is selected. So this walks the page instead of reading
 * `primarySelected`.
 *
 * Outer `data-overlay="true"` is what keeps it out of an exported SVG — the same
 * contract the selection chrome uses. The canvas-only shell mounts nothing here
 * at all, because this sits inside `CanvasArea`'s editor-only fragment, and a
 * `data-*` attribute alone would have let guides leak into `?view=canvas`.
 *
 * NOT drawn with `1/zoom`: these are fills, and a fill is an area the author
 * stated in the document, not chrome describing a gesture. The alpha they chose
 * is the whole visual weight, exactly as in Figma.
 */
export function LayoutGuideLayer({ doc, zoom }: { doc: DesignDocument; zoom: number }): JSX.Element | null {
  const frames = useMemo(() => flattenElements(getActivePage(doc).children ?? []).filter(guided), [doc]);
  if (frames.length === 0) return null;

  return (
    <g data-overlay="true" data-layout-guides="true" pointerEvents="none">
      {frames.map((frame) => {
        // `worldMatrixOf` places the frame's BOX, so the frame's own origin has to
        // be composed in as a second step. Doing it in the transform (rather than
        // per rect) is what puts a grid guide's `<pattern>` tile origin on the
        // frame's corner instead of on its parent's.
        const world = matrixToSvg(worldMatrixOf(doc, frame));
        const transform = [world, `translate(${frame.x} ${frame.y})`].filter(Boolean).join(" ");

        const shapes: JSX.Element[] = [];
        frame.layoutGuides.forEach((guide, index) => {
          if (guide.visible === false) return;
          const geometry = guideGeometry(guide, frame);

          if (geometry.kind === "bands") {
            geometry.rects.forEach((rect, band) => {
              const clipped = clippedToFrame(rect, frame.width, frame.height);
              if (!clipped) return;
              shapes.push(
                <rect
                  key={`b${band}`}
                  data-layout-guide={guide.kind}
                  x={clipped.x}
                  y={clipped.y}
                  width={clipped.width}
                  height={clipped.height}
                  fill={guide.color ?? DEFAULT_GUIDE_COLOR}
                />
              );
            });
            return;
          }

          if (geometry.kind !== "cells" || geometry.columns <= 0 || geometry.rows <= 0) return;

          // One pattern def and one rect, whatever the pitch: an 8px grid over a
          // 1440×900 frame is eighteen thousand cells, and a rect each would be a
          // page that stops responding the moment a guide is added.
          const id = `lgp_${frame.id}_${index}`;
          shapes.push(
            <PatternPaintDef
              key={`p${index}`}
              id={id}
              paint={guidePatternPaint(guide, zoom)}
              width={frame.width}
              height={frame.height}
            />,
            <rect
              key={`g${index}`}
              data-layout-guide="grid"
              x={0}
              y={0}
              width={frame.width}
              height={frame.height}
              fill={`url(#${id})`}
            />
          );
        });

        if (shapes.length === 0) return null;
        return (
          <g key={frame.id} data-layout-guide-frame={frame.id} transform={transform}>
            {shapes}
          </g>
        );
      })}
    </g>
  );
}
