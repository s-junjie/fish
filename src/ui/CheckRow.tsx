import type { JSX } from "preact";
import { Check } from "lucide-react";
import { SUB_LABEL_CLASS } from "./label-tier";

interface CheckRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  title?: string;
  testId?: string;
  disabled?: boolean;
}

/**
 * A labelled checkbox row: the box is drawn, the input is not.
 *
 * The native control is `sr-only` rather than hidden so it keeps its place in
 * the tab order and still reports to a screen reader; the visible box is a
 * 14px `ctl` chip that fills `brand` when armed, which is the same "armed =
 * amber" reading the dock's tool slots use.
 *
 * It exists as a component because the drawing had already been written once,
 * inline, in the inspector's appearance section — and the label is a row's
 * control, so it wears the sub-label tier (`SUB_LABEL_CLASS`) whether it sits in
 * the inspector or in a popover.
 */
export function CheckRow({
  checked,
  onChange,
  label,
  title,
  testId,
  disabled
}: CheckRowProps): JSX.Element {
  return (
    <label
      className={`flex items-center gap-2 select-none group${disabled ? " opacity-50" : " cursor-pointer"}`}
      title={title}
    >
      <input
        type="checkbox"
        className="sr-only"
        data-check-row={testId}
        name={testId || "check-row"}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <div
        className={`w-3.5 h-3.5 flex-none rounded-ctl border flex items-center justify-center transition-colors duration-micro ease-snap ${
          checked
            ? "bg-brand border-brand text-brand-ink"
            : "bg-surface border-rule-strong group-hover:border-rule text-transparent"
        }`}
      >
        <Check size={10} strokeWidth={2.5} />
      </div>
      <span className={SUB_LABEL_CLASS}>{label}</span>
    </label>
  );
}