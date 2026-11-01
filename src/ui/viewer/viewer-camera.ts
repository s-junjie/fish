import type { Rect } from "../../core/geometry/bounds";
import { fitRect } from "../../core/geometry/fit";
import { calculateVisibleViewport, type ViewportBox } from "../../core/geometry/cull";
import { clampZoom, MIN_ZOOM } from "../../core/geometry/viewport";

/**
 * The reader's camera, and the four things a phone does to it.
 *
 * All of it is pure so the arithmetic can be graded without a DOM: a pinch that
 * drifts, or a clamp that lets the artwork leave the screen, is indistinguishable
 * from a rendering bug in a screenshot and miserable to debug through one.
 */

export interface ViewerCamera {
  zoom: number;
  pan: { x: number; y: number };
}

export interface ViewerSize {
  width: number;
  height: number;
}

/** Screen px kept free around the board when it is fitted. */
export const VIEWER_FIT_MARGIN = 14;

/**
 * How much of the board must stay on screen after a pan.
 *
 * A reader has no scrollbars and no "zoom to fit" muscle memory, so a fling that
 * leaves one corner of a 2100px board on a 390px screen looks exactly like an
 * empty document. This is the tether.
 */
export const VIEWER_KEEP_VISIBLE = 56;

/** A fit never magnifies: a 320px artboard on a 390px screen is already legible. */
const FIT_MAX_ZOOM = 1;

/**
 * The board to frame: the page's declared canvas, plus anything that spills past
 * it. Fitting `contentBounds` alone would frame a single stray layer, and
 * fitting the canvas alone would crop a design someone drew outside it.
 */
export function boardBounds(
  canvas: { width?: number; height?: number } | undefined,
  content: Rect | null
): Rect {
  const board: Rect = {
    x: 0,
    y: 0,
    width: Math.max(1, canvas?.width ?? 1920),
    height: Math.max(1, canvas?.height ?? 1080)
  };
  if (!content) return board;
  const minX = Math.min(board.x, content.x);
  const minY = Math.min(board.y, content.y);
  const maxX = Math.max(board.x + board.width, content.x + content.width);
  const maxY = Math.max(board.y + board.height, content.y + content.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const IDENTITY: ViewerCamera = { zoom: 1, pan: { x: 0, y: 0 } };

export function fitCamera(bounds: Rect | null, size: ViewerSize): ViewerCamera {
  if (size.width <= 0 || size.height <= 0) return IDENTITY;
  const fit = fitRect(
    bounds,
    { x: 0, y: 0, width: size.width, height: size.height },
    { margin: VIEWER_FIT_MARGIN, minZoom: MIN_ZOOM, maxZoom: FIT_MAX_ZOOM }
  );
  return fit ?? IDENTITY;
}

/**
 * Zoom about a point that stays put on screen — a pinch midpoint, a double tap.
 *
 * `factor` is relative, not absolute, because both callers think in "how much
 * bigger" and the clamp has to happen against the zoom being left behind.
 */
export function zoomCameraAt(
  camera: ViewerCamera,
  screenX: number,
  screenY: number,
  factor: number
): ViewerCamera {
  const zoom = clampZoom(camera.zoom * factor);
  if (zoom === camera.zoom) return camera;
  const worldX = (screenX - camera.pan.x) / camera.zoom;
  const worldY = (screenY - camera.pan.y) / camera.zoom;
  return { zoom, pan: { x: screenX - worldX * zoom, y: screenY - worldY * zoom } };
}

export function panCamera(camera: ViewerCamera, dx: number, dy: number): ViewerCamera {
  return { zoom: camera.zoom, pan: { x: camera.pan.x + dx, y: camera.pan.y + dy } };
}

/**
 * Hold the board against the edges of the screen: pan may carry it around, never
 * entirely away. Both bounds are computed even when the board is smaller than the
 * viewport — the constraints meet, they do not cross.
 */
export function clampCameraPan(
  camera: ViewerCamera,
  bounds: Rect | null,
  size: ViewerSize
): ViewerCamera {
  if (!bounds || size.width <= 0 || size.height <= 0) return camera;
  const keep = Math.min(VIEWER_KEEP_VISIBLE, size.width, size.height);
  const minX = keep - (bounds.x + bounds.width) * camera.zoom;
  const maxX = size.width - keep - bounds.x * camera.zoom;
  const minY = keep - (bounds.y + bounds.height) * camera.zoom;
  const maxY = size.height - keep - bounds.y * camera.zoom;
  const x = Math.min(Math.max(camera.pan.x, minX), maxX);
  const y = Math.min(Math.max(camera.pan.y, minY), maxY);
  if (x === camera.pan.x && y === camera.pan.y) return camera;
  return { zoom: camera.zoom, pan: { x, y } };
}

export function cameraViewportBox(camera: ViewerCamera, size: ViewerSize): ViewportBox | null {
  if (size.width <= 0 || size.height <= 0) return null;
  return calculateVisibleViewport(camera.pan, camera.zoom, size.width, size.height);
}
