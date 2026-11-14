import { useState } from "preact/hooks";

import type { ColorToken, ColorTokenValue, DocumentMode, TokenAliasRef } from "../../core/dsl/types";
import { isTokenAliasRef, rawTokenSlot, type TokenLookup } from "../../core/dsl/token-value";
import { DEFAULT_MODES, getColorTokenModeColor } from "../../core/interactions/mode-ops";
import { DEFAULT_ELEMENT_COLOR } from "../../core/dsl/defaults";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { composeColorAlpha, parseColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { useDraftHistory } from "../hooks/useDraftHistory";
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
  color: ColorTokenValue;
  modes?: Record<string, ColorTokenValue | undefined>;
  darkColor?: ColorTokenValue;
  description: string;
}

interface TokenEditorPanelProps {
  /** `null` creates; an existing token edits in place. */
  token: ColorToken | null;
  tokens?: TokenLookup;
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
  onAlpha,
  onDragStart,
  onDragEnd
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
  onAlpha: (pct: number, discrete?: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
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
        <ScrubInput
          compact
          label="%"
          value={alphaPct}
          min={0}
          max={100}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={onAlpha}
        />
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
  tokens,
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

  const [colorAnchor, setColorAnchor] = useState<{ modeId: string; el: HTMLElement } | null>(null);

  const {
    value: draft,
    set: setDraft,
    startGesture,
    endGesture
  } = useDraftHistory(() => {
    const initialModeColors: Record<string, string> = {};
    const initialAliases: Record<string, TokenAliasRef> = {};
    if (token) {
      const rawBase = rawTokenSlot(token, baseMode.id, baseMode.id);
      if (isTokenAliasRef(rawBase)) initialAliases[baseMode.id] = rawBase;
    }
    for (const m of otherModes) {
      if (token?.modes?.[m.id] !== undefined) {
        initialModeColors[m.id] = getColorTokenModeColor(token, m.id, tokens);
        if (isTokenAliasRef(token.modes[m.id])) initialAliases[m.id] = token.modes[m.id] as TokenAliasRef;
      } else if (m.id === "dark" && (token as any)?.darkColor) {
        initialModeColors[m.id] = (token as any).darkColor;
      }
    }
    return {
      name: token?.name ?? initialName ?? "",
      description: token?.description ?? "",
      lightColor: token ? colorTokenColor(token, baseMode.id, tokens) : initialColor ?? DEFAULT_ELEMENT_COLOR,
      modeColors: initialModeColors,
      preservedAliases: initialAliases
    };
  });

  const { name, description, lightColor, modeColors, preservedAliases } = draft;
  const parsedLight = parseColorAlpha(lightColor);

  const withoutAlias = (aliases: Record<string, TokenAliasRef>, modeId: string) => {
    if (!(modeId in aliases)) return aliases;
    const next = { ...aliases };
    delete next[modeId];
    return next;
  };
  const setName = (next: string) => setDraft((d) => ({ ...d, name: next }), true);
  const setDescription = (next: string) => setDraft((d) => ({ ...d, description: next }), true);
  const setLightColor = (value: string, discrete = true) =>
    setDraft(
      (d) => ({
        ...d,
        lightColor: value,
        preservedAliases: withoutAlias(d.preservedAliases, baseMode.id)
      }),
      discrete
    );
  const setModeColor = (modeId: string, value: string | undefined, discrete = true) =>
    setDraft((d) => {
      const next = { ...d.modeColors };
      if (value === undefined) delete next[modeId];
      else next[modeId] = value;
      return {
        ...d,
        modeColors: next,
        preservedAliases: withoutAlias(d.preservedAliases, modeId)
      };
    }, discrete);

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
            setLightColor(composeColorAlpha(hex6, alphaPct ?? parsedLight.alphaPct), true)
          }
          onAlpha={(pct, discrete) =>
            setLightColor(composeColorAlpha(parsedLight.hex6, pct), discrete)
          }
          onDragStart={startGesture}
          onDragEnd={endGesture}
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
              if (!hex6) setModeColor(m.id, undefined, true);
              else setModeColor(m.id, composeColorAlpha(hex6, alphaPct ?? parsedMode.alphaPct), true);
            }}
            onAlpha={(pct, discrete) =>
              setModeColor(m.id, composeColorAlpha(parsedMode.hex6, pct), discrete)
            }
            onDragStart={startGesture}
            onDragEnd={endGesture}
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
      onSubmit={() => {
        const nextModes: Record<string, ColorTokenValue | undefined> = {};
        for (const m of otherModes) {
          if (preservedAliases[m.id]) nextModes[m.id] = preservedAliases[m.id];
          else if (modeColors[m.id]) nextModes[m.id] = modeColors[m.id];
        }
        onSave({
          name: name.trim(),
          color: preservedAliases[baseMode.id] ?? lightColor,
          modes: nextModes,
          darkColor: nextModes["dark"],
          description: description.trim()
        });
      }}
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
          onGestureStart={startGesture}
          onGestureEnd={endGesture}
          onChange={(paint, discrete) => {
            if (paint.type !== "solid") return;
            if (colorAnchor.modeId === baseMode.id) setLightColor(paint.color, discrete);
            else setModeColor(colorAnchor.modeId, paint.color, discrete);
          }}
          onClose={() => setColorAnchor(null)}
        />
      )}
    </TokenEditorDialog>
  );
}
