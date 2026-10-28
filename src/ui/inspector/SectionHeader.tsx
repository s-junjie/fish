/**
 * The one place an inspector group is written: its heading AND its body.
 *
 * There were nineteen copies of the same class string, which is why the panel
 * read as undifferentiated: every header was 11px, semibold, uppercase and the
 * same colour as the field labels underneath, so nothing told the eye where one
 * group ended and the next began. `text-micro` is the fix — 9px with 0.18em
 * tracking, a full step below `text-ui`.
 *
 * The label is followed by a **leader rule** that fades out to the right. That
 * is an engineering-drawing convention, not decoration: it draws the group
 * boundary as a measured span rather than relying on a full-width `border-b`,
 * which is why the panel now reads as a set of labelled compartments instead of
 * a stack of boxes. The fade is deliberate — a hard rule competes with the
 * label, a dissolving one groups without asserting an edge.
 *
 * `Section` is the call site: it owns the heading, the body, and the fold that
 * decides whether the body is drawn at all. The two were separate siblings
 * (`<SectionHeader>` then the body) until a group could be collapsed — at which
 * point the header would have had to name a body it could not reach, and the
 * two would have had to agree on a key by hand. One component owns both, so the
 * compiler is what keeps them together: `title` is required, so a call site that
 * forgets to move its label is an error rather than a header with no name.
 *
 * The heading is not the inspector's alone: `SectionHeaderLabel` is what the
 * left column's Pages and Layers bands draw too, because a label whose caps sit
 * where its chevron expects them is a property of `text-micro`, not of a panel.
 */
import { useEffect, useState } from "preact/hooks";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ComponentChildren, JSX } from "preact";

/**
 * The engineering-drawing leader rule that closes a section label.
 *
 * Exported as a class so there is exactly ONE definition: the inspector's
 * section headers, the Pages header and the Layers header all draw it, and
 * three copies would drift. `rule-strong` anchors it at the label and it
 * dissolves across the remaining width — a hard rule would compete with the
 * label, a dissolving one groups without asserting an edge.
 *
 * It is a real element rather than a `::after` because the fade needs a
 * gradient, and it is a Tailwind gradient rather than an inline
 * `linear-gradient(90deg, #333338, transparent)` because the inline form
 * spells the hex out and no theme change could reach it.
 */
export const LEADER_RULE_CLASS =
  "flex-1 h-px bg-gradient-to-r from-rule-strong to-transparent";

/**
 * What puts a `micro` label's caps on the axis everything beside it is centred
 * on.
 *
 * A heading row centres its items on the label's LINE BOX, and the label is
 * UPPERCASE, so it never draws a descender: at `text-micro`'s 9px with
 * `line-height: 1` the caps occupy 6.34px of the box and the 2.3px below the
 * baseline that no glyph reaches — a quarter of the box — drag the caps'
 * optical centre 1px ABOVE the box centre. Measured on the built shell at 3×:
 * the fold chevron, the leader rule and a header's trailing control were each
 * 0.83px low against the label.
 *
 * The LABEL moves onto the row's axis rather than five pieces of chrome moving
 * off it: the box centre is the one reference every item in the row already
 * honours, so a control added to a heading later is aligned without being told
 * anything, and the gutter arithmetic above stays out of it. An integer
 * translate, not a fraction, because it leaves 0.17px of residue and
 * rasterises crisply.
 */
export const MICRO_LABEL_AXIS_CLASS = "translate-y-px";

/**
 * Which groups the reader has folded shut, for this session.
 *
 * Module-level rather than `useState` inside `Section`, because the panel KEYS
 * two of its sections on the selection (`TransformSection`, `AutoLayoutSection`)
 * — a flag owned by the section would be thrown away and re-created the moment
 * another layer was picked, so a group folded on one layer would spring back
 * open on the next, which reads as the chevron not working. Keyed by the
 * section's stable `id`, the fold belongs to the panel's layout and survives
 * both a remount and a selection change.
 *
 * Not persisted, for the reason the left rail's bands are not: a remembered
 * "collapsed" is an empty-looking panel on the next open with nothing on screen
 * to explain it.
 */
const collapsedIds = new Set<string>();
const collapsedListeners = new Set<() => void>();

function setCollapsed(id: string, collapsed: boolean) {
  // A no-op when the state already matches: the click handler is a toggle on
  // read state, and notifying on a no-op would re-render the whole panel.
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

/**
 * The heading itself: the micro label, and the chevron that folds the group it
 * names.
 *
 * One definition, two rails. The inspector's `Section` and the left column's
 * `RailSectionHeader` said the same thing twice — the inspector's copy simply
 * arrived second — and a label aligned in one of them is a label misaligned in
 * the other.
 *
 * The chevron hangs in the 12px gutter BOTH rails put their content on (`px-3`
 * in either panel), so the label starts on the edge the tabs and the rows share
 * instead of 17px further in. It stays hidden until the pointer is over the
 * label, because a permanent chevron competes with a strip whose whole job is
 * to be a heading — and it is always drawn once the group is COLLAPSED, because
 * a folded group with no visible affordance is a dead end. Hovering the
 * chevron itself keeps it shown: the span is a child of the button even though
 * it sits outside the button's box, and `:hover` follows the descendant, not
 * the geometry.
 */
export function SectionHeaderLabel({
  label,
  headerId,
  collapsed,
  onToggle
}: {
  label: ComponentChildren;
  /** The e2e hook (`[data-inspector-header="fills"]`); the rails name none. */
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
      {/* `uppercase` is Tailwind's STOCK utility, paired with `text-micro`, and
          that is deliberate rather than incidental — two attempts to fold the
          transform into the token failed silently:
            - `textTransform` inside a `fontSize` tuple is dropped by Tailwind 3
              without warning, so the token looked configured and rendered mixed
              case;
            - a named `textTransform` scale (`{ micro: "uppercase" }`) emits NO
              utility at all in this build, verified against an isolated config.
          Both are LESSONS §31's shape: a declaration that compiles to nothing.
          The rule to keep: a micro label is 9px + wide tracking + UPPERCASE, and
          all three must be visible in the markup to be reviewable. */}
      <span className={`text-micro uppercase text-ink-muted ${MICRO_LABEL_AXIS_CLASS}`}>{label}</span>
    </button>
  );
}

/**
 * The heading row. Private: a call site writes `Section`, which owns the fold
 * this row's button drives, and a second public spelling of the row would be a
 * header nothing could collapse.
 */
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
  /** A control that closes the header — a plus, a style picker, an eye. */
  trailing?: ComponentChildren;
  className?: string;
}) {
  return (
    /* `pt-[15px] pb-[7px]` is the WHOLE gap between one group and the next, and
       it is the reference layout's own `.ann` padding. Asymmetric on purpose:
       the label belongs to what FOLLOWS it, so it sits closer to its group than
       to the group above. `pt-3 pb-2` was 12/8 — the same shape, a third less
       pronounced, which is why a group boundary read as if it might belong to
       either side. */
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
      {/* The trailing control must not be able to move the gap the padding
          above just fixed. A 20px button in the row is 11px taller than the 9px
          label, so every header carrying one pushed its group down by 11px and
          no two headers agreed. It is wrapped in a ZERO-HEIGHT, vertically
          centred box: still a flex item, so the leader rule ends before it, but
          its own box adds nothing to the row. Headers are 31px either way. */}
      {trailing ? <span className="flex h-0 shrink-0 items-center">{trailing}</span> : null}
    </div>
  );
}

/**
 * A labelled group that folds.
 *
 * `id` is the fold's identity and the e2e hook (`[data-inspector-header="fills"]`),
 * so it is required: two groups that forgot to name themselves would fold as
 * one, and a probe could only find them by their label text — which is
 * translated, and changes with the selection.
 *
 * It renders the group's own box, and takes over the container the call site
 * already had — `className` carries that container's classes and any other prop
 * lands on it, so `space-y-3` (`CanvasBackgroundSection`), `select-none`
 * (`LocalStylesSection`), `flex flex-col` (`AdjustRows`) and the
 * `data-inspector-section` probes the e2e suites read by name all move onto the
 * group rather than staying on a div wrapped around it. One box, one owner of
 * the rhythm: the group's `space-y-*` spaces the heading from the body, and the
 * stack above spaces one group from the next.
 *
 * One call site passes an EMPTY `className` on purpose — `ComponentSection`
 * renders inside `InspectorPanel`'s own unwrapped `data-inspector-section`
 * wrapper, so its rows have never been given a gap and a `space-y-2` here would
 * silently loosen the component group.
 *
 * `header` exists for one other call site and is not a general escape hatch.
 * `AutoLayoutSection` draws its LAYOUT heading only when one of the three
 * halves it unites is present, and a polygon in path-edit mode reaches it with
 * none of them — rendering its side-count row with no heading above it. That
 * state is preserved as it was rather than quietly given a heading it never
 * had; with no heading there is nothing to press, so `children` always render.
 */
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
