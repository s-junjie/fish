import { DEFAULT_DASH, Stroke } from "../../core/dsl/types";
import { SegmentedControl } from "../SegmentedControl";
import { ScrubInput } from "../ScrubInput";
import { t } from "../../i18n";
import { SUB_LABEL_CLASS } from "../label-tier";

/**
 * The stroke settings that describe the LINE rather than the paint: cap, join,
 * miter limit and the dash pattern.
 *
 * Split out of `StrokeSection` because they are the only stroke controls that do
 * not appear on the collapsed row, so folding them into that file would bury the
 * per-side weight grid under a fourth sibling list of unrelated inputs.
 */

interface StrokeLineControlsProps {
  stroke: Stroke;
  /** Applies a patch. `discrete` means "one undo step", used for enum toggles. */
  onChange: (patch: Partial<Stroke>, discrete: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Cap and join only mean something where a line can end or turn. */
  showCapJoin: boolean;
}

/**
 * What the Solid / Dashed switch reads as.
 *
 * `dashArray` is the setting and `style` is only its shorthand, so a pattern wins
 * in both directions: `style: "solid"` with a real pattern on it still dashes, and
 * an empty one is solid whatever the style says.
 */
const isDashed = (s: Stroke): boolean =>
  (s.dashArray && s.dashArray.length > 0 && s.dashArray.some((v) => v > 0)) ||
  (s.style === "dashed" && !(s.dashArray && s.dashArray.length > 0));

export function StrokeLineControls({
  stroke,
  onChange,
  onDragStart,
  onDragEnd,
  showCapJoin
}: StrokeLineControlsProps) {
  const dashed = isDashed(stroke);
  const pattern = stroke.dashArray && stroke.dashArray.length > 0 ? stroke.dashArray : [...DEFAULT_DASH];
  const odd = pattern.length % 2 === 1;
  /** Dash and gap slots pair up; an odd pattern has one unmatched length. */
  const dash = pattern[0] ?? 0;
  const gap = pattern[1] ?? 0;

  // ScrubInput already brackets its own value changes with onDragStart/onDragEnd,
  // so this must not open or close another gesture around them.
  const setPattern = (next: number[]) =>
    onChange({ dashArray: next, style: next.length > 0 ? "dashed" : "solid" }, false);

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <span className={SUB_LABEL_CLASS}>{t("paint.style")}</span>
        <SegmentedControl<string>
          className="w-full"
          value={dashed ? "dashed" : "solid"}
          onChange={(v) =>
            onChange(
              v === "dashed"
                ? { dashArray: [...DEFAULT_DASH], style: "dashed" }
                : { dashArray: undefined, dashOffset: undefined, style: "solid" },
              true
            )
          }
          items={[
            { value: "solid", label: t("paint.styleSolid"), grow: true },
            { value: "dashed", label: t("paint.styleDashed"), grow: true }
          ]}
        />
      </div>

      {dashed && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <ScrubInput
              label={t("paint.dash")}
              value={Math.round(dash * 100) / 100}
              min={0}
              onDragStart={onDragStart}
              onDragEnd={() => {
                onDragEnd();
              }}
              onChange={(v) => setPattern([v, gap])}
              title={t("paint.dash")}
            />
            <ScrubInput
              label={t("paint.gap")}
              value={Math.round(gap * 100) / 100}
              min={0}
              onDragStart={onDragStart}
              onDragEnd={() => {
                onDragEnd();
              }}
              onChange={(v) => setPattern([dash, v])}
              title={t("paint.gap")}
            />
          </div>
          <ScrubInput
            label={t("paint.dashOffset")}
            value={Math.round((stroke.dashOffset ?? 0) * 100) / 100}
            onDragStart={onDragStart}
            onDragEnd={() => {
              onDragEnd();
            }}
            onChange={(v) => onChange({ dashOffset: v }, false)}
            title={t("paint.dashOffset")}
          />
          {odd && <div className={SUB_LABEL_CLASS}>{t("paint.dashOddHint")}</div>}
        </div>
      )}

      {showCapJoin && (
        <>
          {/* Cap and join are the two places a stroke's ENDS and its TURNS are
              drawn differently, so each option explains itself on hover. */}
          <div className="space-y-1">
            <span className={SUB_LABEL_CLASS}>{t("paint.cap")}</span>
            <SegmentedControl<string>
              className="w-full"
              value={stroke.cap ?? "butt"}
              onChange={(v) => onChange({ cap: v as Stroke["cap"] }, true)}
              items={[
                { value: "butt", label: t("paint.capButt"), grow: true, title: t("paint.capButtHint") },
                { value: "round", label: t("paint.capRound"), grow: true, title: t("paint.capRoundHint") },
                { value: "square", label: t("paint.capSquare"), grow: true, title: t("paint.capSquareHint") }
              ]}
            />
          </div>

          <div className="space-y-1">
            <span className={SUB_LABEL_CLASS}>{t("paint.join")}</span>
            <SegmentedControl<string>
              className="w-full"
              value={stroke.join ?? "miter"}
              onChange={(v) => onChange({ join: v as Stroke["join"] }, true)}
              items={[
                { value: "miter", label: t("paint.joinMiter"), grow: true, title: t("paint.joinMiterHint") },
                { value: "round", label: t("paint.joinRound"), grow: true, title: t("paint.joinRoundHint") },
                { value: "bevel", label: t("paint.joinBevel"), grow: true, title: t("paint.joinBevelHint") }
              ]}
            />
          </div>

          {(stroke.join ?? "miter") === "miter" && (
            <ScrubInput
              label={t("paint.miterLimit")}
              value={stroke.miterLimit ?? 4}
              min={1}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onChange({ miterLimit: v }, false)}
              title={t("paint.miterLimitHint")}
            />
          )}
        </>
      )}
    </div>
  );
}
