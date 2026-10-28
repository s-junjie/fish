import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { X } from "lucide-react";

import type { DocumentMode, NumberToken, NumberTokenCategory } from "../../core/dsl/types";
import { DEFAULT_NUMBER_MODES } from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { Button } from "../Button";
import { ScrubInput, TEXT_FIELD_CLASS } from "../ScrubInput";
import { Select } from "../Select";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_CLASS } from "../row-style";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_WIDTH } from "./StylePickerPopover";

export interface NumberTokenEditorDraft {
  name: string;
  value: number;
  modes?: Record<string, number | undefined>;
  darkValue?: number;
  category: NumberTokenCategory;
  description: string;
}

interface NumberTokenEditorPanelProps {
  token: NumberToken | null;
  /** The NUMBER axis' modes — the ids this token's per-mode values are filed under. */
  modes?: DocumentMode[];
  anchorRef: { current: HTMLElement | null };
  initialValue?: number;
  initialName?: string;
  initialCategory?: NumberTokenCategory;
  onSave: (draft: NumberTokenEditorDraft) => void;
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

export function NumberTokenEditorPanel({
  token,
  modes = DEFAULT_NUMBER_MODES,
  anchorRef,
  initialValue = 0,
  initialName,
  initialCategory = "spacing",
  onSave,
  onClose
}: NumberTokenEditorPanelProps) {
  const effectiveModes = modes.length > 0 ? modes : DEFAULT_NUMBER_MODES;
  const baseMode = effectiveModes[0];
  const otherModes = effectiveModes.slice(1);

  const [name, setName] = useState(token?.name ?? initialName ?? "");
  const [description, setDescription] = useState(token?.description ?? "");
  const [value, setValue] = useState(token?.value ?? initialValue);

  const initialModeValues: Record<string, number | undefined> = {};
  for (const m of otherModes) {
    if (token?.modes?.[m.id] !== undefined) {
      initialModeValues[m.id] = token.modes[m.id];
    }
  }

  const [modeValues, setModeValues] = useState<Record<string, number | undefined>>(initialModeValues);
  const [category, setCategory] = useState<NumberTokenCategory>(
    token?.category ?? initialCategory
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const focusedOnceRef = useRef(false);

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [token?.id ?? "new"],
    compute: (anchor, panel) => {
      const a = anchor.getBoundingClientRect();
      if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) return null;
      const host =
        anchor.closest("[data-number-token-picker]") ??
        anchor.closest("[data-host-popover], [data-style-picker-popover]");
      const bounds = host ? host.getBoundingClientRect() : a;
      let left = bounds.left - POPOVER_WIDTH - ANCHOR_GAP;
      if (left < VIEWPORT_MARGIN) {
        left = Math.min(bounds.right + ANCHOR_GAP, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
      }
      left = Math.max(VIEWPORT_MARGIN, left);

      const height = panel.offsetHeight || 260;
      const fitsBelow = a.top + height <= window.innerHeight - BOTTOM_MARGIN;
      const fitsAbove = a.top - height >= VIEWPORT_MARGIN;
      const top = fitsBelow
        ? a.top
        : fitsAbove
          ? a.top - height
          : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - BOTTOM_MARGIN);
      return { left, top };
    }
  });

  useDismiss(true, onClose, panelRef, anchorRef);

  useEffect(() => {
    if (focusedOnceRef.current) return;
    focusedOnceRef.current = true;
    requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
  }, []);

  const submit = (e: Event) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;
    onSave({
      name: cleanName,
      value,
      modes: modeValues,
      darkValue: modeValues["dark"],
      category,
      description: description.trim()
    });
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={token ? t("tokens.editNumberToken") : t("tokens.newNumberToken")}
      data-number-token-editor="1"
      data-number-token-editor-panel="1"
      data-host-popover="true"
      data-field-tab-scope="number-token-editor"
      data-inspector-activity="true"
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[80] px-2.5 py-3 flex flex-col text-ui select-none max-h-[85vh] overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
    >
      <form onSubmit={submit} className="flex flex-col space-y-3">
        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("tokens.category")}</span>
          <Select
            value={category}
            onChange={(c) => setCategory(c as NumberTokenCategory)}
            className="flex-1 min-w-0"
            data-token-category="1"
          >
            <option value="spacing">{t("tokens.categories.spacing")}</option>
            <option value="radius">{t("tokens.categories.radius")}</option>
            <option value="stroke">{t("tokens.categories.stroke")}</option>
            <option value="size">{t("tokens.categories.size")}</option>
            <option value="typography">{t("tokens.categories.typography")}</option>
            <option value="effect">{t("tokens.categories.effect")}</option>
          </Select>
        </div>

        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("tokens.name")}</span>
          <input
            ref={nameRef}
            data-token-name="1"
            name="token-name"
            value={name}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            placeholder={t("tokens.numberNamePlaceholder")}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
            spellcheck={false}
          />
        </div>

        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("tokens.description")}</span>
          <input
            data-token-description="1"
            name="token-description"
            value={description}
            onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)}
            placeholder={t("tokens.descriptionPlaceholder")}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
            spellcheck={false}
          />
        </div>

        {/* Base Mode Value */}
        <div className={ROW_CLASS}>
          <span
            className={`${SUB_LABEL_CLASS} w-16 shrink-0 truncate`}
            title={baseMode.name}
          >
            {baseMode.name}
          </span>
          <div className="flex-1 min-w-0">
            <ScrubInput
              label="px"
              value={value}
              onChange={setValue}
              unit="px"
              className="w-full"
            />
          </div>
        </div>

        {/* Dynamic Other Modes Values */}
        {otherModes.map((m) => {
          const mVal = modeValues[m.id];
          return (
            <div key={m.id} className={ROW_CLASS}>
              <span className={`${SUB_LABEL_CLASS} w-16 shrink-0 truncate`} title={m.name}>
                {m.name}
              </span>
              <div className="flex-1 min-w-0">
                <ScrubInput
                  label="px"
                  value={mVal}
                  placeholder={String(value)}
                  onChange={(v) =>
                    setModeValues((prev) => ({
                      ...prev,
                      [m.id]: v
                    }))
                  }
                  trailing={
                    mVal !== undefined ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setModeValues((prev) => {
                            const next = { ...prev };
                            delete next[m.id];
                            return next;
                          });
                        }}
                        title={t("tokens.resetToInherited")}
                        className="flex-none p-1 rounded-swatch text-ink-dim hover:text-ink hover:bg-raised transition-all mr-1 cursor-pointer"
                      >
                        <X size={10} />
                      </button>
                    ) : null
                  }
                  unit="px"
                  className="w-full"
                />
              </div>
            </div>
          );
        })}

        <div className="pt-2 border-t border-rule-strong flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="text" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="text" data-token-save="1" disabled={!name.trim()}>
            {token ? t("tokens.save") : t("tokens.create")}
          </Button>
        </div>
      </form>
    </div>,
    document.body
  );
}
