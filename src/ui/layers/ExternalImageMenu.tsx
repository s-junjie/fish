import { useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Loader2, HardDriveDownload } from "lucide-react";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../menu-style";
import { t } from "../../i18n";

const MENU_VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;
const MENU_POPUP_WIDTH = 180;

interface ExternalImageMenuProps {
  anchor: HTMLElement;
  isEmbedding: boolean;
  label?: string;
  onEmbed: () => void;
  onClose: () => void;
}

export function ExternalImageMenu({
  anchor,
  isEmbedding,
  label,
  onEmbed,
  onClose
}: ExternalImageMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const pos = useAnchoredPosition({
    anchorRef: { current: anchor },
    panelRef: ref,
    deps: [anchor],
    compute: (el, panel) => {
      const a = el.getBoundingClientRect();
      const height = panel.offsetHeight;
      const left = Math.max(
        MENU_VIEWPORT_MARGIN,
        Math.min(a.left, window.innerWidth - MENU_POPUP_WIDTH - MENU_VIEWPORT_MARGIN)
      );
      const below = a.bottom + MENU_GAP;
      const top =
        below + height <= window.innerHeight - MENU_VIEWPORT_MARGIN
          ? below
          : Math.max(MENU_VIEWPORT_MARGIN, a.top - MENU_GAP - height);
      return { left, top };
    }
  });

  useDismiss(true, () => closeRef.current(), ref, { current: anchor });

  return createPortal(
    <div
      ref={ref}
      data-external-image-menu="1"
      role="menu"
      style={placementStyle(pos, MENU_POPUP_WIDTH)}
      className={`fixed z-[60] select-none ${MENU_SURFACE_CLASS} min-w-[180px]`}
    >
      <button
        type="button"
        role="menuitem"
        disabled={isEmbedding}
        onClick={(e) => {
          e.stopPropagation();
          onEmbed();
        }}
        className={MENU_ITEM_CLASS}
      >
        {isEmbedding ? (
          <Loader2 size={13} className="animate-spin text-brand shrink-0" />
        ) : (
          <HardDriveDownload size={13} className="shrink-0" />
        )}
        <span className="truncate">{label || t("layers.embedAction")}</span>
      </button>
    </div>,
    document.body
  );
}
