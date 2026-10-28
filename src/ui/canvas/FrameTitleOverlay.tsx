import { DesignElement } from "../../core/dsl/types";
import { ComponentMark, VariantSetMark } from "../ComponentMark";
import { CANVAS_COMPONENT, CANVAS_GUIDE, CANVAS_SELECT } from "./canvas-colors";
import { CANVAS_CHROME_TEXT } from "./canvas-text";
import type { NodeRenderContext } from "./NodeRenderContext";

/**
 * Top-level frame names, painted as a layer of their own rather than inside the
 * node they describe.
 *
 * A node's `<g>` carries the element's effects, rotation and blend mode, and an
 * SVG `filter` applies to the whole subtree — so a label drawn in there took the
 * frame's drop shadow, and a rotated frame rotated its label. Chrome is not
 * artwork: it is painted in screen pixels above everything, impervious to both.
 */
export function FrameTitleOverlay({
  items,
  titles,
  ctx
}: {
  items: readonly DesignElement[];
  titles: ReadonlyMap<string, string>;
  ctx: NodeRenderContext;
}) {
  return (
    <>
      {items.map((el) => {
        const titleText = titles.get(el.id);
        if (titleText === undefined) return null;
        return (
          <g
            key={`title_${el.id}`}
            data-chrome-counter="true"
            data-locked={el.locked ? "true" : undefined}
            style={{ "--tx": `${el.x}px`, "--ty": `${el.y}px` }}
          >
            {el.type === "component" && (
              <ComponentMark size={11} className="text-component" x={0} y={-15} />
            )}
            {el.type === "componentSet" && (
              <VariantSetMark size={11} className="text-component" x={0} y={-15} />
            )}
            <text
              data-frame-title={el.type === "componentSet" ? undefined : "true"}
              data-component-set-title={el.type === "componentSet" ? "true" : undefined}
              data-component-set={el.type === "componentSet" ? el.id : undefined}
              x={el.type === "component" || el.type === "componentSet" ? 14 : 0}
              y={-6}
              fontSize={11}
              fill={titleColor(el, ctx)}
              fontFamily={CANVAS_CHROME_TEXT}
              fontWeight={400}
              className="select-none pointer-events-auto cursor-default"
              onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
              onDblClick={(e) => e.stopPropagation()}
            >
              {el.type === "instance" ? `◇ ${titleText}` : titleText}
            </text>
          </g>
        );
      })}
    </>
  );
}

function titleColor(el: DesignElement, ctx: NodeRenderContext): string {
  if (el.type === "component" || el.type === "instance") return CANVAS_COMPONENT;
  if (el.type === "componentSet") {
    return ctx.dragOverFrameId === el.id ? CANVAS_SELECT : CANVAS_COMPONENT;
  }
  return ctx.selectedIds.has(el.id) ? CANVAS_SELECT : CANVAS_GUIDE;
}
