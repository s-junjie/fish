import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { ComponentChildren } from "preact";
import { Link2Off, Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { useAnchoredPosition, placementStyle, sidePanelCompute } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import { StyleCard } from "./StyleCard";

/** One list row, resolved: both axes differ only inside this shape. */
export interface TokenPickerRow {
  id: string;
  name: string;
  subtitle: string;
  preview: ComponentChildren;
  /** The bound tick, a hover-revealed edit button, or nothing. */
  trailing?: ComponentChildren;
}

interface TokenPickerPopoverProps<T> {
  tokens: T[];
  /** What the search box accepts — the two axes match on different fields. */
  matches: (token: T, query: string) => boolean;
  row: (token: T) => TokenPickerRow;

  anchor: HTMLElement;
  ariaLabel: string;
  title: string;
  createTitle: string;
  searchPlaceholder: string;
  emptyLabel: string;
  /** Data attributes and scopes the rigs name differently per axis. */
  rootAttr: Record<string, string>;
  searchAttr: Record<string, string>;
  createAttr: Record<string, string>;
  detachAttr: Record<string, string>;
  optionAttr: string;
  fieldScope: string;
  /** A nested panel this one must prepend to the default host chain. */
  hostSelector?: string;

  boundTokenId?: string;
  onDetach?: () => void;
  /** The `+` in the header. */
  onCreate: () => void;
  /** The category filter, when the axis has one. */
  extraControls?: ComponentChildren;
  /** Re-measure when these change (the category selection). */
  extraDeps?: unknown[];

  onSelect: (token: T) => void;
  onClose: () => void;
  /** Selectors a press must not dismiss on — the editor this picker hosts. */
  keepOpenFor?: string[];
  /** Whether that editor is up, so Escape unwinds one layer at a time. */
  nestedOpen?: () => boolean;
  /**
   * The editor, portalled by this picker. It is handed the picker's own panel
   * ref, because an editor opened from inside the list anchors to the popover —
   * not to the row that opened it.
   */
  editor?: (panelRef: { current: HTMLElement | null }) => ComponentChildren;
}

/**
 * The per-property token picker both axes wear: header with create/detach, search,
 * an optional filter row, the list, an editor slot. What stays per-axis is how a
 * token reads as a row and what its search matches.
 */
export function TokenPickerPopover<T>({
  tokens,
  matches,
  row,
  anchor,
  ariaLabel,
  title,
  createTitle,
  searchPlaceholder,
  emptyLabel,
  rootAttr,
  searchAttr,
  createAttr,
  detachAttr,
  optionAttr,
  fieldScope,
  hostSelector,
  boundTokenId,
  onDetach,
  onCreate,
  extraControls,
  extraDeps = [],
  onSelect,
  onClose,
  keepOpenFor,
  nestedOpen,
  editor
}: TokenPickerPopoverProps<T>) {
  const [filter, setFilter] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusedOnceRef = useRef(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((token) => matches(token, q));
  }, [tokens, filter, matches]);

  const rows = filtered.map((token) => ({ token, view: row(token) }));

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [filter, tokens.length, ...extraDeps],
    compute: sidePanelCompute(POPOVER_WIDTH, 280, hostSelector)
  });

  useDismiss(true, onClose, panelRef, anchorRef, keepOpenFor, nestedOpen);

  useEffect(() => {
    if (focusedOnceRef.current || !pos) return;
    focusedOnceRef.current = true;
    searchRef.current?.focus();
  }, [pos]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      {...rootAttr}
      data-host-popover="true"
      data-field-tab-scope={fieldScope}
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[70] px-2.5 py-3 flex flex-col text-ui select-none max-h-[85vh] overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
    >
      <PanelHeader
        title={title}
        onClose={onClose}
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              type="button"
              {...createAttr}
              title={createTitle}
              aria-label={createTitle}
              onClick={onCreate}
            >
              <Plus size={12} />
            </Button>
            {boundTokenId && onDetach && (
              <Button
                size="icon"
                type="button"
                {...detachAttr}
                title={t("tokens.detach")}
                aria-label={t("tokens.detach")}
                onClick={onDetach}
              >
                <Link2Off size={12} />
              </Button>
            )}
          </div>
        }
      />

      <div className="mt-2">
        <input
          ref={searchRef}
          {...searchAttr}
          value={filter}
          onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          placeholder={searchPlaceholder}
          className={TEXT_FIELD_CLASS}
          spellcheck={false}
        />
      </div>

      {extraControls ? <div className="mt-1.5">{extraControls}</div> : null}

      <div className="mt-2 space-y-1">
        {rows.length === 0 ? (
          <p className="px-1 py-3 text-center text-meta text-ink-muted">{emptyLabel}</p>
        ) : (
          rows.map(({ token, view }) => (
            <StyleCard
              key={view.id}
              rowProps={{ [optionAttr]: view.id }}
              preview={view.preview}
              name={view.name}
              subtitle={view.subtitle}
              onClick={() => onSelect(token)}
              className="group"
              trailing={view.trailing}
            />
          ))
        )}
      </div>

      {editor?.(panelRef)}
    </div>,
    document.body
  );
}
