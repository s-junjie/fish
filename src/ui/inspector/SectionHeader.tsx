import { useEffect, useState } from "preact/hooks";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ComponentChildren, JSX } from "preact";

export const LEADER_RULE_CLASS =
  "flex-1 h-px bg-gradient-to-r from-rule-strong to-transparent";

// Uppercase 9px micro labels sit 1px high in their line box; shift down onto the row axis.
export const MICRO_LABEL_AXIS_CLASS = "translate-y-px";

// Module-level so fold state survives selection changes and section remounts within the session.
const collapsedIds = new Set<string>(["link"]);
const collapsedListeners = new Set<() => void>();

function setCollapsed(id: string, collapsed: boolean) {
  if (collapsedIds.has(id) === collapsed) return;
  if (collapsed) collapsedIds.add(id);
  else collapsedIds.delete(id);
  for (const listener of collapsedListeners) listener();
}

function useSectionCollapsed(id: string): [boolean, () => void] {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    collapsedListeners.add(listener);
    return () => {
      collapsedListeners.delete(listener);
    };
  }, []);
  return [collapsedIds.has(id), () => setCollapsed(id, !collapsedIds.has(id))];
}

export function SectionHeaderLabel({
  label,
  headerId,
  collapsed,
  onToggle
}: {
  label: ComponentChildren;
  headerId?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      data-inspector-header={headerId}
      data-collapsed={collapsed ? "true" : undefined}
      className="group relative flex items-center shrink-0 text-ink-muted hover:text-ink transition-colors duration-micro ease-snap cursor-default"
    >
      <span
        aria-hidden="true"
        className={`absolute -left-3 flex h-4 w-3 items-center justify-center transition-opacity duration-micro ease-snap ${
          collapsed
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      >
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
      </span>
      <span className={`text-micro uppercase text-ink-muted ${MICRO_LABEL_AXIS_CLASS}`}>{label}</span>
    </button>
  );
}

function SectionHeaderRow({
  label,
  headerId,
  collapsed,
  onToggle,
  trailing,
  className = ""
}: {
  label: ComponentChildren;
  headerId: string;
  collapsed: boolean;
  onToggle: () => void;
  trailing?: ComponentChildren;
  className?: string;
}) {
  return (
    <div
      className={`relative flex items-center gap-2.5 pt-[15px] pb-[7px] select-none ${className}`.trim()}
    >
      <SectionHeaderLabel
        label={label}
        headerId={headerId}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      <span aria-hidden="true" className={LEADER_RULE_CLASS} />
      {/* Zero-height wrapper keeps taller trailing buttons from expanding the header row height. */}
      {trailing ? <span className="flex h-0 shrink-0 items-center">{trailing}</span> : null}
    </div>
  );
}

export function Section({
  id,
  title,
  trailing,
  className = "space-y-2",
  header = true,
  children,
  ...rest
}: {
  id: string;
  title: ComponentChildren;
  trailing?: ComponentChildren;
  className?: string;
  header?: boolean;
  children: ComponentChildren;
} & Omit<JSX.HTMLAttributes<HTMLDivElement>, "id" | "title" | "children" | "className">) {
  const [collapsed, toggle] = useSectionCollapsed(id);
  return (
    <div className={className} {...rest}>
      {header && (
        <SectionHeaderRow
          label={title}
          headerId={id}
          collapsed={collapsed}
          onToggle={toggle}
          trailing={trailing}
        />
      )}
      {header && collapsed ? null : children}
    </div>
  );
}
