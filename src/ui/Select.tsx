import type { ComponentChildren, JSX } from "preact";
import { ChevronDown } from "lucide-react";

type SelectProps = {
  value: string | number;
  onChange: (value: string) => void;
  children: ComponentChildren;
  className?: string;
  title?: string;
  disabled?: boolean;
  name?: string;
} & Omit<
  JSX.HTMLAttributes<HTMLSelectElement>,
  "value" | "onChange" | "children" | "class" | "className" | "title" | "disabled" | "name"
>;

/** Native <select> with the arrow pulled back under our control:
 * appearance-none + a centered chevron pinned to the right edge.
 *
 * The box is a FIELD's box — 25px, 3px radius, `inset` fill, no border — because
 * it is one: a dropdown holding a value is the same object as a well holding a
 * number. A bordered 4px-radius box beside a ScrubInput read as a different kind
 * of control doing the same job.
 *
 * Everything else lands on the `<select>` itself, so a caller can hang a
 * `data-*` hook (the constraints axes are read that way) without a second
 * wrapper that would put the attribute on the wrong element. */
export function Select({
  value,
  onChange,
  children,
  className = "",
  title,
  disabled,
  name = "fish-select",
  ...rest
}: SelectProps) {
  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <select
        {...rest}
        name={name}
        value={value}
        title={title}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        className="w-full appearance-none h-[25px] bg-inset rounded-swatch pl-[7px] pr-6 text-row text-ink focus:outline-none cursor-default transition-colors duration-micro ease-snap disabled:opacity-50 truncate"
      >
        {children}
      </select>
      <ChevronDown size={12} className="absolute right-1.5 pointer-events-none text-ink-dim" />
    </div>
  );
}
