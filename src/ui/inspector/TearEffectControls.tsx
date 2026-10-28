import type { ComponentChildren } from "preact";
import type { EdgeInsets, EdgeProfile, EdgeSide, TearEffect, TearForm } from "../../core/dsl/types";
import { EDGE_PROFILES, EDGE_SIDES, TEAR_FORMS } from "../../core/dsl/schema-enums";
import { tearWithProfile } from "../../core/dsl/normalize/tear";
import { holeInsetsOf } from "../../core/geometry/edge-hole";
import { SegmentedControl } from "../SegmentedControl";
import { Select } from "../Select";
import { ScrubInput } from "../ScrubInput";
import {
  Dices,
  Link2,
  Unlink,
  ArrowUp,
  ArrowRight,
  ArrowDown,
  ArrowLeft,
  ArrowUpFromLine,
  ArrowRightFromLine,
  ArrowDownFromLine,
  ArrowLeftFromLine
} from "lucide-react";
import { t } from "../../i18n";

/** Which of the three forms; absent in the document means `"edge"`. */
const FORMS = TEAR_FORMS;

/**
 * Which edge the break replaces, as the segment icons read it: the line sits on
 * that edge, the arrow points into the box it cuts into.
 */
const SIDE_ICON: Record<EdgeSide, ComponentChildren> = {
  top: <ArrowDownFromLine size={13} strokeWidth={1.75} />,
  right: <ArrowLeftFromLine size={13} strokeWidth={1.75} />,
  bottom: <ArrowUpFromLine size={13} strokeWidth={1.75} />,
  left: <ArrowRightFromLine size={13} strokeWidth={1.75} />
};

/**
 * The four margins, in the order the tuple stores them (`EDGE_SIDES` is TRBL).
 *
 * Each arrow points the way its margin pushes: the top margin pushes DOWN into
 * the sheet, the left one pushes right. An arrow pointing at its own edge would
 * be labelling the edge, which is the one thing the field does not set.
 */
const INSET_ICON: Record<EdgeSide, ComponentChildren> = {
  top: <ArrowDown size={11} strokeWidth={1.75} />,
  right: <ArrowLeft size={11} strokeWidth={1.75} />,
  bottom: <ArrowUp size={11} strokeWidth={1.75} />,
  left: <ArrowRight size={11} strokeWidth={1.75} />
};

/**
 * The same break in the other form.
 *
 * Entering the closed form drops everything only an open break owns — a side, a
 * position across it, its two ends — so a hole document never carries a value
 * its own form cannot read; leaving it puts back the side a break cannot do
 * without.
 */
function tearWithForm(ef: TearEffect, form: TearForm): TearEffect {
  const { form: _form, ...rest } = ef;
  // Every form's settings stay in the slot: flipping must not cost the author
  // their margins or their position. Only the edge form needs something the
  // loops never had — a side.
  if (form === "edge") return { ...rest, side: ef.side ?? "right" };
  return { ...rest, form };
}

/**
 * The two ends of a break sit on the sides ADJACENT to it: a left/right break
 * runs top to bottom, a top/bottom break runs left to right. Naming the ends by
 * those sides is what makes "move this end in from the edge" unambiguous.
 */
const EDGE_ENDS: Record<EdgeSide, [EdgeSide, EdgeSide]> = {
  top: ["left", "right"],
  bottom: ["left", "right"],
  right: ["top", "bottom"],
  left: ["top", "bottom"]
};

/** A position across the axis, as the field reads it: distance in from the edge. */
function atToPct(at: number, side: EdgeSide): number {
  const along = side === "right" || side === "bottom" ? 1 - at : at;
  return Math.round(along * 100);
}

function pctToAt(pct: number, side: EdgeSide): number {
  const frac = Math.min(100, Math.max(0, Math.round(pct))) / 100;
  return side === "right" || side === "bottom" ? 1 - frac : frac;
}

/**
 * "One value" or "one per side/end" — a chain, not a viewfinder.
 *
 * The glyph states which of the two the field is in: a whole chain for values
 * that move together, a broken one for values that do not. `Scan` said "look at
 * this" to nobody in particular.
 */
function SplitToggle({ pressed, title, onToggle }: { pressed: boolean; title: string; onToggle: () => void }) {
  const Icon = pressed ? Unlink : Link2;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      aria-label={title}
      onClick={onToggle}
      className={`shrink-0 h-[25px] w-[25px] flex items-center justify-center rounded-swatch transition-colors ${
        pressed ? "bg-brand-wash text-brand" : "bg-field ring-1 ring-inset ring-rule text-ink-dim"
      }`}
    >
      <Icon size={13} strokeWidth={1.75} />
    </button>
  );
}

export interface EdgeEffectControlsProps {
  effect: TearEffect;
  /** The layer's box: the hole's margins are a length of it. */
  box?: { w: number; h: number };
  onChange: (next: TearEffect, commit?: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

/**
 * Every control an `edge` effect has, in the panel that opens from its row.
 *
 * The two forms share the profile, the scale, the fibres and the seed; they do
 * NOT share a frame. A break is anchored to a side and has two ends; a hole has
 * no side at all — it is a loop with four margins — so the row that picks an
 * edge simply does not exist in that form, rather than sitting there doing
 * nothing.
 */
export function TearEffectControls({ effect, box, onChange, onDragStart, onDragEnd }: EdgeEffectControlsProps) {
  const form = effect.form ?? "edge";
  const loop = form !== "edge";
  const insets: EdgeInsets = box ? holeInsetsOf(effect, box.w, box.h) : [0, 0, 0, 0];
  const splitInset = Array.isArray(effect.inset);
  const side = effect.side ?? "right";

  const setInsetSlot = (slot: number, v: number) => {
    const next = insets.slice() as EdgeInsets;
    next[slot] = Math.max(0, Math.round(v));
    onChange({ ...effect, inset: next });
  };

  /** Collapsing four margins keeps the tightest one, which is the only value
   *  that still describes a margin the loop respects on every side. */
  const toggleInsetSplit = () =>
    onChange({ ...effect, inset: splitInset ? Math.min(...insets) : ([...insets] as EdgeInsets) }, true);

  const atPair = Array.isArray(effect.at) ? effect.at : null;
  const atOne = typeof effect.at === "number" ? effect.at : undefined;
  const defaultAt = side === "right" || side === "bottom" ? 1 : 0;
  const [endA, endB] = EDGE_ENDS[side];

  return (
    <div className="space-y-2.5" data-tear-controls="1">
      <SegmentedControl<TearForm>
        className="w-full"
        value={form}
        rowProps={{ "data-tear-form": "1" }}
        items={FORMS.map((f) => ({
          value: f,
          label: t(`tear.form.${f}`),
          title: t(`tear.formHint.${f}`),
          grow: true
        }))}
        onChange={(next) => onChange(tearWithForm(effect, next), true)}
      />

      <Select
        className="w-full"
        value={effect.profile}
        title={t("tear.profileHint")}
        onChange={(profile) => onChange(tearWithProfile(effect, profile as EdgeProfile), true)}
      >
        {EDGE_PROFILES.map((profile) => (
          <option key={profile} value={profile}>
            {t(`tear.profile.${profile}`)}
          </option>
        ))}
      </Select>

      {!loop && (
        <SegmentedControl<EdgeSide>
          className="w-full"
          value={side}
          items={EDGE_SIDES.map((s) => ({
            value: s,
            icon: SIDE_ICON[s],
            title: t(`tear.sideShort.${s}`),
            grow: true
          }))}
          onChange={(next) => onChange({ ...effect, side: next }, true)}
        />
      )}

      <div className="space-y-1">
        {loop && (
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0">
              {splitInset ? (
                <div className="grid grid-cols-4 gap-1">
                  {EDGE_SIDES.map((s, slot) => (
                    <ScrubInput
                      key={s}
                      label={INSET_ICON[s]}
                      title={t(`tear.insetSide.${s}`)}
                      value={Math.round(insets[slot])}
                      min={0}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      onChange={(v) => setInsetSlot(slot, v)}
                    />
                  ))}
                </div>
              ) : (
                <ScrubInput
                  label={t("tear.inset")}
                  title={t("tear.insetHint")}
                  value={Math.round(insets[0])}
                  min={0}
                  max={100}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onChange={(v) => onChange({ ...effect, inset: Math.max(0, Math.round(v)) })}
                />
              )}
            </div>
            <SplitToggle
              pressed={splitInset}
              title={splitInset ? t("tear.insetSingle") : t("tear.insetSplit")}
              onToggle={toggleInsetSplit}
            />
          </div>
        )}
        {!loop && (
          <>
            <div className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                {atPair ? (
                  <div className="grid grid-cols-2 gap-1">
                    <ScrubInput
                      label={t(`tear.sideShort.${endA}`)}
                      title={t("tear.endHint")}
                      value={atToPct(atPair[0], side)}
                      min={0}
                      max={100}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      onChange={(v) => onChange({ ...effect, at: [pctToAt(v, side), atPair[1]] } as TearEffect)}
                    />
                    <ScrubInput
                      label={t(`tear.sideShort.${endB}`)}
                      title={t("tear.endHint")}
                      value={atToPct(atPair[1], side)}
                      min={0}
                      max={100}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      onChange={(v) => onChange({ ...effect, at: [atPair[0], pctToAt(v, side)] } as TearEffect)}
                    />
                  </div>
                ) : (
                  <ScrubInput
                    label={t("tear.position")}
                    title={t("tear.atHint")}
                    value={atToPct(atOne ?? defaultAt, side)}
                    min={0}
                    max={100}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onChange={(v) => {
                      // The field reads "how far from the chosen edge", which is
                      // the direction a user thinks in; `at` is stored along the
                      // box axis, so the two run opposite on a right/bottom
                      // break. The default writes the key OUT.
                      const at = pctToAt(v, side);
                      onChange({ ...effect, ...(at === defaultAt ? { at: undefined } : { at }) } as TearEffect);
                    }}
                  />
                )}
              </div>
              <SplitToggle
                pressed={!!atPair}
                title={atPair ? t("tear.positionSingle") : t("tear.positionEnds")}
                onToggle={() => {
                  if (atPair) {
                    const one = atPair[0];
                    onChange({ ...effect, ...(one === defaultAt ? { at: undefined } : { at: one }) } as TearEffect, true);
                    return;
                  }
                  const one = atOne ?? defaultAt;
                  onChange({ ...effect, at: [one, one] } as TearEffect, true);
                }}
              />
            </div>
          </>
        )}
        <ScrubInput
          label={t("tear.scale")}
          title={t("tear.scaleHint")}
          value={effect.scale}
          min={0}
          max={900}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(scale) => onChange({ ...effect, scale: Math.round(scale) } as TearEffect)}
        />
        {effect.profile === "torn" && (
          <>
            <ScrubInput
              label={t("tear.roughness")}
              title={t("tear.roughnessHint")}
              value={Math.round(effect.roughness * 100)}
              min={0}
              max={100}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onChange({ ...effect, roughness: Math.round(v) / 100 } as TearEffect)}
            />
            <ScrubInput
              label={t("tear.fiber")}
              title={t("tear.fiberHint")}
              value={Math.round(effect.fiber * 100)}
              min={0}
              max={100}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onChange({ ...effect, fiber: Math.round(v) / 100 } as TearEffect)}
            />
          </>
        )}
      </div>

      <div className="flex items-center gap-1">
        <div className="flex-1 min-w-0">
          <ScrubInput
            label={t("tear.seed")}
            title={t("tear.seedHint")}
            value={effect.seed}
            min={0}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChange={(seed) => onChange({ ...effect, seed: Math.max(0, Math.round(seed)) } as TearEffect)}
          />
        </div>
        <button
          type="button"
          className="shrink-0 h-[25px] w-[25px] flex items-center justify-center rounded-swatch bg-field ring-1 ring-inset ring-rule text-ink-dim"
          title={t("tear.reroll")}
          onClick={() =>
            // One click, one different break. The value lands in the document
            // immediately — this is authoring, not rendering, so the
            // determinism contract is untouched.
            onChange({ ...effect, seed: Math.floor(Math.random() * 0x7fffffff) }, true)
          }
        >
          <Dices size={13} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
