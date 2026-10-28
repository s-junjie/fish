import { DesignElement, Page } from "../../core/dsl/types";

export interface LayerPanelBaseProps {
  hidden?: boolean;
  elements: DesignElement[];
  totalCount: number;
  selectedIds: Set<string>;
  primarySelectedId?: string | null;
  onSelect: (ids: Set<string>) => void;
  onReorder: (sourceIds: string[], targetId: string, position: "before" | "after" | "inside") => void;
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
  onPageContextMenu?: (e: any, page: any) => void;
  renamingPageId?: string | null;
  onCancelRenamePage?: () => void;
  assets?: any[];
  components?: any[];
  docRef?: { current: any };
  assetUsage?: Map<string, number>;
  onAssetInsert?: (payload: any, worldX?: number, worldY?: number) => void;
  onSelectComponent?: (componentId: string) => void;
  onImportComponents?: (file: File) => void;
  onCleanUnusedAssets?: () => void;
  onRowContextMenu?: (e: any, layerId: string) => void;
  onEmbedAsset?: (assetId: string) => Promise<void> | void;
}

export function pagesEqual(a?: Page[], b?: Page[]): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name) return false;
  }
  return true;
}

// The layer tree only paints identity, name, visibility, mask flag, lock flag,
// link presence, the two mode badges and layout icon — never geometry or paint.
// Comparing just those fields lets a canvas drag (x/y churn) skip the whole
// recursive tree rebuild, which otherwise costs ~12µs per element per frame.
export function layerTreeEqual(a: DesignElement[], b: DesignElement[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (
      x.id !== y.id ||
      x.type !== y.type ||
      x.name !== y.name ||
      (x.visible === false) !== (y.visible === false) ||
      (x.isMask === true) !== (y.isMask === true) ||
      (x.locked === true) !== (y.locked === true) ||
      (x.link ?? "") !== (y.link ?? "") ||
      x.themeMode !== y.themeMode ||
      x.numberMode !== y.numberMode
    ) {
      return false;
    }
    // `componentSet` is in the list because it nests, and the collapse flag has to
    // reach the panel: collapsing changes what the panel shows without changing any
    // row's own identity.
    if (
      x.type === "frame" || y.type === "frame" ||
      x.type === "component" || y.type === "component" ||
      x.type === "componentSet" || y.type === "componentSet"
    ) {
      const xFrame = x as any;
      const yFrame = y as any;
      if (Boolean(xFrame.collapsed) !== Boolean(yFrame.collapsed)) return false;
      if ((xFrame.layout?.mode ?? null) !== (yFrame.layout?.mode ?? null)) return false;
      if ((xFrame.layout?.direction ?? null) !== (yFrame.layout?.direction ?? null)) return false;
      if (!layerTreeEqual(xFrame.children || [], yFrame.children || [])) return false;
    }
  }
  return true;
}

export function layerPanelPropsEqual(prev: LayerPanelBaseProps, next: LayerPanelBaseProps): boolean {
  if (
    prev.hidden !== next.hidden ||
    prev.activePageId !== next.activePageId ||
    !pagesEqual(prev.pages, next.pages) ||
    prev.totalCount !== next.totalCount ||
    prev.selectedIds !== next.selectedIds ||
    prev.primarySelectedId !== next.primarySelectedId ||
    prev.renamingId !== next.renamingId ||
    prev.onSelect !== next.onSelect ||
    prev.onReorder !== next.onReorder ||
    prev.onToggleVisibility !== next.onToggleVisibility ||
    prev.onToggleLock !== next.onToggleLock ||
    prev.onStartRename !== next.onStartRename ||
    prev.onCommitRename !== next.onCommitRename ||
    prev.onCancelRename !== next.onCancelRename ||
    prev.onSelectPage !== next.onSelectPage ||
    prev.onAddPage !== next.onAddPage ||
    prev.onStartRenamePage !== next.onStartRenamePage ||
    prev.onRenamePage !== next.onRenamePage ||
    prev.onDeletePage !== next.onDeletePage ||
    prev.onDuplicatePage !== next.onDuplicatePage ||
    prev.onPageContextMenu !== next.onPageContextMenu ||
    prev.renamingPageId !== next.renamingPageId ||
    prev.onCancelRenamePage !== next.onCancelRenamePage ||
    prev.assets !== next.assets ||
    prev.components !== next.components ||
    prev.assetUsage !== next.assetUsage ||
    prev.onAssetInsert !== next.onAssetInsert ||
    prev.onSelectComponent !== next.onSelectComponent ||
    prev.onImportComponents !== next.onImportComponents ||
    prev.onCleanUnusedAssets !== next.onCleanUnusedAssets ||
    prev.onRowContextMenu !== next.onRowContextMenu ||
    prev.onEmbedAsset !== next.onEmbedAsset
  ) {
    return false;
  }
  return layerTreeEqual(prev.elements, next.elements);
}
