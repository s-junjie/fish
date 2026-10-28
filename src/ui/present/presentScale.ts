export type PresentScaleMode =
  | "actual"
  | "responsive"
  | "fit-width"
  | "fit"
  | "fill";

export interface PresentViewport {
  width: number;
  height: number;
}

export interface PresentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PresentFitResult {
  zoom: number;
  pan: { x: number; y: number };
}

/**
 * Calculates pan and zoom transforms for the presentation frame
 * according to the selected Figma-style scale mode.
 */
export function calculatePresentFit(
  bounds: PresentBounds | null,
  viewport: PresentViewport,
  mode: PresentScaleMode
): PresentFitResult | null {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }

  const { width: vw, height: vh } = viewport;
  const { x: bx, y: by, width: bw, height: bh } = bounds;

  let zoom = 1;

  switch (mode) {
    case "actual":
      zoom = 1;
      break;

    case "responsive":
      // Scale down to fit the window if larger, but never scale up beyond 100%
      zoom = Math.min(1.0, vw / bw, vh / bh);
      break;

    case "fit-width":
      zoom = vw / bw;
      break;

    case "fit":
      // Fit both width and height within viewport (can scale up or down)
      zoom = Math.min(vw / bw, vh / bh);
      break;

    case "fill":
      // Fill the entire screen (cover), clipping any overflow
      zoom = Math.max(vw / bw, vh / bh);
      break;
  }

  // Ensure finite and positive zoom
  if (!Number.isFinite(zoom) || zoom <= 0) {
    zoom = 1;
  }

  // Center the frame horizontally in the viewport
  const panX = (vw - bw * zoom) / 2 - bx * zoom;
  // If content height exceeds viewport, align to the top (like previewing a web page); otherwise center vertically
  const renderedHeight = bh * zoom;
  const panY = renderedHeight > vh ? -by * zoom : (vh - renderedHeight) / 2 - by * zoom;

  return {
    zoom,
    pan: { x: panX, y: panY }
  };
}
