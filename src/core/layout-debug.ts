import { getActivePage, type ContainerElement, type DesignDocument, type DesignElement } from "./dsl/types";
import { elementAABB } from "./geometry/element-bounds";
import { measureDocument, type MeasuredNode } from "./measure";
import type { Rect } from "./geometry/bounds";
import { resolvePadding } from "./layout/box";
import { layoutOf } from "./dsl/layout-flat";

/**
 * Every auto-layout container, with the number it was laid out at beside the number
 * its children actually occupy.
 *
 * This is the question a screenshot cannot answer. A container that measured a
 * child short, or read a size before it was resolved, distributes the wrong total
 * and its own box ends up shorter than the space its children cover — the classic
 * cause of a headline printing over the paragraph under it. The two numbers are
 * equal in every healthy document, so any non-zero `delta` is a defect rather than a
 * judgement call, which is what makes this worth calling instead of leaving to the
 * eye.
 *
 * `overflow` is reported separately from `delta` because the two mean different
 * things: a container that is simply taller than its content is a design decision,
 * while a container shorter than its content is a measurement that came out wrong.
 */
export interface LayoutDebugEntry {
  id: string;
  name: string;
  type: DesignElement["type"];
  /** The container's own box, canvas coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "flex" | "grid";
  direction?: string;
  /** In-flow children only — an absolute child is outside the flow by definition. */
  childCount: number;
  /** Union of the in-flow children's boxes, canvas coordinates. */
  content: Rect;
  /** The box the layout pass actually gave the children: `height` less its padding. */
  contentBoxHeight: number;
  /** `content.height - contentBoxHeight`. Zero in a healthy document. */
  delta: number;
  /**
   * `content.height > height` — the content does not fit the box the engine gave it.
   *
   * Two pixels, not a hair. Measured boxes carry sub-pixel residue, and the demo
   * document's 61 containers include two that read 1px over on a row of 19.59px
   * items; a threshold that calls those defects teaches the reader to ignore the
   * list. A genuine mis-measurement is tens of pixels — a four-line paragraph read
   * as one is 63px — so nothing real is lost.
   */
  overflow: boolean;
}

const isInFlow = (el: DesignElement): boolean =>
  el.visible !== false && el.position !== "absolute";

function unionOf(boxes: Rect[]): Rect | null {
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function collect(
  list: readonly DesignElement[],
  originX: number,
  originY: number,
  boxes: Map<string, MeasuredNode>,
  out: LayoutDebugEntry[]
): void {
  for (const el of list) {
    const local = elementAABB(el);
    const x = local.x + originX;
    const y = local.y + originY;
    const stack = el.type === "frame" || el.type === "component" ? el : null;
    const mode = stack ? layoutOf(stack)?.mode : undefined;

    if (stack && (mode === "flex" || mode === "grid")) {
      const children = (stack.children ?? []).filter(isInFlow);
      const content = unionOf(
        children.map((c) => {
          const m = boxes.get(c.id);
          const b = m ? { x: m.x, y: m.y, width: m.width, height: m.height } : elementAABB(c);
          return { x: b.x + originX, y: b.y + originY, width: b.width, height: b.height };
        })
      );
      if (content) {
        // Against the CONTENT box, not the border box: a padded flex container's
        // children are inset by that padding, so comparing them to the full height
        // reports every well-formed card as short by exactly its padding.
        const [padTop, , padBottom] = resolvePadding(layoutOf(stack)?.padding);
        const contentBoxHeight = local.height - padTop - padBottom;
        const delta = content.height - contentBoxHeight;
        out.push({
          id: el.id,
          name: el.name || el.id,
          type: el.type,
          x,
          y,
          width: local.width,
          height: local.height,
          mode,
          direction: layoutOf(stack)?.direction,
          childCount: children.length,
          content,
          contentBoxHeight,
          delta: Math.round(delta * 100) / 100,
          overflow: delta > 2
        });
      }
    }

    // A set is descended into like any other container even though it reports no
    // layout: it has no stack to measure against, but its variants still have
    // positions worth checking.
    if (el.type === "frame" || el.type === "component" || el.type === "componentSet") {
      // An instance's children live in the master's tree, not the document's, so
      // there is nothing to descend into here. Its own box already accounts for the
      // resolved content, and saying more would need a second resolution pass to
      // produce a number a reader could act on.
      collect((el as ContainerElement).children ?? [], x, y, boxes, out);
    }
  }
}

/**
 * The whole document's layout ledger. A caller that wants only the defects filters
 * `overflow`; the healthy entries are what make a non-empty result believable.
 */
export function layoutDebug(doc: DesignDocument): LayoutDebugEntry[] {
  const boxes = new Map(measureDocument(doc).map((m) => [m.id, m]));
  const out: LayoutDebugEntry[] = [];
  for (const page of doc.pages && doc.pages.length > 0 ? doc.pages : [getActivePage(doc)]) {
    collect(page.children || [], 0, 0, boxes, out);
  }
  return out;
}

/** The subset that is a defect: content taller than the box the engine gave it. */
export function layoutDefects(doc: DesignDocument): LayoutDebugEntry[] {
  return layoutDebug(doc).filter((e) => e.overflow);
}
