import { useEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { ComponentChildren } from "preact";

import { t } from "../../i18n";
import { Button } from "../Button";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_CLASS } from "../row-style";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { useAnchoredPosition, placementStyle, sidePanelCompute } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_WIDTH } from "./StylePickerPopover";

/** One "label + control" line of the form — the base value, or one mode's. */
export interface TokenEditorRow {
  key: string;
  label: string;
  /** The full label, when the 16-width column truncates it. */
  title?: string;
  control: ComponentChildren;
}

interface TokenEditorDialogProps {
  /** "Edit colour token" / "New number token" — the dialog's accessible name. */
  ariaLabel: string;
  /** Data attributes the callers' rigs and e2e specs reach for. */
  panelAttr: Record<string, string>;
  fieldScope: string;
  /** The row or `+` that opened this dialog. */
  anchorRef: { current: HTMLElement | null };
  /** Re-measure when the token being edited changes. */
  deps?: unknown[];
  /** The tallest this dialog is expected to be before it has a measured height. */
  fallbackHeight: number;
  /** A nested picker prepends its own host attribute to the default chain. */
  hostSelector?: string;

  name: { value: string; placeholder: string; onInput: (next: string) => void };
  description: { value: string; placeholder: string; onInput: (next: string) => void };
  /** Rows above the name row — the number axis' category picker. */
  leadingRows?: ComponentChildren;
  /** The per-mode value lines, base mode first. */
  rows: TokenEditorRow[];

  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
  /** Selectors a click must NOT dismiss on (a nested colour panel). */
  keepOpenFor?: string[];
  /** Whether a nested popover is up, so Escape unwinds one layer at a time. */
  nestedOpen?: () => boolean;
  /** Portalled content that belongs to this dialog (the colour panel). */
  children?: ComponentChildren;
}

/**
 * The floating editor both token axes share: name, description, one line per
 * document mode, cancel/save. The two axes differed only in how a mode's value
 * is edited — that is a row slot — and copied the other eighty lines.
 */
export function TokenEditorDialog({
  ariaLabel,
  panelAttr,
  fieldScope,
  anchorRef,
  deps = [],
  fallbackHeight,
  hostSelector,
  name,
  description,
  leadingRows,
  rows,
  submitLabel,
  canSubmit,
  onSubmit,
  onClose,
  keepOpenFor,
  nestedOpen,
  children
}: TokenEditorDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const focusedOnceRef = useRef(false);

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps,
    compute: sidePanelCompute(POPOVER_WIDTH, fallbackHeight, hostSelector)
  });

  useDismiss(true, onClose, panelRef, anchorRef, keepOpenFor, nestedOpen);

  // Focusing is a separate effect gated on `pos`: a hidden panel cannot take
  // focus, so focusing on mount silently did nothing on the slow path.
  useEffect(() => {
    if (focusedOnceRef.current || !pos) return;
    focusedOnceRef.current = true;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [pos]);

  const submit = (event?: Event) => {
    event?.preventDefault();
    if (!canSubmit) {
      nameRef.current?.focus();
      return;
    }
    onSubmit();
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      {...panelAttr}
      data-host-popover="true"
      data-field-tab-scope={fieldScope}
      data-inspector-activity="true"
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[80] px-2.5 py-3 flex flex-col text-ui select-none max-h-[85vh] overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
    >
      <form onSubmit={submit} className="flex flex-col space-y-3">
        {leadingRows}

        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("tokens.name")}</span>
          <input
            ref={nameRef}
            data-token-name="1"
            name="token-name"
            value={name.value}
            onInput={(e) => name.onInput((e.currentTarget as HTMLInputElement).value)}
            placeholder={name.placeholder}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
            spellcheck={false}
          />
        </div>

        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("tokens.description")}</span>
          <input
            data-token-description="1"
            name="token-description"
            value={description.value}
            onInput={(e) => description.onInput((e.currentTarget as HTMLInputElement).value)}
            placeholder={description.placeholder}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
            spellcheck={false}
          />
        </div>

        {rows.map((row) => (
          <div key={row.key} className={ROW_CLASS}>
            <span
              className={`${SUB_LABEL_CLASS} w-16 shrink-0 truncate`}
              title={row.title ?? row.label}
            >
              {row.label}
            </span>
            {row.control}
          </div>
        ))}

        <div className="pt-2 border-t border-rule-strong flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="text" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="text" data-token-save="1" disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      </form>

      {children}
    </div>,
    document.body
  );
}
