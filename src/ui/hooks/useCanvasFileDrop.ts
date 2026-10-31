import { useEffect, useRef } from "preact/hooks";
import { ASSET_MIME } from "../../core/plugins/types";
import { acceptsDroppedFiles, partitionDroppedFiles } from "../../core/import/dropped-intake";

/**
 * Files dropped onto the canvas, and onto the panels around it.
 *
 * THE CANVAS IS THE ONLY SURFACE WITH AN OPINION. A picture wants the place it
 * was dropped; a document wants the import dialog. The panels around the canvas
 * have neither, and the browser's own answer to a file dropped on ordinary DOM is
 * to navigate the tab away — so one window-level guard takes the drop back and
 * hands it to the same two doors.
 *
 * WHY THIS IS NOT INLINE IN THE CANVAS: those two handlers plus the guard are one
 * subject, and they were the fourth one in a file already measured in hundreds of
 * lines. Keeping them together is also what stops the dragover reply from
 * drifting away from the drop that has to keep it.
 */

interface UseCanvasFileDropOptions {
  canvasContainerRef: { current: HTMLDivElement | null };
  pan: { x: number; y: number };
  zoom: number;
  /** Canvas-only view is a rendering of a document, not a place to edit one. */
  enabled: boolean;
  onInsertImage?: (file: File | Blob, worldX: number, worldY: number) => void;
  onAssetDrop?: (payloadJson: string, worldX: number, worldY: number, swap?: boolean) => void;
  onImportFiles?: (files: File[]) => void;
}

export function useCanvasFileDrop({
  canvasContainerRef,
  pan,
  zoom,
  enabled,
  onInsertImage,
  onAssetDrop,
  onImportFiles
}: UseCanvasFileDropOptions) {
  // Read by the window guard, which is registered once: panning changes `pan` on
  // every pointer move, and a listener swap per frame is not a price worth paying
  // for the one drop that lands on a panel.
  const viewRef = useRef({ pan, zoom });
  viewRef.current = { pan, zoom };

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      worldX: Math.round((clientX - rect.left - viewRef.current.pan.x) / viewRef.current.zoom),
      worldY: Math.round((clientY - rect.top - viewRef.current.pan.y) / viewRef.current.zoom)
    };
  };

  /**
   * A DRAG IS ANSWERED BEFORE IT DROPS, and the answer has to be one the drop can
   * keep. This used to take every file and then keep only the pictures, so a
   * `.fish.html` got a `copy` cursor and then nothing at all — a promise broken
   * silently, which reads as a dropped file that vanished.
   *
   * What is published during a drag is MIME and nothing else, so the guess is
   * made there and kept honest later: anything unrecognisable gets a sentence
   * from `readDroppedDocument` rather than nothing.
   */
  const handleDragOver = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.types.includes(ASSET_MIME) || acceptsDroppedFiles(dt)) {
      e.preventDefault();
      dt.dropEffect = "copy";
    }
  };

  const handleDrop = (e: DragEvent) => {
    const assetPayload = e.dataTransfer?.getData(ASSET_MIME);
    if (assetPayload && onAssetDrop) {
      const at = worldPoint(e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      e.stopPropagation();
      onAssetDrop(assetPayload, at.worldX, at.worldY, e.altKey);
      return;
    }

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const { media, documents } = partitionDroppedFiles(files);
    const placesMedia = media.length > 0 && Boolean(onInsertImage);
    const takesDocuments = documents.length > 0 && Boolean(onImportFiles);
    if (!placesMedia && !takesDocuments) return;

    e.preventDefault();
    // `stopPropagation` is what parts this handler from the window guard below:
    // the canvas has already answered, and its answer includes a place.
    e.stopPropagation();
    const at = placesMedia ? worldPoint(e.clientX, e.clientY) : null;
    if (at && onInsertImage) for (const file of media) onInsertImage(file, at.worldX, at.worldY);
    if (takesDocuments) onImportFiles?.(documents);
  };

  useEffect(() => {
    if (!enabled) return;
    const guardDragOver = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt || !acceptsDroppedFiles(dt)) return;
      e.preventDefault();
      dt.dropEffect = "copy";
    };
    const guardDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      const { media, documents } = partitionDroppedFiles(files);
      if (media.length === 0 && documents.length === 0) return;
      e.preventDefault();
      if (documents.length > 0) onImportFiles?.(documents);
      if (media.length === 0 || !onInsertImage) return;
      // Beside what is already here rather than under the pointer: the panels
      // give no usable drop point, and the centre of the viewport is one the
      // user can see.
      const rect = canvasContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const { pan: currentPan, zoom: currentZoom } = viewRef.current;
      const worldX = Math.round((rect.width / 2 - currentPan.x) / currentZoom);
      const worldY = Math.round((rect.height / 2 - currentPan.y) / currentZoom);
      for (const file of media) onInsertImage(file, worldX, worldY);
    };
    window.addEventListener("dragover", guardDragOver);
    window.addEventListener("drop", guardDrop);
    return () => {
      window.removeEventListener("dragover", guardDragOver);
      window.removeEventListener("drop", guardDrop);
    };
  }, [enabled, onImportFiles, onInsertImage]);

  return { handleDragOver, handleDrop };
}
