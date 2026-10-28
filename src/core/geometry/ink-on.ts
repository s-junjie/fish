/**
 * The ink a NEW text layer starts in, read from what it is about to sit on.
 *
 * A text dropped on the page a new file opens on used to arrive in `#000000` —
 * 1.1:1 against that page's `#101010`, which is not "low contrast", it is
 * invisible — while the same text inside a white frame was right. The colour is
 * not a property of the tool, it is a property of the backdrop, so it is read
 * from the top-most opaque fill beneath the insertion point; the page background
 * answers when nothing covers that point.
 *
 * The answer is WRITTEN INTO the layer as an ordinary `fills` entry, so this is
 * a starting colour and nothing more: the user can recolour it, and moving the
 * text over a different backdrop does not silently repaint it.
 *
 * What cannot answer: an image, a gradient, a pattern or a translucent fill is
 * skipped rather than guessed at, so a text dropped on a photo takes the colour
 * of whatever lies behind the photo. Sampling pixels would need a raster pass
 * this path does not have.
 */

import { DesignDocument, DesignElement, getActivePage } from "../dsl/types";
import { DEFAULT_CANVAS_BACKGROUND, DEFAULT_TEXT_INK_ON_DARK, DEFAULT_TEXT_INK_ON_LIGHT } from "../dsl/defaults";
import { topPaint } from "../dsl/paint-stack";
import { contrastRatio, parseColorAlpha } from "./color-utils";
import { elementAABB } from "./element-bounds";
import { identityMatrix, invert, multiply, transformPoint, translation, type Matrix2D } from "./matrix";
import { isContainer } from "./tree-query";
import { elementPivot, elementTransformMatrix } from "./transforms";

/** Whichever of the two inks reads better on `background`. */
export function inkForBackground(background: string): string {
  return contrastRatio(background, DEFAULT_TEXT_INK_ON_DARK) > contrastRatio(background, DEFAULT_TEXT_INK_ON_LIGHT)
    ? DEFAULT_TEXT_INK_ON_DARK
    : DEFAULT_TEXT_INK_ON_LIGHT;
}

/** The element's own background colour, when it has one this can trust. */
function opaqueFillOf(el: DesignElement): string | null {
  if (el.fillEnabled === false) return null;
  const paint = topPaint(el.fills);
  if (!paint || paint.type !== "solid") return null;
  if (paint.opacity !== undefined && paint.opacity < 1) return null;
  return parseColorAlpha(paint.color).alphaPct >= 100 ? paint.color : null;
}

/**
 * Top-most opaque fill covering `point`, or `null` when nothing does.
 *
 * The walk is `findElementAtPoint`'s — the same matrix chain the renderer draws
 * with, so a turned frame is asked where it actually paints — but it returns a
 * colour instead of a node, and it does not skip locked layers: a locked layer
 * still paints.
 */
function backgroundAt(elements: DesignElement[], point: { x: number; y: number }): string | null {
  function search(list: DesignElement[], parentM: Matrix2D): string | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (el.visible === false) continue;
      const pivot = elementPivot(el);
      const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
      // Children paint above their container's own fill, and a non-clipping
      // container paints them outside its box, so this is asked before the box
      // test — the child's own test is what bounds the answer.
      if (isContainer(el) && el.children && el.children.length > 0) {
        const childBackground = search(el.children, multiply(worldM, translation(el.x, el.y)));
        if (childBackground) return childBackground;
      }
      const local = invert(worldM);
      if (!local) continue;
      const p = transformPoint(local, point);
      const b = elementAABB(el);
      if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) continue;
      const fill = opaqueFillOf(el);
      if (fill) return fill;
    }
    return null;
  }
  return search(elements, identityMatrix());
}

/** The colour a text created at `point` should start in. */
export function newTextInkAt(doc: DesignDocument, point: { x: number; y: number }): string {
  const page = getActivePage(doc);
  const canvas = page?.canvas ?? doc.canvas;
  const pageBackground =
    canvas?.background?.type === "solid" ? canvas.background.color : DEFAULT_CANVAS_BACKGROUND;
  return inkForBackground(backgroundAt(page?.children ?? [], point) ?? pageBackground);
}
