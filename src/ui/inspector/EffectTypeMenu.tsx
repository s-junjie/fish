import { useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import { EFFECT_KINDS, EffectKind, effectLabel } from "../EffectRows";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../menu-style";

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;
const BOTTOM_MARGIN = 20;
const MENU_WIDTH = 128;

/**
 * Which effect type a new layer gets. Portalled because the style picker clips
 * its own overflow, and the menu is opened from a row at the very bottom of it.
 */
export function EffectTypeMenu({
  anchor,
  onPick,
  onClose,
  isText
}: {
  anchor: HTMLElement;
  onPick: (kind: EffectKind) => void;
  onClose: () => void;
  isText?: boolean;
}) {
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
        VIEWPORT_MARGIN,
        Math.min(a.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN)
      );
      const below = a.bottom + MENU_GAP;
      const top =
        below + height <= window.innerHeight - BOTTOM_MARGIN
          ? below
          : Math.max(VIEWPORT_MARGIN, a.top - MENU_GAP - height);
      return { left, top };
    }
  });

  useDismiss(true, () => closeRef.current(), ref, { current: anchor });

  return createPortal(
    <div
      ref={ref}
      data-effect-menu="1"
      role="menu"
      style={placementStyle(pos, MENU_WIDTH)}
      className={`fixed z-[60] select-none ${MENU_SURFACE_CLASS}`}
    >
      {EFFECT_KINDS.filter(
        (kind) =>
          !isText ||
          (kind !== "liquid-glass" && kind !== "backdrop-blur" && kind !== "tear")
      ).map((kind) => (
        <button
          key={kind}
          type="button"
          role="menuitem"
          onClick={() => onPick(kind)}
          className={MENU_ITEM_CLASS}
        >
          {effectLabel(kind)}
        </button>
      ))}
    </div>,
    document.body
  );
}
