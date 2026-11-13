import { useMemo } from "preact/hooks";
import type { DesignDocument, DesignElement, Page } from "../../core/dsl/types";
import { DEFAULT_CANVAS_BACKGROUND } from "../../core/dsl/defaults";
import type { ViewportBox } from "../../core/geometry/cull";
import { DocumentStage } from "../canvas/DocumentStage";
import { pageNeedsBackdropSafeStage } from "../canvas/stage-transform-mode";
import type { ViewerCamera } from "./viewer-camera";

interface ViewerStageProps {
  hostRef: { current: HTMLDivElement | null };
  page: Page;
  elements: DesignElement[];
  allElements: DesignElement[];
  docRef: { current: DesignDocument };
  camera: ViewerCamera;
  viewportBox: ViewportBox | null;
  /** A pointer is dragging the board, so the hand is closed. */
  panning: boolean;
}

/**
 * The board, at the reader's camera, and nothing else.
 *
 * No `CanvasArea` here on purpose: that component's job is deciding which of
 * fifteen editing overlays to mount, and every one of them is dead weight on a
 * phone. What both hosts must agree on is the stage itself, so `DocumentStage`
 * is mounted exactly as the presentation overlay mounts it — same `<defs>`, same
 * renderer, same paint.
 */
export function ViewerStage({
  hostRef,
  page,
  elements,
  allElements,
  docRef,
  camera,
  viewportBox,
  panning
}: ViewerStageProps) {
  // Same rule as the editor (`stage-transform-mode.ts`): with a backdrop blur and a blend
  // mode in the page, a transform ABOVE the svg makes Chromium drop every
  // `backdrop-filter` inside it. Then the camera rides a `<g>` attribute instead.
  const needsGroup = useMemo(() => pageNeedsBackdropSafeStage(elements), [elements]);
  const canvas = page.canvas ?? docRef.current.canvas;
  // The document's own surface, painted the way the editor paints it: the
  // canvas colour is the whole view, not a rectangle on the workbench's dark.
  // A reader that showed a white artboard on black read as "my background did
  // not carry over", because in the editor there is no black to carry it from.
  const surface = canvas?.background?.type === "solid" ? canvas.background.color : null;
  const background = surface ?? DEFAULT_CANVAS_BACKGROUND;

  const cssTransform = needsGroup
    ? undefined
    : `translate(${camera.pan.x}px, ${camera.pan.y}px) scale(${camera.zoom})`;
  const stageTransform = needsGroup
    ? `translate(${camera.pan.x}, ${camera.pan.y}) scale(${camera.zoom})`
    : undefined;

  return (
    <div
      ref={hostRef}
      data-viewer-stage="true"
      // The browser decides whether a drag is a pan or a page scroll before it
      // reports the first move; without this the canvas loses every gesture.
      // The cursor carries the same sentence for a device that has one: an open
      // hand over a board that can be dragged, a closed one while it is.
      // A paint the reader cannot draw (a gradient, an image) leaves the
      // workbench surface showing instead of tinting the whole screen wrong.
      style={{
        touchAction: "none",
        cursor: panning ? "grabbing" : "grab",
        ...(surface ? { backgroundColor: surface } : {})
      }}
      className="absolute inset-0 overflow-hidden bg-panel select-none"
    >
      <svg
        style={{
          display: "block",
          overflow: "visible",
          width: "100%",
          height: "100%",
          transform: cssTransform,
          transformOrigin: "0 0",
          // Read by every screen-constant chrome value in the tree (style.css).
          "--fish-zoom": camera.zoom
        }}
      >
        <g transform={stageTransform} data-stage-transform="true">
          {/* The page, painted. No outline: the editor draws none either, and a
              line around the artboard is a mark the document never made. */}
          <rect
            x={0}
            y={0}
            width={canvas?.width ?? 1920}
            height={canvas?.height ?? 1080}
            fill={background}
          />
          <DocumentStage
            elements={elements}
            allElements={allElements}
            docRef={docRef}
            zoom={camera.zoom}
            viewportBox={viewportBox}
            assets={docRef.current.assets}
            frameTitles={false}
          />
        </g>
      </svg>
    </div>
  );
}
