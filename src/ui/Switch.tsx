import type { JSX } from "preact";

/**
 * A single on/off control: a 26×14 track with a 10px square knob.
 *
 * Square, not round, for the reason `SliderRow`'s knob is: this workbench reads
 * as an instrument, and a pill-and-circle switch reads as a consumer setting.
 * The armed track is `brand` with a `brand-ink` knob — the same amber-on-dark
 * pairing the dock's armed slots use, so "on" looks the same everywhere.
 *
 * It is a `button` with `role="switch"` rather than a checkbox: the control is a
 * single binary, and a checkbox would need a label of its own beside a row that
 * already has one.
 */
export function Switch({
  checked,
  onChange,
  title,
  disabled,
  ...rest
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  disabled?: boolean;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "title" | "disabled">) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[14px] w-[26px] flex-none rounded-full ring-1 ring-inset transition-colors duration-micro ease-snap cursor-default disabled:opacity-50 ${
        checked ? "bg-brand ring-brand" : "bg-field ring-rule hover:ring-rule-strong"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[10px] w-[10px] rounded-sm transition-colors duration-micro ease-snap ${
          checked ? "left-[14px] bg-brand-ink" : "left-[2px] bg-ink-muted"
        }`}
      />
    </button>
  );
}
