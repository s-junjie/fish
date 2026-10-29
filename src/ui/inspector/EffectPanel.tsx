import { useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { DesignDocument, Effect, LiquidGlassEffect } from "../../core/dsl/types";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { findNumberToken } from "../../core/interactions/number-token-ops";
import { LIQUID_GLASS_PARAMS } from "../../core/dsl/liquid-glass";
import type { TearEffect } from "../../core/dsl/types";
import { TearEffectControls } from "./TearEffectControls";
import { ColorField } from "../ColorField";
import { ScrubInput } from "../ScrubInput";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { effectLabel } from "../EffectRows";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { t } from "../../i18n";

const PANEL_WIDTH = 268;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

export interface EffectPanelProps {
  effect: Effect;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  anchor: HTMLElement | null;
  onClose: () => void;
  onChange: (next: Effect, commit?: boolean) => void;
  onCommit?: () => void;
  /** The undo stream for a token edit saved from its token picker. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  isText?: boolean;
  /** The layer's box, for the fields whose default is a length of it. */
  box?: { w: number; h: number };
}

export function EffectPanel({
  effect,
  doc,
  docRef,
  anchor,
  onClose,
  onChange,
  onCommit,
  onCommitSnapshot,
  onGestureStart,
  onGestureEnd,
  isText,
  box
}: EffectPanelProps) {
  const [tokenPicker, setTokenPicker] = useState<{
    prop: "offsetX" | "offsetY" | "blur" | "spread";
    anchor: HTMLElement;
  } | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [anchor, effect.type],
    compute: (anchorEl, panel) => {
      const a = anchorEl.getBoundingClientRect();
      if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) return null;
      const host = anchorEl.closest("[data-host-popover], [data-style-picker-popover]");
      const bounds = host ? host.getBoundingClientRect() : a;
      let left = bounds.left - PANEL_WIDTH - ANCHOR_GAP;
      if (left < VIEWPORT_MARGIN) {
        left = Math.min(bounds.right + ANCHOR_GAP, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN);
      }
      left = Math.max(VIEWPORT_MARGIN, left);

      const height = panel.offsetHeight || 300;
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

  useDismiss(true, onClose, panelRef, anchorRef, [
    "[data-color-panel]",
    "[data-color-token-picker]",
    "[data-number-token-picker]",
    "[data-number-token-editor-panel]"
  ]);

  const isShadow = effect.type === "drop-shadow" || effect.type === "inner-shadow";
  /**
   * Only a text's DROP shadow lacks spread: it paints as a CSS `text-shadow`,
   * which has no spread term. A text's inner shadow is still an SVG filter, where
   * spread is real, so it keeps the field.
   */
  const hasSpread = !(isText && effect.type === "drop-shadow");

  const effectDoc = docRef?.current || doc;
  const tokenNameFor = (prop: string) =>
    effectDoc && (effect as any).tokenBindings?.[prop]
      ? findNumberToken(effectDoc.tokens ?? [], (effect as any).tokenBindings[prop])?.name
      : undefined;
  const detachTokenFor = (prop: string) => {
    if (!(effect as any).tokenBindings?.[prop]) return undefined;
    return () => {
      const { [prop]: _, ...rem } = (effect as any).tokenBindings || {};
      onChange({ ...effect, tokenBindings: Object.keys(rem).length > 0 ? rem : undefined } as any, true);
    };
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      data-effect-panel="1"
      data-inspector-activity="true"
      style={placementStyle(pos, PANEL_WIDTH)}
      className="fixed z-[60] bg-panel border border-rule-strong rounded-pill shadow-popover p-2.5 space-y-2.5 text-ui text-ink select-none animate-pop-in"
    >
      <PanelHeader
        title={effectLabel(
          effect.type,
          effect.type === "tear" ? effect.profile : undefined,
          effect.type === "tear" ? effect.form : undefined
        )}
        onClose={onClose}
        className="pb-1.5 border-b border-rule"
      />

      {/* Content */}
      {isShadow && (
        <div className="space-y-2.5">
          <ColorField
            value={effect.color}
            tokenId={(effect as any).tokenId}
            doc={doc}
            onBindToken={(token) => {
              if (docRef && !docRef.current.tokens?.some((t) => t.id === token.id)) {
                docRef.current = addTokenToDoc(docRef.current, token);
              }
              onChange({ ...effect, color: colorTokenColor(token, effectDoc?.activeTheme), tokenId: token.id }, true);
            }}
            onDetachToken={() => {
              const { tokenId: _tokenId, ...rest } = effect as any;
              onChange(rest, true);
            }}
            onChange={(color) => onChange({ ...effect, color })}
            onCommit={onCommit}
            onGestureStart={onGestureStart}
            onGestureEnd={onGestureEnd}
          />
          {/* Two columns, never four: at four a field in this 268px popover is
              59px wide, and the key, the well's padding and the token trigger
              leave ~11px for the value — one and a half digits. Two columns give
              X/Y and B/S one row each and ~118px per field, which holds a signed
              four-digit offset with the trigger still in the flow. */}
          <div className={`grid ${hasSpread ? "grid-cols-2" : "grid-cols-3"} gap-1`}>
            <ScrubInput
              label="X"
              value={effect.offset.x}
              tokenName={tokenNameFor("offsetX")}
              onDetachToken={detachTokenFor("offsetX")}
              onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "offsetX", anchor })}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd}
              onChange={(x) => onChange({ ...effect, offset: { ...effect.offset, x } })}
            />
            <ScrubInput
              label="Y"
              value={effect.offset.y}
              tokenName={tokenNameFor("offsetY")}
              onDetachToken={detachTokenFor("offsetY")}
              onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "offsetY", anchor })}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd}
              onChange={(y) => onChange({ ...effect, offset: { ...effect.offset, y } })}
            />
            <ScrubInput
              label="B"
              value={effect.blur}
              min={0}
              title={t("effects.blurLabel")}
              tokenName={tokenNameFor("blur")}
              onDetachToken={detachTokenFor("blur")}
              onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "blur", anchor })}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd}
              onChange={(blur) => onChange({ ...effect, blur })}
            />
            {hasSpread && (
              <ScrubInput
                label="S"
                value={effect.spread ?? 0}
                title={t("effects.spreadLabel")}
                tokenName={tokenNameFor("spread")}
                onDetachToken={detachTokenFor("spread")}
                onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "spread", anchor })}
                onDragStart={onGestureStart}
                onDragEnd={onGestureEnd}
                onChange={(spread) => onChange({ ...effect, spread })}
              />
            )}
          </div>
        </div>
      )}

      {(effect.type === "layer-blur" || effect.type === "backdrop-blur") && (
        <ScrubInput
          label={t("effects.blurLabel")}
          value={effect.blur}
          min={0}
          tokenName={tokenNameFor("blur")}
          onDetachToken={detachTokenFor("blur")}
          onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "blur", anchor })}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
          onChange={(blur) => onChange({ ...effect, blur })}
        />
      )}

      {effect.type === "tear" && (
        <TearEffectControls
          effect={effect}
          box={box}
          onChange={onChange}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
        />
      )}

      {effect.type === "liquid-glass" && (
        <div className="space-y-1">
          {LIQUID_GLASS_PARAMS.map((spec) => (
            <div key={spec.key} className={spec.key === "lightAngle" ? "pt-1 border-t border-rule" : ""}>
              <ScrubInput
                label={t(spec.labelKey)}
                value={effect[spec.key] ?? spec.def}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                onDragStart={onGestureStart}
                onDragEnd={onGestureEnd}
                onChange={(v) => onChange({ ...effect, [spec.key]: v } as LiquidGlassEffect)}
              />
            </div>
          ))}
        </div>
      )}

      {tokenPicker && effectDoc && (
        <NumberTokenPicker
          doc={effectDoc}
          docRef={docRef}
          anchor={tokenPicker.anchor}
          category="effect"
          boundTokenId={effect.tokenBindings?.[tokenPicker.prop]}
          currentValue={
            tokenPicker.prop === "offsetX"
              ? (effect as any).offset?.x ?? 0
              : tokenPicker.prop === "offsetY"
              ? (effect as any).offset?.y ?? 0
              : tokenPicker.prop === "blur"
              ? (effect as any).blur ?? 0
              : (effect as any).spread ?? 0
          }
          onSelect={(token) => {
            if (docRef && !docRef.current.tokens?.some((t) => t.id === token.id)) {
              docRef.current = addTokenToDoc(docRef.current, token);
            }
            const nextBindings = { ...((effect as any).tokenBindings || {}), [tokenPicker.prop]: token.id };
            if (tokenPicker.prop === "offsetX") {
              onChange({ ...effect, offset: { ...(effect as any).offset, x: token.value }, tokenBindings: nextBindings } as any, true);
            } else if (tokenPicker.prop === "offsetY") {
              onChange({ ...effect, offset: { ...(effect as any).offset, y: token.value }, tokenBindings: nextBindings } as any, true);
            } else if (tokenPicker.prop === "blur") {
              onChange({ ...effect, blur: token.value, tokenBindings: nextBindings } as any, true);
            } else if (tokenPicker.prop === "spread") {
              onChange({ ...effect, spread: token.value, tokenBindings: nextBindings } as any, true);
            }
            setTokenPicker(null);
          }}
          onDetach={() => {
            const { [tokenPicker.prop]: _, ...rem } = (effect as any).tokenBindings || {};
            onChange({ ...effect, tokenBindings: Object.keys(rem).length > 0 ? rem : undefined } as any, true);
            setTokenPicker(null);
          }}
          onCommitSnapshot={onCommitSnapshot}
          onClose={() => setTokenPicker(null)}
        />
      )}
    </div>,
    document.body
  );
}
