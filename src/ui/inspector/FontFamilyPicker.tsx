import { useState, useRef, useEffect, useMemo } from "preact/hooks";
import { createPortal } from "preact/compat";
import { ChevronDown, Check, Search, Loader2, AlertCircle } from "lucide-react";
import { t } from "../../i18n";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { readLocalFonts, supportsLocalFonts } from "../../core/fonts/local-font-access";
import { FontOption, buildFontOptions, currentLabel, firstFamily } from "./fonts";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { MIXED_LABEL } from "./mixed";

interface FontFamilyPickerProps {
  value: string;
  onChange: (fontFamily: string) => void;
  /** The selection disagrees: the trigger says so and opens the list with nothing
   *  pre-highlighted, because no family in the list is the one on screen. */
  mixed?: boolean;
  /**
   * Overrides what the trigger SAYS, for a caller that is not showing a current
   * family. The missing-fonts row is that caller: the family it would display is
   * the one being replaced, so it says "Replace…" instead — and, for the same
   * reason, does not set the trigger in that family's face, which is a face this
   * machine does not have.
   */
  label?: string;
}

const PANEL_WIDTH = 252;
const LIST_MAX_HEIGHT = 280;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

function fontPreview(label: string): string {
  return /^[\w\- ]+$/.test(label) ? `"${label}", system-ui, sans-serif` : `${label}, system-ui, sans-serif`;
}

export function FontFamilyPicker({ value, onChange, mixed = false, label }: FontFamilyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [localFamilies, setLocalFamilies] = useState<string[] | null>(null);
  const [noList, setNoList] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => {
    setOpen(false);
    setQuery("");
    // Every way out returns the caret to the trigger: the list replaced it in the
    // tab order, and leaving focus on a button that is no longer in the document
    // drops the user at the top of the panel.
    triggerRef.current?.focus();
  };

  const supported = supportsLocalFonts();
  const loading = supported && localFamilies === null && !noList;

  // Opening the list is the request. Mounting the field is not: a text layer is
  // selected far more often than a font is chosen, and the platform's font
  // access prompt is not something a selection may spend on its own.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readLocalFonts().then((res) => {
      if (cancelled) return;
      // An empty list is not "no fonts installed": the platform returned nothing
      // to show, so the presets below are the whole menu and the user is told so.
      setLocalFamilies(res.ok ? res.families : []);
      setNoList(!res.ok || res.families.length === 0);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const pos = useAnchoredPosition({
    anchorRef: triggerRef,
    panelRef,
    deps: [open],
    compute: (el, panel) => {
      const a = el.getBoundingClientRect();
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(a.left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)
      );
      const height = panel.offsetHeight;
      const fitsBelow = a.bottom + ANCHOR_GAP + height <= window.innerHeight - VIEWPORT_MARGIN;
      const fitsAbove = a.top - ANCHOR_GAP - height >= VIEWPORT_MARGIN;
      const top = fitsBelow
        ? a.bottom + ANCHOR_GAP
        : fitsAbove
        ? a.top - ANCHOR_GAP - height
        : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
      return { left, top };
    }
  });

  // The panel is mounted exactly while it is open, so mounting is the moment it
  // takes the keyboard focus.
  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(focusTimer);
  }, [open]);

  useDismiss(open, () => closeRef.current(), panelRef, triggerRef);

  const options = useMemo(() => buildFontOptions(value, localFamilies), [value, localFamilies]);
  const triggerLabel = label ?? currentLabel(options, value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(Math.max(0, filtered.length - 1));
  }, [filtered, highlight]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const row = listRef.current.children[highlight] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, filtered]);

  const commit = (id: string) => {
    onChange(id);
    closeRef.current();
  };

  const isCurrentOption = (opt: FontOption) =>
    opt.id === value || (opt.isLocal && firstFamily(opt.id) === firstFamily(value));

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    const count = filtered.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (count === 0 ? 0 : (h + 1) % count));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (count === 0 ? 0 : (h - 1 + count) % count));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) commit(opt.id);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-font-trigger="1"
        onClick={() => setOpen((v) => !v)}
        onDblClick={(e) => e.stopPropagation()}
        style={label ? undefined : { fontFamily: fontPreview(triggerLabel) }}
        className={`${TEXT_FIELD_CLASS} flex items-center justify-between gap-2 cursor-default`}
      >
        <span className={`truncate${mixed ? " text-ink-muted" : ""}`}>{mixed ? MIXED_LABEL : triggerLabel}</span>
        <ChevronDown size={12} className={`shrink-0 ${open ? "text-ink" : "text-ink-dim"}`} />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            data-font-panel="1"
            role="dialog"
            style={placementStyle(pos, PANEL_WIDTH)}
            className={`fixed overflow-hidden ${POPOVER_SURFACE_CLASS}`}
          >
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-rule-strong">
              <Search size={12} className="text-ink-dim shrink-0" />
              <input
                ref={inputRef}
                autoFocus
                name="font-search"
                value={query}
                placeholder={t("typography.searchFonts")}
                onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
                onKeyDown={handleKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
                className="w-full bg-transparent outline-none text-ui text-ink placeholder:text-ink-muted"
              />
            </div>
            <div ref={listRef} className="overflow-y-auto py-1" style={{ maxHeight: LIST_MAX_HEIGHT }}>
              {filtered.map((opt, i) => (
                <button
                  type="button"
                  key={opt.id}
                  onClick={() => commit(opt.id)}
                  onMouseMove={() => setHighlight(i)}
                  style={{ fontFamily: fontPreview(opt.label) }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1 text-row text-left truncate ${
                    i === highlight
                      ? "bg-raised text-ink"
                      : "text-ink-dim hover:bg-raised hover:text-ink"
                  }`}
                >
                  <span className="truncate">{opt.label}</span>
                  {isCurrentOption(opt) && <Check size={12} className="text-brand shrink-0" />}
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-ui text-ink-muted">{t("typography.noMatch")}</div>
              )}
              {loading && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-ui text-ink-muted">
                  <Loader2 size={11} className="animate-spin" />
                  {t("typography.loadingFonts")}
                </div>
              )}
            </div>
            {(!supported || noList) && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-rule-strong text-ui text-ink-muted">
                <AlertCircle size={10} className="shrink-0" />
                {t("typography.presetsOnly")}
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  );
}