import type { ComponentChildren } from "preact";
import { LEADER_RULE_CLASS, SectionHeaderLabel } from "../inspector/SectionHeader";

/**
 * The labelled band that opens a rail section (Pages, Layers).
 *
 * The heading itself — the label and the fold chevron in the gutter to its
 * left — is `SectionHeaderLabel`, shared with the inspector, so the two rails
 * cannot drift apart on where a label sits or which way its chevron points.
 * What is left here is the band's own geometry, which is the rail's: a 12px
 * gutter it shares with the tabs and the layer rows, and `pt-3 pb-2` rather
 * than an inspector section's 15/7.
 *
 * One definition, two call sites: the Pages band adds a trailing `+`, the
 * Layers band adds a collapse-all, and neither should have to restate the
 * leader rule.
 */
export function RailSectionHeader({
  label,
  collapsed,
  onToggle,
  trailing,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  trailing?: ComponentChildren;
}) {
  return (
    <div className="relative flex items-center gap-2.5 pl-3 pr-2.5 pb-2 pt-3 shrink-0">
      <SectionHeaderLabel label={label} collapsed={collapsed} onToggle={onToggle} />
      <span aria-hidden="true" className={LEADER_RULE_CLASS} />
      {trailing}
    </div>
  );
}
