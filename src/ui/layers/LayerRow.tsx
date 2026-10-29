import type { DesignElement } from "../../core/dsl/types";
import { t } from "../../i18n";
import { ChevronDown, ChevronRight, Eye, EyeOff, Link2, Globe, Loader2, Lock, LockOpen, AlertTriangle } from "lucide-react";
import { getElementIcon } from "./layer-icons";
import { DARK_RING_CLASS } from "../ring-style";
import { INLINE_RENAME_INPUT_CLASS } from "../rename-style";
import type { LayerDropSlot } from "./layer-reorder";
import { textFontStatus } from "../../core/fonts/font-status";
import { useFontStatusUpdates } from "../hooks/useFontStatusUpdates";
import { openMissingFonts } from "../missing-fonts";

export const INDENT_PER_LEVEL = 12;
/**
 * The gutter every left-panel row insets by. This is the ONE number that
 * keeps the file name, the tabs, the page rows and the layer rows on the
 * same left edge — measured at 1600px they were landing on 12 / 10 / 8,
 * which reads as a 4px stagger no one can name but everyone can see. It is
 * 8 rather than 12 because the scroller already adds its own `p-2`: the two
 * stack, and a top-level row was sitting 20px off the rail.
 * `INDENT_PER_LEVEL` stacks on top of this for depth.
 */
export const BASE_PADDING = 8;

export interface LayerRowProps {
  el: DesignElement;
  depth: number;
  isSelected: boolean;
  insideSelectedSubtree: boolean;
  isRenaming: boolean;
  isDerived: boolean;
  derivedCanOverride: boolean;
  isCollapsed: boolean;
  hasChildren: boolean;
  showRowActions: boolean;
  dropPosition: LayerDropSlot | null;
  renameDraft: string;
  renameInputRef: { current: HTMLInputElement | null };
  externalAsset: { assetId: string; title: string; active: boolean } | null;
  isEmbedding: boolean;
  themeModeLabel?: string;
  numberModeLabel?: string;
  handlers: {
    onSelect: (e: MouseEvent) => void;
    onToggleCollapse: (e: MouseEvent) => void;
    onStartRename: () => void;
    onRenameDraft: (value: string) => void;
    onCommitRename: () => void;
    onCancelRename: () => void;
    onToggleLock: () => void;
    onToggleVisibility: () => void;
    onContextMenu: (e: MouseEvent) => void;
    onOpenExternalMenu: (anchor: HTMLElement) => void;
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
  };
}

/**
 * One layer row. Split out of `LayerTree` so windowing can drop a row that is
 * off-screen by not calling this at all — a 3120-row page cannot afford to
 * re-render its whole list to move the scroll position.
 */
export function LayerRow({
  el,
  depth,
  isSelected,
  insideSelectedSubtree,
  isRenaming,
  isDerived,
  derivedCanOverride,
  isCollapsed,
  hasChildren,
  showRowActions,
  dropPosition,
  renameDraft,
  renameInputRef,
  externalAsset,
  isEmbedding,
  themeModeLabel,
  numberModeLabel,
  handlers
}: LayerRowProps) {
  const rowSurface = isSelected
    ? "bg-selection text-ink"
    : insideSelectedSubtree
      ? "text-ink-dim hover:bg-selection-hover"
      : "text-ink-dim hover:bg-raised";
  /* The action buttons overlay the row's right end, so they must occlude the
     truncated name — hence a background at all. Each value is the
     OPAQUE equivalent of whatever is already behind them (see
     `tailwind.config.js`), never a second tint: painting `bg-selection` on
     a row that is already `bg-selection` composites to ~22.6% and shows up
     as a darker box around the lock/eye. */
  const actionSurface = isSelected
    ? "bg-selection-solid"
    : insideSelectedSubtree
      ? "bg-selection-subtree-solid group-hover:bg-selection-subtree-hover-solid"
      : "bg-panel group-hover:bg-raised";
  /* The same fills, attached to the hover instead of painted at rest. The chip
     sits ON the row (see below), so a fill at rest is a bare rectangle covering
     the label's tail and whatever mark sits under it — the icons inside are
     invisible, only the block was not. */
  const actionHoverSurface = isSelected
    ? "group-hover:bg-selection-solid"
    : insideSelectedSubtree
      ? "group-hover:bg-selection-subtree-hover-solid"
      : "group-hover:bg-raised";

  useFontStatusUpdates();
  // Only `missing` is marked. A `remote` family is a font this machine can still
  // get, and the row would then wear a warning for a state that resolves itself.
  const missingFont = (() => {
    const font = textFontStatus(el);
    return font?.status === "missing" ? font.family : null;
  })();

  /* What the chip carries that is true whether or not the row is hovered: a
     warning, an external source, and the two switches that are currently OFF
     (locked / hidden). Those keep their slot in the row; everything else is an
     overlay that only exists on hover. */
  const actionsPinned =
    Boolean(missingFont) ||
    Boolean(externalAsset) ||
    Boolean(showRowActions && (el.locked || el.visible === false));

  /* The chip lands on the row's right end, which is where the row's own marks
     (`Mask`, link, theme mode, number mode) sit. They step aside as it fades in
     — the slot holds status at rest and controls under the pointer — instead of
     being covered one frame after they were read. A pinned chip keeps its own
     slot in the flow, so nothing there needs to move. */
  const marksYieldOnHover =
    showRowActions && !actionsPinned
      ? "group-hover:opacity-0 transition-opacity duration-micro ease-snap"
      : "";

  /* An elided name is the one thing the row cannot tell you and the list no
     longer scrolls sideways to reveal, so the tooltip is attached on the way in
     and only when the text is actually cut. */
  const titleIfElided = (node: HTMLElement) => {
    node.title = node.scrollWidth > node.clientWidth + 1 ? el.name || el.type : "";
  };

  return (
    <div className="select-none relative">
      {dropPosition === "above" && (
        <div
          data-testid="layer-drop-indicator"
          style={{ left: `${depth * INDENT_PER_LEVEL + BASE_PADDING}px`, right: "6px" }}
          className={`absolute -top-[1.5px] h-[2px] bg-brand z-30 pointer-events-none rounded-full flex items-center ${DARK_RING_CLASS}`}
        >
          <div className="absolute -left-1 w-2 h-2 rounded-full bg-brand border border-surface" />
        </div>
      )}
      {dropPosition === "below" && (
        <div
          data-testid="layer-drop-indicator"
          style={{ left: `${depth * INDENT_PER_LEVEL + BASE_PADDING}px`, right: "6px" }}
          className={`absolute -bottom-[1.5px] h-[2px] bg-brand z-30 pointer-events-none rounded-full flex items-center ${DARK_RING_CLASS}`}
        >
          <div className="absolute -left-1 w-2 h-2 rounded-full bg-brand border border-surface" />
        </div>
      )}
      {dropPosition === "inside" && (
        <div className="absolute inset-0 border-2 border-brand bg-brand-wash rounded-ctl pointer-events-none z-20" />
      )}

      <div
        data-layer-row={el.id}
        title={isDerived && !derivedCanOverride ? t("component.derivedChildLocked") : undefined}
        draggable={!isRenaming && !el.locked && !isDerived}
        onDragStart={handlers.onDragStart}
        onDragOver={handlers.onDragOver}
        onDragLeave={handlers.onDragLeave}
        onDrop={handlers.onDrop}
        onClick={handlers.onSelect}
        onContextMenu={handlers.onContextMenu}
        style={{ paddingLeft: `${depth * INDENT_PER_LEVEL + BASE_PADDING}px` }}
        /* `text-row`: the reference layout draws the layer list in mono,
         which is most of why it reads as an instrument rather than a
         file browser. `text-row` carries that role's -0.01em tracking. */
        className={`group relative flex items-center justify-between py-1.5 rounded-ctl text-row transition-colors duration-micro ease-snap cursor-default pr-1.5 ${rowSurface} ${
          el.visible === false ? "opacity-50" : ""
        }`}
      >
        {/* The selection indicator. `left-1` keeps it clear of the row's 4px
            corner arc; `h-3.5` (14px) centred is the same mark a page row
            wears, so the two lists read as one system. Absolute, so it costs
            no layout and the label does not shift as selection moves. */}
        {isSelected && (
          <span
            aria-hidden="true"
            data-layer-selected-bar={el.id}
            className="absolute left-1 top-1/2 -translate-y-1/2 w-0.5 h-3.5 rounded-full bg-brand pointer-events-none"
          />
        )}
        {hasChildren ? (
          <button
            type="button"
            onClick={handlers.onToggleCollapse}
            className="relative w-3.5 h-3.5 flex items-center justify-center text-ink-dim hover:text-ink cursor-default shrink-0 rounded-ctl hover:bg-raised"
            title={isCollapsed ? t("layers.expand") : t("layers.collapse")}
          >
            <span aria-hidden="true" className="absolute -inset-x-1.5 -inset-y-2" />
            {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        ) : (
          <span className="w-3.5 h-3.5 shrink-0" />
        )}

        <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
          {getElementIcon(el)}

          {isRenaming ? (
            <input
              ref={renameInputRef}
              data-layer-rename={el.id}
              type="text"
              name="layer-name"
              value={renameDraft}
              onInput={(e) => handlers.onRenameDraft((e.target as HTMLInputElement).value)}
              onBlur={handlers.onCommitRename}
              onKeyDown={(e) => {
                if (e.isComposing || (e as any).keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  handlers.onCommitRename();
                } else if (e.key === "Escape") {
                  handlers.onCancelRename();
                }
              }}
              onClick={(e) => e.stopPropagation()}
              onDblClick={(e) => e.stopPropagation()}
              className={`${INLINE_RENAME_INPUT_CLASS} min-w-[120px]`}
            />
          ) : (
            <span
              onDblClick={(e) => {
                e.stopPropagation();
                if (!isDerived) handlers.onStartRename();
              }}
              onMouseEnter={(e) => titleIfElided(e.currentTarget)}
              className={`truncate flex-1 select-none ${
                (el.type === "component" || el.type === "instance" || el.type === "componentSet") && !isSelected
                  ? "text-component"
                  : ""
              }`}
            >
              {el.name || el.type}
            </span>
          )}
        </div>

        {el.isMask && (
          <span className={`shrink-0 text-meta bg-brand-wash text-brand border border-brand/30 px-1 py-0.2 rounded-ctl ${marksYieldOnHover}`}>
            Mask
          </span>
        )}

        {/* The only place a link is visible without opening the inspector. */}
        {el.link && (
          <span data-layer-link={el.id} title={el.link} className={`shrink-0 text-ink-dim ${marksYieldOnHover}`}>
            <Link2 size={11} />
          </span>
        )}

        {el.themeMode && (
          <span
            data-layer-theme-mode={el.id}
            title={`${t("tokens.themeMode")}: ${themeModeLabel || el.themeMode}`}
            className={`shrink-0 text-meta bg-raised text-ink-muted border border-rule px-1 py-0.2 rounded-ctl uppercase ${marksYieldOnHover}`}
          >
            {themeModeLabel || el.themeMode}
          </span>
        )}

        {el.numberMode && (
          <span
            data-layer-number-mode={el.id}
            title={`${t("tokens.numberMode")}: ${numberModeLabel || el.numberMode}`}
            className={`shrink-0 text-meta bg-raised text-ink-muted border border-rule px-1 py-0.2 rounded-ctl uppercase ${marksYieldOnHover}`}
          >
            {numberModeLabel || el.numberMode}
          </span>
        )}

        {/* `h-3.5` pins the row to the 14px control `DESIGN.md` specifies: the
            p-0.5-wrapped 12px icons are 16px, and without this the row renders
            28px against the 26px the scroll plan lays out.
            The chip sits ON the row instead of parking in the flow: a reserved
            slot took 34px off every label for two buttons the author cannot see
            while idle. It is opaque only while it is drawn, so a row nobody is
            pointing at is pure label. */}
        {(showRowActions || externalAsset || missingFont) && (
          <div
            className={`flex h-3.5 items-center pl-1.5 rounded-ctl z-10 ${
              actionsPinned
                ? `relative ml-auto shrink-0 ${actionSurface}`
                : `absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-micro ease-snap ${actionHoverSurface}`
            }`}
          >
            {/* The one row mark that says the file will not paint as designed. It is
                always drawn, never hover-gated like the eye and the lock: a warning
                you have to find is a warning that arrives too late. `measure-coral`
                is the shell's existing "something is wrong" note (`AppNotices`,
                `AutosaveBadge`), which keeps amber meaning "armed".
                It is a BUTTON, because a mark that only explains leaves the author
                to find the fix: the press opens the panel that offers one, and stops
                there — selecting the layer was not what the author asked for. */}
            {missingFont && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openMissingFonts();
                }}
                data-layer-missing-font={el.id}
                data-font-family={missingFont}
                title={t("fonts.missingDetail", { family: missingFont })}
                aria-label={t("fonts.missingDetail", { family: missingFont })}
                className="shrink-0 flex items-center text-measure-coral p-0.5 cursor-pointer hover:opacity-80 mr-0.5"
              >
                <AlertTriangle size={11} />
              </button>
            )}
            {/* External media (image / video) URL indicator & embed action */}
            {externalAsset && (
              <button
                type="button"
                data-layer-external-image={el.id}
                disabled={isEmbedding}
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.onOpenExternalMenu(e.currentTarget as HTMLElement);
                }}
                title={externalAsset.title}
                className="flex items-center justify-center p-0.5 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised transition-all duration-micro ease-snap cursor-default disabled:cursor-default mr-0.5"
              >
                {isEmbedding ? (
                  <Loader2 size={11} className="animate-spin text-brand" />
                ) : (
                  <Globe size={11} />
                )}
              </button>
            )}

            {showRowActions && (
              <div className="flex items-center">
                <button
                  type="button"
                  data-layer-lock={el.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlers.onToggleLock();
                  }}
                  title={el.locked ? t("layers.unlock") : t("layers.lock")}
                  className={`flex items-center justify-center p-0.5 rounded-ctl transition-opacity cursor-default hover:text-ink duration-micro ease-snap ${actionSurface} ${
                    el.locked ? "opacity-100 text-ink-dim" : "opacity-0 group-hover:opacity-100 text-ink-muted"
                  }`}
                >
                  {el.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                </button>
                <button
                  type="button"
                  data-layer-eye={el.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlers.onToggleVisibility();
                  }}
                  title={el.visible === false ? t("layers.show") : t("layers.hide")}
                  className={`flex items-center justify-center p-0.5 rounded-ctl transition-opacity cursor-default hover:text-ink duration-micro ease-snap ${actionSurface} ${
                    el.visible === false ? "opacity-100 text-ink-dim" : "opacity-0 group-hover:opacity-100 text-ink-muted"
                  }`}
                >
                  {el.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
