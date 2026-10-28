import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ColorToken, DesignDocument, Paint } from "../core/dsl/types";
import { ColorRow } from "./inspector/ColorRow";
import { ColorPanel } from "./ColorPanel";

interface ColorFieldProps {
  value: string;
  tokenId?: string;
  panelTitle?: ComponentChildren;
  doc?: DesignDocument;
  onBindToken?: (token: ColorToken) => void;
  onDetachToken?: () => void;
  onChange: (val: string, discrete?: boolean) => void;
  onCommit?: () => void;
  /** Optional undo bracket for picker drags; falls back to `onCommit`. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  className?: string;
}

/**
 * Standard inline color field used across effects, canvas background, and pattern paint.
 * Delegated to the unified `ColorRow` component for shared token binding, hex, and opacity chrome.
 */
export function ColorField({
  value,
  tokenId,
  panelTitle,
  doc,
  onBindToken,
  onDetachToken,
  onChange,
  onCommit,
  onGestureStart,
  onGestureEnd,
  className = ""
}: ColorFieldProps) {
  const [panelAnchor, setPanelAnchor] = useState<HTMLElement | null>(null);

  const solidPaint: Paint = { type: "solid", color: value, tokenId };

  return (
    <>
      <ColorRow
        color={value}
        paint={solidPaint}
        tokenId={tokenId}
        doc={doc}
        showAlpha={true}
        /* The row has no row id of its own — the field is the row — and without
           one the swatch and the alpha well carry no `data-*` hook at all, so a
           probe driving the picker this opens cannot name what it is pressing. */
        dataRowId="color-field"
        onChange={(nextColor, _alpha, discrete) => onChange(nextColor, discrete)}
        onCommit={onCommit}
        onGestureStart={onGestureStart}
        onGestureEnd={onGestureEnd}
        onOpenColorPanel={(anchor) => setPanelAnchor((cur) => (cur ? null : anchor))}
        onBindToken={onBindToken}
        onDetachToken={onDetachToken}
        className={className}
      />

      {panelAnchor && (
        <ColorPanel
          title={panelTitle}
          paint={solidPaint}
          anchor={panelAnchor}
          doc={doc}
          /* No kind switcher: this field stores ONE colour (a pattern's
             foreground, a shadow's tint, the canvas). Offering Gradient / Image
             / Pattern here let the panel switch to a paint this field cannot
             keep, and the write below drops everything but `solid` — so the
             panel showed a choice that silently did nothing. Kind is the fill
             stack's question, asked one level up. */
          tabs={[]}
          onChange={(nextPaint, discrete) => {
            if (nextPaint.type === "solid") {
              onChange(nextPaint.color, discrete);
            }
          }}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd ?? onCommit}
          onClose={() => setPanelAnchor(null)}
        />
      )}
    </>
  );
}
