import { ContainerElement, DesignDocument } from "../../core/dsl/types";
import { gridCellRects } from "../../core/layout/grid-layout";
import { worldMatrixOf } from "../../core/interactions/component-swap";
import { matrixToSvg } from "../../core/geometry/matrix";
import { CANVAS_SELECT } from "./canvas-colors";

/**
 * The cells of a selected grid, outlined where the layout pass will place
 * children.
 *
 * A grid's tracks are the one piece of its structure you cannot read off the
 * artwork: children are painted at the cell they landed in, so an empty track, a
 * reserved row and a track narrower than its child all look alike.
 *
 * It wears the selection blue — the same value the margin band uses, and for the
 * same reason: both are structure marks on the inside of a container, and this
 * one is drawn only while that container is chosen, beside its own box and
 * nothing else. Dashed and unfilled, so it reads as structure rather than as
 * another selection: the artwork underneath stays the artwork, and the solid box
 * around the frame is the one mark that says "chosen".
 *
 * Drawn OUTSIDE the selection group, beside the spacing bands, for the reason
 * they are: working a gap or a padding in the inspector takes the box and its
 * eight handles off the canvas so they do not jump under the numbers being read,
 * and the cells are the feedback for that very gesture — they are where the
 * gutter you are opening can be seen at all. What is left on screen is a set of
 * outlines describing the frame's structure, which is not the thing that jumps.
 *
 * The rectangles come from `gridCellRects`, which calls the same row rule the
 * layout pass does (see `gridRowGeometry`): a preview that restated the tracks
 * its own way would draw a grid the canvas is not using.
 */
export function GridCellOverlay({
  doc,
  frame,
  zoom
}: {
  doc: DesignDocument;
  frame: ContainerElement;
  zoom: number;
}) {
  const cells = gridCellRects(frame);
  if (cells.length === 0) return null;

  return (
    <g
      data-overlay="true"
      data-grid-cells="true"
      transform={matrixToSvg(worldMatrixOf(doc, frame))}
      fill="none"
      stroke={CANVAS_SELECT}
      strokeWidth={1 / zoom}
      strokeDasharray={`${4 / zoom} ${3 / zoom}`}
      pointerEvents="none"
    >
      {cells.map((cell) => (
        <rect
          key={`r${cell.row}c${cell.column}`}
          data-grid-cell={`r${cell.row}c${cell.column}`}
          x={frame.x + cell.x}
          y={frame.y + cell.y}
          width={cell.width}
          height={cell.height}
        />
      ))}
    </g>
  );
}