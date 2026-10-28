import { useCallback } from "preact/hooks";
import { DesignDocument, DesignElement, getActivePage } from "../../core/dsl/types";
import { worldMatrixOf } from "../../core/interactions/component-swap";
import { elementAABB, contentBounds } from "../../core/geometry/element-bounds";
import { transformBoundsToAABB, type Rect } from "../../core/geometry/bounds";

interface ZoomCommandsOptions {
  docRef: { current: DesignDocument };
  selectedElements: DesignElement[];
  fitBounds: (bounds: Rect | null) => void;
  zoomByStep: (direction: 1 | -1) => void;
}

/**
 * The five zoom commands, which a key, a dock button and the title bar all share.
 *
 * Both fits read the document through `docRef` rather than through a `doc` from
 * the render: a fit fired while a stroke is still being committed has to frame
 * the layers that are about to be painted, not the ones this render happened to
 * capture.
 */
export function useZoomCommands({ docRef, selectedElements, fitBounds, zoomByStep }: ZoomCommandsOptions) {
  // Frame every visible layer of the active page.
  const zoomToFit = useCallback(() => {
    fitBounds(contentBounds(getActivePage(docRef.current).children));
  }, [docRef, fitBounds]);

  const zoomToSelection = useCallback(() => {
    if (selectedElements.length === 0) return;
    // Each box's four corners go through the full world matrix — ancestors'
    // rotations included — because a fit has to frame what is PAINTED. Adding a
    // translation-only origin and ignoring the element's own turn framed a
    // rectangle that a turned layer does not occupy, and a layer inside a turned
    // frame was framed at the place the frame was before it was turned.
    const boxes = selectedElements.map((el) =>
      transformBoundsToAABB(elementAABB(el), worldMatrixOf(docRef.current, el))!
    );
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }, [docRef, fitBounds, selectedElements]);

  const zoomIn = useCallback(() => zoomByStep(1), [zoomByStep]);
  const zoomOut = useCallback(() => zoomByStep(-1), [zoomByStep]);

  return { zoomToFit, zoomToSelection, zoomIn, zoomOut };
}
