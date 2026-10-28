import { useState, useRef, useEffect, useMemo } from "preact/hooks";
import { t } from "../../i18n";
import { ChevronDown, Check, Search } from "lucide-react";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { useDismiss } from "../hooks/useDismiss";

export interface SwapPickerOption {
  id: string;
  label: string;
  disabled?: boolean;
  refusal?: string;
}

const LIST_MAX_HEIGHT = 200;

/**
 * Picking the component an instance projects, with a search box.
 *
 * Rendered as a floating popover aligned with `POPOVER_SURFACE_CLASS` and `FontFamilyPicker`.
 */
export function InstanceSwapPicker({
  options,
  value,
  onSelect
}: {
  options: SwapPickerOption[];
  value: string;
  onSelect: (id: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  useDismiss(open, close, panelRef, triggerRef);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  const current = options.find((o) => o.id === value);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options),
    [options, needle]
  );

  useEffect(() => {
    if (highlight >= matches.length) setHighlight(Math.max(0, matches.length - 1));
  }, [matches, highlight]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const row = listRef.current.children[highlight] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, matches]);

  const commit = (opt: SwapPickerOption) => {
    if (opt.disabled) return;
    onSelect(opt.id);
    close();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229) return;
    const count = matches.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (count === 0 ? 0 : (h + 1) % count));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (count === 0 ? 0 : (h - 1 + count) % count));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = matches[highlight];
      if (opt) commit(opt);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="relative w-full" data-swap-picker-root="true">
      <button
        ref={triggerRef}
        type="button"
        data-swap-open="true"
        onClick={() => {
          if (open) {
            close();
          } else {
            setQuery("");
            setOpen(true);
          }
        }}
        className="relative w-full flex items-center h-[25px] bg-inset rounded-swatch pl-[7px] pr-6 text-row text-ink hover:bg-surface focus:outline-none cursor-default transition-colors duration-micro ease-snap text-left"
      >
        <span className="truncate">{current?.label ?? t("component.missingComponent")}</span>
        <ChevronDown
          size={12}
          className={`absolute right-1.5 pointer-events-none shrink-0 ${
            open ? "text-ink" : "text-ink-dim"
          }`}
        />
      </button>

      {open && (
        <div
          ref={panelRef}
          data-swap-picker="true"
          role="dialog"
          className={`absolute left-0 right-0 top-full mt-1 overflow-hidden shadow-popover ${POPOVER_SURFACE_CLASS}`}
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-rule-strong">
            <Search size={12} className="text-ink-dim shrink-0" />
            <input
              ref={inputRef}
              autoFocus
              name="component-search"
              value={query}
              data-swap-search="true"
              placeholder={t("component.swapSearch")}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-full bg-transparent outline-none text-ui text-ink placeholder:text-ink-muted"
            />
          </div>

          <div
            ref={listRef}
            className="overflow-y-auto py-1"
            style={{ maxHeight: LIST_MAX_HEIGHT }}
          >
            {matches.map((o, i) => {
              const isSelected = o.id === value;
              const isHighlighted = i === highlight;
              return (
                <button
                  key={o.id}
                  type="button"
                  data-swap-option={o.id}
                  disabled={o.disabled}
                  title={o.refusal ? t(`component.swapRefused.${o.refusal}`) : undefined}
                  onClick={() => commit(o)}
                  onMouseMove={() => setHighlight(i)}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1 text-row text-left truncate transition-colors duration-micro ease-snap ${
                    o.disabled
                      ? "text-ink-muted cursor-default opacity-50"
                      : isHighlighted
                      ? "bg-raised text-ink cursor-default"
                      : "text-ink-dim hover:bg-raised hover:text-ink cursor-default"
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {isSelected && <Check size={12} className="text-brand shrink-0" />}
                </button>
              );
            })}
            {matches.length === 0 && (
              <div className="px-3 py-2 text-ui text-ink-muted">{t("assets.noResults")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
