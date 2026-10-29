import { DesignDocument, DesignElement, Page, PathElement } from "../core/dsl/types";
import { useState, useEffect } from "preact/hooks";
import { collectComponents } from "../core/interactions/component-inventory";
import type { ViewportBox } from "../core/geometry/cull";
import { TITLE_BAR_HEIGHT } from "./toolbar/titlebar-layout";
import { t } from "../i18n";
import { AppNotices } from "./AppNotices";
import { FileMismatchDialog } from "./toolbar/FileMismatchDialog";
// The JSON door is `ImportJsonDialog` (it replaced `ReplaceFromJsonDialog`), and
import { ImportJsonDialog } from "./toolbar/ImportJsonDialog";
import { ImportProgressDialog } from "./toolbar/ImportProgressDialog";
import { HistoryPanel } from "./HistoryPanel";
import { MissingFontsDialog } from "./MissingFontsDialog";
import { LayerPanel } from "./LayerPanel";
import { CanvasArea } from "./canvas/CanvasArea";
import type { CommentsOverlayProps } from "./canvas/CommentsOverlay";
import type { CommentsPanelProps } from "./comments/CommentsPanel";
import { CommentsRail } from "./comments/CommentsRail";
import { ContextMenu } from "./context-menu/ContextMenu";
import { InspectorPanel } from "./inspector/InspectorPanel";
import { BottomToolbar } from "./toolbar/BottomToolbar";
import { PresentOverlay } from "./present/PresentOverlay";
import { TitleBar } from "./toolbar/TitleBar";
import { FloatingPluginPanel } from "./plugins/FloatingPluginPanel";
import { PluginBoundary } from "./plugins/PluginBoundary";
import { usePluginList } from "./plugins/usePluginList";
import { usePluginRuntime } from "./plugins/usePluginRuntime";
import { Button } from "./Button";
import { SegmentedControl } from "./SegmentedControl";
import { ColorField } from "./ColorField";
import { PAINT_SWATCH_CHECKER } from "./inspector/paint-row-style";
import { injectPluginStyles } from "../core/plugins/plugin-styles";
import { getLanguage } from "../i18n";
import { useUpdateStatus } from "./hooks/useUpdateStatus";
import { setImageCropTarget, useImageCropTarget } from "./hooks/image-crop-edit";
import { MutateContext, MutateSelected } from "./inspector/mutate-channel";
import type { AlignmentType } from "../core/interactions/alignment";
import type { BooleanOp } from "../core/geometry/boolean-ops";
import type { SmartSelectionInfo } from "../core/geometry/smart-selection";
import type { FramePreset } from "../core/frame-presets";
import type { useAssetInsertion } from "./hooks/useAssetInsertion";
import type { useHtmlImport, HtmlImportProgress } from "./hooks/useHtmlImport";
import type { useFigmaImport } from "./hooks/useFigmaImport";
import type { useComponentImport } from "./hooks/useComponentImport";
import type { useLayerRowActions } from "./hooks/useLayerRowActions";
import type { usePageManagement } from "./hooks/usePageManagement";
import type { useContextMenu } from "./context-menu/useContextMenu";
import type { useZoomCommands } from "./hooks/useZoomCommands";
import type { ToolState } from "./hooks/useToolState";
import type { useCanvasGestures } from "./hooks/useCanvasGestures";
import type { useInlineEditing } from "./hooks/useInlineEditing";
import type { useSmartSelectionGesture } from "./hooks/useSmartSelectionGesture";
import type { usePresentation } from "./present/usePresentation";
import type { useFileWriteback } from "./hooks/useFileWriteback";
import type { useDocumentJsonActions } from "./hooks/useDocumentJsonActions";
import type { useHint } from "./hooks/useHint";
import type { usePenEditing } from "./hooks/usePenEditing";

export interface EditorUiState {
  isUiVisible: boolean;
  is4Corners: boolean;
  setIs4Corners: (val: boolean) => void;
  /** The inspector is being used, so the canvas stands its chrome down. */
  overlayHidden: boolean;
  /** Whether the morph pairing lines are drawn. */
  morphLines: boolean;
  setMorphLines: (val: boolean) => void;
  /** Cmd/Ctrl held: a frame offers resize handles even while hugging. */
  frameResizeKey: boolean;
}

export interface EditorDocState {
  doc: DesignDocument;
  activePage: Page;
  allElements: DesignElement[];
  components: ReturnType<typeof collectComponents>;
  docRef: { current: DesignDocument };
  /** Asset id → how many places point at it; the assets panel counts orphans by it. */
  assetUsage: Map<string, number>;
  setDoc: (updater: DesignDocument | ((prev: DesignDocument) => DesignDocument)) => void;
  /** The path being edited, or null when no path is in edit mode. */
  editingPathElement: PathElement | null;
  commitSnapshot: (doc: DesignDocument) => void;
  startDragGesture: () => void;
  endDragGesture: () => void;
}

export interface EditorSelectionState {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  selectedElements: DesignElement[];
  primarySelected: DesignElement | null;
  multiBounds: { minX: number; minY: number; width: number; height: number } | null;
}

export interface EditorViewportState {
  canvasContainerRef: { current: HTMLDivElement | null };
  zoom: number;
  pan: { x: number; y: number };
  isCanvasPanning: boolean;
  isPanMode: boolean;
  handleWheel: (e: any) => void;
  viewportBox: ViewportBox | null;
  /** Top-left of a box at the centre of the unobstructed canvas — see `PluginHostContext`. */
  dropTopLeft: (size: { width: number; height: number }) => { x: number; y: number };
}

export interface EditorCommands {
  handleZoomIn: ReturnType<typeof useZoomCommands>["zoomIn"];
  handleZoomOut: ReturnType<typeof useZoomCommands>["zoomOut"];
  /** Fit the selection when there is one, else the whole page. */
  handleZoomFit: () => void;
  handleZoomActualSize: () => void;
  handleToggleSelectionLock: () => void;
  handleToggleSelectionVisibility: () => void;
  handleAlignment: (type: AlignmentType) => void;
  selectByColor: (ids: string[]) => void;
  handleBooleanAction: (op: BooleanOp) => void;
  handleLocateComponent: (componentId: string) => void;
  handleImportComponents: ReturnType<typeof useComponentImport>;
  handleCleanUnusedAssets: () => void;
  handleAssetInsert: ReturnType<typeof useAssetInsertion>["insertAsset"];
  handleAssetDropJson: ReturnType<typeof useAssetInsertion>["dropAssetJson"];
  handleEmbedAsset: ReturnType<typeof useAssetInsertion>["embedAsset"];
  handleInsertImage: ReturnType<typeof useAssetInsertion>["insertImageFile"];
  handleInsertImageUrl: ReturnType<typeof useAssetInsertion>["insertImageUrl"];
  handleInsertVideoUrl: ReturnType<typeof useAssetInsertion>["insertVideoUrl"];
  handleInsertHtmlUrl: ReturnType<typeof useAssetInsertion>["insertHtmlUrl"];
  handleInsertHtmlFile: ReturnType<typeof useAssetInsertion>["insertHtmlFile"];
  handleInsertHtmlCode: ReturnType<typeof useAssetInsertion>["insertHtmlCode"];
  handleImportHtmlFile: ReturnType<typeof useHtmlImport>["importHtmlFile"];
  /** Bitmaps a page named by relative path, waiting for the folder that holds them. */
  pendingAssets: ReturnType<typeof useHtmlImport>["pendingAssets"];
  handleAttachAssetFolder: ReturnType<typeof useHtmlImport>["attachAssetFolder"];
  handleDismissAssetFolder: ReturnType<typeof useHtmlImport>["dismissPendingAssets"];
  handleImportFigmaExport: ReturnType<typeof useFigmaImport>["importFigmaExport"];
  handleOnPathTextBounds: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  /** New page-level frame at a preset size, selected, with the tool returned to Move. */
  handleCreateFramePreset: (preset: FramePreset) => void;
}

export interface EditorLayerCommands {
  handleLayerReorder: ReturnType<typeof useLayerRowActions>["reorder"];
  handleLayerToggleVisibility: ReturnType<typeof useLayerRowActions>["toggleVisibility"];
  handleLayerToggleLock: ReturnType<typeof useLayerRowActions>["toggleLock"];
  handleLayerCommitRename: ReturnType<typeof useLayerRowActions>["commitRename"];
  handleLayerCancelRename: () => void;
}

export interface EditorPageCommands {
  handleSelectPage: ReturnType<typeof usePageManagement>["selectPage"];
  handleAddPage: ReturnType<typeof usePageManagement>["addPage"];
  handleStartRenamePage: (pageId: string) => void;
  handleRenamePage: ReturnType<typeof usePageManagement>["renamePage"];
  handleDeletePage: ReturnType<typeof usePageManagement>["deletePage"];
  handleDuplicatePage: ReturnType<typeof usePageManagement>["duplicatePage"];
  renamingPageId: string | null;
  handleCancelRenamePage: () => void;
}

export interface EditorContextMenuState {
  contextMenu: ReturnType<typeof useContextMenu>["contextMenu"];
  contextMenuEntries: ReturnType<typeof useContextMenu>["contextMenuEntries"];
  closeContextMenu: ReturnType<typeof useContextMenu>["closeContextMenu"];
  openCanvasContextMenu: ReturnType<typeof useContextMenu>["openCanvasContextMenu"];
  openLayerContextMenu: ReturnType<typeof useContextMenu>["openLayerContextMenu"];
  openPageContextMenu: ReturnType<typeof useContextMenu>["openPageContextMenu"];
}

export interface EditorShellProps {
  file: ReturnType<typeof useFileWriteback>;
  documentJson: ReturnType<typeof useDocumentJsonActions>;
  hint: ReturnType<typeof useHint>;
  ui: EditorUiState;
  docState: EditorDocState;
  selection: EditorSelectionState;
  viewport: EditorViewportState;
  gestures: ReturnType<typeof useCanvasGestures>;
  /** The gap/dot handles, plus the gestures that move them. */
  smart: ReturnType<typeof useSmartSelectionGesture> & { smartSelection: SmartSelectionInfo | null };
  inline: ReturnType<typeof useInlineEditing>;
  tool: ToolState;
  pen: ReturnType<typeof usePenEditing>;
  present: ReturnType<typeof usePresentation>;
  commands: EditorCommands;
  layers: EditorLayerCommands;
  pages: EditorPageCommands;
  menu: EditorContextMenuState;
  /** The inspector's write channel, stable for the lifetime of the app. */
  mutate: MutateSelected;
  htmlImportProgress?: HtmlImportProgress | null;
  commentsOverlayProps?: CommentsOverlayProps | null;
  commentsPanelProps?: CommentsPanelProps | null;
  /** The comment tool is armed: the rail shows the comment list. */
  commentsOpen?: boolean;
  /** Applies a recovered snapshot, comments included. */
  onRecover?: () => void;
}

/**
 * The editor's whole render tree.
 *
 * The window owns no state of its own: every value is handed in, so this file is
 * where a panel can be read against what feeds it and `App` stays a list of
 * wiring. `mutate` is provided here rather than threaded down because a dozen
 * inspector sections write through it and none of them needs to know where it
 * came from.
 */
export function EditorShell(p: EditorShellProps) {
  const { file, documentJson, hint, pen, tool, inline, present, mutate, gestures, htmlImportProgress } = p;
  const { isUiVisible, is4Corners, setIs4Corners, overlayHidden, morphLines, setMorphLines, frameResizeKey } = p.ui;
  // The pair row under the pointer: the list is in the inspector, the line is on
  // the canvas, and it changes twice per hover rather than per pointer move.
  const [hoverPairId, setHoverPairId] = useState<string | null>(null);
  const {
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
  } = p.docState;
  // One hook for the whole shell: the title bar's badge, the panel, and the
  // notice that announces a launch find are three readers of the same check.
  const updates = useUpdateStatus(doc);
  const { selectedIds, setSelectedIds, selectedElements, primarySelected, multiBounds } = p.selection;

  /*
    Crop mode is a mode over one layer, so it cannot outlive that layer's
    selection. Clearing it here rather than in each exit path is what makes every
    way out — a click on empty canvas, a pick in the layer list, a marquee, a
    delete, a page switch — the same way out, including the ones that will be
    added later. The row's own flip side lives in `FillSection`.
  */
  const cropTarget = useImageCropTarget();
  useEffect(() => {
    if (cropTarget && cropTarget.elId !== primarySelected?.id) setImageCropTarget(null);
  }, [cropTarget, primarySelected?.id]);

  const {
    canvasContainerRef,
    zoom,
    pan,
    isCanvasPanning,
    isPanMode,
    handleWheel,
    viewportBox,
    dropTopLeft
  } = p.viewport;
  const {
    dragOverFrameId,
    dropSlot,
    activeGuides,
    marqueeRect,
    shapeDraft,
    measurement,
    hoverSelectId,
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    handleCanvasClick,
    handleElementMouseDown,
    handleResizePointerDown,
    handleMultiResizePointerDown,
    handleRotatePointerDown,
    handleLineEndpointPointerDown,
    handleRadiusPointerDown,
    handleStartOffsetPointerDown,
    handleGradientHandlePointerDown
  } = p.gestures;
  const {
    smartSelection,
    isSmartDragActive,
    isGapDragActive,
    swapDropBox,
    handleGapDragStart,
    handleTidySpacing,
    handleDotDragStart
  } = p.smart;
  const {
    handleZoomIn,
    handleZoomOut,
    handleZoomFit,
    handleZoomActualSize,
    handleToggleSelectionLock,
    handleToggleSelectionVisibility,
    handleAlignment,
    selectByColor,
    handleBooleanAction,
    handleLocateComponent,
    handleImportComponents,
    handleCleanUnusedAssets,
    handleAssetInsert,
    handleAssetDropJson,
    handleEmbedAsset,
    handleInsertImage,
    handleInsertImageUrl,
    handleInsertVideoUrl,
    handleInsertHtmlUrl,
    handleInsertHtmlFile,
    handleInsertHtmlCode,
    handleOnPathTextBounds,
    handleCreateFramePreset
  } = p.commands;
  const {
    handleLayerReorder,
    handleLayerToggleVisibility,
    handleLayerToggleLock,
    handleLayerCommitRename,
    handleLayerCancelRename
  } = p.layers;
  const {
    handleSelectPage,
    handleAddPage,
    handleStartRenamePage,
    handleRenamePage,
    handleDeletePage,
    handleDuplicatePage,
    renamingPageId,
    handleCancelRenamePage
  } = p.pages;
  const {
    contextMenu,
    contextMenuEntries,
    closeContextMenu,
    openCanvasContextMenu,
    openLayerContextMenu,
    openPageContextMenu
  } = p.menu;

  const [activePluginId, setActivePluginId] = useState<string | null>(null);
  const commentsMode = Boolean(p.commentsOpen && p.commentsPanelProps);
  // Called unconditionally: the panel is either idle or loading, never "no hook".
  const pluginRuntime = usePluginRuntime(activePluginId);
  const installedPlugins = usePluginList();
  // Removing a plugin must take its panel with it: the row is gone from the list,
  // and a window that is still open over a plugin the user just uninstalled reads
  // as "it did not work".
  useEffect(() => {
    if (!activePluginId || !installedPlugins.ready) return;
    if (!installedPlugins.items.some((m) => m.id === activePluginId)) setActivePluginId(null);
  }, [installedPlugins, activePluginId]);

  return (
    <MutateContext.Provider value={mutate}>
      {/* No `font-sans` on the shell root. It was here, and one class on one
          element decided the voice for every component below it — a direct
          declaration at the top of the tree that no `text-*` token and no theme
          change could argue with, which is why the two-family split in
          DESIGN.md §Typography never survived contact with the app. The root
          now inherits the shell's voice (monospace, set on `html` in
          `src/style.css`); anything that needs the humanist stack opts in with
          `font-sans` where it is reviewable. */}
      <div className="relative h-screen w-screen bg-paper text-ink overflow-hidden select-none">
        <TitleBar
          hidden={!isUiVisible}
          docName={file.writebackTarget ?? file.openedDocName ?? null}
          autosaveStatus={file.autosaveStatus}
          saveStatus={file.saveStatus}
          showActivateAutosave={file.showActivateAutosave}
          writebackTarget={file.writebackTarget}
          openedName={file.openedName}
          filePath={file.filePath}
          fileDirectory={file.fileDirectory}
          savedAsCopyOf={file.savedAsCopyOf}
          otherTabActive={file.otherTabActive}
          onActivateAutosave={file.activateAutosave}
          onSave={file.triggerSave}
          onSaveAs={file.triggerSaveAs}
          onNewFile={file.triggerNewFile}
          onOpenHistory={file.openHistory}
          onExportJson={documentJson.exportJson}
          onImportJson={documentJson.openImport}
          onImportFromFile={documentJson.importFromFile}
          canUseFilePicker={documentJson.canUseFilePicker}
          onPresent={present.start}
          zoom={zoom}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onZoomFit={handleZoomFit}
          onZoomActualSize={handleZoomActualSize}
          updates={updates}
        />

        {/* Top-center notices: critical recovery, load corrupt alerts, and toast hints */}
        <AppNotices
          pendingRecovery={file.pendingRecovery}
          onRecover={p.onRecover}
          openedName={file.openedName}
          loadFailed={file.loadFailed}
          hintMessage={hint.hintMessage}
          onHintDismiss={hint.dismissHint}
          busyMessage={hint.busyMessage}
          historyOpen={file.showHistory}
          pendingAssets={p.commands.pendingAssets}
          onAttachAssetFolder={p.commands.handleAttachAssetFolder}
          onDismissAssetFolder={p.commands.handleDismissAssetFolder}
          commitSnapshot={commitSnapshot}
          setPendingRecovery={file.setPendingRecovery}
          controllerRef={file.controllerRef}
        />

        {/* Wrong file picked warning dialog */}
        {file.pickMismatch && (
          <FileMismatchDialog
            reason={file.pickMismatch.reason}
            openedName={file.openedName}
            filePath={file.filePath}
            fileDirectory={file.fileDirectory}
            onDismiss={file.dismissPickMismatch}
            /* Deliberately NOT dismissed before the retry: unmounting the dialog
               while the native picker is being created leaves macOS without a
               key window and greys out the whole list. `activateAutosave` closes
               it on success and replaces the reason on a second failure. */
            onRetry={() => {
              void file.activateAutosave();
            }}
          />
        )}


        {documentJson.pendingImport && (
          <ImportJsonDialog
            picked={documentJson.pendingImport}
            writebackTarget={file.writebackTarget}
            onDismiss={documentJson.closeImport}
            onReplace={() => documentJson.replaceWith(documentJson.pendingImport!.doc)}
            onMerge={() => documentJson.mergeWith(documentJson.pendingImport!.doc)}
          />
        )}

        {htmlImportProgress && (
          <ImportProgressDialog
            name={htmlImportProgress.name}
            stage={htmlImportProgress.stage}
            percent={htmlImportProgress.percent}
            onCancel={htmlImportProgress.onCancel}
          />
        )}

        {/* Outside every dock, like the other dialogs: it is the answer to a
            gesture, not a place to keep things. Mounted unconditionally and
            returns null while closed, because the gate that opens it lives in
            a hook several levels below this tree. */}
        <MissingFontsDialog doc={doc} commitSnapshot={commitSnapshot} selectedIds={selectedIds} />

        {file.showHistory && (
          <HistoryPanel versions={file.versions}
            hidden={!isUiVisible}
            previewingId={file.previewingId}
            onPreview={file.previewVersion}
            onExitPreview={file.exitPreview}
            onClose={file.closeHistory}
            // History mode ends with the restore it performed: the panel being
            // open would keep the document read-only, and a restore whose
            // images are gone leaves it where it was, so the panel stays put.
            onRestore={(id) =>
              void file.controllerRef.current?.restoreVersion(id).then((ok) => {
                if (!ok) return;
                file.closeHistory();
                hint.showHint(t("history.restoreDone"));
              })
            }
            onName={(id, label) => file.controllerRef.current?.nameVersion(id, label)}
            onDelete={(id) => file.controllerRef.current?.deleteVersion(id)}
            onExport={(id) => file.controllerRef.current?.exportVersion(id)}
          />
        )}

        <LayerPanel
          hidden={!isUiVisible}
          elements={activePage.children}
          totalCount={allElements.length}
          selectedIds={selectedIds}
          primarySelectedId={primarySelected?.id}
          onSelect={setSelectedIds}
          onReorder={handleLayerReorder}
          onToggleVisibility={handleLayerToggleVisibility}
          onToggleLock={handleLayerToggleLock}
          renamingId={inline.renamingId}
          onStartRename={inline.handleLayerStartRename}
          onCommitRename={handleLayerCommitRename}
          onCancelRename={handleLayerCancelRename}
          pages={doc.pages}
          activePageId={doc.activePageId}
          onSelectPage={handleSelectPage}
          onAddPage={handleAddPage}
          onStartRenamePage={handleStartRenamePage}
          onRenamePage={handleRenamePage}
          onDeletePage={handleDeletePage}
          onDuplicatePage={handleDuplicatePage}
          onPageContextMenu={openPageContextMenu}
          renamingPageId={renamingPageId}
          onCancelRenamePage={handleCancelRenamePage}
          assets={doc.assets || []}
          components={components}
          docRef={docRef}
          assetUsage={assetUsage}
          onAssetInsert={handleAssetInsert}
          onSelectComponent={handleLocateComponent}
          onImportComponents={handleImportComponents}
          onCleanUnusedAssets={handleCleanUnusedAssets}
          onRowContextMenu={openLayerContextMenu}
          onEmbedAsset={handleEmbedAsset}
        />

        <CanvasArea
          presentActive={present.active}
          canvasContainerRef={canvasContainerRef}
          doc={doc}
          allElements={allElements}
          docRef={docRef}
          zoom={zoom}
          pan={pan}
          isCanvasPanning={isCanvasPanning}
          isPanMode={isPanMode}
          activeTool={tool.activeTool}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          selectedElements={selectedElements}
          primarySelected={primarySelected || null}
          multiBounds={multiBounds}
          activeGuides={activeGuides}
          marqueeRect={marqueeRect}
          shapeDraft={shapeDraft}
          measurement={measurement}
          smartSelection={smartSelection}
          isSmartDragActive={isSmartDragActive}
          isGapDragActive={isGapDragActive}
          overlaySuppressed={overlayHidden}
          showMorphLines={morphLines}
          morphHighlightId={hoverPairId}
          swapDropBox={swapDropBox}
          onGapDragStart={handleGapDragStart}
          onTidySpacing={handleTidySpacing}
          onDotDragStart={handleDotDragStart}
          viewportBox={viewportBox}
          editingPathElement={editingPathElement}
          selectedAnchorIdxs={inline.selectedAnchorIdxs}
          onSelectOnlyAnchor={inline.selectOnlyAnchor}
          onToggleAnchor={inline.toggleAnchor}
          onCommitPathEdit={inline.commitPathEdit}
          onPathDragStart={startDragGesture}
          onPathDragChange={inline.commitPathEditTransient}
          onExitPathEdit={inline.exitPathEdit}
          onFinishPenDraft={pen.finishDraft}
          onCancelPenDraft={pen.cancelDraft}
          penMode={pen.penMode}
          penTargets={pen.targets}
          onEditPenPath={pen.editPath}
          onExitPen={pen.cancelDraft}
          dragOverFrameId={dragOverFrameId}
          hoverSelectId={hoverSelectId}
          dropSlot={dropSlot}
          editingCanvasTextId={inline.editingCanvasTextId}
          canvasTextDraft={inline.canvasTextDraft}
          setCanvasTextDraft={inline.changeCanvasTextDraft}
          canvasTextInputRef={inline.canvasTextInputRef}
          onCanvasMouseDown={handleCanvasMouseDown}
          onCanvasMouseMove={handleCanvasMouseMove}
          onWheel={handleWheel}
          onCanvasClick={handleCanvasClick}
          onElementMouseDown={handleElementMouseDown}
          onResizePointerDown={handleResizePointerDown}
          onMultiResizePointerDown={handleMultiResizePointerDown}
          onRotatePointerDown={handleRotatePointerDown}
          onEndpointPointerDown={handleLineEndpointPointerDown}
          onRadiusPointerDown={handleRadiusPointerDown}
          onStartCanvasTextEdit={inline.startCanvasTextEdit}
          onTextSelect={inline.reportCanvasTextSelection}
          onCommitCanvasText={inline.commitCanvasText}
          onCancelCanvasText={inline.cancelCanvasText}
          onOnPathTextBounds={handleOnPathTextBounds}
          onStartOffsetPointerDown={handleStartOffsetPointerDown}
          onGradientHandlePointerDown={handleGradientHandlePointerDown}
          onCropMovePointerDown={gestures.handleCropMovePointerDown}
          onCropHandlePointerDown={gestures.handleCropHandlePointerDown}
          onCropRotatePointerDown={gestures.handleCropRotatePointerDown}
          onInsertImage={handleInsertImage}
          onAssetDrop={handleAssetDropJson}
          frameResizeKey={frameResizeKey}
          onContextMenu={openCanvasContextMenu}
          commentsOverlayProps={p.commentsOverlayProps}
        />

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            entries={contextMenuEntries}
            onClose={closeContextMenu}
          />
        )}

        {/* Comment mode owns the right rail: the two are the same 288px plate on
            the same edge, so the inspector slides out and the comment list
            slides in. Both stay mounted — the inspector is expensive to rebuild
            and a comment is not a reason to forget its fold state. */}
        <InspectorPanel
          hidden={!isUiVisible || commentsMode}
          doc={doc}
          setDoc={setDoc}
          docRef={docRef}
          selectedElements={selectedElements}
          primarySelected={primarySelected || null}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          multiBounds={multiBounds}
          is4Corners={is4Corners}
          onToggle4Corners={setIs4Corners}
          showMorphLines={morphLines}
          onToggleMorphLines={setMorphLines}
          onHoverMorphPair={setHoverPairId}
          onToggleLock={handleToggleSelectionLock}
          onToggleVisibility={handleToggleSelectionVisibility}
          onAlign={handleAlignment}
          onSelectByColor={selectByColor}
          isScaleToolActive={tool.isScaleTool}
          isFrameToolActive={tool.activeTool === "frame"}
          onCreateFramePreset={handleCreateFramePreset}
          scaleAnchor={tool.scaleTool.anchor}
          onScaleAnchorChange={tool.scaleTool.setAnchor}
          scaleReference={tool.scaleTool.reference}
          onLeaveScaleTool={tool.scaleTool.leave}
          onBooleanAction={handleBooleanAction}
          penMode={pen.penMode}
          onPenModeChange={pen.setPenMode}
          onCommitSnapshot={commitSnapshot}
          onLocateComponent={handleLocateComponent}
          onHint={hint.showHint}
          onDragStart={startDragGesture}
          onDragEnd={endDragGesture}
          canvasContainerRef={canvasContainerRef}
          editingPathElement={editingPathElement}
          selectedAnchorIdxs={inline.selectedAnchorIdxs}
          onSelectOnlyAnchor={inline.selectOnlyAnchor}
          onCommitPathEdit={inline.commitPathEdit}
          onCommitPathTransient={inline.commitPathEditTransient}
          onExitPathEdit={inline.exitPathEdit}
          activeTextSelection={inline.activeTextSelection}
        />

        {commentsMode && p.commentsPanelProps && (
          <CommentsRail
            {...p.commentsPanelProps}
            hidden={!isUiVisible}
            onExit={() => p.tool.setActiveTool("select")}
          />
        )}

        {/* The toolbar's URL handlers pass `(url, signal)`; the hook takes
            `(url, worldX, worldY, signal)`. Passing one straight through binds
            the signal to `worldX`, so the popover's cancel never reaches the
            loader. */}
        <BottomToolbar
          hidden={!isUiVisible || file.showHistory}
          activeTool={tool.activeTool}
          setActiveTool={tool.setActiveTool}
          currentNavTool={tool.currentNavTool}
          setCurrentNavTool={tool.setCurrentNavTool}
          currentShapeTool={tool.currentShapeTool}
          setCurrentShapeTool={tool.setCurrentShapeTool}
          isCanvasPanning={isCanvasPanning}
          setHintMessage={hint.setHintMessage}
          onImageFileSelect={handleInsertImage}
          onImageUrlSelect={(url, signal) => handleInsertImageUrl(url, undefined, undefined, signal)}
          onVideoFileSelect={handleInsertImage}
          onVideoUrlSelect={(url, signal) => handleInsertVideoUrl(url, undefined, undefined, signal)}
          onHtmlFileSelect={handleInsertHtmlFile}
          onHtmlUrlSelect={(url) => handleInsertHtmlUrl(url, undefined, undefined)}
          onHtmlCodeSelect={(code) => handleInsertHtmlCode(code, undefined, undefined)}
          onHtmlImportSelect={p.commands.handleImportHtmlFile}
          onFigmaImportSelect={p.commands.handleImportFigmaExport}
          onSetScaleTool={tool.scaleTool.toggle}
          onOpenPlugin={(pluginId) => setActivePluginId(pluginId)}
          onExitPathEdit={inline.exitPathEdit}
        />

        {(() => {
          // The panel can exist before the plugin can: opening one reads bytes
          // from storage and evaluates a module, so "loading" and "failed" are
          // states of the panel rather than reasons to render nothing. The name
          // arrives with the signed manifest, which is inside the load.
          if (pluginRuntime.status === "idle") return null;
          const manifest = pluginRuntime.status === "ready" ? pluginRuntime.manifest : null;

          const pluginContext = {
            ui: {
              Button,
              SegmentedControl,
              ColorField,
              checkerboardStyle: PAINT_SWATCH_CHECKER,
              injectStyles: injectPluginStyles
            },
            docRef,
            primarySelected: primarySelected || null,
            commitSnapshot,
            notify: hint.showHint,
            locale: getLanguage(),
            dropTopLeft
          };

          return (
            <FloatingPluginPanel
              pluginId={activePluginId ?? undefined}
              title={manifest?.name ?? t("plugins.loading")}
              onClose={() => setActivePluginId(null)}
              width={manifest?.width}
              height={manifest?.height}
              minWidth={manifest?.minWidth}
              minHeight={manifest?.minHeight}
              resize={manifest?.resize ?? "none"}
              attribution={manifest?.attribution}
            >
              {pluginRuntime.status === "ready" ? (
                <PluginBoundary message={t("plugins.crashed")}>
                  <pluginRuntime.mod.Component context={pluginContext} />
                </PluginBoundary>
              ) : pluginRuntime.status === "error" ? (
                <div className="p-3 flex flex-col gap-1 font-sans">
                  <div className="text-ui text-ink">{t("plugins.failed")}</div>
                  <div className="text-micro text-ink-muted break-words">{pluginRuntime.error}</div>
                </div>
              ) : (
                <div className="p-3 text-ui text-ink-muted font-sans">{t("plugins.loading")}</div>
              )}
            </FloatingPluginPanel>
          );
        })()}

        {present.active && (
          <PresentOverlay
            frame={present.frame}
            index={present.index}
            total={present.total}
            transition={present.transition}
            allElements={allElements}
            docRef={docRef}
            onExit={present.keys.exit}
            onNext={present.keys.next}
            onPrev={present.keys.prev}
          />
        )}

      </div>
    </MutateContext.Provider>
  );
}
