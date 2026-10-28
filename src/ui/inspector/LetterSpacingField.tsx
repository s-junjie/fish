import { useRef } from "preact/hooks";
import type { LetterSpacing } from "../../core/dsl/types";
import { evaluateMathExpression } from "../math-expression";
import { ScrubInput } from "../ScrubInput";

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface LetterSpacingFieldProps {
  value?: LetterSpacing;
  mixed?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onChange: (value: LetterSpacing | undefined) => void;
  tokenName?: string;
  onDetachToken?: () => void;
  onOpenTokenPicker?: (anchor: HTMLElement) => void;
}

/**
 * Letter spacing reads the way Figma writes it: a bare number is PIXELS, and a
 * trailing `%` is a fraction of the size (`5%` = `0.05em`).
 *
 * The DSL keeps CSS's spelling instead (a bare number is px, `"0.05em"` is the
 * relative form) — only the relative unit is spelled differently, and the field's
 * unit is TYPED rather than chosen from a menu. That is the one thing `ScrubInput`
 * cannot do on its own, so this is a thin wrapper around it: it hands over the
 * number in the value's own unit, teaches `parse` to split a trailing `%` off the
 * draft, and turns the reported unit back into a DSL value. Scrubbing, the arrow
 * keys, the calculator and the mixed state are all `ScrubInput`'s.
 *
 * Unlike line height, `0` and a NEGATIVE tracking are real values (tight
 * setting), so nothing here is cleared on zero.
 */
export function LetterSpacingField({
  value,
  mixed,
  onDragStart,
  onDragEnd,
  onChange,
  tokenName,
  onDetachToken,
  onOpenTokenPicker
}: LetterSpacingFieldProps) {
  const percent = typeof value === "string" && value.endsWith("em");
  const shown =
    value === undefined
      ? 0
      : percent
        ? round2(Number.parseFloat(value as string) * 100)
        : typeof value === "number"
          ? value
          : Number.parseFloat(value);
  // Set only by a TYPED commit (via `onUnit`), and read in the `onChange` that
  // follows it — so a typed `%` flips the unit while a drag keeps the current one.
  const typedUnit = useRef<string | null>(null);

  return (
    <ScrubInput
      label="LS"
      value={shown}
      mixed={mixed}
      min={percent ? -100 : undefined}
      unit={percent ? "%" : ""}
      tokenName={tokenName}
      onDetachToken={onDetachToken}
      onOpenTokenPicker={onOpenTokenPicker}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      parse={(raw) => {
        const s = raw.trim();
        const pct = s.endsWith("%");
        const num = evaluateMathExpression(pct ? s.slice(0, -1) : s);
        return num === null ? null : { value: num, unit: pct ? "%" : "" };
      }}
      onUnit={(u) => {
        typedUnit.current = u;
      }}
      onChange={(n) => {
        const asPercent = (typedUnit.current ?? (percent ? "%" : "")) === "%";
        typedUnit.current = null;
        onChange(asPercent ? (`${round2(n / 100)}em` as LetterSpacing) : round2(n));
      }}
      trailing={
        percent ? <span className="flex-none pr-[6px] text-meta select-none text-ink-muted">%</span> : undefined
      }
    />
  );
}
