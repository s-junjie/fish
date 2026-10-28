import { useEffect, useMemo } from "preact/hooks";
import { DesignDocument, DesignElement, SlideSpec, SlideTransition, getActivePage } from "../../core/dsl/types";
import { isContainer } from "../../core/geometry/tree-ops";
import { matchSlides } from "../../core/presentation/morph";
import { presentationFrames, nextSlideOf } from "../../core/presentation/frames";
import { resolveSlide } from "../../core/presentation/slide";
import { SLIDE_TRANSITIONS } from "../../core/dsl/schema-enums";
import { Section } from "./SectionHeader";
import { SUB_LABEL_CLASS } from "../label-tier";
import { iconCell } from "./icon-cell-style";
import { SegmentedControl } from "../SegmentedControl";
import { ScrubInput } from "../ScrubInput";
import { Select } from "../Select";
import { Button } from "../Button";
import { Eye, EyeOff } from "lucide-react";
import { t } from "../../i18n";
import { ROW_DENSE_CLASS, ROW_SPREAD_GAP_CLASS, ROW_TIGHT_CLASS } from "../row-style";

interface SlideSectionProps {
  primarySelected: DesignElement | null;
  doc: DesignDocument;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Whether the canvas is drawing the pairing lines. */
  showMorphLines?: boolean;
  onToggleMorphLines?: (val: boolean) => void;
  /** The id — on THIS slide — of the pair the pointer is on. */
  onHoverPair?: (id: string | null) => void;
  onSelectLayer?: (id: string) => void;
}

/**
 * The way a slide leaves, drawn in the five ways it can do it. Hand-built at
 * 14px the way `PresentOverlay`'s scale-mode icons are — a transition is a
 * diagram of a movement, and no icon set ships those.
 */
function TransitionIcon({ kind }: { kind: SlideTransition }) {
  const stroke = { stroke: "currentColor", strokeWidth: 1.3, fill: "none" } as const;
  const round = { strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (kind) {
    case "none":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" {...stroke} />
          <path d="M6 11L10 5" {...stroke} {...round} />
        </svg>
      );
    case "dissolve":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" {...stroke} />
          <path d="M2.5 8h11" {...stroke} strokeDasharray="2 2" />
        </svg>
      );
    case "push":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" {...stroke} />
          <path d="M6 8h5M9.5 6l2 2-2 2" {...stroke} {...round} />
        </svg>
      );
    case "slide":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16">
          <rect x="1.5" y="3" width="9" height="10" rx="1.5" {...stroke} />
          <path d="M9 8h5M12.5 5.5l2 2.5-2 2.5" {...stroke} {...round} />
        </svg>
      );
    case "morph":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16">
          <circle cx="4" cy="11" r="2" {...stroke} />
          <circle cx="12" cy="5" r="2.4" {...stroke} />
          <path d="M5.6 9.6C7 8.5 8.5 7 10.2 6.2" {...stroke} strokeDasharray="2 2" />
        </svg>
      );
  }
}

/**
 * An edge marker AND an arrow per direction — the bar for the edge the value
 * names, the arrow for the way the slide then moves. A lone arrow has to mean
 * one or the other, and the reader predicts the motion from it.
 */
const DIRECTIONS = [
  { value: "left" as const, key: "slide.fromLeft", d: "M2.5 4.5v7M5.5 8h6.5M9.5 5.5L12 8l-2.5 2.5" },
  { value: "right" as const, key: "slide.fromRight", d: "M13.5 4.5v7M4 8h6.5M6.5 5.5L4 8l2.5 2.5" },
  { value: "up" as const, key: "slide.fromAbove", d: "M4.5 2.5h7M8 5.5v6.5M5.5 9.5L8 12l2.5-2.5" },
  { value: "down" as const, key: "slide.fromBelow", d: "M4.5 13.5h7M8 4v6.5M5.5 6.5L8 4l2.5 2.5" }
];

const arrow = (d: string) => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d={d} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * How the selected frame leaves, and which of its layers travel into the next
 * slide. This is Figma Slides' own attachment: the transition belongs to the
 * slide it starts from.
 *
 * It sits at the TOP of the panel because it describes the whole slide: the
 * decision is made before the pixels are, and Figma puts its prototype panel
 * above Design for the same reason. Only a top-level frame, component,
 * componentSet or html carries it — anything else is not a slide.
 */
export function SlideSection({
  primarySelected,
  doc,
  onMutate,
  onDragStart,
  onDragEnd,
  showMorphLines = true,
  onToggleMorphLines,
  onHoverPair,
  onSelectLayer
}: SlideSectionProps) {
  const pageElements = getActivePage(doc).children ?? [];

  // Top-level, not "any container": a nested frame is not a slide, and the
  // canvas draws the pairing lines by the same rule, so the two agree about
  // what a slide is. `html` is named beside `isContainer` rather than folded
  // into it because `isContainer` is also what decides whether a node has
  // `children` — an html embed has none, and widening it would make every
  // container walk look for a child list that is not there.
  const host =
    primarySelected &&
    (isContainer(primarySelected) || primarySelected.type === "html") &&
    pageElements.some((el) => el.id === primarySelected.id)
      ? primarySelected
      : null;

  const frames = useMemo(() => (host ? presentationFrames(doc) : []), [doc, host]);
  const next = useMemo(() => (host ? nextSlideOf(frames, host.id) : null), [frames, host]);
  const match = useMemo(
    () => (host && next ? matchSlides(host, next) : null),
    // `doc` is in the key even though it is not read: `host` and `next` are
    // identified by reference, and a document updated in place would hand back
    // the same two objects with different contents and leave this stale while
    // the canvas — which does list `doc` — drew the new pairing.
    [doc, next, host]
  );

  // A selection change unmounts this section under the pointer, so no
  // `mouseleave` ever arrives to put the line out.
  useEffect(() => () => onHoverPair?.(null), [onHoverPair]);

  if (!host) return null;

  const resolved = resolveSlide(host.slide);
  // `discrete` false for the frames of a scrub: `ScrubInput` brackets those with
  // `onDragStart`/`onDragEnd`, which is what collapses a drag into ONE undo step.
  // Committing each one instead put an undo entry — and a version-timeline row —
  // behind every pointermove, so a 60px drag took fifteen ⌘Z to undo.
  const patch = (spec: SlideSpec, discrete = true) =>
    onMutate((el) => ({ ...el, slide: { ...(el as { slide?: SlideSpec }).slide, ...spec } } as DesignElement), discrete);

  return (
    <Section id="slide" title={t("slide.section")} data-inspector-section="slide">

      <div className="grid grid-cols-5 gap-1">
        {SLIDE_TRANSITIONS.map((kind) => {
          const armed = resolved.transition === kind;
          return (
            <button
              key={kind}
              type="button"
              data-slide-transition={kind}
              aria-pressed={armed}
              title={t(`slide.${kind === "slide" ? "slideOver" : kind}`)}
              aria-label={t(`slide.${kind === "slide" ? "slideOver" : kind}`)}
              className={iconCell(armed)}
              onClick={() => patch({ transition: kind })}
            >
              <TransitionIcon kind={kind} />
            </button>
          );
        })}
      </div>

      {/* Nothing below means anything for a cut, so the rows that would only
          lie — a duration nothing waits for, a direction nothing travels — are
          absent rather than disabled. */}
      {resolved.transition !== "none" && (
        <>
          {(resolved.transition === "push" || resolved.transition === "slide") && (
            <div>
              <span className={SUB_LABEL_CLASS}>{t("slide.direction")}</span>
              <div className="mt-1">
                <SegmentedControl
                  value={resolved.direction}
                  onChange={(dir) => patch({ direction: dir as SlideSpec["direction"] })}
                  items={DIRECTIONS.map(({ value, key, d }) => ({
                    value,
                    icon: arrow(d),
                    title: t(key),
                    grow: true,
                    attrs: { "data-slide-direction": value }
                  }))}
                />
              </div>
            </div>
          )}

          <div className={ROW_TIGHT_CLASS}>
            <div className="w-24 shrink-0">
              <ScrubInput
                label="ms"
                title={t("slide.duration")}
                value={resolved.durationMs}
                min={0}
                max={10000}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onChange={(ms) => patch({ durationMs: ms }, false)}
              />
            </div>
            <Select
              className="flex-1 min-w-0"
              value={resolved.easing}
              onChange={(easing) => patch({ easing: easing as SlideSpec["easing"] })}
              title={t("slide.easing")}
            >
              <option value="linear">{t("slide.linear")}</option>
              <option value="ease-in">{t("slide.easeIn")}</option>
              <option value="ease-out">{t("slide.easeOut")}</option>
              <option value="ease-in-out">{t("slide.easeInOut")}</option>
            </Select>
          </div>
        </>
      )}

      {resolved.transition === "morph" && (
        <div className="rounded-swatch bg-inset px-2 py-1.5 space-y-1">
          <div className={ROW_SPREAD_GAP_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("slide.pairs")}</span>
            <span className={ROW_DENSE_CLASS}>
              {/* Absent on the last slide: nothing follows it, so nothing to
                  turn off. */}
              {next && (
                <Button
                  size="icon"
                  data-morph-lines-toggle={showMorphLines ? "on" : "off"}
                  aria-pressed={showMorphLines}
                  title={t(showMorphLines ? "slide.hideLines" : "slide.showLines")}
                  onClick={() => onToggleMorphLines?.(!showMorphLines)}
                >
                  {showMorphLines ? <Eye size={12} /> : <EyeOff size={12} />}
                </Button>
              )}
              <span className="text-row tabular-nums text-ink">{match ? match.pairs.length : 0}</span>
            </span>
          </div>

          {!next && <p className="text-meta text-ink-muted">{t("slide.lastSlide")}</p>}

          {match && match.pairs.length === 0 && next && (
            <p className="text-meta text-ink-muted">{t("slide.noPairs")}</p>
          )}

          {match && match.pairs.length > 0 && (
            <ul className="text-meta text-ink-dim space-y-0.5">
              {match.pairs.slice(0, 8).map((pair) => (
                <li key={`${pair.fromId}-${pair.toId}`} style={{ paddingLeft: pair.depth * 8 }}>
                  {/* Selects the layer on THIS slide — the one being read. */}
                  <button
                    type="button"
                    data-morph-pair={pair.fromId}
                    className="block w-full truncate text-left cursor-default transition-colors duration-micro ease-snap hover:text-ink"
                    onMouseEnter={() => onHoverPair?.(pair.fromId)}
                    onMouseLeave={() => onHoverPair?.(null)}
                    onClick={() => onSelectLayer?.(pair.fromId)}
                  >
                    {pair.name}
                  </button>
                </li>
              ))}
              {match.pairs.length > 8 && <li className="text-ink-muted">+{match.pairs.length - 8}</li>}
            </ul>
          )}
        </div>
      )}

      {resolved.transition === "morph" && (
        <p className="text-meta text-ink-muted leading-relaxed">{t("slide.morphHint")}</p>
      )}
    </Section>
  );
}
