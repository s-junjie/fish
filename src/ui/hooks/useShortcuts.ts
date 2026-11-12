import { useEffect, useRef } from "preact/hooks";
import { getActivePage } from "../../core/dsl/document-ops";
import { useEditorCommands } from "./useEditorCommands";
import { handleShortcut } from "./shortcuts/dispatch";
import type { ShortcutContext, UseShortcutsOptions, ZoomCommands } from "./shortcuts/types";

export type { UseShortcutsOptions };

const noop = () => {};

/**
 * The editor's keyboard. What each key does lives in `shortcuts/` — this file is
 * only the wiring: it registers one capture-phase listener on `window`, builds the
 * context that listener reads, and holds the two refs that keep it from having to
 * re-register on every render.
 */
export function useShortcuts(options: UseShortcutsOptions) {
  const {
    selectedIds,
    setSelectedIds,
    primarySelected,
    docRef,
    commitSnapshot,
    canvasContainerRef,
    handleUndo,
    handleRedo,
    triggerSave,
    triggerSaveAs,
    startRenaming,
    startCanvasTextEdit,
    onSetScaleTool,
    onCyclePenMode,
    penActive = false,
    isScaleToolActive = false,
    onLeaveScaleTool,
    isSpacePressed,
    setIsSpacePressed,
    setHintMessage = noop,
    onPngCopyProgress,
    setActiveTool,
    activeTool,
    setCurrentNavTool,
    setCurrentShapeTool,
    editingPathId,
    onStartPathEdit,
    onExitPathEdit,
    visibleWorldRect,
    onZoomToFit,
    onZoomToActualSize,
    onZoomIn,
    onZoomOut,
    onZoomToSelection,
    onToggleUiVisible,
    onImportFigmaExport,
    onImportHtmlClip,
    presentation = null,
    onTogglePresent
  } = options;

  useEditorCommands({
    selectedIds,
    setSelectedIds,
    primarySelected,
    docRef,
    commitSnapshot,
    setHintMessage,
    onPngCopyProgress,
    visibleWorldRect,
    canvasContainerRef,
    onImportFigmaExport,
    onImportHtmlClip
  });

  // Same reasoning as `zoomRef`: the listener must not re-register every time the
  // tool changes, only read what the tool is now.
  const penActiveRef = useRef(penActive);
  useEffect(() => {
    penActiveRef.current = penActive;
  });

  /**
   * The five zoom commands, read through a ref.
   *
   * The listener below re-registers only on the dependencies named at its end, so
   * it keeps the callbacks of the render it was born in. That is safe for a
   * command whose identity never changes and silently wrong for one that does:
   * `+` used to re-run the first render's `zoomByStep`, which read that render's
   * zoom, so every press recomputed the same rung and the view froze after one.
   * The ref makes the listener call the command that is on screen now, whatever
   * identity a caller passes.
   */
  const zoomRef = useRef<ZoomCommands>({ onZoomIn, onZoomOut, onZoomToActualSize, onZoomToFit, onZoomToSelection });
  zoomRef.current = { onZoomIn, onZoomOut, onZoomToActualSize, onZoomToFit, onZoomToSelection };

  useEffect(() => {
    const ctx: ShortcutContext = {
      selectedIds,
      setSelectedIds,
      primarySelected,
      docRef,
      commitSnapshot,
      handleUndo,
      handleRedo,
      triggerSave,
      triggerSaveAs,
      startRenaming,
      startCanvasTextEdit,
      onSetScaleTool,
      onCyclePenMode,
      isScaleToolActive,
      onLeaveScaleTool,
      isSpacePressed,
      setIsSpacePressed,
      setHintMessage,
      setActiveTool,
      activeTool,
      setCurrentNavTool,
      setCurrentShapeTool,
      editingPathId,
      onStartPathEdit,
      onExitPathEdit,
      onToggleUiVisible,
      presentation,
      onTogglePresent,
      activeEls: () => getActivePage(docRef.current).children,
      zoom: () => zoomRef.current,
      penActive: () => penActiveRef.current
    };

    // Capture on `window`, so the editor answers a key before any overlay does.
    const handleKeyDown = (e: KeyboardEvent) => {
      handleShortcut(e, ctx);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setIsSpacePressed(false);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp);
    };
    // `isScaleToolActive` is a dependency for the same reason `onSetScaleTool` is
    // not one of them: the handler above has to be able to tell whether Enter
    // means "leave Scale", and a flag frozen at the listener's registration would
    // answer the wrong question (LESSONS §59). The flag is a boolean, so the
    // listener re-registers only on the two transitions, not on every render.
    // `onLeaveScaleTool` is a stable `useCallback`, so it does not belong here.
    //
    // The zoom commands are the opposite case and are NOT listed: their identity
    // is not something this hook can guarantee, so they are read through
    // `zoomRef` instead. Listing them would re-register the listener on every
    // selection change (the fits depend on it) and still leave a window where the
    // captured command is older than the camera.
  }, [
    selectedIds,
    isSpacePressed,
    primarySelected,
    visibleWorldRect,
    commitSnapshot,
    setSelectedIds,
    isScaleToolActive,
    activeTool,
    presentation,
    onTogglePresent
  ]);
}
