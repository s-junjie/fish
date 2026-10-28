import { relayoutDocumentTree, resolvePadding } from "./compile";
import { getActivePage } from "./dsl/types";
import { DEFAULT_FLEX_DIRECTION, layoutOf, type FlatAutoLayout } from "./dsl/layout-flat";
import { elementRotatedAABB } from "./geometry/element-bounds";
import type { AutoLayout, DesignDocument, DesignElement } from "./dsl/types";

export interface GeometryFinding {
  level: "info" | "warning";
  kind: "overflow" | "clipped" | "zero-size" | "unused-space";
  message: string;
  elementId?: string;
}

type Any = Record<string, unknown>;

const EPS = 0.5;

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

const fields = (el: DesignElement): Any => el as unknown as Any;

const isLayoutContainer = (el: DesignElement): boolean => {
  const mode = layoutOf(el as FlatAutoLayout)?.mode;
  return mode === "flex" || mode === "grid";
};

const inFlow = (child: DesignElement): boolean =>
  fields(child).position !== "absolute" && fields(child).visible !== false;

/** Below this the gap is padding by another name, and the ratio is noise. */
const UNUSED_MIN_PX = 32;
const UNUSED_RATIO = 0.25;

/**
 * Does this container stack its children downwards? Only then does the space
 * below the last one mean anything: a row's children end at their own widths,
 * and reporting that would fire on every header row in every document.
 */
const stacksDownwards = (layout: AutoLayout): boolean => {
  if (layout.mode === "flex") return (layout.direction ?? DEFAULT_FLEX_DIRECTION) === "column";
  const columns = layout.columnSizes?.length ?? layout.columns;
  return columns === 1;
};

/**
 * A box that hugs its content has no unused space by construction, and one that
 * distributes it says so. What is left is a fixed height whose content stopped
 * short — the mobile-section case, where the author wrote 600 and meant hug.
 */
const leavesRoomAtTheEnd = (el: DesignElement, layout: AutoLayout): boolean => {
  const height = (el as unknown as { sizing?: { height?: string } }).sizing?.height;
  if (height === "fit-content" || height === "max-content") return false;
  const justify = layout.mode === "flex" ? layout.justify : undefined;
  return justify === undefined || justify === "start";
};

const isBleedDecor = (child: DesignElement): boolean => {
  const c = fields(child);
  if (c.metadata && typeof c.metadata === "object") {
    const meta = c.metadata as Record<string, unknown>;
    if (meta.bleed === true || meta.decorative === true) return true;
  }
  const blend = c.blendMode ?? (c.style as Record<string, unknown> | undefined)?.mixBlendMode;
  if (blend === "screen" || blend === "plus-lighter" || blend === "lighten" || blend === "color-dodge") return true;
  const fills = Array.isArray(c.fills) ? c.fills : [];
  if (fills.some((f: any) => {
    if (!f || f.enabled === false) return false;
    if (f.type === "radial-gradient") return true;
    const b = f.blendMode;
    return b === "screen" || b === "plus-lighter" || b === "lighten" || b === "color-dodge";
  })) return true;
  const effects = Array.isArray(c.effects) ? c.effects : [];
  if (effects.some((e: any) => e?.type === "layer-blur" && e?.enabled !== false)) return true;
  return false;
};

/**
 * A collapsed box is only a defect when the box was going to be seen. A frame
 * with no paint and no clipping is a structural wrapper — its own box collapsing
 * changes nothing on the canvas, so reporting it would be noise on a legitimate
 * pattern.
 */
const hasVisibleSurface = (el: DesignElement): boolean => {
  const any = fields(el);
  const fills = Array.isArray(any.fills) ? any.fills : [];
  const effects = Array.isArray(any.effects) ? any.effects : [];
  return (
    fills.length > 0 || any.strokes !== undefined || effects.length > 0 || any.clipContent === true
  );
};

/**
 * Measurements, not verdicts.
 *
 * Overlap is deliberately absent: two children of a plain frame sit where they
 * were authored and may overlap by design, an `absolute` child is an overlay by
 * definition, and in-flow children of a stack or grid never intersect each other
 * — when they do not fit they *overflow* instead. So the question this asks is
 * "did something end up outside the box that was supposed to hold it", which has
 * a number to report, rather than "is anything on top of anything", which does
 * not.
 *
 * `info` is the default level: a bleed past the edge and a cropped photo are both
 * real design techniques. Only the collapsed container is a `warning`, because
 * there the author wrote paint that cannot be painted.
 */
export function geometryReport(doc: DesignDocument): GeometryFinding[] {
  const laidOut = relayoutDocumentTree(getActivePage(doc).children ?? []);
  const out: GeometryFinding[] = [];

  const walk = (els: DesignElement[]) => {
    for (const el of els) {
      const any = fields(el);
      const children = (any.children as DesignElement[] | undefined) ?? [];
      if (children.length === 0) continue;

      const w = num(any.width);
      const h = num(any.height);

      if (isLayoutContainer(el)) {
        const layout = layoutOf(any as FlatAutoLayout);
        const [pt, pr, pb, pl] = resolvePadding(layout?.padding as AutoLayout["padding"]);
        const left = pl;
        const right = w - pr;
        const top = pt;
        const bottom = h - pb;
        // A container with no box has nothing to overflow. Skipping it here is
        // what keeps a collapsed parent reported once, as its own zero-size
        // finding, instead of once per child.
        const hasRoom = right - left > EPS && bottom - top > EPS;
        if (hasRoom && layout && stacksDownwards(layout) && leavesRoomAtTheEnd(el, layout)) {
          // The mirror of overflow, measured on the same axis: the layout engine
          // had room and the content stopped short of it.
          const ends = children
            .filter(inFlow)
            .map((child) => num(fields(child).y) + num(fields(child).height));
          if (ends.length > 0) {
            const unused = bottom - Math.max(...ends);
            const innerHeight = bottom - top;
            if (unused > UNUSED_MIN_PX && unused / innerHeight > UNUSED_RATIO) {
              out.push({
                level: "info",
                kind: "unused-space",
                elementId: String(any.id ?? ""),
                message:
                  `has ${Math.round(unused)}px unused below its content (${ends.length} in-flow child(ren) end at ` +
                  `${Math.round(Math.max(...ends))}px in a ${Math.round(h)}px box) — the box is taller than what it holds. ` +
                  `If it should hug, say sizing.height "fit-content"; if the gap is meant to be distributed, say "justify-content": "space-between" (or "center").`
              });
            }
          }
        }
        for (const child of children) {
          if (!hasRoom) break;
          if (!inFlow(child)) continue;
          const c = fields(child);
          const cx = num(c.x);
          const cy = num(c.y);
          const cw = num(c.width);
          const ch = num(c.height);
          const overRight = cx + cw - right;
          const overBottom = cy + ch - bottom;
          const overLeft = left - cx;
          const overTop = top - cy;
          const worst = Math.max(overRight, overBottom, overLeft, overTop);
          if (worst > EPS) {
            const axis = overRight === worst ? "right" : overBottom === worst ? "bottom" : overLeft === worst ? "left" : "top";
            out.push({
              level: "info",
              kind: "overflow",
              elementId: String(c.id ?? ""),
              message: `${Math.round(cw)}×${Math.round(ch)} overflows "${String(any.name ?? any.id)}" content box ${Math.round(right - left)}×${Math.round(bottom - top)} by ${Math.round(worst)}px on the ${axis}; the layout engine gave it no room, so check sizing (a text told "max-content" is the usual cause). Deliberate? Give it position "absolute" or move it out of the stack.`
            });
          }
        }
      }

      if (any.clipContent === true) {
        for (const child of children) {
          if (fields(child).visible === false || isBleedDecor(child)) continue;
          // The clip acts on PAINT, and a turned child paints its turned
          // envelope. Reading the stored box reports a vertical label as cut by
          // the width it no longer occupies — the user sees it inside the frame.
          const box = elementRotatedAABB(child);
          const cut = Math.max(box.x + box.width - w, box.y + box.height - h, -box.x, -box.y);
          if (cut > EPS) {
            out.push({
              level: "info",
              kind: "clipped",
              elementId: String(fields(child).id ?? ""),
              message: `is cut by ${Math.round(cut)}px at the edge of "${String(any.name ?? any.id)}" (overflow: hidden). Expected? Set "overflow": "visible" to let it hang out.`
            });
          }
        }
      }

      if ((w <= EPS || h <= EPS) && hasVisibleSurface(el)) {
        // The advice cannot be one sentence for every collapsed box: `validate`
        // already reports that a hug outside Auto-Layout is ignored, so pointing
        // the author at `fit-content` here would name the thing that does not
        // work. Without a layout pass there is nothing to derive the size from —
        // the sizes have to be written down.
        const how = isLayoutContainer(el)
          ? "the hug found nothing to hug — give the children real sizes"
          : "set an explicit width and height, or give it Auto-Layout so \"fit-content\" has a layout pass to be computed by";
        out.push({
          level: "warning",
          kind: "zero-size",
          elementId: String(any.id ?? ""),
          message: `has ${children.length} child(ren) and paint, but its box is ${Math.round(w)}×${Math.round(h)} — the fill, radius and effects have nothing to paint on. Fix it: ${how}.`
        });
      }

      walk(children);
    }
  };

  walk(laidOut);
  return out;
}
