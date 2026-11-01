import { useRef, useState } from "preact/hooks";
import { Check, ChevronDown, Lock, Minus, Play, Plus } from "lucide-react";
import { t } from "../../i18n";
import { useDismiss } from "../hooks/useDismiss";
import { MENU_SURFACE_CLASS } from "../menu-style";
import { ScaleModeIcon } from "../scale-icons";

/**
 * The reader's entire chrome: two floating pills over a full-bleed board.
 *
 * They float rather than dock because a phone screen is the whole budget — a
 * 44px strip top and bottom costs 10% of it, and the document is the content
 * here. They never auto-hide: a control that disappears on a device with no
 * pointer to hover is a control the user has to rediscover, and the tap that
 * would bring it back is also the tap that has to mean "follow this link".
 */
export interface ViewerPageEntry {
  id: string;
  name: string;
}

interface ViewerChromeProps {
  docName: string;
  pages: readonly ViewerPageEntry[];
  pageIndex: number;
  /** Already formatted (`formatZoomPercent`), so both readers of a zoom agree. */
  zoomLabel: string;
  /** Null when the file forbids editing: there is nowhere for the door to go. */
  editorHref: string | null;
  readOnly: boolean;
  /** False when the page has nothing to play; the button is absent, not dead. */
  canPresent: boolean;
  onSelectPage: (index: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onPresent: () => void;
}

const PILL = "flex items-center gap-0.5 rounded-dock border border-rule-strong bg-surface/95 px-1.5 py-0.5 shadow-popover";
const SLOT = "flex h-11 w-11 items-center justify-center rounded-ctl text-ink-dim transition-colors duration-micro ease-snap active:bg-raised";
const LABEL = "min-w-11 px-1 text-center text-readout text-ink tabular-nums";

/**
 * A page row is 44px, not the menu's 26.
 *
 * `MENU_ITEM_CLASS` pins its height because a pointer can hit a 26px row. A
 * fingertip cannot, and a menu that is the only way to change page on a phone is
 * the last place to keep the desktop metric.
 */
const PAGE_ROW = "flex h-11 w-full items-center gap-2 rounded-ctl px-2.5 text-left text-ui active:bg-raised";

export function ViewerChrome({
  docName,
  pages,
  pageIndex,
  zoomLabel,
  editorHref,
  readOnly,
  canPresent,
  onSelectPage,
  onZoomIn,
  onZoomOut,
  onFit,
  onPresent
}: ViewerChromeProps) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const pageButtonRef = useRef<HTMLButtonElement>(null);
  const pageMenuRef = useRef<HTMLDivElement>(null);
  useDismiss(pagesOpen, () => setPagesOpen(false), pageMenuRef, pageButtonRef);

  const multiPage = pages.length > 1;
  const current = pages[pageIndex];

  return (
    <>
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 p-3"
        style={{ paddingTop: "calc(12px + env(safe-area-inset-top))" }}
      >
        <div className="relative flex min-w-0 flex-col items-start">
          <div className="pointer-events-auto max-w-[62vw] rounded-pill border border-rule-strong bg-surface/95 px-3 py-1.5 shadow-popover">
            <div className="truncate text-ui text-ink-dim">{docName}</div>
            {multiPage ? (
              <button
                ref={pageButtonRef}
                type="button"
                aria-expanded={pagesOpen}
                aria-label={t("viewer.pages")}
                onClick={() => setPagesOpen((open) => !open)}
                className="mt-0.5 flex w-full items-center gap-1 text-left text-displaySm text-ink"
              >
                <span className="truncate">{current?.name ?? ""}</span>
                <ChevronDown size={13} className="shrink-0 text-ink-dim" />
              </button>
            ) : (
              <div className="mt-0.5 truncate text-displaySm text-ink">{current?.name ?? ""}</div>
            )}
          </div>

          {pagesOpen && (
            <div
              ref={pageMenuRef}
              role="menu"
              aria-label={t("viewer.pages")}
              className={`${MENU_SURFACE_CLASS} pointer-events-auto absolute left-0 top-full mt-2 max-h-[50vh] w-60 overflow-y-auto overscroll-contain`}
            >
              {pages.map((page, index) => (
                <button
                  key={page.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={index === pageIndex}
                  className={PAGE_ROW}
                  onClick={() => {
                    onSelectPage(index);
                    setPagesOpen(false);
                  }}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    {index === pageIndex && <Check size={13} className="text-brand" />}
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${index === pageIndex ? "text-ink" : "text-ink-dim"}`}>
                    {page.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {readOnly || !editorHref ? (
          /* The same pill in the same slot, saying why the door is not there.
             A control that leads to a refused reload is worse than no control:
             it promises an editor the file has already decided against. */
          <span
            data-viewer-read-only="true"
            className="pointer-events-auto flex h-11 shrink-0 items-center gap-1.5 rounded-pill border border-rule-strong bg-surface/95 px-3 text-ui text-ink-dim shadow-popover"
          >
            <Lock size={13} />
            {t("viewer.readOnly")}
          </span>
        ) : (
          <a
            href={editorHref}
            className="pointer-events-auto flex h-11 shrink-0 items-center rounded-pill border border-rule-strong bg-surface/95 px-3 text-ui text-ink shadow-popover active:bg-raised"
          >
            {t("viewer.desktopMode")}
          </a>
        )}
      </div>

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3"
        style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}
      >
        <div className={`pointer-events-auto ${PILL}`}>
          <button type="button" className={SLOT} title={t("viewer.zoomOut")} aria-label={t("viewer.zoomOut")} onClick={onZoomOut}>
            <Minus size={16} />
          </button>
          <span className={LABEL}>{zoomLabel}</span>
          <button type="button" className={SLOT} title={t("viewer.zoomIn")} aria-label={t("viewer.zoomIn")} onClick={onZoomIn}>
            <Plus size={16} />
          </button>
          <div className="mx-1 h-4 w-px bg-rule-strong" />
          <button type="button" className={SLOT} title={t("viewer.fit")} aria-label={t("viewer.fit")} onClick={onFit}>
            {/* The deck's own mark, not a corner bracket: a bracket is the deck's
                FULLSCREEN glyph, and this button is the other statement — put the
                page back inside the window. `fill`, the same glyph the deck's
                "Fill screen" row wears, because both say the page meets the frame. */}
            <ScaleModeIcon mode="fill" size={16} />
          </button>
          {canPresent && (
            <>
              <div className="mx-1 h-4 w-px bg-rule-strong" />
              <button
                type="button"
                className={SLOT}
                title={t("viewer.present")}
                aria-label={t("viewer.present")}
                onClick={onPresent}
              >
                <Play size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
