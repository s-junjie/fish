import { useState } from "preact/hooks";
import { X } from "lucide-react";

import type { DocumentMode, NumberToken, NumberTokenCategory } from "../../core/dsl/types";
import { DEFAULT_NUMBER_MODES } from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { ScrubInput } from "../ScrubInput";
import { Select } from "../Select";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_CLASS } from "../row-style";
import { NUMBER_TOKEN_CATEGORIES } from "../tokens/CategoryIcon";
import { TokenEditorDialog, type TokenEditorRow } from "./TokenEditorDialog";

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

  const setModeValue = (modeId: string, next: number | undefined) =>
    setModeValues((prev) => {
      const copy = { ...prev };
      if (next === undefined) delete copy[modeId];
      else copy[modeId] = next;
      return copy;
    });

  const rows: TokenEditorRow[] = [
    {
      key: baseMode.id,
      label: baseMode.name,
      control: (
        <div className="flex-1 min-w-0">
          <ScrubInput label="" value={value} onChange={setValue} className="w-full" />
        </div>
      )
    },
    ...otherModes.map((m) => {
      const mVal = modeValues[m.id];
      return {
        key: m.id,
        label: m.name,
        control: (
          <div className="flex-1 min-w-0">
            <ScrubInput
              label=""
              value={mVal}
              placeholder={String(value)}
              onChange={(v) => setModeValue(m.id, v)}
              trailing={
                mVal !== undefined ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModeValue(m.id, undefined);
                    }}
                    title={t("tokens.resetToInherited")}
                    className="flex-none p-1 rounded-swatch text-ink-dim hover:text-ink hover:bg-raised transition-all mr-1 cursor-pointer"
                  >
                    <X size={10} />
                  </button>
                ) : null
              }
              className="w-full"
            />
          </div>
        )
      };
    })
  ];

  return (
    <TokenEditorDialog
      ariaLabel={token ? t("tokens.editNumberToken") : t("tokens.newNumberToken")}
      panelAttr={{ "data-number-token-editor": "1", "data-number-token-editor-panel": "1" }}
      fieldScope="number-token-editor"
      anchorRef={anchorRef}
      deps={[token?.id ?? "new"]}
      fallbackHeight={260}
      hostSelector="[data-number-token-picker], [data-host-popover], [data-style-picker-popover]"
      leadingRows={
        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("tokens.category")}</span>
          <Select
            value={category}
            onChange={(c) => setCategory(c as NumberTokenCategory)}
            className="flex-1 min-w-0"
            data-token-category="1"
          >
            {NUMBER_TOKEN_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {t(`tokens.categories.${cat}`)}
              </option>
            ))}
          </Select>
        </div>
      }
      name={{
        value: name,
        placeholder: t("tokens.numberNamePlaceholder"),
        onInput: setName
      }}
      description={{
        value: description,
        placeholder: t("tokens.descriptionPlaceholder"),
        onInput: setDescription
      }}
      rows={rows}
      submitLabel={token ? t("tokens.save") : t("tokens.create")}
      canSubmit={!!name.trim()}
      onSubmit={() =>
        onSave({
          name: name.trim(),
          value,
          modes: modeValues,
          darkValue: modeValues["dark"],
          category,
          description: description.trim()
        })
      }
      onClose={onClose}
    />
  );
}
