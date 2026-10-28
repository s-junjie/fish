import { DesignDocument, getActivePage } from "../../core/dsl/types";
import { spacingBands } from "../../core/geometry/spacing-bands";
import { findElementById } from "../../core/geometry/tree-ops";
import { worldMatrixOf, worldOriginOf } from "../../core/interactions/component-swap";
import { useSpacingScrub } from "../hooks/spacing-scrub";
import { SpacingBandView } from "./SpacingBandView";

/**
 * The live spacing readout on the canvas: what padding, margin or gap is
 * becoming while a number is being dragged in the inspector.
 *
 * Deliberately NOT mounted inside `SelectionOverlay`. That group stands down
 * while a scrub runs — `inspector-activity.ts` hides the selection chrome so
 * the handles do not sit on top of the numbers being dragged — and this overlay
 * exists precisely for that moment. The selection box and its eight handles are
 * what the bands are measuring against; drawing them at the same time would put
 * a resize handle inside every padding band.
 *
 * `data-overlay="true"` for the same reason every other canvas annotation has
 * it: `export.ts` strips the attribute, and a saved SVG must not carry the
 * editor's own chrome into another tool.
 */
export function SpacingOverlay({ doc, zoom }: { doc: DesignDocument; zoom: number }) {
  const scrub = useSpacingScrub();
  if (!scrub) return null;

  const el = findElementById(getActivePage(doc).children, scrub.elementId);
  if (!el) return null;

  const bands = spacingBands(scrub, el, (child) => worldOriginOf(doc, child), (child) =>
    worldMatrixOf(doc, child)
  );
  if (bands.length === 0) return null;

  return (
    <g data-overlay="true" data-spacing-overlay={scrub.kind} className="select-none">
      {bands.map((b, i) => (
        <SpacingBandView key={`${scrub.kind}_${i}`} band={b} zoom={zoom} />
      ))}
    </g>
  );
}