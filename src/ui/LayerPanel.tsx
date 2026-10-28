import { useState, useRef, useEffect, useMemo, useCallback } from "preact/hooks";
import { memo } from "./memo";
import { DesignElement, Page, DesignDocument } from "../core/dsl/types";
import { flattenElements } from "../core/geometry/tree-ops";
import { ancestorChain } from "../core/interactions/component-swap";
import { hasRows } from "./layers/instance-rows";
import { TITLE_BAR_HEIGHT } from "./toolbar/titlebar-layout";
import { AssetsPanel } from "./AssetsPanel";
import { PageSection } from "./layers/PageSection";
import { LayerTree, LayerDropPosition } from "./layers/LayerTree";
import { RailSectionHeader } from "./layers/RailSectionHeader";
import { Button } from "./Button";
import { CornerLeftUp, ListChevronsDownUp, ListChevronsUpDown } from "lucide-react";
import { tabClass } from "./panel-tabs-style";
import { layerPanelPropsEqual } from "./layers/layer-tree-equality";
import { t } from "../i18n";
import type { AssetInsertPayload } from "../core/plugins/types";
import type { AssetRef } from "../core/dsl/types";
import type { ComponentEntry } from "../core/interactions/component-inventory";

export { layerPanelPropsEqual, layerTreeEqual } from "./layers/layer-tree-equality";

const DEFAULT_PANEL_WIDTH = 280;
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 500;
const STORAGE_KEY = "fish_layer_panel_width_v2";

export interface LayerPanelProps {
  hidden?: boolean;
  elements: DesignElement[];
  totalCount: number;
  selectedIds: Set<string>;
  primarySelectedId?: string | null;
  onSelect: (ids: Set<string>) => void;
  onReorder: (sourceIds: string[], targetId: string, position: LayerDropPosition) => void;
  onToggleVisibility: (id: string, nextVisible: boolean) => void;
  onToggleLock: (id: string, nextLocked: boolean) => void;
  renamingId: string | null;
  onStartRename?: (id: string) => void;
  onCommitRename: (id: string, newName: string) => void;
  onCancelRename: () => void;
  pages?: Page[];
  activePageId?: string;
  onSelectPage?: (pageId: string) => void;
  onAddPage?: () => void;
  onStartRenamePage?: (pageId: string) => void;
  onRenamePage?: (pageId: string, newName: string) => void;
  onDeletePage?: (pageId: string) => void;
  onDuplicatePage?: (pageId: string) => void;
  onPageContextMenu?: (e: MouseEvent, page: Page) => void;
  renamingPageId?: string | null;
  onCancelRenamePage?: () => void;
  assets?: AssetRef[];
  components?: ComponentEntry[];
  docRef?: { current: DesignDocument };
  /** Asset id → how many places point at it; the assets panel's usage counts. */
  assetUsage?: Map<string, number>;
  onAssetInsert?: (payload: AssetInsertPayload, worldX?: number, worldY?: number) => void;
  onSelectComponent?: (componentId: string) => void;
  onImportComponents?: (file: File) => void;
  onCleanUnusedAssets?: () => void;
  onRowContextMenu?: (e: any, layerId: string) => void;
  onEmbedAsset?: (assetId: string) => Promise<void> | void;
}

export const LayerPanel = memo(LayerPanelBase, layerPanelPropsEqual);

function LayerPanelBase({
  hidden = false,
  elements,
  selectedIds,
  primarySelectedId,
  onSelect,
  onReorder,
  onToggleVisibility,
  onToggleLock,
  renamingId,
  onStartRename,
  onCommitRename,
  onCancelRename,
  pages,
  activePageId,
  onSelectPage,
  onAddPage,
  onStartRenamePage,
  onRenamePage,
  onDeletePage,
  onDuplicatePage,
  onPageContextMenu,
  renamingPageId,
  onCancelRenamePage,
  assets = [],
  components = [],
  docRef,
  assetUsage,
  onAssetInsert,
  onSelectComponent,
  onImportComponents,
  onCleanUnusedAssets,
  onRowContextMenu,
  onEmbedAsset
}: LayerPanelProps) {
  const [activeTab, setActiveTab] = useState<"layers" | "assets">("layers");
  /* Not persisted, matching the Pages band: both collapse states are session
     affordances, and a remembered "collapsed" would look like an empty panel
     on the next open with no obvious way back. */
  const [isLayersCollapsed, setIsLayersCollapsed] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [expandedInstances, setExpandedInstances] = useState<Set<string>>(new Set());

  // Find all container/instance layer ids that have children/rows and can be collapsed
  const collapsibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const el of flattenElements(elements)) {
      if (hasRows(docRef?.current, el)) {
        ids.push(el.id);
      }
    }
    return ids;
  }, [elements, docRef]);

  // If every collapsible layer is currently collapsed, the next action is expand all
  const isAllCollapsed = useMemo(() => {
    if (collapsibleIds.length === 0) return false;
    return collapsibleIds.every((id) => collapsedIds.has(id) || !expandedInstances.has(id));
  }, [collapsibleIds, collapsedIds, expandedInstances]);

  const selectedParent = useMemo(() => {
    if (!primarySelectedId || !docRef) return null;
    const chain = ancestorChain(docRef.current, primarySelectedId);
    return chain.length > 1 ? chain[chain.length - 2] : null;
  }, [primarySelectedId, docRef, elements]);

  const handleSelectParent = () => {
    if (selectedParent) onSelect(new Set([selectedParent.id]));
  };

  const handleToggleAllLayers = useCallback(() => {
    if (isAllCollapsed) {
      // Expand all: clear collapsedIds for frames, expand instances
      setCollapsedIds(new Set());
      setExpandedInstances(new Set(collapsibleIds));
    } else {
      // Collapse all: add all collapsible frame/container ids to collapsedIds, clear expandedInstances
      setCollapsedIds(new Set(collapsibleIds));
      setExpandedInstances(new Set());
    }
  }, [isAllCollapsed, collapsibleIds]);

  const [width, setWidth] = useState<number>(() => {
    try {
      const val = window.localStorage?.getItem(STORAGE_KEY);
      if (val) {
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed) && parsed >= MIN_PANEL_WIDTH && parsed <= MAX_PANEL_WIDTH) {
          return parsed;
        }
      }
    } catch {
      // ignore in sandboxed environments without allow-same-origin
    }
    return DEFAULT_PANEL_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    try {
      window.localStorage?.setItem(STORAGE_KEY, String(width));
    } catch {
      // ignore in sandboxed environments without allow-same-origin
    }
  }, [width]);

  useEffect(() => {
    if (!isResizing) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isResizing]);

  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const nextWidth = Math.min(Math.max(startWidth + deltaX, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH);
      setWidth(nextWidth);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      setIsResizing(false);
    };

    setIsResizing(true);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleResetWidth = () => {
    setWidth(DEFAULT_PANEL_WIDTH);
  };

  return (
    <div
      data-ui-panel="left"
      style={{ width: `${width}px`, top: TITLE_BAR_HEIGHT }}
      className={`absolute left-0 bottom-0 bg-panel border-r border-rule flex flex-col z-20 shrink-0 select-none transition-transform duration-slide ease-slide ${hidden ? "-translate-x-full" : "translate-x-0"
        }`}
    >
      {/* The tab strip carries `pl-1.5` and each tab `px-1.5`, which adds up to
          the same 12px gutter the rows and section labels start on — so the
          active tab's wash is inset off the panel edge without moving its
          label off the rail's alignment. `pt-2` keeps the wash off the top
          edge too: the tab is a raised block sitting ON the rule, not a
          full-height cell. */}
      <div className="h-10 border-b border-rule flex items-stretch gap-1 pt-2 pl-1.5 shrink-0 bg-panel">
        <button
          type="button"
          data-testid="panel-tab-layers"
          onClick={() => setActiveTab("layers")}
          title={t("layers.title")}
          className={tabClass(activeTab === "layers")}
        >
          {t("layers.title")}
        </button>
        <button
          type="button"
          data-testid="panel-tab-assets"
          onClick={() => setActiveTab("assets")}
          title={t("assets.tab")}
          className={tabClass(activeTab === "assets")}
        >
          {t("assets.tab")}
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === "assets" ? (
          <AssetsPanel
            assets={assets}
            components={components}
            docRef={docRef as { current: DesignDocument }}
            usage={assetUsage}
            onInsert={onAssetInsert}
            onLocateComponent={onSelectComponent}
            onImportComponents={onImportComponents}
            onCleanUnused={onCleanUnusedAssets}
          />
        ) : (
          <>
            {pages && pages.length > 0 && (
              <PageSection
                pages={pages}
                activePageId={activePageId}
                onSelectPage={onSelectPage}
                onAddPage={onAddPage}
                onStartRenamePage={onStartRenamePage}
                onRenamePage={onRenamePage}
                onDeletePage={onDeletePage}
                onDuplicatePage={onDuplicatePage}
                onPageContextMenu={onPageContextMenu}
                renamingPageId={renamingPageId}
                onCancelRenamePage={onCancelRenamePage}
              />
            )}
            {/* The layer list gets the same labelled, collapsible band the
                pages list has, so the two sections read as peers rather than
                as "a list and a remainder". Outside the scroller, so it stays
                put while the tree scrolls under it. */}
            <RailSectionHeader
              label={t("layers.title")}
              collapsed={isLayersCollapsed}
              onToggle={() => setIsLayersCollapsed((prev) => !prev)}
              trailing={
                <div className="flex items-center gap-0.5">
                  <Button
                    size="icon"
                    type="button"
                    data-layer-select-parent="true"
                    onClick={handleSelectParent}
                    disabled={!selectedParent}
                    title={t("layers.selectParent")}
                    aria-label={t("layers.selectParent")}
                  >
                    <CornerLeftUp size={13} />
                  </Button>
                  {collapsibleIds.length > 0 && (
                    <Button
                      size="icon"
                      type="button"
                      onClick={handleToggleAllLayers}
                      title={isAllCollapsed ? t("layers.expandAll") : t("layers.collapseAll")}
                    >
                      {isAllCollapsed ? <ListChevronsUpDown size={13} /> : <ListChevronsDownUp size={13} />}
                    </Button>
                  )}
                </div>
              }
            />
            {!isLayersCollapsed && (
              <LayerTree
                elements={elements}
                selectedIds={selectedIds}
                primarySelectedId={primarySelectedId}
                onSelect={onSelect}
                onReorder={onReorder}
                onToggleVisibility={onToggleVisibility}
                onToggleLock={onToggleLock}
                renamingId={renamingId}
                onStartRename={onStartRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
                docRef={docRef}
                onRowContextMenu={onRowContextMenu}
                onEmbedAsset={onEmbedAsset}
                collapsedIds={collapsedIds}
                setCollapsedIds={setCollapsedIds}
                expandedInstances={expandedInstances}
                setExpandedInstances={setExpandedInstances}
              />
            )}
          </>
        )}
      </div>

      {/* Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={handleResizeStart}
        onDblClick={handleResetWidth}
        title={t("layers.resizeTip")}
        className="absolute top-0 -right-1 w-2.5 h-full cursor-col-resize z-20 group flex justify-center items-center"
      >
        <div
          className={`w-[2px] h-full transition-colors ${isResizing ? "bg-brand" : "group-hover:bg-brand/70"
            }`}
        />
      </div>

      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none pointer-events-none" />
      )}
    </div>
  );
}
