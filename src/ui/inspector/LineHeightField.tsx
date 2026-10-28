import { useRef } from "preact/hooks";
import type { LineHeight } from "../../core/dsl/types";
import { resolveDynamicLineHeight } from "../../core/compile";
import { evaluateMathExpression } from "../math-expression";
import { ScrubInput } from "../ScrubInput";
import { t } from "../../i18n";

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface LineHeightFieldProps {
  value?: LineHeight;
  fontSize: number;
  mixed?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onChange: (value: LineHeight | undefined) => void;
  tokenName?: string;
  onDetachToken?: () => void;
  onOpenTokenPicker?: (anchor: HTMLElement) => void;
}

/**
 * Line height reads the way Figma writes it: a bare number is a fixed PIXEL
 * height, and a trailing `%` is a multiple of the size (`100%` = `1×`).
 *
 * The DSL keeps CSS's convention instead (a unitless `<number>` is the multiple,
 * `"24px"` is absolute) — only the SPELLING differs, and the field's unit is
 * TYPED rather than chosen from a menu. That is the one thing `ScrubInput` cannot
 * do on its own, so this is a thin wrapper around it: it hands over the number in
 * the value's own unit, teaches `parse` to split a trailing `%` off the draft, and
 * turns the reported unit back into a DSL value. Scrubbing, the arrow keys, the
 * calculator and the mixed state are all `ScrubInput`'s.
 */
export function LineHeightField({
  value,
  fontSize,
  mixed,
  onDragStart,
  onDragEnd,
  onChange,
  tokenName,
  onDetachToken,
  onOpenTokenPicker
}: LineHeightFieldProps) {
  const percent = typeof value === "number";
  const shown = value === undefined ? undefined : percent ? round2((value as number) * 100) : Number.parseFloat(value as string);
  // Set only by a TYPED commit (via `onUnit`), and read in the `onChange` that
  // follows it — so a typed `%` or `px` flips the unit while a drag or a bare
  // number keeps the current one.
  const typedUnit = useRef<string | null>(null);

  return (
    <ScrubInput
      label="LH"
      value={shown}
      mixed={mixed}
      placeholder={t("typography.lineHeightAuto")}
      // From Auto a drag starts at the engine's own size-tiered default.
      defaultVal={Math.round(resolveDynamicLineHeight(fontSize))}
      min={0}
      unit={percent ? "%" : ""}
      tokenName={tokenName}
      onDetachToken={onDetachToken}
      onOpenTokenPicker={onOpenTokenPicker}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      parse={(raw, currentUnit) => {
        const s = raw.trim();
        // A trailing `%` or `px` spells the unit explicitly; a bare number (the
        // calculator still works) inherits whatever unit the field already has,
        // so `24` while showing `%` is 24% — not a revert to the other unit.
        const suffixed = s.endsWith("%") ? "%" : s.toLowerCase().endsWith("px") ? "px" : null;
        const body = suffixed ? s.slice(0, s.length - suffixed.length) : s;
        const num = evaluateMathExpression(body);
        return num === null ? null : { value: num, unit: suffixed ?? currentUnit };
      }}
      onUnit={(u) => {
        typedUnit.current = u;
      }}
      onChange={(n) => {
        const asPercent = (typedUnit.current ?? (percent ? "%" : "px")) === "%";
        typedUnit.current = null;
        if (n <= 0) {
          onChange(undefined);
          return;
        }
        onChange(asPercent ? round2(n / 100) : (`${round2(n)}px` as LineHeight));
      }}
      trailing={
        percent ? <span className="flex-none pr-[6px] text-meta select-none text-ink-muted">%</span> : undefined
      }
    />
  );
}
