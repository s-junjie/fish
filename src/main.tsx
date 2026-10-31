import "./style.css";
import { render } from "preact";
import { useState, useEffect, useRef, useCallback, useMemo } from "preact/hooks";
import { capturePristine, loadInitialComments, registerPreviewGenerator } from "./core/data-bridge";
import { removeCoverFromDom } from "./core/cover-block";
import { renderThumbnailPreviewHtml } from "./ui/thumbnail-preview";
import { APP_VERSION } from "./core/version";
import { installHostBridge } from "./core/plugins/host-bridge";

registerPreviewGenerator(renderThumbnailPreviewHtml);
// The file's own cover is a picture of the document, not part of the editor: it is
// cleared before the shell is captured, so a re-save writes a fresh one rather than
// inheriting the copy this session booted with.
removeCoverFromDom();
capturePristine();
// Before anything can open a panel: a plugin bundle reads the runtime off this
// global at module evaluation, and has no other way to reach Preact.
installHostBridge();
console.info(`FISH runtime v${APP_VERSION}`);
import { DesignElement, PathElement, getActivePage, updateActivePageElements } from "./core/dsl/types";
import { t } from "./i18n";
import { collectComponents, findComponentOwnerPageId } from "./core/interactions/component-inventory";
import { resolveInstanceSelection, resolvedEditChangesNode, commitInstanceOverrides } from "./core/interactions/instance-resolve";
import type { InstanceSelection } from "./core/interactions/instance-resolve";
import {
  createEmptyCommentsDocument,
  type FishCommentsDocument
} from "./core/comments/types";
import { worldMatrixOf, worldOriginOf } from "./core/interactions/component-swap";
import { applyAutoLayout, relayoutDocumentTree } from "./core/compile";
import { layoutOf } from "./core/dsl/layout-flat";
import { useContextMenu } from "./ui/context-menu/useContextMenu";
import { useFrameResizeModifier } from "./ui/hooks/useFrameResizeModifier";
import { useBlockBrowserZoom } from "./ui/hooks/useBlockBrowserZoom";
import { usePageManagement } from "./ui/hooks/usePageManagement";
import { useFileWriteback } from "./ui/hooks/useFileWriteback";
import { useDocumentJsonActions } from "./ui/hooks/useDocumentJsonActions";
import { useInlineEditing } from "./ui/hooks/useInlineEditing";
import { useToolState } from "./ui/hooks/useToolState";
import { useHint } from "./ui/hooks/useHint";
import { CanvasOnlyView } from "./ui/canvas/CanvasOnlyView";
import { usePresentation } from "./ui/present/usePresentation";
import { useCanvasViewport } from "./ui/hooks/useCanvasViewport";
import { useElementSize } from "./ui/hooks/useElementSize";
import { useShortcuts } from "./ui/hooks/useShortcuts";
import { useCanvasGestures } from "./ui/hooks/useCanvasGestures";
import { useSmartSelectionGesture } from "./ui/hooks/useSmartSelectionGesture";
import { useInspectorOverlayHidden } from "./ui/hooks/inspector-activity";
import { useHeadlessReport } from "./ui/hooks/useHeadlessReport";
import { useFishBridge } from "./ui/hooks/useFishBridge";
import { useAssetInsertion } from "./ui/hooks/useAssetInsertion";
import { useHtmlImport } from "./ui/hooks/useHtmlImport";
import { useFigmaImport } from "./ui/hooks/useFigmaImport";
import { useLayerRowActions } from "./ui/hooks/useLayerRowActions";
import { useZoomCommands } from "./ui/hooks/useZoomCommands";
import { useHtmlEmbedSnapshotListener } from "./ui/hooks/useHtmlEmbedSnapshotListener";
import { useThumbnailSnapshot } from "./ui/hooks/useThumbnailSnapshot";
import { useGestureActive } from "./ui/hooks/useGestureActive";
import { useFontStatusSync } from "./ui/hooks/useFontStatusSync";
import { EditorShell } from "./ui/EditorShell";
import { useEditorStore } from "./ui/hooks/useEditorStore";
import { usePenEditing } from "./ui/hooks/usePenEditing";
import { useTestBridge } from "./ui/hooks/useTestBridge";
import { useStructuralCommands } from "./ui/hooks/useStructuralCommands";
import { useComponentCommands } from "./ui/hooks/useComponentCommands";
import { useComponentImport } from "./ui/hooks/useComponentImport";
import { useAssetUsage } from "./ui/hooks/useAssetUsage";
import { useFramePresetCreate, type FramePresetViewport } from "./ui/hooks/useFramePresetCreate";
import { findElementById, flattenElements, mapElements, isContainer } from "./core/geometry/tree-ops";
import { computeParentOrigin } from "./core/geometry/tree-coords";
import { elementWorldAABB } from "./core/geometry/tree-hit";
import { elementAABB, isLineElement } from "./core/geometry/element-bounds";
import { transformBoundsToAABB } from "./core/geometry/bounds";
import { detectSmartSelection } from "./core/geometry/smart-selection";
import { calculateVisibleViewport } from "./core/geometry/cull";
import { setLineSize } from "./core/interactions/line-ops";
import { useComments } from "./ui/hooks/useComments";
import type { CommentsOverlayProps } from "./ui/canvas/CommentsOverlay";
import type { CommentsPanelProps } from "./ui/comments/CommentsPanel";
import type { DesignDocument } from "./core/dsl/types";
import { resolveCommentCanvasPoint } from "./core/comments/anchor";

export function App() {
  // Canvas Viewport Hook
  const {
    canvasContainerRef,
    zoom,
    setZoom,
    pan,
    setPan,
    isSpacePressed,
    setIsSpacePressed,
    isCanvasPanning,
    handleWheel,
    startCanvasPan,
    updateCanvasPan,
    endCanvasPan,
    fitBounds,
    focusOn,
    zoomByStep,
    zoomToActualSize,
    visibleWorldRect,
    dropTopLeft
  } = useCanvasViewport();
  useBlockBrowserZoom();

  // The live camera, for everything that has to read it without re-rendering:
  // the page switch that files it away, the bridge an agent drives, and the save
  // that stamps it into the file. Panning would otherwise rebuild every consumer.
  const viewportRef = useRef({ x: pan.x, y: pan.y, zoom });
  viewportRef.current = { x: pan.x, y: pan.y, zoom };

  const {
    store,
    doc,
    docRef,
    setDoc,
    commitSnapshot,
    startDragGesture,
    endDragGesture,
    undo: handleUndo,
    redo: handleRedo
  } = useEditorStore((v) => {
    setPan({ x: v.x, y: v.y });
    setZoom(v.zoom);
  });

  /* The comment block, readable by the file writer without depending on the
     render that created it: auto-save is built once, and a recovery snapshot
     flushed before the first comment existed must still be able to say "none". */
  const commentsRef = useRef<FishCommentsDocument>(createEmptyCommentsDocument());
  const getComments = useCallback(() => commentsRef.current, []);
  /* `loaded` never changes: it is the block this tab booted with, which is what
     "did the snapshot hold a different conversation" has to compare against. */
  const [bootComments] = useState(() => loadInitialComments());
  const commentWriteback = useMemo(
    () => ({ get: getComments, loaded: bootComments }),
    [getComments, bootComments]
  );

  const file = useFileWriteback(store, viewportRef, commentWriteback);
  const documentJsonActions = useDocumentJsonActions(store, file.flashSaveStatus);

  // The cover snapshot a save pastes into the file. Kept warm here because the
  // save path is synchronous and cannot wait for a decode — and held off while a
  // gesture is redrawing the document, whose every frame it would chase.
  useThumbnailSnapshot(doc, useGestureActive(store));

  // Which of the document's families this machine actually has. Decided once per
  // document version, in the one module everyone reads — see `core/fonts/font-status`.
  useFontStatusSync(doc);

  const [selectedIds, setSelectedIdsRaw] = useState<Set<string>>(new Set());

  const setSelectedIds = useCallback((next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    // If an inspector input or text field is currently focused, blur it first
    // so its draft commits to the element that was being edited, BEFORE the selection
    // changes to a new element.
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      active.blur();
    }
    setSelectedIdsRaw(next);
  }, []);

  // Comments live in their own `#fish-comments` block, so writing one commits
  // nothing — `touch` is what tells auto-save the file is stale.
  const requestPersist = useCallback(() => store.touch(), [store]);
  const comments = useComments(docRef, commitSnapshot, requestPersist);
  commentsRef.current = comments.comments;

  const hint = useHint();
  const [isUiVisible, setIsUiVisible] = useState(true);

  const [is4Corners, setIs4Corners] = useState(false);

  // The morph pairing lines. Session state: never in the document or the undo stack.
  const [morphLines, setMorphLines] = useState(true);

  const inspectorOverlayHidden = useInspectorOverlayHidden();

  // `window.__fish`, the channel an agent drives the editor through. It reads the
  // viewport through a ref, so this call sits after the hook that owns it rather
  // than up where the accessor used to be defined.
  useFishBridge({ docRef, canvasContainerRef, zoom, pan });

  // Active page & flattened elements.
  //
  // Each of the four derives from the one above it and is memoized on its own
  // input: they are read by the canvas, the inspector and every command, so an
  // array rebuilt on each render is an array whose consumers can never memoize.
  // `activePage.children` rather than `activePage` as the key because the page
  // object is not stable across commits while its element array is.
  const activePage = getActivePage(doc);
  const allElements = useMemo(() => flattenElements(activePage.children), [activePage.children]);
  const realSelected = useMemo(
    () => allElements.filter((el) => selectedIds.has(el.id)),
    [allElements, selectedIds]
  );
  // A node inside an instance is a resolved clone: it is painted but never
  // stored, so it is absent from the tree. Resolving the selection here is what
  // lets the inspector edit it — writes are turned into overrides downstream.
  const virtualSelections = useMemo(() => {
    const out: InstanceSelection[] = [];
    for (const id of selectedIds) {
      if (realSelected.some((el) => el.id === id)) continue;
      const sel = resolveInstanceSelection(doc, id);
      if (sel) out.push(sel);
    }
    return out;
  }, [selectedIds, doc, realSelected]);
  const selectedElements = useMemo(
    () => [...realSelected, ...virtualSelections.map((s) => s.node)],
    [realSelected, virtualSelections]
  );
  const inline = useInlineEditing({
    store,
    docRef,
    setDoc,
    commitSnapshot,
    startDragGesture,
    endDragGesture,
    setSelectedIds,
    selectedIds,
    virtualSelections
  });
  const tool = useToolState(docRef, selectedIds);
  const primarySelected = selectedElements[0] as DesignElement | undefined;

  /* Leaving comment mode closes the cards with it: the rail that lists the
     threads is gone in the same frame, and a comment window left floating over
     the canvas would be a conversation with no way back to its siblings. */
  useEffect(() => {
    if (tool.activeTool === "comment") return;
    comments.setActiveThreadId(null);
    comments.setDraftTarget(null);
  }, [tool.activeTool, comments.setActiveThreadId, comments.setDraftTarget]);

  // Renderer-measured glyph-run box of an on-path text. Transient (no history
  // entry): the next gesture's baseline snapshots the already-corrected box.
  const handleOnPathTextBounds = useCallback((id: string, box: { x: number; y: number; width: number; height: number }) => {
    setDoc((prev) =>
      updateActivePageElements(
        prev,
        mapElements(getActivePage(prev).children, (el) => (el.id === id ? { ...el, ...box } : el))
      )
    );
  }, []);

  const pen = usePenEditing({
    docRef,
    doc,
    activePage,
    commitSnapshot,
    setSelectedIds,
    setEditingPathId: inline.setEditingPathId,
    setSelectedAnchorIdxs: inline.setSelectedAnchorIdxs,
    setActiveTool: tool.setActiveTool,
    showHint: hint.showHint
  });

  // Before `useAssetInsertion`, which takes `importHtmlFile` from it: every door
  // that accepts a file accepts `.svg`, and an SVG is layers, not a picture.
  const {
    importHtmlFile: handleImportHtmlFile,
    importHtmlClip: handleImportHtmlClip,
    importProgress: htmlImportProgress,
    pendingAssets,
    attachAssetFolder: handleAttachAssetFolder,
    dismissPendingAssets: handleDismissAssetFolder
  } = useHtmlImport({
    docRef,
    commitSnapshot,
    select: setSelectedIds,
    showHint: hint.showHint,
    setPan,
    setZoom
  });

  const {
    insertImageFile: handleInsertImage,
    insertImageUrl: handleInsertImageUrl,
    insertVideoUrl: handleInsertVideoUrl,
    insertHtmlUrl: handleInsertHtmlUrl,
    insertHtmlFile: handleInsertHtmlFile,
    insertHtmlCode: handleInsertHtmlCode,
    insertAsset: handleAssetInsert,
    dropAssetJson: handleAssetDropJson,
    embedAsset: handleEmbedAsset
  } = useAssetInsertion({
    docRef,
    commitSnapshot,
    select: setSelectedIds,
    showHint: hint.showHint,
    dropTopLeft,
    importVectorFile: handleImportHtmlFile
  });

  const { importFigmaExport: handleImportFigmaExport } = useFigmaImport({
    docRef,
    commitSnapshot,
    select: setSelectedIds,
    showHint: hint.showHint,
    setPan,
    setZoom
  });

  /**
   * A paste of the plugin's clipboard copy.
   *
   * The envelope the plugin puts on the clipboard is the single-file JSON the
   * picker already reads, so the paste takes the SAME door with the text wrapped
   * as the file it would have been — one import path, not two. The name and type
   * are honest about what it is; nothing downstream reads either.
   *
   * `paste: true` is what makes it a paste rather than a picked file: the same
   * payload lands on the page the designer is working on when it is one board,
   * because that is what pasting means everywhere else.
   */
  const importFigmaFromClipboard = useCallback(
    (text: string) =>
      handleImportFigmaExport(new File([text], "fish-figma-export.json", { type: "application/json" }), {
        paste: true
      }),
    [handleImportFigmaExport]
  );

  const structural = useStructuralCommands({
    docRef,
    commitSnapshot,
    selectedIds,
    setSelectedIds,
    selectedElements,
    realSelected,
    showHint: hint.showHint,
    startPathEdit: inline.startPathEdit
  });

  useTestBridge({
    docRef,
    selectedIds,
    setSelectedIds,
    commitSnapshot,
    undo: handleUndo,
    redo: handleRedo
  });

  const toggleUiVisible = useCallback(() => setIsUiVisible((prev) => !prev), []);

  useEffect(() => {
    if (isUiVisible) {
      hint.setHintMessage("");
      return;
    }
    hint.showHint(t("view.uiHidden"));
  }, [isUiVisible, hint.showHint]);

  // Presentation. A mode of the viewer: the overlay covers the window, so the
  // editor's gestures never see a pointer and the canvas keeps its own zoom and
  // pan untouched underneath — which is why entering and leaving restores
  // nothing.
  const present = usePresentation(doc, primarySelected?.id ?? null, hint.showHint);

  const {
    zoomToFit: handleZoomToFit,
    zoomToSelection: handleZoomToSelection,
    zoomIn: handleZoomIn,
    zoomOut: handleZoomOut
  } = useZoomCommands({ docRef, selectedElements, fitBounds, zoomByStep });

  // The strip's fit button frames what the user is working on: a selection gets
  // the Shift+2 treatment, an empty selection the Shift+1 one.
  const handleZoomFit = useCallback(() => {
    (selectedElements.length > 0 ? handleZoomToSelection : handleZoomToFit)();
  }, [selectedElements, handleZoomToSelection, handleZoomToFit]);

  // Global Keyboard Shortcuts
  useShortcuts({
    onCyclePenMode: pen.cycleMode,
    penActive: tool.activeTool === "path",
    selectedIds,
    onSetScaleTool: tool.scaleTool.toggle,
    isScaleToolActive: tool.isScaleTool,
    onLeaveScaleTool: tool.scaleTool.leave,
    setSelectedIds,
    primarySelected: primarySelected || null,
    docRef,
    commitSnapshot,
    canvasContainerRef,
    handleUndo,
    handleRedo,
    triggerSave: file.triggerSave,
    triggerSaveAs: file.triggerSaveAs,
    startRenaming: inline.startRenaming,
    startCanvasTextEdit: inline.startCanvasTextEdit,
    setHintMessage: hint.showHint,
    onPngCopyProgress: (busy) => hint.setBusy(busy ? t("clipboard.copyImageInProgress") : null),
    isSpacePressed,
    setIsSpacePressed,
    setActiveTool: tool.setActiveTool,
    activeTool: tool.activeTool,
    setCurrentNavTool: tool.setCurrentNavTool,
    setCurrentShapeTool: tool.setCurrentShapeTool,
    editingPathId: inline.editingPathId,
    onStartPathEdit: inline.startPathEdit,
    onExitPathEdit: inline.exitPathEdit,
    visibleWorldRect,
    onZoomToFit: handleZoomToFit,
    onZoomToActualSize: zoomToActualSize,
    onZoomIn: handleZoomIn,
    onZoomOut: handleZoomOut,
    onZoomToSelection: handleZoomToSelection,
    onToggleUiVisible: toggleUiVisible,
    onImportFigmaExport: importFigmaFromClipboard,
    onImportHtmlClip: handleImportHtmlClip,
    presentation: present.active ? present.keys : null,
    onTogglePresent: present.toggle,
  });

  /**
   * Select every layer carrying a colour, replacing what was selected.
   *
   * A REPLACEMENT, not an addition: the point of the button is to go and look at
   * the layers that share this colour, and carrying the previous selection along
   * means the thing you just clicked to narrow down is still in the box.
   *
   * Resolved against the real tree, so an id that no longer exists anywhere does
   * not enter the selection — but a resolved id INSIDE an instance is kept: a
   * colour only an instance's children carry is exactly what this button is for,
   * and a selection of resolved ids is the one the inspector already edits as
   * overrides.
   */
  const selectByColor = useCallback(
    (ids: string[]) => {
      const elements = getActivePage(docRef.current).children;
      const present = ids.filter(
        (id) => findElementById(elements, id) || resolveInstanceSelection(docRef.current, id)
      );
      if (present.length === 0) {
        hint.showHint(t("selectedColors.noneOnCanvas"));
        return;
      }
      setSelectedIds(new Set(present));
    },
    [docRef, setSelectedIds, hint.showHint]
  );

  const isPanMode = tool.activeTool === "hand" || isSpacePressed;

  // Memoized SVG node handlers read this at event time; their own closure goes
  // stale when only pan state changed (see element-click.ts).
  const isPanModeRef = useRef(false);
  isPanModeRef.current = isPanMode;

  // Canvas Gestures Hook (mouse down, move, element drag, resize, rotate, creation)
  const gestures = useCanvasGestures({
    docRef,
    setDoc,
    selectedIds,
    setSelectedIds,
    primarySelected: primarySelected || null,
    activeTool: tool.activeTool,
    setActiveTool: tool.setActiveTool,
    zoom,
    pan,
    isPanMode,
    isPanModeRef,
    startCanvasPan,
    updateCanvasPan,
    endCanvasPan,
    canvasContainerRef,
    startDragGesture,
    endDragGesture,
    commitSnapshot,
    setHintMessage: hint.showHint,
    startCanvasTextEdit: inline.startCanvasTextEdit,
    editingPathId: inline.editingPathId,
    scaleAnchor: tool.scaleTool.anchor,
    onAnchorMarquee: inline.handleAnchorMarquee,
    onCommentAtElement: comments.handleCommentAtElement,
    onCommentAtCanvas: comments.handleCommentAtCanvas
  });

  useHtmlEmbedSnapshotListener(docRef, commitSnapshot);

  const multiBounds = useMemo(() => {
    if (selectedElements.length < 2) return null;
    // Each member's box is carried into canvas space by its FULL world matrix —
    // ancestors' rotations included — and the union is taken over the four
    // corners it lands on. The old form added a translation-only origin and
    // dropped the element's own turn entirely, so a union of turned layers framed
    // the wrong rectangle; see `worldMatrixOf` for why the two answers differ.
    const boxes = selectedElements.map((e) =>
      transformBoundsToAABB(elementAABB(e), worldMatrixOf(docRef.current, e))!
    );
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    return {
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }, [selectedElements, doc]);

  // Smart Selection gap handles calculation. Locked members are dropped first:
  // every gap/dot gesture rewrites the positions of the elements it spans, which
  // is exactly what a lock forbids. `originOf` puts the reported handles in canvas
  // space — a stack's children are positioned inside the frame, and the overlay
  // draws them next to the frame, not at the frame's own origin.
  const smartSelection = useMemo(
    () =>
      detectSmartSelection(
        selectedElements.filter((el) => !el.locked),
        // The matrix, not just the origin: these handles are drawn over the
        // children, and inside a turned frame the children are not at the
        // position a translation names.
        { originOf: (el) => worldOriginOf(doc, el), matrixOf: (el) => worldMatrixOf(doc, el) }
      ),
    [selectedElements, doc]
  );

  // Smart Selection interactive gestures (Gap scrub, Tidy up & Dot swap)
  const smartSelectionGesture = useSmartSelectionGesture({
    docRef,
    setDoc,
    commitSnapshot,
    selectedIds,
    setSelectedIds,
    zoom,
    smartSelection,
    startDragGesture,
    endDragGesture
  });

  // Viewport Culling bounding box
  const canvasSize = useElementSize(canvasContainerRef);
  const viewportBox = useMemo(() => {
    return canvasSize.width > 0 && canvasSize.height > 0
      ? calculateVisibleViewport(pan, zoom, canvasSize.width, canvasSize.height, 250)
      : null;
  }, [pan.x, pan.y, zoom, canvasSize.width, canvasSize.height]);

  const editingPathElement = inline.editingPathId
    ? (() => {
        const el = findElementById(activePage.children, inline.editingPathId);
        return el && el.type === "path" ? (el as PathElement) : null;
      })()
    : null;

  /**
   * The inspector's write channel, and the only way a section edits a layer.
   *
   * Its identity never changes: it is handed to the inspector through context,
   * and a section that re-rendered because the channel moved would re-render on
   * every selection and every document change. The selection and the document are
   * therefore read at call time instead of captured — safe because a section only
   * ever calls this from an event handler, never while rendering.
   */
  const mutateInputsRef = useRef({ selectedIds, realSelected, virtualSelections });
  mutateInputsRef.current = { selectedIds, realSelected, virtualSelections };

  const mutateSelected = useCallback(
    (updater: (el: DesignElement) => DesignElement, discrete = false) => {
      const { selectedIds, realSelected, virtualSelections } = mutateInputsRef.current;
      const hasReal = realSelected.length > 0;
      if (virtualSelections.length > 0) {
        const virtualNext = commitInstanceOverrides(docRef.current, virtualSelections, updater);
        if (virtualNext) {
          if (!hasReal) {
            if (discrete) commitSnapshot(virtualNext);
            else setDoc(virtualNext);
            return;
          }
        } else if (!hasReal) {
          if (virtualSelections.some((s) => resolvedEditChangesNode(s.node, updater))) {
            hint.showHint(t("component.derivedChildLocked"));
          }
          return;
        }
      }
      if (!hasReal) return;

      const cur = getActivePage(docRef.current);
      const updatedElements = mapElements(cur.children, (item) => {
        if (selectedIds.has(item.id)) {
          let updated = updater({ ...item });
          if (isContainer(updated) && layoutOf(updated)) {
            updated = applyAutoLayout(updated);
          }
          if (
            updated.type === "instance" &&
            (updated.width !== item.width || updated.height !== item.height)
          ) {
            updated = { ...updated, sizeOverride: true };
          }

          if (isLineElement(item) && isLineElement(updated)) {
            if (updated.width !== item.width || updated.height !== item.height) {
              updated = setLineSize(updated as any, updated.width, updated.height) as any;
            }
          }
          return updated;
        }
        return item;
      });

      const nextDoc = updateActivePageElements(docRef.current, relayoutDocumentTree(updatedElements));
      if (discrete) {
        commitSnapshot(nextDoc);
      } else {
        setDoc(nextDoc);
      }
    },
    [commitSnapshot, setDoc, docRef, hint.showHint]
  );

  const {
    reorder: handleLayerReorder,
    toggleVisibility: handleLayerToggleVisibility,
    toggleLock: handleLayerToggleLock,
    commitRename: handleLayerCommitRename
  } = useLayerRowActions({
    docRef,
    commitSnapshot,
    showHint: hint.showHint,
    endRename: () => inline.setRenamingId(null)
  });

  const {
    selectPage: handleSelectPage,
    addPage: handleAddPage,
    renamePage: handleRenamePage,
    deletePage: handleDeletePage,
    duplicatePage: handleDuplicatePage
  } = usePageManagement({
    docRef,
    setDoc,
    commitSnapshot,
    setSelectedIds,
    viewportRef,
    setPan,
    setZoom,
    onLeaveLayer: () => {
      inline.setEditingCanvasTextId(null);
      inline.setEditingPathId(null);
    }
  });

  const components = useMemo(() => collectComponents(doc), [doc]);

  const handleImportComponents = useComponentImport({ docRef, commitSnapshot, setHintMessage: hint.setHintMessage });

  const { assetUsage, cleanUnusedAssets } = useAssetUsage({
    doc,
    docRef,
    commitSnapshot,
    showHint: hint.showHint
  });

  /**
   * Going to a main component: switch to the page that owns it — selecting an id
   * the active page does not contain selects nothing — then centre the canvas on
   * it. The second half is not optional on the current page either: a master may
   * sit far outside the viewport, and a jump that only selects leaves the user
   * looking at the same empty corner.
   */
  const handleLocateComponent = useCallback(
    (componentId: string) => {
      const cur = docRef.current;
      const pageId = findComponentOwnerPageId(cur, componentId);
      if (pageId && pageId !== getActivePage(cur).id) {
        handleSelectPage(pageId);
      }
      setSelectedIds(new Set([componentId]));
      // Read after the switch: `handleSelectPage` reflows the page it opens, so
      // the coordinates to aim at exist only in the document it produced.
      const master = findElementById(getActivePage(docRef.current).children, componentId);
      if (!master) return;
      const origin = worldOriginOf(docRef.current, master);
      const box = elementAABB(master);
      focusOn({ x: box.x + origin.x, y: box.y + origin.y, width: box.width, height: box.height });
    },
    [focusOn, handleSelectPage, setSelectedIds]
  );

  const handleLayerCancelRename = useCallback(() => inline.setRenamingId(null), []);

  // Right-click a definition to place an instance of it, or an instance to trace
  // it back to its master. Registered here because this is where the page-switch
  // half of `locateComponent` first exists.
  useComponentCommands({
    docRef,
    commitSnapshot,
    setSelectedIds,
    selectedIds,
    primarySelected: primarySelected || null,
    locateComponent: handleLocateComponent,
    showHint: hint.showHint
  });

  const isCanvasOnlyView = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "canvas";

  const headlessOrigin = useHeadlessReport(doc, docRef, canvasContainerRef);

  /**
   * The preset command needs three viewport accessors, and all three are rebuilt
   * on every pan and zoom. They are read through a ref instead of being captured:
   * the command is handed to a memoized inspector whose comparison deliberately
   * does not look at callbacks, so a captured drop point would place the next
   * frame at the centre of the view the panel last rendered with.
   */
  const framePresetViewportRef = useRef<FramePresetViewport>({ dropTopLeft, visibleWorldRect, focusOn });
  framePresetViewportRef.current = { dropTopLeft, visibleWorldRect, focusOn };

  const handleCreateFramePreset = useFramePresetCreate({
    docRef,
    commitSnapshot,
    select: setSelectedIds,
    setActiveTool: tool.setActiveTool,
    viewportRef: framePresetViewportRef
  });

  // Cmd/Ctrl + drag on a frame resizes the frame and leaves its contents be, so
  // the canvas has to offer the handles of a hugging frame while the key is held.
  const frameResizeKey = useFrameResizeModifier();

  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const handleStartRenamePage = useCallback((pageId: string) => {
    setRenamingPageId(pageId);
  }, []);
  const handleCancelRenamePage = useCallback(() => {
    setRenamingPageId(null);
  }, []);

  const {
    contextMenu,
    contextMenuEntries,
    closeContextMenu,
    openCanvasContextMenu,
    openLayerContextMenu,
    openPageContextMenu
  } = useContextMenu({
    docRef,
    commitSnapshot,
    selectedIds,
    onRenamePage: handleStartRenamePage,
    onDuplicatePage: handleDuplicatePage,
    onDeletePage: handleDeletePage,
    onHint: hint.showHint
  });

  if (isCanvasOnlyView) {
    return (
      <CanvasOnlyView
        canvasContainerRef={canvasContainerRef}
        headlessOrigin={headlessOrigin}
        doc={doc}
        allElements={allElements}
        docRef={docRef}
        canvasTextInputRef={inline.canvasTextInputRef}
      />
    );
  }

  const findElementBounds = useCallback(
    (elementId: string) => {
      const page = getActivePage(docRef.current);
      const el = findElementById(page.children, elementId);
      if (!el) return undefined;
      const parentOrigin = computeParentOrigin(page.children, el.id);
      const box = elementWorldAABB(el, parentOrigin.x, parentOrigin.y);
      return { ...box, name: el.name ?? el.type, type: el.type };
    },
    [docRef]
  );

  /**
   * A row in the comment panel: switch to its page, bring the pin into view and
   * open its card. Selecting a thread the user cannot see would be the same as
   * doing nothing, which is the one thing a jump must never be.
   */
  const handleFocusCommentThread = useCallback(
    (threadId: string) => {
      const thread = comments.comments.threads.find((item) => item.id === threadId);
      if (!thread) return;
      if (thread.pageId !== getActivePage(docRef.current).id) {
        handleSelectPage(thread.pageId);
      }
      const point = resolveCommentCanvasPoint(thread.target, findElementBounds);
      focusOn({ x: point.x, y: point.y, width: 0, height: 0 });
      comments.setActiveThreadId(threadId);
    },
    [comments, docRef, findElementBounds, focusOn, handleSelectPage]
  );

  /** A suggestion preview is a view redirect, the same one browsing a version
      uses: read-only, and invisible to auto-save, so nothing unaccepted lands
      in `#design-doc`. */
  const handleSetCommentPreview = useCallback((doc: DesignDocument | null) => {
    store.setViewDoc(doc);
  }, [store]);

  const commentsOverlayProps: CommentsOverlayProps = {
    comments: comments.comments,
    pageId: activePage.id,
    viewport: { panX: pan.x, panY: pan.y, zoom },
    findElement: findElementBounds,
    onAddComment: comments.handleAddComment,
    onReplyComment: comments.handleReplyComment,
    onResolveComment: comments.handleResolveComment,
    onReopenComment: comments.handleReopenComment,
    onDeleteComment: comments.handleDeleteComment,
    onMoveComment: comments.handleMoveComment,
    onApplySuggestion: comments.handleApplySuggestion,
    onDiscardSuggestion: comments.handleDiscardSuggestion,
    draftTarget: comments.draftTarget,
    setDraftTarget: comments.setDraftTarget,
    activeThreadId: comments.activeThreadId,
    setActiveThreadId: comments.setActiveThreadId,
    docRef,
    onSetPreview: handleSetCommentPreview,
    hidden: !isUiVisible
  };

  /* Named by id so the rail can label the threads it now lists from every page.
     Read off `doc` rather than a ref: renaming a page has to rename its rows. */
  const pageNames = useMemo(
    () => Object.fromEntries(doc.pages.map((page) => [page.id, page.name ?? page.id])),
    [doc.pages]
  );

  const commentsPanelProps: CommentsPanelProps = useMemo(
    () => ({
      comments: comments.comments,
      pageId: activePage.id,
      pageNames,
      activeThreadId: comments.activeThreadId,
      onFocusThread: handleFocusCommentThread,
      onResolve: comments.handleResolveComment,
      onReopen: comments.handleReopenComment,
      onDelete: comments.handleDeleteComment
    }),
    [
      comments.comments,
      comments.activeThreadId,
      comments.handleResolveComment,
      comments.handleReopenComment,
      comments.handleDeleteComment,
      pageNames,
      activePage.id,
      handleFocusCommentThread
    ]
  );

  /* One decision, two stores: the document the snapshot holds is committed as
     one undoable step, and the conversation it carried is adopted beside it —
     recovering the design while dropping the comments about it would leave the
     canvas showing work nobody can explain. */
  const handleRecover = useCallback(() => {
    if (file.pendingRecovery) commitSnapshot(file.pendingRecovery);
    comments.replaceComments(file.recoveredComments);
  }, [file.pendingRecovery, file.recoveredComments, commitSnapshot, comments.replaceComments]);

return (
<EditorShell
      file={file}
      documentJson={documentJsonActions}
      hint={hint}
      ui={{
        isUiVisible,
        is4Corners,
        setIs4Corners,
        overlayHidden: inspectorOverlayHidden,
        morphLines,
        setMorphLines,
        frameResizeKey
      }}
      docState={{
        doc,
        activePage,
        allElements,
        components,
        docRef,
        assetUsage,
        setDoc,
        commitSnapshot,
        startDragGesture,
        endDragGesture,
        editingPathElement
      }}
      selection={{ selectedIds, setSelectedIds, selectedElements, primarySelected: primarySelected || null, multiBounds }}
      viewport={{ canvasContainerRef, zoom, pan, isCanvasPanning, isPanMode, handleWheel, viewportBox, dropTopLeft }}
      gestures={gestures}
      smart={{ ...smartSelectionGesture, smartSelection }}
      inline={inline}
      tool={tool}
      pen={pen}
      present={present}
      commands={{
        handleZoomIn,
        handleZoomOut,
        handleZoomFit,
        handleZoomActualSize: zoomToActualSize,
        handleToggleSelectionLock: structural.toggleLock,
        handleToggleSelectionVisibility: structural.toggleVisibility,
        handleAlignment: structural.align,
        selectByColor,
        handleBooleanAction: structural.boolean,
        handleLocateComponent,
        handleImportComponents,
        handleCleanUnusedAssets: cleanUnusedAssets,
        handleAssetInsert,
        handleAssetDropJson,
        handleEmbedAsset,
        handleInsertImage,
        handleInsertImageUrl,
        handleInsertVideoUrl,
        handleInsertHtmlUrl,
        handleInsertHtmlFile,
        handleInsertHtmlCode,
        handleImportHtmlFile,
        pendingAssets,
        handleAttachAssetFolder,
        handleDismissAssetFolder,
        handleImportFigmaExport,
        handleOnPathTextBounds,
        handleCreateFramePreset
      }}
      layers={{
        handleLayerReorder,
        handleLayerToggleVisibility,
        handleLayerToggleLock,
        handleLayerCommitRename,
        handleLayerCancelRename
      }}
      pages={{
        handleSelectPage,
        handleAddPage,
        handleStartRenamePage,
        handleRenamePage,
        handleDeletePage,
        handleDuplicatePage,
        renamingPageId,
        handleCancelRenamePage
      }}
      menu={{
        contextMenu,
        contextMenuEntries,
        closeContextMenu,
        openCanvasContextMenu,
        openLayerContextMenu,
        openPageContextMenu
      }}
      mutate={mutateSelected}
      htmlImportProgress={htmlImportProgress}
      commentsOverlayProps={commentsOverlayProps}
      commentsPanelProps={commentsPanelProps}
      commentsOpen={tool.activeTool === "comment"}
      onRecover={handleRecover}
    />
);
}

render(<App />, document.getElementById("app")!);
