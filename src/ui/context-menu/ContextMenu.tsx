import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  MENU_ITEM_CLASS,
  MENU_ROW_HEIGHT,
  MENU_SEPARATOR_CLASS,
  MENU_SHORTCUT_CLASS,
  MENU_SURFACE_CLASS,
  MENU_WIDTH
} from "../menu-style";

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Right-aligned shortcut, e.g. "⌘⇧C". Presentation only. */
  hint?: string;
  disabled?: boolean;
  /** Why the item is disabled. Shown as the row's tooltip, never as a dialog. */
  title?: string;
  onSelect: () => void;
}

export type ContextMenuEntry = ContextMenuItem | { separator: true };

export function isContextMenuSeparator(entry: ContextMenuEntry): entry is { separator: true } {
  return "separator" in entry;
}

interface ContextMenuBaseProps {
  entries: ContextMenuEntry[];
  onClose: () => void;
}

/** At a point in the viewport — the right-click menu. */
type PointMenuProps = ContextMenuBaseProps & { x: number; y: number; anchor?: undefined };

/** Against the control that opened it — a row's `⋯`. */
type AnchorMenuProps = ContextMenuBaseProps & { anchor: HTMLElement; x?: never; y?: never };

type ContextMenuProps = PointMenuProps | AnchorMenuProps;

/** Gap between an anchor and the menu it opened, in px. */
const ANCHOR_GAP = 4;
/** Distance kept from every window edge, in px. */
const EDGE = 4;

function place(
  el: HTMLElement,
  anchor: HTMLElement | null,
  x: number,
  y: number
): { left: number; top: number } {
  const rect = el.getBoundingClientRect();
  if (!anchor) {
    const maxLeft = Math.max(EDGE, window.innerWidth - rect.width - EDGE);
    const maxTop = Math.max(EDGE, window.innerHeight - rect.height - EDGE);
    return { left: Math.min(x, maxLeft), top: Math.min(y, maxTop) };
  }
  // Right-aligned to its control and flipped above when the control sits too
  // low to open downward — a menu opened from a row near the bottom of a
  // bottom-anchored panel would otherwise spend its whole height covering the
  // row that opened it.
  const a = anchor.getBoundingClientRect();
  const maxLeft = Math.max(EDGE, window.innerWidth - rect.width - EDGE);
  const left = Math.min(Math.max(EDGE, a.right - rect.width), maxLeft);
  const below = a.bottom + ANCHOR_GAP;
  const top =
    below + rect.height <= window.innerHeight - EDGE
      ? below
      : Math.max(EDGE, a.top - ANCHOR_GAP - rect.height);
  return { left, top };
}

/**
 * The one menu, wherever it opened from.
 *
 * Positioned in viewport coordinates and clamped to the window, because a menu
 * opened near the bottom-right corner is the common case, not the rare one. The
 * entries are supplied by the caller: this component knows how to draw and
 * dismiss a menu, not what any particular command does.
 *
 * With an `anchor` it is opened BY a control instead of AT a point, and that
 * control stays "inside" for dismissal: without it the menu closes on mousedown
 * and the control's own click reopens it, so the menu could never be toggled
 * shut from the thing that opened it.
 */
export function ContextMenu(props: ContextMenuProps) {
  const { entries, onClose } = props;
  const anchor = props.anchor ?? null;
  const x = props.x ?? 0;
  const y = props.y ?? 0;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    if (!anchor) return { left: x, top: y };
    const a = anchor.getBoundingClientRect();
    return { left: Math.max(EDGE, a.right - MENU_WIDTH), top: a.bottom + ANCHOR_GAP };
  });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos(place(el, anchor, x, y));
  }, [x, y, entries, anchor]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    // A menu that cannot be dismissed by clicking away is a menu that gets stuck.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, anchor]);

  // Pre-measure so a menu taller than the viewport scrolls instead of spilling.
  const overflows = entries.length * MENU_ROW_HEIGHT > window.innerHeight - 16;

  return (
    <div
      ref={menuRef}
      data-context-menu="true"
      role="menu"
      style={{
        position: "fixed",
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        minWidth: `${MENU_WIDTH}px`,
        maxHeight: overflows ? "calc(100vh - 16px)" : undefined,
        overflowY: overflows ? "auto" : undefined
      }}
      className={MENU_SURFACE_CLASS}
    >
      {entries.map((entry, index) =>
        isContextMenuSeparator(entry) ? (
          <div key={`sep_${index}`} className={MENU_SEPARATOR_CLASS} />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            data-context-item={entry.id}
            disabled={entry.disabled}
            title={entry.title}
            onClick={() => {
              if (entry.disabled) return;
              entry.onSelect();
              onClose();
            }}
            className={`${MENU_ITEM_CLASS} justify-between gap-6 ${
              entry.disabled ? "text-ink-muted cursor-default pointer-events-none" : "text-ink"
            }`}
          >
            <span className="truncate">{entry.label}</span>
            {/* The shortcut is set in the SAME type step as the label, not a
                smaller one: at `row` (10.5px) it sat on a different baseline and
                read as crowding rather than as a second column. Dimmer is enough
                to separate them, and `tabular-nums` keeps `⌘⇧` pairs from
                changing width as the pointer travels down the menu. */}
            {entry.hint && (
              <span className={MENU_SHORTCUT_CLASS}>{entry.hint}</span>
            )}
          </button>
        )
      )}
    </div>
  );
}
