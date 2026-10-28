import { parseColorAlpha } from "../core/geometry/color-utils";
import { t } from "../i18n";
import { Button } from "./Button";
import { ScrubInput, TEXT_FIELD_CLASS } from "./ScrubInput";
import { HexInput } from "./HexInput";
import { Select } from "./Select";
import { Pipette } from "lucide-react";
import { ColorNotation, COLOR_NOTATIONS, applyChannel, notationChannels, notationLabel } from "./color-model";
import { ROW_DENSE_CLASS, ROW_TIGHT_CLASS } from "./row-style";

/**
 * The colour's VALUE, in whichever notation is armed.
 *
 * Two rows, and the split is the design rather than a consequence of width:
 *
 *   row 1 — how this colour is NAMED (the notation) and how transparent it is
 *   row 2 — the numbers themselves
 *
 * A three-channel notation plus an alpha readout plus an eyedropper is five
 * controls, and five controls do not fit a 240px panel on one line: the three
 * channel wells come to ~46px each, which is narrower than `255` at `readout`
 * with its key beside it. Splitting them also means the notation never MOVES
 * when the channel count changes between HEX (one field) and the three-channel
 * models — it stays on its own row, so the eye re-finds it in the same place.
 *
 * The channel wells are `ScrubInput`, which is why each key (`R`, `H`, `L`) is
 * also a drag handle: one gesture, one grip, the same rule the colour rail
 * follows. The suite reads them through `data-scrub-field`, the hook `ScrubInput`
 * has always exposed for its key.
 */
export function ColorValueFields({
  notation,
  onNotationChange,
  color,
  onHexChange,
  onAlphaChange,
  onGestureStart,
  onGestureEnd,
  onPickFromScreen,
  hexInputAttrs
}: {
  notation: ColorNotation;
  onNotationChange: (next: ColorNotation) => void;
  /** The stored colour, any format. Alpha is read from it rather than passed twice. */
  color: string;
  /** `alphaPct` is set only when the edit carried an explicit alpha (`#RGBA`).
   *  `discrete` separates the hex field, which commits one whole edit, from a
   *  channel scrub, whose frames the gesture bracket collapses into one. */
  onHexChange: (hex6: string, alphaPct?: number, discrete?: boolean) => void;
  onAlphaChange: (pct: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onPickFromScreen?: () => void;
  /** The suite's `data-*` hooks, so a caller can keep naming its own field. */
  hexInputAttrs?: Record<string, string>;
}) {
  const parsed = parseColorAlpha(color);
  const channels = notationChannels(notation, parsed.hex6);

  return (
    <div className="space-y-1.5">
      <div className={ROW_TIGHT_CLASS}>
        {/* A `Select`, not a menu: the notation is the value the picker is
            currently IN, re-read on every keystroke — the same relationship the
            gradient dialect above it has. A menu row is a command that fires
            once, which is not what this is. */}
        <Select
          className="flex-1 min-w-0"
          data-color-notation="1"
          value={notation}
          onChange={(next) => onNotationChange(next as ColorNotation)}
          title={t("colorNotation.label")}
        >
          {COLOR_NOTATIONS.map((n) => (
            <option key={n} value={n} data-notation={n}>
              {notationLabel(n)}
            </option>
          ))}
        </Select>
        <div className="w-[68px] shrink-0">
          <ScrubInput
            label="%"
            value={Math.round(parsed.alphaPct)}
            min={0}
            max={100}
            onChange={onAlphaChange}
            onDragStart={onGestureStart}
            onDragEnd={onGestureEnd}
          />
        </div>
        {onPickFromScreen && (
          <Button size="icon" type="button" onClick={onPickFromScreen} title={t("paint.eyedropper")}>
            <Pipette size={12} />
          </Button>
        )}
      </div>

      {notation === "hex" ? (
        <HexInput
          {...hexInputAttrs}
          value={parsed.hex6}
          onChange={onHexChange}
          /* `TEXT_FIELD_CLASS` rather than a hand-rolled well. The box this
             replaces was `bg-inset rounded-ctl px-2 py-1` with no focus ring:
             4px where every other field is 3px, and no ring, so the one field
             being typed into was the only one in the app that gave no sign it
             had focus. */
          className={`${TEXT_FIELD_CLASS} uppercase tabular-nums text-left`}
        />
      ) : (
        <div className={ROW_DENSE_CLASS}>
          {channels.map((channel, i) => (
            <ScrubInput
              key={channel.key}
              label={channel.key}
              value={channel.value}
              min={channel.min}
              max={channel.max}
              onChange={(next) => onHexChange(applyChannel(notation, parsed.hex6, i, next), undefined, false)}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd}
              className="flex-1 min-w-0"
            />
          ))}
        </div>
      )}
    </div>
  );
}