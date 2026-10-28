import { ComponentSetElement } from "../../core/dsl/types";
import { visibleVariants } from "../../core/layout/component-set";
import { renderNodeList, type NodeRenderContext } from "./SvgElementRenderer";
import { CANVAS_SELECT, CANVAS_COMPONENT } from "./canvas-colors";

/**
 * A component set on the canvas: a dashed border around its variants.
 *
 * Separate from `SvgElementRenderer` for a structural reason, not a stylistic one:
 * that file is at the 1000-line hard ceiling (AGENTS.md §9) and a set needs a
 * branch no other element has — a border that paints nothing, and a collapse that
 * hides all but one child (driven from the layer panel, not a canvas twisty).
 *
 * No fill and no clip, which is what Figma does and also what makes a set read as
 * a container rather than artwork: the variants show through, and dragging one
 * outside the border is visible rather than silently cut off.
 */
export function ComponentSetFrame({
  set,
  ctx,
  isDragOver
}: {
  set: ComponentSetElement;
  ctx: NodeRenderContext;
  isDragOver: boolean;
}) {
  const variants = visibleVariants(set);
  const stroke = isDragOver ? CANVAS_SELECT : CANVAS_COMPONENT;

  return (
    <g>
      {/* Transparent, so the padding between the variants selects the set rather
          than falling through to whatever is behind it. */}
      <rect
        x={set.x}
        y={set.y}
        width={set.width}
        height={set.height}
        fill="transparent"
        data-hit="true"
        pointerEvents="all"
        onMouseDown={(e) => ctx.onElementMouseDown(e, set)}
        onDblClick={(e) => e.stopPropagation()}
      />
      <rect
        data-component-set-outline="true"
        data-drag-over={isDragOver ? "true" : undefined}
        data-collapsed={set.collapsed ? "true" : undefined}
        x={set.x}
        y={set.y}
        width={set.width}
        height={set.height}
        fill="none"
        stroke={stroke}
        pointerEvents="none"
      />

      <g transform={`translate(${set.x}, ${set.y})`}>
        {renderNodeList(variants, ctx, false)}
      </g>
    </g>
  );
}