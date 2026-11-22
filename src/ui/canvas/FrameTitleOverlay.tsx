import { DesignElement } from "../../core/dsl/types";
import { isSectionElement } from "../../core/geometry/tree-query";
import { ComponentMark, VariantSetMark } from "../ComponentMark";
import {
  CANVAS_COMPONENT,
  CANVAS_GUIDE,
  CANVAS_ON_SELECT,
  CANVAS_SECTION_INK,
  CANVAS_SECTION_LABEL,
  CANVAS_SECTION_LABEL_RING,
  CANVAS_SELECT
} from "./canvas-colors";
import { CANVAS_CHROME_TEXT } from "./canvas-text";
import { SECTION_LABEL_PAD, titleLabelWidth } from "./frame-titles";
import type { NodeRenderContext } from "./NodeRenderContext";

/**
 * Top-level frame names, painted as a layer of their own rather than inside the
 * node they describe.
 *
 * A node's `<g>` carries the element's effects, rotation and blend mode, and an
 * SVG `filter` applies to the whole subtree — so a label drawn in there took the
 * frame's drop shadow, and a rotated frame rotated its label. Chrome is not
 * artwork: it is painted in screen pixels above everything, impervious to both.
 *
 * A SECTION's label is a PILL rather than bare text, and it sits outside the
 * box's top edge. Bare text there is unreadable the moment a section is stacked
 * under another one or lands on a photograph; an opaque plate is what Figma
 * settled on for the same reason, and the plate is the only thing that makes the
 * name a coordinate instead of an overlay.
 */

/** The pill's own height and corner, in screen px. */
const LABEL_HEIGHT = 20;
const LABEL_RADIUS = 5;
/** Distance from the pill's bottom edge to the section's top edge. */
const LABEL_GAP = 6;
/** The baseline inside that height for an 11px face: the glyph box sits centred. */
const LABEL_BASELINE = LABEL_HEIGHT - 6;

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
        const section = isSectionElement(el);
        const selected = ctx.selectedIds.has(el.id);
        const label = el.type === "instance" ? `◇ ${titleText}` : titleText;
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
            {section && (
              <rect
                data-section-label="true"
                x={0}
                y={-(LABEL_HEIGHT + LABEL_GAP)}
                width={titleLabelWidth(label) + SECTION_LABEL_PAD * 2}
                height={LABEL_HEIGHT}
                rx={LABEL_RADIUS}
                fill={selected ? CANVAS_SELECT : CANVAS_SECTION_LABEL}
                stroke={selected ? undefined : CANVAS_SECTION_LABEL_RING}
                strokeWidth={1}
                className="pointer-events-auto cursor-default"
                onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
                onDblClick={(e) => e.stopPropagation()}
              />
            )}
            <text
              data-frame-title={el.type === "componentSet" ? undefined : "true"}
              data-section-title={section ? "true" : undefined}
              data-component-set-title={el.type === "componentSet" ? "true" : undefined}
              data-component-set={el.type === "componentSet" ? el.id : undefined}
              x={section ? SECTION_LABEL_PAD : el.type === "component" || el.type === "componentSet" ? 14 : 0}
              y={section ? -(LABEL_GAP + LABEL_HEIGHT) + LABEL_BASELINE : -6}
              fontSize={11}
              fill={section ? (selected ? CANVAS_ON_SELECT : CANVAS_SECTION_INK) : titleColor(el, ctx)}
              fontFamily={CANVAS_CHROME_TEXT}
              fontWeight={400}
              className="select-none pointer-events-auto cursor-default"
              onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
              onDblClick={(e) => e.stopPropagation()}
            >
              {label}
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
