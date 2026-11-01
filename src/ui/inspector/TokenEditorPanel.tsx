import { useState } from "preact/hooks";

import type { ColorToken, DocumentMode } from "../../core/dsl/types";
import { DEFAULT_MODES, getColorTokenModeColor } from "../../core/interactions/mode-ops";
import { DEFAULT_ELEMENT_COLOR } from "../../core/dsl/defaults";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { composeColorAlpha, parseColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { ColorPanel } from "../ColorPanel";
import { HexInput } from "../HexInput";
import { ScrubInput } from "../ScrubInput";
import {
  PAINT_ALPHA_CONTAINER_CLASS,
  PAINT_HEX_FIELD_CLASS,
  PAINT_SWATCH_CHECKER,
  PAINT_SWATCH_CLASS
} from "./paint-row-style";
import { TokenEditorDialog, type TokenEditorRow } from "./TokenEditorDialog";

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

/** The colour axis' value control: swatch, hex, alpha — three columns of one line. */
function ColorValue({
  modeId,
  label,
  swatchColor,
  hex,
  placeholder,
  alphaPct,
  onPick,
  onHex,
  onAlpha
}: {
  modeId: string;
  /** The mode's name — the swatch's accessible name, not its hex. */
  label: string;
  swatchColor: string;
  hex: string;
  placeholder?: string;
  alphaPct: number;
  onPick: (modeId: string, el: HTMLElement) => void;
  onHex: (hex6: string, alphaPct?: number) => void;
  onAlpha: (pct: number) => void;
}) {
  return (
    <>
      <button
        type="button"
        data-token-color-swatch={modeId}
        onClick={(e) => onPick(modeId, e.currentTarget)}
        className={`${PAINT_SWATCH_CLASS} cursor-pointer`}
        style={PAINT_SWATCH_CHECKER}
        title={label}
        aria-label={label}
      >
        <span className="absolute inset-0" style={{ background: swatchColor }} />
      </button>
      <HexInput
        value={hex}
        placeholder={placeholder}
        onChange={(nextHex, nextAlpha) => onHex(nextHex, nextAlpha)}
        className={PAINT_HEX_FIELD_CLASS}
        data-hex-input={`token-color-${modeId}`}
      />
      <div className={PAINT_ALPHA_CONTAINER_CLASS}>
        <ScrubInput compact label="%" value={alphaPct} min={0} max={100} onChange={onAlpha} />
      </div>
    </>
  );
}

/**
 * The floating editor for a color token, supporting the base mode and dynamic
 * custom theme modes.
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

  const parsedLight = parseColorAlpha(lightColor);
  const setModeColor = (modeId: string, value: string | undefined) =>
    setModeColors((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[modeId];
      else next[modeId] = value;
      return next;
    });

  const rows: TokenEditorRow[] = [
    {
      key: baseMode.id,
      label: baseMode.name,
      control: (
        <ColorValue
          modeId={baseMode.id}
          label={baseMode.name}
          swatchColor={lightColor}
          hex={parsedLight.hex6}
          alphaPct={parsedLight.alphaPct}
          onPick={(modeId, el) => setColorAnchor({ modeId, el })}
          onHex={(hex6, alphaPct) =>
            setLightColor(composeColorAlpha(hex6, alphaPct ?? parsedLight.alphaPct))
          }
          onAlpha={(pct) => setLightColor(composeColorAlpha(parsedLight.hex6, pct))}
        />
      )
    },
    ...otherModes.map((m) => {
      const modeVal = modeColors[m.id] || "";
      const effectiveColor = modeVal || lightColor;
      const parsedMode = parseColorAlpha(effectiveColor);
      return {
        key: m.id,
        label: m.name,
        control: (
          <ColorValue
            modeId={m.id}
            label={m.name}
            swatchColor={effectiveColor}
            hex={modeVal ? parsedMode.hex6 : ""}
            placeholder={parsedLight.hex6.toUpperCase()}
            alphaPct={modeVal ? parsedMode.alphaPct : parsedLight.alphaPct}
            onPick={(modeId, el) => setColorAnchor({ modeId, el })}
            onHex={(hex6, alphaPct) => {
              if (!hex6) setModeColor(m.id, undefined);
              else setModeColor(m.id, composeColorAlpha(hex6, alphaPct ?? parsedMode.alphaPct));
            }}
            onAlpha={(pct) => setModeColor(m.id, composeColorAlpha(parsedMode.hex6, pct))}
          />
        )
      };
    })
  ];

  return (
    <TokenEditorDialog
      ariaLabel={token ? t("tokens.editToken") : t("tokens.newToken")}
      panelAttr={{ "data-token-editor": "1", "data-token-editor-panel": "1" }}
      fieldScope="token-editor"
      anchorRef={anchorRef}
      deps={[token?.id ?? "new"]}
      fallbackHeight={240}
      hostSelector="[data-color-token-picker], [data-host-popover], [data-style-picker-popover]"
      name={{
        value: name,
        placeholder: t("tokens.namePlaceholder"),
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
          color: lightColor,
          modes: modeColors,
          darkColor: modeColors["dark"] || undefined,
          description: description.trim()
        })
      }
      onClose={onClose}
      keepOpenFor={["[data-color-panel]"]}
      nestedOpen={() => Boolean(colorAnchor)}
    >
      {colorAnchor && (
        <ColorPanel
          title={t("paint.color")}
          paint={{
            type: "solid",
            color:
              colorAnchor.modeId === baseMode.id
                ? lightColor
                : modeColors[colorAnchor.modeId] || lightColor
          }}
          anchor={colorAnchor.el}
          zIndex="z-[90]"
          tabs={["solid"]}
          onChange={(paint) => {
            if (paint.type !== "solid") return;
            if (colorAnchor.modeId === baseMode.id) setLightColor(paint.color);
            else setModeColor(colorAnchor.modeId, paint.color);
          }}
          onClose={() => setColorAnchor(null)}
        />
      )}
    </TokenEditorDialog>
  );
}
