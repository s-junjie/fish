import { useState, useRef, useEffect, useMemo, useCallback, StateUpdater, Dispatch } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { DesignElement, DesignDocument, PaintStack } from "../../core/dsl/types";
import { firstImagePaint } from "../../core/dsl/image-fill";
import { findElementById, findParentById, flattenElements, isContainer } from "../../core/geometry/tree-ops";
import { isDerivedNode } from "../../core/interactions/component-inventory";
import { resolveInstanceSelection } from "../../core/interactions/instance-resolve";
import { layerRangeSelection, visibleLayerRowIds } from "./range-select";
import { derivedRowPath, hasRows, layerRowsOf } from "./instance-rows";
import { rowOrderOf } from "./row-order";
import {
  collapsedRunHeight,
  LAYER_LIST_PADDING,
  LAYER_ROW_GAP_NESTED,
  LAYER_ROW_GAP_ROOT,
  LAYER_ROW_HEIGHT,
  PlannedRow,
  planRows,
  rowIsVisible,
  selectedSubtreeIds,
  visibleRowWindow
} from "./row-window";
import { LayerRow, BASE_PADDING, INDENT_PER_LEVEL } from "./LayerRow";
import { ExternalImageMenu } from "./ExternalImageMenu";
import { useElementSize } from "../hooks/useElementSize";
import { createRafCoalescer } from "../raf";
import { measureSpan } from "../../core/perf";
import { t } from "../../i18n";
import {
  arrayDropPosition,
  LAYER_DRAG_MIME,
  layerDragBlock,
  LayerDropPosition,
  LayerDropSlot,
  readLayerDragIds
} from "./layer-reorder";
import { LayerDragGhost, stackDepthFor } from "./LayerDragGhost";

export type { LayerDropPosition, LayerDropSlot };

export interface LayerTreeProps {
  elements: DesignElement[];
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
  docRef?: { current: DesignDocument };
  onRowContextMenu?: (e: any, layerId: string) => void;
  onEmbedAsset?: (assetId: string) => Promise<void> | void;
  collapsedIds: Set<string>;
  setCollapsedIds: Dispatch<StateUpdater<Set<string>>>;
  expandedInstances: Set<string>;
  setExpandedInstances: Dispatch<StateUpdater<Set<string>>>;
  /** Bumped by the header's locate button to re-reveal an unchanged selection. */
  revealToken?: number;
}

export function LayerTree({
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
  docRef,
  onRowContextMenu,
  onEmbedAsset,
  collapsedIds,
  setCollapsedIds,
  expandedInstances,
  setExpandedInstances,
  revealToken = 0
}: LayerTreeProps) {
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [dragOverInfo, setDragOverInfo] = useState<{ id: string; position: LayerDropSlot } | null>(null);
  const [dragStack, setDragStack] = useState<{ depth: number; x: number; y: number; width: number; height: number } | null>(null);
  const [embeddingAssetIds, setEmbeddingAssetIds] = useState<Set<string>>(new Set());
  const [renameDraft, setRenameDraft] = useState("");
  const renameSettledRef = useRef(false);
  const [activeMenu, setActiveMenu] = useState<{ assetId: string; isVideo?: boolean; anchor: HTMLElement } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const revealedSelectionRef = useRef<string | null>(null);
  const revealTokenRef = useRef(revealToken);
  /** The rows the current drag carries, so a row inside it can refuse the drop. */
  const dragBlockRef = useRef<string[] | null>(null);
  /** Where the drag image sat at the press, and the pointer it started from. */
  const dragOriginRef = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);

  const activeSelectedId = primarySelectedId ?? selectedIds.values().next().value ?? null;

  const rowsOf = (el: DesignElement) => layerRowsOf(docRef?.current, el);
  const rowOrder = (parent: DesignElement) => rowOrderOf(docRef?.current, parent);
  const isRowCollapsed = useCallback(
    (el: DesignElement) => (el.type === "instance" ? !expandedInstances.has(el.id) : collapsedIds.has(el.id)),
    [collapsedIds, expandedInstances]
  );

  /**
   * One set standing for "collapsed", covering both kinds of row. An instance row
   * is closed until opened and a frame row is open until closed, so anything
   * asking which rows exist has to union the two first.
   */
  const hiddenIds = useMemo(() => {
    const hidden = new Set(collapsedIds);
    for (const el of flattenElements(elements)) {
      if (el.type === "instance" && !expandedInstances.has(el.id)) hidden.add(el.id);
    }
    return hidden;
  }, [elements, collapsedIds, expandedInstances]);

  /**
   * The whole list laid out, including the rows that are off-screen.
   *
   * This is what makes windowing possible: a collapsed subtree's height has to be
   * known before it is rendered, and the only honest source for that is the same
   * walk that would otherwise have rendered it. It is a plain O(n) pass with no
   * DOM in it — the 3120 rows it replaces cost 129 ms of Preact diff each, and
   * this costs a fraction of a millisecond.
   */
  const plan = useMemo(
    () => measureSpan("fish.layerPlan", () =>
      planRows(elements, { collapsedIds: hiddenIds, rowsOf, rowOrderOf: rowOrder })
    ),
    [elements, hiddenIds]
  );

  /** The subtree wash: derived from the selection, looked up per rendered row. */
  const selectedSubtree = useMemo(() => selectedSubtreeIds(elements, selectedIds), [elements, selectedIds]);

  const viewport = useElementSize(scrollContainerRef);
  const win = visibleRowWindow(scrollTop, viewport.height);

  const scrollSinkRef = useRef<ReturnType<typeof createRafCoalescer<number>> | null>(null);
  if (!scrollSinkRef.current) {
    scrollSinkRef.current = createRafCoalescer<number>((top) => setScrollTop(top));
  }
  // A wheel over the list fires far faster than the display, and every write
  // re-runs the window — so the position is collapsed to one read per frame.
  const onScroll = (e: Event) => scrollSinkRef.current!.push((e.currentTarget as HTMLDivElement).scrollTop);

  // The reveal is armed by the selection, not by every document edit. Reading the
  // latest layout at fire time keeps `elements`/`plan` out of the effect's deps:
  // listing them let an unrelated edit re-run the effect and cancel the pending
  // scroll, dropping the reveal.
  const revealLayoutRef = useRef({ elements, plan });
  revealLayoutRef.current = { elements, plan };

  useEffect(() => {
    const forceReveal = revealTokenRef.current !== revealToken;
    if (forceReveal) {
      revealTokenRef.current = revealToken;
      revealedSelectionRef.current = null;
    }

    if (!activeSelectedId) {
      revealedSelectionRef.current = null;
      return;
    }

    if (revealedSelectionRef.current !== activeSelectedId) {
      const { elements: liveElements } = revealLayoutRef.current;
      let cur: string | null = activeSelectedId;
      const toReveal: string[] = [];
      while (cur) {
        const parent = findParentById(liveElements, cur);
        if (!parent) break;
        if (collapsedIds.has(parent.id)) {
          toReveal.push(parent.id);
        }
        cur = parent.id;
      }

      const selected = findElementById(liveElements, activeSelectedId);
      if (!selected) {
        for (const rowId of derivedRowPath(docRef?.current, activeSelectedId)) {
          if (collapsedIds.has(rowId) || !expandedInstances.has(rowId)) toReveal.push(rowId);
        }
      } else if (forceReveal && hasRows(docRef?.current, selected)) {
        // Only an explicit locate unfolds the selected layer itself: doing it on
        // every selection change would undo the collapse the user just clicked.
        const collapsed =
          selected.type === "instance" ? !expandedInstances.has(selected.id) : collapsedIds.has(selected.id);
        if (collapsed) toReveal.push(selected.id);
      }

      if (toReveal.length > 0) {
        setCollapsedIds((prev) => {
          const next = new Set(prev);
          for (const id of toReveal) next.delete(id);
          return next;
        });
        setExpandedInstances((prev) => new Set([...prev, ...toReveal]));
        return;
      }
    }

    if (revealedSelectionRef.current === activeSelectedId) return;

    const rafId = requestAnimationFrame(() => {
      // Marked only when the frame actually runs: a render that cancels this RAF
      // must leave the selection unrevealed so the next pass can still scroll.
      revealedSelectionRef.current = activeSelectedId;

      const container = scrollContainerRef.current;
      const row = revealLayoutRef.current.plan.byId.get(activeSelectedId);
      if (!container || !row || container.clientHeight <= 0) return;

      // Scroll only when the row is out of view. A row that is already (even
      // partly) visible needs no reveal — re-centring it would move the list out
      // from under a pointer that just clicked it, which reads as a flicker.
      const rowTop = row.top;
      const rowBottom = row.top + LAYER_ROW_HEIGHT;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;

      // Scroll by the planned offset, never by the row's box: a row outside the
      // window has no box to measure, which is exactly the case worth revealing.
      // `instant`, not `smooth`: a selection moving through the canvas (arrow
      // keys, a drag) re-arms this every step, and an animated scroll would
      // spend that whole run chasing a target that keeps leaving.
      if (rowBottom <= viewTop) {
        container.scrollTo({ top: Math.max(0, rowTop - LAYER_LIST_PADDING), behavior: "instant" });
      } else if (rowTop >= viewBottom) {
        // Scroll the target towards the vertical center of the container so it is
        // not flush against the bottom edge or obscured by bottom chrome.
        const centeredTop = rowTop - Math.round((container.clientHeight - LAYER_ROW_HEIGHT) / 2);
        container.scrollTo({
          top: Math.max(0, centeredTop),
          behavior: "instant"
        });
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [activeSelectedId, collapsedIds, expandedInstances, revealToken]);

  useEffect(() => {
    if (renamingId) {
      const target = flattenElements(elements).find((el) => el.id === renamingId);
      renameSettledRef.current = false;
      setRenameDraft(target?.name || target?.type || "");
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [renamingId]);

  /**
   * The stack has no mouse to listen to: a native drag reports motion through
   * `dragover` on whatever sits under the pointer, and the drag can end on a
   * drop, on a `dragend`, or on Escape — so all three clear it, and the effect's
   * teardown is the backstop for a panel that unmounts mid-drag.
   */
  const dragging = dragStack !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: DragEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const x = origin.x + (e.clientX - origin.startX);
      const y = origin.y + (e.clientY - origin.startY);
      setDragStack((cur) => (cur && (cur.x !== x || cur.y !== y) ? { ...cur, x, y } : cur));
    };
    const end = () => {
      dragBlockRef.current = null;
      dragOriginRef.current = null;
      setDragStack(null);
    };
    document.addEventListener("dragover", move);
    document.addEventListener("drop", end, true);
    document.addEventListener("dragend", end, true);
    return () => {
      document.removeEventListener("dragover", move);
      document.removeEventListener("drop", end, true);
      document.removeEventListener("dragend", end, true);
    };
  }, [dragging]);

  const toggleCollapse = (el: DesignElement, e: MouseEvent) => {
    e.stopPropagation();
    const setter = el.type === "instance" ? setExpandedInstances : setCollapsedIds;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(el.id)) next.delete(el.id);
      else next.add(el.id);
      return next;
    });
  };

  const handleRowSelect = (el: DesignElement, e: MouseEvent) => {
    if (e.shiftKey) {
      const ranged = layerRangeSelection(
        visibleLayerRowIds(elements, hiddenIds, rowsOf, rowOrder),
        selectionAnchorId,
        el.id,
        selectedIds
      );
      if (ranged) {
        onSelect(ranged);
        return;
      }
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedIds);
      if (next.has(el.id)) next.delete(el.id);
      else next.add(el.id);
      onSelect(next);
      setSelectionAnchorId(el.id);
      return;
    }
    onSelect(new Set([el.id]));
    setSelectionAnchorId(el.id);
  };

  /** The embed affordance exists only for a row whose media is a remote asset. */
  const externalAssetFor = (el: DesignElement) => {
    const isVideoEl = el.type === "video";
    const assetId = isVideoEl ? (el as any).assetId : firstImagePaint(el as { fills?: PaintStack })?.assetId;
    const uri = assetId ? docRef?.current?.assets?.find((a) => a.id === assetId)?.uri : undefined;
    if (!assetId || !uri || !(uri.startsWith("http://") || uri.startsWith("https://"))) return null;
    const embedding = embeddingAssetIds.has(assetId);
    return {
      assetId,
      isVideo: isVideoEl,
      title: isVideoEl
        ? embedding
          ? t("layers.embeddingVideo")
          : t("layers.embedVideo")
        : embedding
          ? t("layers.embeddingImage")
          : t("layers.embedImage"),
      active: el.locked || el.visible === false
    };
  };

  /**
   * A run of rows the window missed, standing in for itself at its exact height.
   *
   * `space-y-*` puts a margin BETWEEN siblings, so one spacer owes the gaps of the
   * run it swallowed — without that the list shortens as you scroll and the
   * scrollbar stops meaning anything.
   */
  const renderRun = (rows: PlannedRow[], depth: number, gap: number): ComponentChildren[] => {
    const out: ComponentChildren[] = [];
    let pendingFrom = -1;

    const flush = (to: number) => {
      if (pendingFrom === -1) return;
      const height = collapsedRunHeight(rows, pendingFrom, to, gap);
      if (height <= 0) {
        pendingFrom = -1;
        return;
      }
      out.push(<div key={rows[pendingFrom].el.id} style={{ height: `${height}px` }} aria-hidden="true" />);
      pendingFrom = -1;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!rowIsVisible(row, win)) {
        if (pendingFrom === -1) pendingFrom = i;
        continue;
      }
      flush(i);
      out.push(renderPlanned(row, depth));
    }
    flush(rows.length);
    return out;
  };

  const renderPlanned = (row: PlannedRow, depth: number): ComponentChildren => {
    const el = row.el;
    const isSelected = selectedIds.has(el.id);
    const isDerived = isDerivedNode(el);
    const derivedCanOverride =
      isDerived && docRef?.current ? Boolean(resolveInstanceSelection(docRef.current, el.id)?.overridable) : false;
    const hasChildren = hasRows(docRef?.current, el);
    const isRenaming = renamingId === el.id;

    const children =
      row.children.length > 0 ? renderRun(row.children, depth + 1, LAYER_ROW_GAP_NESTED) : null;

    /* The field unmounts the moment the rename ends, and unmounting a focused
       input fires its `blur` — so Enter and Escape both re-enter here with the
       draft still in hand. This flag marks the exit as already decided, which is
       what keeps Escape a discard rather than a late commit. */
    const commitRename = () => {
      if (renameSettledRef.current) return;
      renameSettledRef.current = true;
      const trimmed = renameDraft.trim();
      if (trimmed) onCommitRename(el.id, trimmed);
      else onCancelRename();
    };
    const cancelRename = () => {
      renameSettledRef.current = true;
      onCancelRename();
    };

    const externalAsset = externalAssetFor(el);

    return (
      <div key={el.id} data-layer-id={el.id} data-derivative={isDerived ? "true" : undefined}>
        <LayerRow
          el={el}
          depth={depth}
          isSelected={isSelected}
          insideSelectedSubtree={selectedSubtree.has(el.id)}
          isRenaming={isRenaming}
          isDerived={isDerived}
          derivedCanOverride={derivedCanOverride}
          isCollapsed={isRowCollapsed(el)}
          hasChildren={hasChildren}
          showRowActions={!isDerived || derivedCanOverride}
          dropPosition={dragOverInfo?.id === el.id ? dragOverInfo.position : null}
          renameDraft={renameDraft}
          renameInputRef={renameInputRef}
          externalAsset={externalAsset}
          isEmbedding={Boolean(externalAsset && embeddingAssetIds.has(externalAsset.assetId))}
          themeModeLabel={
            el.themeMode
              ? docRef?.current?.modes?.find((m) => m.id === el.themeMode)?.name ?? el.themeMode
              : undefined
          }
          numberModeLabel={
            el.numberMode
              ? docRef?.current?.numberModes?.find((m) => m.id === el.numberMode)?.name ??
                el.numberMode
              : undefined
          }
          handlers={{
            onSelect: (e) => {
              if (isRenaming) return;
              handleRowSelect(el, e);
            },
            onToggleCollapse: (e) => toggleCollapse(el, e),
            onStartRename: () => onStartRename?.(el.id),
            onRenameDraft: setRenameDraft,
            onCommitRename: commitRename,
            onCancelRename: cancelRename,
            onToggleLock: () => onToggleLock(el.id, el.locked !== true),
            onToggleVisibility: () => onToggleVisibility(el.id, el.visible === false),
            onContextMenu: (e) => {
              if (isRenaming) return;
              onRowContextMenu?.(e, el.id);
            },
            onOpenExternalMenu: (anchor) => {
              const asset = externalAssetFor(el);
              if (asset) setActiveMenu({ assetId: asset.assetId, isVideo: asset.isVideo, anchor });
            },
            onDragStart: (e) => {
              if (isDerived) return;
              // The payload is the BLOCK, not the pressed row: a multi-selection
              // reorders as one, and the drop cannot know which rows were
              // selected if this only names one.
              const block = layerDragBlock(selectedIds, el.id);
              dragBlockRef.current = block;
              e.dataTransfer?.setData(LAYER_DRAG_MIME, JSON.stringify(block));
              e.dataTransfer?.setData("text/plain", el.id);
              const rowBox = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                /* The row's OWN image, anchored at the point it was grabbed, so it
                   sits under the cursor the way the row did — and so the cards
                   stacked behind it line up with its box rather than with a corner
                   of the panel. */
                e.dataTransfer.setDragImage(
                  e.currentTarget as HTMLElement,
                  e.clientX - rowBox.left,
                  e.clientY - rowBox.top
                );
              }
              /* The stack starts where that image will sit and follows the same
                 delta the pointer takes from here. */
              dragOriginRef.current = { startX: e.clientX, startY: e.clientY, x: rowBox.left, y: rowBox.top };
              setDragStack({
                depth: stackDepthFor(block.length),
                x: rowBox.left,
                y: rowBox.top,
                width: rowBox.width,
                height: rowBox.height
              });
            },
            onDragOver: (e) => {
              if (isDerived) return;
              // A row that travels with the block is not a place to put it: the
              // drop would be reading a position the block is about to vacate, and
              // a line drawn there promises a move the tree will refuse.
              if (dragBlockRef.current?.includes(el.id)) {
                if (dragOverInfo?.id === el.id) setDragOverInfo(null);
                return;
              }
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const yRatio = (e.clientY - rect.top) / rect.height;
              setDragOverInfo({
                id: el.id,
                position:
                  isContainer(el) && !el.locked && yRatio >= 0.25 && yRatio <= 0.75
                    ? "inside"
                    : yRatio < 0.5
                      ? "above"
                      : "below"
              });
            },
            onDragLeave: () => {
              if (dragOverInfo?.id === el.id) setDragOverInfo(null);
            },
            onDrop: (e) => {
              if (isDerived) return;
              e.preventDefault();
              const sourceIds = readLayerDragIds(e.dataTransfer);
              if (sourceIds.length > 0 && dragOverInfo && !sourceIds.includes(dragOverInfo.id)) {
                onReorder(sourceIds, dragOverInfo.id, arrayDropPosition(dragOverInfo.position, row.order));
              }
              dragBlockRef.current = null;
              setDragOverInfo(null);
            }
          }}
        />

        {children && (
          /* `selection-subtree` (4%), not `brand-wash` (12%): the subtree must
             sit clearly BELOW the selected row it belongs to, or the two read as
             one flat amber block. Only the root of the selection tints its
             container — nested child scopes never stack tints. */
          <div
            data-layer-scope={el.id}
            className={`relative space-y-0.5 mt-0.5 rounded-ctl ${
              isSelected && !selectedSubtree.has(el.id) ? "bg-selection-subtree" : ""
            }`}
          >
            <div
              data-layer-guide={el.id}
              className="absolute top-0 bottom-0 w-px bg-raised pointer-events-none z-10"
              style={{ left: `${depth * INDENT_PER_LEVEL + BASE_PADDING + 7}px` }}
            />
            {children}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div ref={scrollContainerRef} onScroll={onScroll} className="flex-1 overflow-auto p-2">
        <div className="min-w-full w-max space-y-1">
          {renderRun(plan.roots, 0, LAYER_ROW_GAP_ROOT)}
        </div>
      </div>
      {activeMenu && (
        <ExternalImageMenu
          anchor={activeMenu.anchor}
          isEmbedding={embeddingAssetIds.has(activeMenu.assetId)}
          label={activeMenu.isVideo ? t("layers.embedVideoAction") : t("layers.embedAction")}
          onEmbed={async () => {
            const assetId = activeMenu.assetId;
            setActiveMenu(null);
            if (!onEmbedAsset || embeddingAssetIds.has(assetId)) return;
            setEmbeddingAssetIds((prev) => new Set(prev).add(assetId));
            try {
              await onEmbedAsset(assetId);
            } finally {
              setEmbeddingAssetIds((prev) => {
                const next = new Set(prev);
                next.delete(assetId);
                return next;
              });
            }
          }}
          onClose={() => setActiveMenu(null)}
        />
      )}
      {dragStack && (
        <LayerDragGhost
          depth={dragStack.depth}
          x={dragStack.x}
          y={dragStack.y}
          width={dragStack.width}
          height={dragStack.height}
        />
      )}
    </>
  );
}
