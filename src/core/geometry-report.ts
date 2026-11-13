import { relayoutDocumentTree, resolvePadding } from "./compile";
import { getActivePage } from "./dsl/document-ops";
import { instanceSizeResolver } from "./interactions/instance-size";
import { DEFAULT_FLEX_DIRECTION, layoutOf, type FlatAutoLayout } from "./dsl/layout-flat";
import { elementRotatedAABB } from "./geometry/element-bounds";
import type { AutoLayout, DesignDocument, DesignElement, LayoutGuide } from "./dsl/types";
import { guideGeometry } from "./layout/layout-guides";
import { clipsContent, scrollsAxis, type OverflowFields } from "./dsl/overflow";

export interface GeometryFinding {
  level: "info" | "warning";
  kind: "overflow" | "clipped" | "zero-size" | "unused-space" | "guide-degenerate";
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

/** The axes a container lets its content exceed it: `overflow: auto` is the author's "by design". */
const scrollOf = (el: OverflowFields | null | undefined): { x: boolean; y: boolean } => ({
  x: scrollsAxis(el, "x"),
  y: scrollsAxis(el, "y")
});

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
    fills.length > 0 || any.strokes !== undefined || effects.length > 0 || clipsContent(any as OverflowFields)
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
  const laidOut = relayoutDocumentTree(getActivePage(doc).children ?? [], instanceSizeResolver(doc));
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
          // A scrolled axis is the container saying content may exceed it, so
          // spill on that axis is the feature working — only the rest can be a
          // mis-measurement worth naming.
          const scroll = scrollOf(any as OverflowFields);
          const active = (
            [
              [overRight, "right", scroll.x],
              [overBottom, "bottom", scroll.y],
              [overLeft, "left", scroll.x],
              [overTop, "top", scroll.y]
            ] as Array<[number, string, boolean]>
          ).filter(([over, , scrolled]) => !scrolled && over > EPS);
          if (active.length > 0) {
            const worst = Math.max(...active.map(([over]) => over));
            const axis = (active.find(([over]) => over === worst) as [number, string, boolean])[1];
            out.push({
              level: "info",
              kind: "overflow",
              elementId: String(c.id ?? ""),
              message: `${Math.round(cw)}×${Math.round(ch)} overflows "${String(any.name ?? any.id)}" content box ${Math.round(right - left)}×${Math.round(bottom - top)} by ${Math.round(worst)}px on the ${axis}; the layout engine gave it no room, so check sizing (a text told "max-content" is the usual cause). Deliberate? Give it position "absolute" or move it out of the stack.`
            });
          }
        }
      }

      if (clipsContent(any as OverflowFields)) {
        const scroll = scrollOf(any as OverflowFields);
        for (const child of children) {
          if (fields(child).visible === false || isBleedDecor(child)) continue;
          // The clip acts on PAINT, and a turned child paints its turned
          // envelope. Reading the stored box reports a vertical label as cut by
          // the width it no longer occupies — the user sees it inside the frame.
          const box = elementRotatedAABB(child);
          // A scrolled axis is reachable by scrolling, so its cut says nothing.
          const cut = Math.max(
            scroll.x ? 0 : box.x + box.width - w,
            scroll.y ? 0 : box.y + box.height - h,
            scroll.x ? 0 : -box.x,
            scroll.y ? 0 : -box.y
          );
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

  /**
   * Guides are checked on their own axis, outside the child walk.
   *
   * A frame with no children can still carry a ruler, and a guide that draws
   * nothing is the quietest defect in the feature: the panel lists a guide, the
   * canvas shows none, and nothing anywhere says the two disagree. `w <= 0` is
   * skipped because the box already reports itself as zero-size.
   */
  const checkGuides = (els: DesignElement[]) => {
    for (const el of els) {
      const any = fields(el);
      const width = num(any.width);
      const height = num(any.height);
      const guides = (any.layoutGuides as LayoutGuide[] | undefined) ?? [];
      if (guides.length > 0 && width > EPS && height > EPS) {
        guides.forEach((guide, index) => {
          if (guide.visible === false) return;
          if (guideGeometry(guide, { width, height }).kind !== "none") return;
          const why =
            guide.kind === "grid"
              ? `a grid cell of ${guide.size ?? 0}px`
              : `${String(guide.count ?? 0)} ${guide.kind} in ${Math.round(width)}×${Math.round(height)} with margin ${guide.margin ?? 0} and gutter ${guide.gutter ?? 0}`;
          out.push({
            level: "warning",
            kind: "guide-degenerate",
            elementId: String(any.id ?? ""),
            message: `layout guide ${index + 1} (${guide.kind}) draws nothing: ${why} leaves no room. Give the guide a smaller margin / gutter, or a smaller cell.`
          });
        });
      }
      checkGuides((any.children as DesignElement[] | undefined) ?? []);
    }
  };
  checkGuides(laidOut);

  return out;
}
