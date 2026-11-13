import { useMemo } from "preact/hooks";
import { memo } from "../memo";
import { ChevronDown, ChevronRight, Image as ImageIcon, ExternalLink, Video } from "lucide-react";
import { t } from "../../i18n";
import { ComponentMark, VariantMark } from "../ComponentMark";
import { renderNodeList, NodeRenderContext } from "../canvas/SvgElementRenderer";
import { getActiveNumberMode, getActiveTheme } from "../../core/interactions/mode-ops";
import { CanvasDefs } from "../canvas/CanvasDefs";
import { flattenElements } from "../../core/geometry/tree-ops";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { formatDuration } from "../duration-format";
import type { ComponentEntry } from "../../core/interactions/component-inventory";
import type { AssetInsertPayload } from "../../core/plugins/types";
import type { AssetRef, DesignDocument, DesignElement, ComponentElement, InstanceElement } from "../../core/dsl/types";
import { dragPayload } from "../../core/plugins";

export { dragPayload };

export type AssetsViewMode = "grid" | "list";
export type CardInsertHandler = ((payload: AssetInsertPayload, worldX?: number, worldY?: number) => void) | undefined;

/** The preview box every card in the panel wears — the two tabs are one grid. */
export const CARD_PREVIEW_CLASS =
  "relative w-full overflow-hidden rounded-swatch border border-rule bg-inset group-hover:border-brand aspect-[4/3] transition-colors";

/** The caption row under a grid preview box — shared by Images and Components. */
export const CARD_CAPTION_CLASS = "flex items-start gap-1 pt-1";
const CARD_NAME_CLASS = "flex-1 min-w-0 text-row leading-snug text-ink line-clamp-2 break-words";
const CARD_COUNT_CLASS = "shrink-0 pt-[1px] text-meta text-ink-muted tabular-nums";

/** Unified list row & thumbnail — shared by Images and Components in list view. */
const LIST_ROW_CLASS =
  "group relative flex items-center gap-2 px-1.5 py-1 min-h-[38px] rounded-ctl hover:bg-raised transition-colors duration-micro ease-snap cursor-default";
const LIST_PREVIEW_CLASS =
  "relative shrink-0 w-8 aspect-[4/3] overflow-hidden rounded-swatch border border-rule bg-inset group-hover:border-brand transition-colors";
const LIST_NAME_CLASS = "block truncate text-row leading-snug text-ink";
const LIST_META_CLASS = "flex items-center gap-1 min-w-0 text-meta leading-snug text-ink-muted";

/**
 * One document asset. Same card/row structure as a component so the two tabs
 * read as one library the switch moves between.
 *
 * A video draws an icon and its clock instead of a frame: the panel never
 * decodes video to show a thumbnail, and an `<img>` pointed at an `.mp4` is a
 * broken-image box, which is the one thing a card must never be.
 */
export const AssetCard = memo(AssetCardView, (prev, next) =>
  prev.asset === next.asset &&
  prev.isVideo === next.isVideo &&
  prev.usage === next.usage &&
  prev.onInsert === next.onInsert &&
  prev.viewMode === next.viewMode
);

function AssetCardView({
  asset,
  isVideo,
  usage = 0,
  onInsert,
  viewMode = "grid"
}: {
  asset: AssetRef;
  isVideo: boolean;
  /** How many places paint this asset; 0 is the card that can be cleaned up. */
  usage?: number;
  onInsert: CardInsertHandler;
  viewMode?: AssetsViewMode;
}) {
  const payload: AssetInsertPayload = { assetId: asset.id };
  const caption = isVideo && asset.duration ? formatDuration(asset.duration) : "";
  const dims = asset.width && asset.height ? `${Math.round(asset.width)}×${Math.round(asset.height)}` : "";
  const tooltip = asset.credit ? `${asset.name} — ${t("assets.photoBy")} ${asset.credit.name}` : asset.name;
  const usageTitle = t(usage > 0 ? "assets.usedTimes" : "assets.unused", { count: usage });

  if (viewMode === "list") {
    return (
      <div
        title={tooltip}
        draggable={true}
        onDragStart={(e) => dragPayload(e, payload)}
        onClick={() => onInsert?.(payload)}
        data-asset-asset={asset.id}
        data-asset-kind={isVideo ? "video" : "image"}
        className={LIST_ROW_CLASS}
      >
        <div className={LIST_PREVIEW_CLASS} data-asset-preview>
          {isVideo ? (
            <div className="flex h-full w-full items-center justify-center">
              <Video size={13} className="text-ink-muted" />
            </div>
          ) : (
            <img
              src={asset.uri}
              alt={asset.name}
              draggable={false}
              className="block w-full h-full object-contain pointer-events-none"
            />
          )}
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <span className={LIST_NAME_CLASS} data-asset-name={asset.id}>
            {asset.name}
          </span>
          <div className={LIST_META_CLASS}>
            {isVideo ? (
              <Video size={11} className="shrink-0 text-ink-dim" />
            ) : (
              <ImageIcon size={11} className="shrink-0 text-ink-dim" />
            )}
            {dims && <span className="tabular-nums truncate">{dims}</span>}
            {caption && (
              <span data-asset-video={asset.id} className="tabular-nums shrink-0">
                {dims ? `· ${caption}` : caption}
              </span>
            )}
            <span className="ml-auto shrink-0 tabular-nums" data-asset-usage={asset.id} title={usageTitle}>
              {usage}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      title={tooltip}
      draggable={true}
      onDragStart={(e) => dragPayload(e, payload)}
      onClick={() => onInsert?.(payload)}
      data-asset-asset={asset.id}
      data-asset-kind={isVideo ? "video" : "image"}
      className="group cursor-default"
    >
      <div className={CARD_PREVIEW_CLASS} data-asset-preview>
        {isVideo ? (
          <div className="flex h-full w-full items-center justify-center">
            <Video size={22} className="text-ink-muted" />
          </div>
        ) : (
          <img
            src={asset.uri}
            alt={asset.name}
            draggable={false}
            className="block w-full h-full object-contain pointer-events-none"
          />
        )}
        {caption && (
          <span
            data-asset-video={asset.id}
            className="absolute bottom-1 right-1 px-1 rounded-ctl bg-black/60 text-meta text-ink tabular-nums pointer-events-none"
          >
            {caption}
          </span>
        )}
      </div>
      <div className={CARD_CAPTION_CLASS}>
        {isVideo ? (
          <Video size={12} className="shrink-0 mt-[2px] text-ink-dim" />
        ) : (
          <ImageIcon size={12} className="shrink-0 mt-[2px] text-ink-dim" />
        )}
        <span className={CARD_NAME_CLASS} data-asset-name={asset.id}>
          {asset.name}
        </span>
        <span className={CARD_COUNT_CLASS} data-asset-usage={asset.id} title={usageTitle}>
          {usage}
        </span>
      </div>
    </div>
  );
}

const SELECTION_NONE: Set<string> = new Set();
const NOOP = () => {};

/**
 * Thumbnails paint the real renderer, not a simplified preview: a component can
 * carry gradients, masks, effects and nested instances, and a second renderer
 * would silently drift from the canvas. The stub context disables every
 * interactive path (selection, drag-over, text editing) — ids stay in canvas
 * coordinates so `url(#…)` defs the canvas already emitted still resolve.
 */
export function thumbnailContext(docRef: { current: DesignDocument }): NodeRenderContext {
  return {
    selectedIds: SELECTION_NONE,
    setSelectedIds: NOOP,
    docRef,
    theme: getActiveTheme(docRef.current),
    numberMode: getActiveNumberMode(docRef.current),
    zoom: 1,
    rasterScale: 1,
    activeTool: "select",
    viewportBox: null,
    worldBounds: new Map(),
    dragOverFrameId: null,
    editingCanvasTextId: null,
    canvasTextDraft: "",
    setCanvasTextDraft: NOOP,
    canvasTextInputRef: { current: null },
    onElementMouseDown: NOOP,
    onStartCanvasTextEdit: NOOP,
    onCommitCanvasText: NOOP,
    onCancelCanvasText: NOOP,
    editingPathId: null
  };
}

export const ComponentCard = memo(ComponentCardView, (prev, next) =>
  prev.entry === next.entry &&
  prev.ctx === next.ctx &&
  prev.onInsert === next.onInsert &&
  prev.onLocate === next.onLocate &&
  prev.count === next.count &&
  prev.name === next.name &&
  prev.onToggleVariants === next.onToggleVariants &&
  prev.expanded === next.expanded &&
  prev.locateId === next.locateId &&
  prev.variant === next.variant &&
  prev.viewMode === next.viewMode &&
  prev.reserveExpanderSlot === next.reserveExpanderSlot
);

function ComponentCardView({
  entry,
  ctx,
  onInsert,
  onLocate,
  count,
  name,
  onToggleVariants,
  expanded,
  locateId,
  variant,
  viewMode = "grid",
  reserveExpanderSlot = false
}: {
  entry: ComponentEntry;
  ctx: NodeRenderContext;
  onInsert: CardInsertHandler;
  onLocate?: (componentId: string) => void;
  /** Variant count when representing a component set. */
  count?: number;
  name?: string;
  /** Set cards only: reveal the members, so one of them can be inserted. */
  onToggleVariants?: () => void;
  expanded?: boolean;
  /**
   * What the arrow targets, when it is not the entry itself. A set card points at
   * the set node; a member card has nothing else to point at.
   */
  locateId?: string;
  /**
   * A member of a set. One diamond rather than four: inside an expanded set the
   * card is a VARIANT, and the mark is the only thing that says so at a glance.
   */
  variant?: boolean;
  viewMode?: AssetsViewMode;
  /** In list view, align standalone components with component sets that have a chevron. */
  reserveExpanderSlot?: boolean;
}) {
  const payload: AssetInsertPayload = { componentId: entry.id };
  const el = entry.el;
  const displayName = name ?? entry.name;
  const variantLabel = entry.variantProperties
    ? Object.entries(entry.variantProperties)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";
  const tooltip =
    count !== undefined
      ? `${displayName} — ${t("assets.variantsCount", { count })}`
      : variantLabel
        ? `${entry.name} — ${variantLabel}`
        : displayName;
  const bw = Math.max(1, el.width || 1);
  const bh = Math.max(1, el.height || 1);
  // The canvas culls its <defs> by viewport and only emits them for the active
  // page, so a thumbnail cannot borrow them: an offscreen or off-page component
  // would lose its gradients, clips and filters. Each thumbnail carries its own
  // — plus the master of every instance it nests, because CanvasDefs resolves
  // an instance by looking its master up inside the very list it is given.
  const defElements = useMemo(() => {
    const doc = ctx.docRef.current;
    const own = flattenElements([el]);
    const ids = new Set(own.map((e) => e.id));
    const masters: ComponentElement[] = [];
    let frontier: DesignElement[] = own;
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next: DesignElement[] = [];
      for (const e of frontier) {
        if (e.type !== "instance") continue;
        const cid = (e as InstanceElement).componentId;
        if (!cid || ids.has(cid)) continue;
        const master = findMasterComponent(doc, cid);
        if (!master) continue;
        ids.add(cid);
        masters.push(master);
        next.push(master);
      }
      frontier = next;
    }
    return masters.length > 0 ? [...own, ...flattenElements(masters)] : own;
  }, [el, ctx.docRef]);

  const thumbSvg = (
    <svg
      viewBox={`${el.x} ${el.y} ${bw} ${bh}`}
      preserveAspectRatio="xMidYMid meet"
      className="block w-full h-full pointer-events-none"
      data-asset-thumb={entry.id}
    >
      <CanvasDefs
        allElements={defElements}
        viewportBox={null}
        selectedIds={SELECTION_NONE}
        assets={ctx.docRef.current.assets}
      />
      {renderNodeList([el], ctx, true)}
    </svg>
  );

  if (viewMode === "list") {
    return (
      <div
        title={tooltip}
        draggable={true}
        onDragStart={(e) => dragPayload(e, payload)}
        onClick={() => onInsert?.(payload)}
        data-asset-component={entry.id}
        className={LIST_ROW_CLASS}
      >
        {onToggleVariants ? (
          <button
            type="button"
            title={t(expanded ? "assets.hideVariants" : "assets.showVariants")}
            data-asset-variants={entry.id}
            aria-expanded={expanded === true}
            onClick={(e) => {
              e.stopPropagation();
              onToggleVariants();
            }}
            className="w-4 h-5 flex items-center justify-center shrink-0 rounded-ctl text-ink-dim hover:text-ink hover:bg-surface cursor-default"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          reserveExpanderSlot && <span className="w-4 shrink-0" />
        )}
        <div className={LIST_PREVIEW_CLASS} data-asset-preview>
          {thumbSvg}
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <span className={LIST_NAME_CLASS} data-asset-name={entry.id}>
            {displayName}
          </span>
          <div className={LIST_META_CLASS}>
            <span className="shrink-0 inline-flex text-component">
              {variant ? <VariantMark size={11} /> : <ComponentMark size={11} />}
            </span>
            {count !== undefined ? (
              <span className="truncate">{t("assets.variantsCount", { count })}</span>
            ) : (
              <span className="tabular-nums truncate">{`${Math.round(bw)}×${Math.round(bh)}`}</span>
            )}
            {count === undefined && entry.instanceCount > 0 && (
              <span
                className="ml-auto shrink-0 tabular-nums"
                title={t("assets.usedTimes", { count: entry.instanceCount })}
              >
                {entry.instanceCount}
              </span>
            )}
          </div>
        </div>
        {onLocate && (
          <button
            type="button"
            title={t("assets.locateComponent")}
            data-asset-locate={locateId ?? entry.id}
            onClick={(e) => {
              e.stopPropagation();
              onLocate(locateId ?? entry.id);
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-ctl bg-raised text-ink-dim opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto hover:text-ink cursor-default transition-opacity"
          >
            <ExternalLink size={11} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      title={tooltip}
      draggable={true}
      onDragStart={(e) => dragPayload(e, payload)}
      onClick={() => onInsert?.(payload)}
      data-asset-component={entry.id}
      className="group cursor-default"
    >
      <div className={CARD_PREVIEW_CLASS} data-asset-preview>
        {thumbSvg}
        {onLocate && (
          <button
            type="button"
            title={t("assets.locateComponent")}
            data-asset-locate={locateId ?? entry.id}
            onClick={(e) => {
              e.stopPropagation();
              onLocate(locateId ?? entry.id);
            }}
            className="absolute top-1 right-1 flex items-center justify-center w-5 h-5 rounded-ctl bg-black/60 text-ink-dim opacity-0 group-hover:opacity-100 hover:text-ink cursor-default transition-opacity"
          >
            <ExternalLink size={11} />
          </button>
        )}
        {onToggleVariants && (
          <button
            type="button"
            title={t(expanded ? "assets.hideVariants" : "assets.showVariants")}
            data-asset-variants={entry.id}
            aria-expanded={expanded === true}
            onClick={(e) => {
              e.stopPropagation();
              onToggleVariants();
            }}
            className="absolute bottom-1 left-1 flex items-center justify-center gap-1 h-5 px-1.5 rounded-ctl bg-black/60 text-ink-dim hover:text-ink cursor-default"
          >
            <span className="text-row leading-none">{expanded ? "▾" : "▸"}</span>
            {count !== undefined && (
              <span className="text-meta leading-none tabular-nums">{count}</span>
            )}
          </button>
        )}
      </div>
      <div className={CARD_CAPTION_CLASS}>
        <span className="shrink-0 mt-[2px] inline-flex text-component">
          {variant ? <VariantMark size={12} /> : <ComponentMark size={12} />}
        </span>
        <span className={CARD_NAME_CLASS} data-asset-name={entry.id}>
          {displayName}
        </span>
        {count === undefined && entry.instanceCount > 0 && (
          <span
            className={CARD_COUNT_CLASS}
            title={t("assets.usedTimes", { count: entry.instanceCount })}
          >
            {entry.instanceCount}
          </span>
        )}
      </div>
    </div>
  );
}
