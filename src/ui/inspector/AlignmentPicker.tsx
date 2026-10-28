import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Check, ChevronDown } from "lucide-react";
import { useDismiss } from "../hooks/useDismiss";
import { setPickerOpen } from "../hooks/picker-focus";
import { placementStyle, useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { MENU_ITEM_CLASS, MENU_ITEM_ON_CLASS, MENU_SURFACE_CLASS, MENU_WIDTH } from "../menu-style";
import { AlignmentGlyph } from "./AlignmentGlyph";
import type { AlignmentKind, AlignmentValue } from "./AlignmentGlyph";

/**
 * The alignment field: the same 25px well as every other field in the panel —
 * `Select`'s own box, down to the 7px lead and the 12px chevron at `right-1.5`.
 *
 * The value in force is TEXT here, not a drawing. A row in a menu is read once
 * while choosing; the closed field is read a hundred times a day as a label,
 * and a 22px picture at that size is a smudge beside the word that already says
 * the same thing.
 *
 * A MENU rather than a native `<select>` for one reason — an `<option>` cannot
 * hold a drawing, and the drawings are the point of the option list. Everything
 * a native select gave for free has to be spelled here: `aria-haspopup`/
 * `aria-expanded`, Escape, dismissal on an outside press, and `data-align-value`
 * so a rig can read the current value the way it used to read `.value`.
 *
 * Portalled, because the inspector rail is `absolute` + `overflow-hidden`: a
 * six-row menu below the last field would be clipped by the rail's bottom edge
 * and could not be scrolled to.
 */
export function AlignmentPicker(props: {
  kind: AlignmentKind;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  /** The field's own name, so the trigger reads as "Align — Center". */
  label: string;
  className?: string;
  disabled?: boolean;
  /** The row's `data-*` hook, e.g. `data-stack-align`. */
  attrs?: Record<string, string>;
}) {
  const { kind, value, options, onChange, label, className = "", disabled, attrs } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, menuRef, triggerRef);

  /**
   * The shortcut layer listens on `window` in the capture phase, so it answers
   * Escape before any menu can: without this registration the press that should
   * only close the list ALSO drops the selection, and the panel the menu hangs
   * from is gone underneath the pointer. `picker-focus` is the editor's way of
   * asking first; a menu of six rows is a keyboard modal for exactly as long as
   * it is on screen.
   */
  useEffect(() => {
    if (!open) return;
    setPickerOpen(true);
    return () => setPickerOpen(false);
  }, [open]);

  // `align-content` disables itself when the frame stops wrapping or loses its
  // slack. A menu left open over a field that just became inert would keep
  // accepting values for a distribution the engine no longer reads.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const pos = useAnchoredPosition({
    anchorRef: triggerRef,
    panelRef: menuRef,
    deps: [open],
    compute: (anchor, panel) => {
      const a = anchor.getBoundingClientRect();
      const height = panel.offsetHeight || 200;
      const left = Math.max(8, Math.min(a.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      const below = a.bottom + 4;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, a.top - height - 4) : below;
      return { left, top };
    }
  });

  const current = options.find((o) => o.value === value) ?? options[0];
  const currentLabel = current?.label ?? "";

  return (
    <>
      {/* The same two elements `Select` draws: an `inline-flex` wrapper the
          caller sizes, the field itself filling it, the chevron pinned to the
          wrapper's right edge. Sizing the button from `className` instead made
          `w-full` and the caller's `w-36` fight, and the field took the whole
          row — the chevron landed at the panel edge. */}
      <div className={`relative inline-flex items-center ${className}`}>
        <button
          ref={triggerRef}
          type="button"
          {...attrs}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${label} — ${currentLabel}`}
          data-align-value={value}
          onClick={() => setOpen((o) => !o)}
          className="block w-full h-[25px] bg-inset rounded-swatch pl-[7px] pr-6 text-row text-ink text-left cursor-default transition-colors duration-micro ease-snap disabled:opacity-50"
        >
          <span className="block truncate">{currentLabel}</span>
        </button>
        <ChevronDown
          size={12}
          className="absolute right-1.5 pointer-events-none text-ink-dim"
        />
      </div>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={label}
            style={placementStyle(pos, MENU_WIDTH)}
            className={`fixed select-none ${MENU_SURFACE_CLASS}`}
          >
            {options.map((opt) => {
              const on = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  data-align-option={opt.value}
                  aria-selected={on}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={`${MENU_ITEM_CLASS} ${on ? MENU_ITEM_ON_CLASS : ""}`.trim()}
                >
                  <AlignmentGlyph kind={kind} value={opt.value as AlignmentValue} width={36} height={22} />
                  <span className="flex-1 min-w-0 truncate">{opt.label}</span>
                  {on && <Check size={11} className="flex-none" />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
