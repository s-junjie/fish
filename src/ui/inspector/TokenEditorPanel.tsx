import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";

import type { ColorToken, DocumentMode } from "../../core/dsl/types";
import { DEFAULT_MODES, getColorTokenModeColor } from "../../core/interactions/mode-ops";
import { DEFAULT_ELEMENT_COLOR } from "../../core/dsl/defaults";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { composeColorAlpha, parseColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { Button } from "../Button";
import { ColorPanel } from "../ColorPanel";
import { HexInput } from "../HexInput";
import { ScrubInput, TEXT_FIELD_CLASS } from "../ScrubInput";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_CLASS } from "../row-style";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import {
  PAINT_ALPHA_CONTAINER_CLASS,
  PAINT_HEX_FIELD_CLASS,
  PAINT_SWATCH_CHECKER,
  PAINT_SWATCH_CLASS
} from "./paint-row-style";

export interface TokenEditorDraft {
  name: string;
  color: string;
  modes?: Record<string, string | undefined>;
  darkColor?: string;
  description: string;
}

interface TokenEditorPanelProps {
  /** `null` creates; an existing token edits in place. */
  token: ColorToken | null;
  /** Available document modes. */
  modes?: DocumentMode[];
  /** The row or + that opened this panel. */
  anchorRef: { current: HTMLElement | null };
  initialColor?: string;
  initialName?: string;
  onSave: (draft: TokenEditorDraft) => void;
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

/**
 * The floating editor for a color token, supporting the base mode and dynamic custom theme modes.
 */
export function TokenEditorPanel({
  token,
  modes = DEFAULT_MODES,
  anchorRef,
  initialColor,
  initialName,
  onSave,
  onClose
}: TokenEditorPanelProps) {
  const effectiveModes = modes.length > 0 ? modes : DEFAULT_MODES;
  const baseMode = effectiveModes[0];
  const otherModes = effectiveModes.slice(1);

  const [name, setName] = useState(token?.name ?? initialName ?? "");
  const [description, setDescription] = useState(token?.description ?? "");
  const [lightColor, setLightColor] = useState(
    token ? colorTokenColor(token) : initialColor ?? DEFAULT_ELEMENT_COLOR
  );

  const initialModeColors: Record<string, string> = {};
  for (const m of otherModes) {
    if (token?.modes?.[m.id]) {
      initialModeColors[m.id] = getColorTokenModeColor(token, m.id);
    } else if (m.id === "dark" && (token as any)?.darkColor) {
      initialModeColors[m.id] = (token as any).darkColor;
    }
  }

  const [modeColors, setModeColors] = useState<Record<string, string>>(initialModeColors);
  const [colorAnchor, setColorAnchor] = useState<{ modeId: string; el: HTMLElement } | null>(null);
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
      const host = anchor.closest("[data-color-token-picker]") ?? anchor.closest("[data-host-popover], [data-style-picker-popover]");
      const bounds = host ? host.getBoundingClientRect() : a;
      let left = bounds.left - POPOVER_WIDTH - ANCHOR_GAP;
      if (left < VIEWPORT_MARGIN) {
        left = Math.min(bounds.right + ANCHOR_GAP, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
      }
      left = Math.max(VIEWPORT_MARGIN, left);

      const height = panel.offsetHeight || 240;
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

  useDismiss(
    true,
    onClose,
    panelRef,
    anchorRef,
    ["[data-color-panel]"],
    () => Boolean(colorAnchor)
  );

  useEffect(() => {
    if (focusedOnceRef.current || !pos) return;
    focusedOnceRef.current = true;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [pos]);

  const submit = (event?: Event) => {
    event?.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      nameRef.current?.focus();
      return;
    }

    onSave({
      name: cleanName,
      color: lightColor,
      modes: modeColors,
      darkColor: modeColors["dark"] || undefined,
      description: description.trim()
    });
  };

  const parsedLight = parseColorAlpha(lightColor);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={token ? t("tokens.editToken") : t("tokens.newToken")}
      data-token-editor="1"
      data-token-editor-panel="1"
      data-host-popover="true"
      data-field-tab-scope="token-editor"
      data-inspector-activity="true"
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[80] px-2.5 py-3 flex flex-col text-ui select-none max-h-[85vh] overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
    >
      <form onSubmit={submit} className="flex flex-col space-y-3">
        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("tokens.name")}</span>
          <input
            ref={nameRef}
            data-token-name="1"
            name="token-name"
            value={name}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            placeholder={t("tokens.namePlaceholder")}
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

        {/* Base Mode Color */}
        <div className={ROW_CLASS}>
          <span
            className={`${SUB_LABEL_CLASS} w-16 shrink-0 truncate`}
            title={baseMode.name}
          >
            {baseMode.name}
          </span>
          <button
            type="button"
            data-token-color-swatch="light"
            onClick={(e) => setColorAnchor({ modeId: baseMode.id, el: e.currentTarget })}
            className={`${PAINT_SWATCH_CLASS} cursor-pointer`}
            style={PAINT_SWATCH_CHECKER}
            title={baseMode.name}
            aria-label={baseMode.name}
          >
            <span className="absolute inset-0" style={{ background: lightColor }} />
          </button>
          <HexInput
            value={parsedLight.hex6}
            onChange={(hex6, alphaPct) =>
              setLightColor(composeColorAlpha(hex6, alphaPct ?? parsedLight.alphaPct))
            }
            className={PAINT_HEX_FIELD_CLASS}
            data-hex-input="token-color-light"
          />
          <div className={PAINT_ALPHA_CONTAINER_CLASS}>
            <ScrubInput
              compact
              label="%"
              value={parsedLight.alphaPct}
              min={0}
              max={100}
              onChange={(pct) => setLightColor(composeColorAlpha(parsedLight.hex6, pct))}
            />
          </div>
        </div>

        {/* Dynamic Other Modes Colors */}
        {otherModes.map((m) => {
          const modeVal = modeColors[m.id] || "";
          const effectiveColor = modeVal || lightColor;
          const parsedMode = parseColorAlpha(effectiveColor);
          return (
            <div key={m.id} className={ROW_CLASS}>
              <span className={`${SUB_LABEL_CLASS} w-16 shrink-0 truncate`} title={m.name}>
                {m.name}
              </span>
              <button
                type="button"
                data-token-color-swatch={m.id}
                onClick={(e) => setColorAnchor({ modeId: m.id, el: e.currentTarget })}
                className={`${PAINT_SWATCH_CLASS} cursor-pointer`}
                style={PAINT_SWATCH_CHECKER}
                title={m.name}
                aria-label={m.name}
              >
                <span className="absolute inset-0" style={{ background: effectiveColor }} />
              </button>
              <HexInput
                value={modeVal ? parsedMode.hex6 : ""}
                placeholder={parsedLight.hex6.toUpperCase()}
                onChange={(hex6, alphaPct) => {
                  if (!hex6) {
                    setModeColors((prev) => {
                      const next = { ...prev };
                      delete next[m.id];
                      return next;
                    });
                  } else {
                    setModeColors((prev) => ({
                      ...prev,
                      [m.id]: composeColorAlpha(hex6, alphaPct ?? parsedMode.alphaPct)
                    }));
                  }
                }}
                className={PAINT_HEX_FIELD_CLASS}
                data-hex-input={`token-color-${m.id}`}
              />
              <div className={PAINT_ALPHA_CONTAINER_CLASS}>
                <ScrubInput
                  compact
                  label="%"
                  value={modeVal ? parsedMode.alphaPct : parsedLight.alphaPct}
                  min={0}
                  max={100}
                  onChange={(pct) =>
                    setModeColors((prev) => ({
                      ...prev,
                      [m.id]: composeColorAlpha(parsedMode.hex6, pct)
                    }))
                  }
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

      {colorAnchor && (
        <ColorPanel
          title={t("paint.color")}
          paint={{
            type: "solid",
            color: colorAnchor.modeId === baseMode.id ? lightColor : (modeColors[colorAnchor.modeId] || lightColor)
          }}
          anchor={colorAnchor.el}
          zIndex="z-[90]"
          tabs={["solid"]}
          onChange={(paint) => {
            if (paint.type === "solid") {
              if (colorAnchor.modeId === baseMode.id) {
                setLightColor(paint.color);
              } else {
                setModeColors((prev) => ({
                  ...prev,
                  [colorAnchor.modeId]: paint.color
                }));
              }
            }
          }}
          onClose={() => setColorAnchor(null)}
        />
      )}
    </div>,
    document.body
  );
}
