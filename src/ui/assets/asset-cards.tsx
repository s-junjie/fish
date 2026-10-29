import { useMemo } from "preact/hooks";
import { memo } from "../memo";
import { Image as ImageIcon, ExternalLink, Video } from "lucide-react";
import { t } from "../../i18n";
import { ComponentMark, VariantMark } from "../ComponentMark";
import { renderNodeList, NodeRenderContext } from "../canvas/SvgElementRenderer";
import { getActiveNumberMode, getActiveTheme } from "../../core/interactions/mode-ops";
import { CanvasDefs } from "../canvas/CanvasDefs";
import { flattenElements } from "../../core/geometry/tree-ops";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { formatDuration } from "../duration-format";
import { ASSET_MIME } from "../../core/plugins/types";
import type { ComponentEntry } from "../../core/interactions/component-inventory";
import type { AssetInsertPayload } from "../../core/plugins/types";
import type { AssetRef, DesignDocument, DesignElement, ComponentElement, InstanceElement } from "../../core/dsl/types";

/** The preview box every card in the panel wears — the two tabs are one grid. */
export const CARD_PREVIEW_CLASS =
  "relative w-full overflow-hidden rounded-swatch border border-rule bg-inset group-hover:border-brand aspect-[4/3] transition-colors";

/** The caption row under a preview box. */
export const CARD_CAPTION_CLASS = "flex items-center gap-1 pt-1";

export type CardInsertHandler = ((payload: AssetInsertPayload, worldX?: number, worldY?: number) => void) | undefined;
import { dragPayload } from "../../core/plugins";
export { dragPayload };

/**
 * One document asset. Same card as a component — 4:3 preview box, caption row
 * under it — so the two tabs read as one grid the switch moves between rather
 * than as a list that grew and a list that didn't.
 *
 * A video draws an icon and its clock instead of a frame: the panel never
 * decodes video to show a thumbnail, and an `<img>` pointed at an `.mp4` is a
 * broken-image box, which is the one thing a card must never be.
 */
export const AssetCard = memo(AssetCardView, (prev, next) =>
  prev.asset === next.asset &&
  prev.isVideo === next.isVideo &&
  prev.usage === next.usage &&
  prev.onInsert === next.onInsert
);

function AssetCardView({
  asset,
  isVideo,
  usage = 0,
  onInsert
}: {
  asset: AssetRef;
  isVideo: boolean;
  /** How many places paint this asset; 0 is the card that can be cleaned up. */
  usage?: number;
  onInsert: CardInsertHandler;
}) {
  const payload: AssetInsertPayload = { assetId: asset.id };
  const caption = isVideo && asset.duration ? formatDuration(asset.duration) : "";
  return (
    <div
      title={asset.credit ? `${asset.name} — ${t("assets.photoBy")} ${asset.credit.name}` : asset.name}
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
            className="absolute bottom-1 right-1 px-1 rounded-ctl bg-black/60 text-ui text-ink tabular-nums pointer-events-none"
          >
            {caption}
          </span>
        )}
      </div>
      <div className={CARD_CAPTION_CLASS}>
        {isVideo ? (
          <Video size={13} className="shrink-0 text-ink-dim" />
        ) : (
          <ImageIcon size={13} className="shrink-0 text-ink-dim" />
        )}
        <span className="flex-1 min-w-0 text-ui text-ink truncate" data-asset-name={asset.id}>
          {asset.name}
        </span>
        <span
          className="shrink-0 text-ui text-ink-muted tabular-nums"
          data-asset-usage={asset.id}
          title={t(usage > 0 ? "assets.usedTimes" : "assets.unused", { count: usage })}
        >
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
  prev.subtitle === next.subtitle &&
  prev.name === next.name &&
  prev.onToggleVariants === next.onToggleVariants &&
  prev.expanded === next.expanded &&
  prev.locateId === next.locateId &&
  prev.variant === next.variant
);

function ComponentCardView({
  entry,
  ctx,
  onInsert,
  onLocate,
  count,
  subtitle,
  name,
  onToggleVariants,
  expanded,
  locateId,
  variant
}: {
  entry: ComponentEntry;
  ctx: NodeRenderContext;
  onInsert: CardInsertHandler;
  onLocate?: (componentId: string) => void;
  /** Set members collapse into one card, so the count and caption come from the set. */
  count?: number;
  subtitle?: string;
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
}) {
  const payload: AssetInsertPayload = { componentId: entry.id };
  const el = entry.el;
  // A member's own name IS its coordinates in Figma, so this is a title that
  // repeats it — kept as the tooltip because the card itself has room for the set
  // name and a count but not for two properties' worth of values.
  const variantLabel = entry.variantProperties
    ? Object.entries(entry.variantProperties)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";
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
  return (
    <div
      title={variantLabel ? `${entry.name} — ${variantLabel}` : entry.name}
      draggable={true}
      onDragStart={(e) => dragPayload(e, payload)}
      onClick={() => onInsert?.(payload)}
      data-asset-component={entry.id}
      className="group cursor-default"
    >
      <div className={CARD_PREVIEW_CLASS} data-asset-preview>
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
            className="absolute bottom-1 left-1 flex items-center justify-center h-5 px-1.5 rounded-ctl bg-black/60 text-ink-dim hover:text-ink cursor-default"
          >
            <span className="text-ui leading-none">{expanded ? "▾" : "▸"}</span>
          </button>
        )}
      </div>
      <div className={CARD_CAPTION_CLASS}>
        {variant ? (
          <VariantMark size={13} className="shrink-0 text-component" />
        ) : (
          <ComponentMark size={13} className="shrink-0 text-component" />
        )}
        <span className="flex-1 min-w-0 text-ui text-ink truncate" data-asset-name={entry.id}>
          {name ?? entry.name}
        </span>
        {subtitle && <span className="shrink-0 text-ui text-ink-muted truncate max-w-[3.5rem]">{subtitle}</span>}
        {(count ?? entry.instanceCount) > 0 && (
          <span className="shrink-0 text-ui text-ink-muted tabular-nums">{count ?? entry.instanceCount}</span>
        )}
      </div>
    </div>
  );
}
