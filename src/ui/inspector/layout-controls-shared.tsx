import type { FrameElement } from "../../core/dsl/types";
import type { TrackSize } from "../../core/dsl/types";
import { trackFr, trackPx } from "../../core/layout/grid-layout";
import { ScrubInput } from "../ScrubInput";
import { t } from "../../i18n";
import { PadMode, PadModeSegmented, PadTuple, PaddingFields } from "./pad-fields";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_DENSE_CLASS, ROW_SPREAD_CLASS } from "../row-style";

export type LayoutMode = "free" | "vertical" | "horizontal" | "grid";

/* Matches the section-header add button exactly: a 20px square with a
   4px radius. They sit in the same column, so a size or radius
   difference between them reads as two different kinds of control. */
const STEPPER_BTN = "w-5 h-5 flex items-center justify-center rounded-ctl bg-raised border border-rule-strong text-ink-dim hover:text-ink text-ui leading-none transition-colors duration-micro ease-snap";

export const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A track list resized to `count`.
 *
 * `columnSizes` is what the layout pass counts, so a stepper that wrote only
 * `columns` was editing a number nothing reads: the count went up while the
 * children and the track fields stayed put.
 *
 * A px list is scaled back to the content box afterwards — px tracks that merely
 * gained one would push the last track past the frame instead of sharing the
 * room with it. An `fr` list is not scaled: a weight is already a share of
 * whatever is there, so a new track takes one share and the rest keep theirs.
 */
export function refitTracks(sizes: TrackSize[], count: number, content: number, gap: number): TrackSize[] {
  const next: TrackSize[] =
    count <= sizes.length
      ? sizes.slice(0, count)
      : [...sizes, ...new Array(count - sizes.length).fill(trackFr(sizes[sizes.length - 1]) > 0 ? { fr: 1 } : mean(sizes))];
  if (next.some((t) => typeof t !== "number")) return next;
  const px = next as number[];
  const target = Math.max(0, content - Math.max(0, count - 1) * gap);
  const total = px.reduce((a, b) => a + b, 0);
  if (total <= 0 || target <= 0) return px.map(round2);
  return px.map((s) => round2((s * target) / total));
}

/**
 * The track list as rows of two, each entry carrying the index its track stores
 * under. The ROW is what a track's unit menu hangs from: a menu anchored to a
 * 29px button can only hang off one of the panel's two edges and overflow the
 * other, while a row is the panel's own inner width.
 */
export const pairs = (list: TrackSize[]): { track: TrackSize; index: number }[][] => {
  const rows: { track: TrackSize; index: number }[][] = [];
  list.forEach((track, index) => {
    if (index % 2 === 0) rows.push([{ track, index }]);
    else rows[rows.length - 1].push({ track, index });
  });
  return rows;
};

const mean = (sizes: TrackSize[]): number =>
  sizes.reduce<number>((sum, s) => sum + (trackPx(s) ?? 0), 0) / Math.max(1, sizes.length);

export function StepperRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Which count this is, for the tests that have to press the steppers. */
  axis: string;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** `discrete` is the buttons' half of the contract: a press is one command,
      while the scrub beside them is bracketed and must stay transient. */
  onChange: (v: number, discrete?: boolean) => void;
}) {
  const step = (d: number) =>
    props.onChange(Math.min(props.max, Math.max(props.min, Math.round(props.value) + d)), true);
  return (
    <div className={ROW_SPREAD_CLASS} data-stack-count={props.axis}>
      <span className={SUB_LABEL_CLASS}>{props.label}</span>
      <div className={ROW_DENSE_CLASS}>
        <div className="w-14">
          <ScrubInput
            label=""
            value={props.value}
            min={props.min}
            max={props.max}
            step={1}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onChange={props.onChange}
          />
        </div>
        <button type="button" className={STEPPER_BTN} onClick={() => step(-1)} aria-label="-1">−</button>
        <button type="button" className={STEPPER_BTN} onClick={() => step(1)} aria-label="+1">+</button>
      </div>
    </div>
  );
}

/**
 * The padding block both layout panels end with.
 *
 * It was spelled out once per panel — same `data-stack-spacing` hook, same mode
 * segment, same fields — so a change to one silently left the other behind. The
 * token binding is the only difference: flex binds gap and padding to number
 * tokens, grid does not yet.
 */
export function LayoutPaddingBlock({
  frame,
  pad,
  padMode,
  setPaddingMode,
  onDragStart,
  onDragEnd,
  onLayout,
  token,
  onOpenTokenPicker,
  onDetachToken
}: {
  frame: FrameElement;
  pad: PadTuple;
  padMode: PadMode;
  setPaddingMode: (m: PadMode) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onLayout: (patch: { padding: PadTuple }, commit?: boolean, tokenBindingsPatch?: Record<string, string | undefined>) => void;
  token?: { boundId?: string; name?: string; onDetach: () => void };
  onOpenTokenPicker?: (anchor: HTMLElement) => void;
  onDetachToken?: () => void;
}) {
  return (
    <div className="space-y-1.5" data-stack-spacing="padding">
      <div className={ROW_SPREAD_CLASS}>
        <span className={`${SUB_LABEL_CLASS} block`}>{t("stack.padding")}</span>
        <PadModeSegmented value={padMode} onChange={setPaddingMode} />
      </div>
      <PaddingFields
        pad={pad}
        mode={padMode}
        elementId={frame.id}
        kind="padding"
        tokenName={token && padMode === "1" ? token.name : undefined}
        onOpenTokenPicker={onOpenTokenPicker}
        onDetachToken={token?.boundId && onDetachToken ? onDetachToken : undefined}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onChange={(next) => onLayout({ padding: next }, false, { padding: undefined })}
      />
    </div>
  );
}
