import { TITLE_BAR_HEIGHT } from "./toolbar/titlebar-layout";

export type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowViewport {
  width: number;
  height: number;
}

export interface WindowSizeBounds {
  minWidth: number;
  minHeight: number;
  minTop?: number;
  margin?: number;
}

export const WINDOW_EDGE_MARGIN = 10;
export const WINDOW_MIN_VISIBLE_BOTTOM = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampWindowSize(
  size: { width: number; height: number },
  viewport: WindowViewport,
  bounds: WindowSizeBounds
): { width: number; height: number } {
  const minTop = bounds.minTop ?? TITLE_BAR_HEIGHT;
  const margin = bounds.margin ?? WINDOW_EDGE_MARGIN;
  const maxW = Math.max(bounds.minWidth, viewport.width - margin * 2);
  const maxH = Math.max(bounds.minHeight, viewport.height - minTop - margin);
  return {
    width: Math.round(clamp(size.width, bounds.minWidth, maxW)),
    height: Math.round(clamp(size.height, bounds.minHeight, maxH))
  };
}

export function clampWindowPosition(
  pos: { x: number; y: number },
  size: { width: number; height?: number },
  viewport: WindowViewport,
  options?: { minTop?: number; margin?: number; minVisibleBottom?: number; fitHeight?: boolean }
): { x: number; y: number } {
  const minTop = options?.minTop ?? TITLE_BAR_HEIGHT;
  const margin = options?.margin ?? WINDOW_EDGE_MARGIN;
  const minVisibleBottom = options?.minVisibleBottom ?? WINDOW_MIN_VISIBLE_BOTTOM;
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY =
    options?.fitHeight && size.height !== undefined
      ? Math.max(minTop, viewport.height - size.height - margin)
      : Math.max(minTop, viewport.height - minVisibleBottom);
  return {
    x: Math.round(clamp(pos.x, margin, maxX)),
    y: Math.round(clamp(pos.y, minTop, maxY))
  };
}

export function resizeWindowRect(
  startRect: WindowRect,
  delta: { dx: number; dy: number },
  direction: ResizeDirection,
  viewport: WindowViewport,
  bounds: WindowSizeBounds
): WindowRect {
  const minTop = bounds.minTop ?? TITLE_BAR_HEIGHT;
  const margin = bounds.margin ?? WINDOW_EDGE_MARGIN;
  const { minWidth, minHeight } = bounds;

  let x = startRect.x;
  let y = startRect.y;
  let width = startRect.width;
  let height = startRect.height;

  if (direction.includes("e")) {
    const maxW = Math.max(minWidth, viewport.width - startRect.x - margin);
    width = Math.round(clamp(startRect.width + delta.dx, minWidth, maxW));
  } else if (direction.includes("w")) {
    const right = startRect.x + startRect.width;
    const minX = Math.min(startRect.x, margin);
    const maxX = Math.max(minX, right - minWidth);
    x = Math.round(clamp(startRect.x + delta.dx, minX, maxX));
    width = right - x;
  }

  if (direction.includes("s")) {
    const maxH = Math.max(minHeight, viewport.height - startRect.y - margin);
    height = Math.round(clamp(startRect.height + delta.dy, minHeight, maxH));
  } else if (direction.includes("n")) {
    const bottom = startRect.y + startRect.height;
    const maxY = Math.max(minTop, bottom - minHeight);
    y = Math.round(clamp(startRect.y + delta.dy, minTop, maxY));
    height = bottom - y;
  }

  return { x, y, width, height };
}
