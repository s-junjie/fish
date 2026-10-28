import type { ComponentChildren, JSX } from "preact";

type FieldDropdownProps = {
  children: ComponentChildren;
  /** `p-1` for a list of options; `p-3` for a block of controls. */
  padding?: "p-1" | "p-3";
  className?: string;
} & Omit<
  JSX.HTMLAttributes<HTMLDivElement>,
  "children" | "class" | "className"
>;

export function FieldDropdown({
  padding = "p-1",
  className = "",
  children,
  ...rest
}: FieldDropdownProps) {
  return (
    <div
      {...rest}
      className={`absolute left-0 right-0 top-full mt-1 z-50 origin-top bg-panel border border-rule rounded-panel shadow-popover animate-pop-in ${padding} ${className}`.trim()}
    >
      {children}
    </div>
  );
}
