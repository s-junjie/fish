/**
 * Compose per-node world transform matrices from design document properties.
 *
 * v0.1 keeps children in absolute canvas coordinates (no parent stacking
 * transforms), so a node's world transform *is* its own rotation around its
 * center. These helpers still accept a path so the geometry layer can later
 * grow into nested parent-relative layouts without the rest of the editor
 * changing.
 */

import type { Matrix2D } from './matrix';
import {
  identityMatrix,
  invert,
  matrixToSvg,
  multiply,
  rotationAroundDeg,
  rotationDeg,
  scale,
  skew,
  transformPoint,
  translation
} from './matrix';
import type { Rect } from './bounds';
import { isLineElement } from './element-bounds';

/** The slice of an element this module needs — a line's box is `|dx|` / `|dy|`. */
export interface TransformableBox {
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  skewX?: number;
  skewY?: number;
  rotateX?: number;
  rotateY?: number;
  perspective?: number;
}

/**
 * The point an element's own rotation turns about.
 *
 * Everything turns about its box centre — EXCEPT a line, which turns about its
 * ORIGIN, because that is where Figma puts it and because it is the only pivot
 * under which dragging one end leaves the other exactly where it was. The
 * segment is `(x, y) → (x + dx, y + dy)` rotated about `(x, y)`: changing
 * `dx`/`dy` cannot move `x`/`y`, so the start endpoint is mathematically pinned
 * and the dragged one lands under the cursor, at any angle.
 *
 * On the box centre both of those fail together — the endpoint moves AND the
 * other end moves with it, because the centre is derived from the very `dx` the
 * drag just changed. It also fixes a latent hazard rather than a new one: `width`
 * is `|dx|`, so on a line with a NEGATIVE `dx` the centre is `x + |dx|/2` while
 * the true midpoint is `x − |dx|/2` — a third of the line's length away, on
 * documents `placeChildAt` produces today.
 *
 * `width`/`height` are passed in so the caller can supply the box the element is
 * actually painted at; a resolved instance rotates around its resolved size.
 */
export function elementPivot(
  el: TransformableBox,
  width: number = el.width,
  height: number = el.height
): { x: number; y: number } {
  if (isLineElement(el as never)) return { x: el.x, y: el.y };
  return { x: el.x + width / 2, y: el.y + height / 2 };
}

/**
 * The SVG transform an element's own `rotation` / `flipX` / `flipY` produce.
 *
 * One function, because the renderer and the selection overlay are a thousand
 * lines apart in the tree and both have to place chrome on the artwork. When
 * only the renderer had the string, the overlay's LINE branch returned before
 * the rotated `<g>` and put a rotated line's two endpoint dots at their
 * unrotated coordinates — the handles visibly off the line they belong to, and
 * dragging one moved the line somewhere else entirely.
 *
 * The pivot is passed rather than computed so the caller can supply the box it
 * is actually painting at — a resolved instance rotates around its RESOLVED
 * size, not the snapshot in the tree.
 */
export function elementTransform(el: TransformableBox, cx: number, cy: number): string | undefined {
  const rot = el.rotation || 0;
  const flipX = !!el.flipX;
  const flipY = !!el.flipY;
  const skewX = el.skewX || 0;
  const skewY = el.skewY || 0;
  if (!rot && !flipX && !flipY && !skewX && !skewY) return undefined;
  // `skewX(a) skewY(b)` is not the CSS `skew(a, b)` these two fields mean — the
  // composed matrix carries a term nobody wrote. Emitting the matrix leaves one
  // writer for the shear; a box without one keeps its readable string.
  if (skewX || skewY) return matrixToSvg(elementTransformMatrix(el, cx, cy));
  if (!flipX && !flipY) return `rotate(${rot} ${cx} ${cy})`;
  // A mirror about the box centre, then the rotation inside it — the order
  // Figma's own matrix composes them in, so a flipped-and-turned layer turns
  // the same way it was authored.
  return `translate(${cx}, ${cy}) ${rot ? `rotate(${rot}) ` : ''}scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1}) translate(${-cx}, ${-cy})`;
}

/**
 * The same transform as `elementTransform`, as a matrix.
 *
 * One function written twice is a second answer to a question that already has
 * one, so this exists only because a matrix is what a caller has to COMBINE: the
 * selection overlay has to hang an element's box inside its ancestors' rotation
 * (`parentWorldMatrix`) rather than beside it, and a `rotate(a b)` string cannot
 * be multiplied. It is derived from the same pivot and the same field order as
 * the string form above — mirror, then rotation inside it — so the two can never
 * disagree about which way a flipped-and-turned layer faces.
 *
 * Returns the IDENTITY for an element with nothing to turn, so a caller can
 * multiply unconditionally and a chain of unrotated nodes costs one identity
 * rather than a rotation about a centre that would cancel itself.
 */
export function elementTransformMatrix(el: TransformableBox, cx: number, cy: number): Matrix2D {
  const rot = el.rotation || 0;
  const flipX = !!el.flipX;
  const flipY = !!el.flipY;
  const skewX = el.skewX || 0;
  const skewY = el.skewY || 0;
  if (!rot && !flipX && !flipY && !skewX && !skewY) return identityMatrix();
  if (!flipX && !flipY && !skewX && !skewY) return rotationAroundDeg(rot, cx, cy);
  // Mirror, then shear, then turn — CSS's `rotate() skew() scale()` order, and
  // the only one under which the slant belongs to the box rather than the canvas.
  const linear = multiply(
    rot ? rotationDeg(rot) : identityMatrix(),
    multiply(skew(skewX, skewY), scale(flipX ? -1 : 1, flipY ? -1 : 1))
  );
  return multiply(translation(cx, cy), multiply(linear, translation(-cx, -cy)));
}

/**
 * The element's perspective tilt, as a CSS `transform` value for a `style`.
 *
 * `undefined` when there is no tilt, so a caller can gate on it. This is a
 * PROJECTION — parallel lines converge — so it cannot ride the SVG `transform`
 * attribute or the Matrix2D machinery, and it must sit on a node that carries
 * no attribute transform of its own (an inline style would override the
 * presentation attribute).
 *
 * The pivot is NOT baked into the list. A projective matrix does not commute
 * with translation, so a `translate(pivot) … translate(back)` wrapper moves the
 * vanishing point instead of the shape — the further the element sits from the
 * view-box origin, the flatter and more skewed the result (measured in
 * Chromium; see the fill-box pairing below). Callers MUST pair this with
 * `transform-box: fill-box; transform-origin: 50% 50%`, which puts the
 * perspective origin at the artwork's own bounding-box centre and reproduces
 * the exact projected quad.
 */
export function elementTransform3d(el: TransformableBox): string | undefined {
  const rx = el.rotateX || 0;
  const ry = el.rotateY || 0;
  if (!rx && !ry) return undefined;
  const d = el.perspective && el.perspective > 0 ? el.perspective : 800;
  return `perspective(${d}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
}

/**
 * A world point, expressed in the element's own unrotated box.
 *
 * The gesture half of `elementTransform`: a pointer lands in canvas space and
 * every write-back is in local space. It inverts the SAME matrix the renderer
 * draws with — a hand-written inverse is a second answer to the composition
 * order, and it was right only while rotation and flips were all that was in it.
 */
export function toElementLocal(
  px: number,
  py: number,
  el: TransformableBox,
  cx: number,
  cy: number
): { x: number; y: number } {
  const inverse = invert(elementTransformMatrix(el, cx, cy));
  // A singular box has no local point to hand back — the pointer's own position
  // is the only answer that is not invented.
  if (!inverse) return { x: px, y: py };
  return transformPoint(inverse, { x: px, y: py });
}

/**
 * Figma-style curved double-arrow rotate cursor in SVG data URI format.
 */
export function getRotateCursor(angleDeg: number = 0): string {
  const normAngle = Math.round(((angleDeg % 360) + 360) % 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none">
    <defs>
      <filter id="c-sh" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="1" stdDeviation="0.8" flood-color="rgba(0,0,0,0.35)"/>
      </filter>
    </defs>
    <g filter="url(#c-sh)" transform="rotate(${normAngle} 16 16)">
      <path d="M 9.5 17 A 7.5 7.5 0 0 1 17 9.5" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round" fill="none"/>
      <path d="M 15 6.2 L 22.5 9.5 L 15 12.8 Z" fill="#ffffff" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M 6.2 15 L 9.5 22.5 L 12.8 15 Z" fill="#ffffff" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M 9.5 16 A 7.5 7.5 0 0 1 16 9.5" stroke="#111827" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <path d="M 15.5 7 L 21.5 9.5 L 15.5 12 Z" fill="#111827"/>
      <path d="M 7 15.5 L 9.5 21.5 L 12 15.5 Z" fill="#111827"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
}

/**
 * The Scale tool's corner cursor: the ordinary diagonal double arrow, drawn larger.
 *
 * `nwse-resize` is the right shape and the wrong size — at 24px on a HiDPI screen it
 * reads as a plain corner resize, and `crosshair` promises a shape that will not be
 * drawn, which is the whole difference between a scale and a resize. A native cursor
 * cannot be scaled, so the enlargement has to be a drawn one, and the drawing is kept
 * to the arrow alone: the box outline a first version added turned up more of the
 * canvas than the tool's own selection chrome and read as clutter.
 *
 * `orientation` names the DIAGONAL, and it has to be the corner's own: a NW↔SE arrow
 * over the top-left handle, a NE↔SW one over the top-right. The one drawing is
 * mirrored rather than written twice, because two sets of hand-written paths would be
 * free to drift apart and only one of them would ever be looked at.
 *
 * So the unmirrored drawing below runs top-left to bottom-right and its arrowheads
 * point that way too, which is what makes the name true: the first version had the
 * shaft on the other diagonal while still being called `nwse`, so every corner got the
 * wrong arrow and the E2E that reads the name back could not see it. A name a drawing
 * does not have is worth less than no name.
 *
 * Every stroke is laid down twice, white under dark, because the canvas behind the
 * cursor is whatever the user drew — the same two-pass trick the rotate cursor uses,
 * and the reason this needs no drop shadow.
 */
export function getScaleCursor(orientation: "nwse" | "nesw" = "nwse"): string {
  const mirror = orientation === "nesw" ? ` transform="translate(32 0) scale(-1 1)"` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none">
    <g${mirror}>
      <path d="M 10 10 L 22 22" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
      <path d="M 10 10 L 22 22" stroke="#111827" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M 6 6 L 13.5 6 L 6 13.5 Z" fill="#ffffff" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M 6 6 L 13.5 6 L 6 13.5 Z" fill="#111827"/>
      <path d="M 26 26 L 18.5 26 L 26 18.5 Z" fill="#ffffff" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M 26 26 L 18.5 26 L 26 18.5 Z" fill="#111827"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
}
