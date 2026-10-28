import { Paint, PatternMotif, PatternPaint, PatternTileType } from "../core/dsl/types";
import { PATTERN_MOTIFS } from "../core/dsl/schema-enums";
import { patternCssBackground, isStripeMotif } from "../core/geometry/pattern-tile";
import { ColorField } from "./ColorField";
import { CheckRow } from "./CheckRow";
import { ScrubInput } from "./ScrubInput";
import { SegmentedControl } from "./SegmentedControl";
import { SUB_LABEL_CLASS } from "./label-tier";
import { t } from "../i18n";

const NUMBER_ROW = "flex items-center gap-1.5 shrink-0";
const NUMBER_FIELD = "w-full";

/**
 * The body of a pattern layer: which motif, how big one cell is, and the two
 * colours. Every control writes the paint whole — a pattern has no sub-state
 * that could be edited in place without re-deriving the tile.
 */
export function PatternPaintBody({
  paint,
  onChange,
  onGestureStart,
  onGestureEnd
}: {
  paint: PatternPaint;
  onChange: (paint: Paint, discrete?: boolean) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}) {
  const set = (patch: Partial<PatternPaint>, discrete = false) =>
    onChange({ ...paint, ...patch } as Paint, discrete);

  const swatch = (motif: PatternMotif): string =>
    motif === paint.motif
      ? patternCssBackground(paint)
      : patternCssBackground({
        ...paint,
        motif,
        tile: { width: 8, height: 8 },
        scale: 1,
        spacing: undefined,
        weight: 2
      });

  const backgroundOn = typeof paint.background === "string";

  /**
   * A staggered layout needs a tile to stagger. Stripes have none, and
   * crosshatch's tile sides are its stripe lattice — offsetting it would open a
   * seam — so those keep the rectangular layout and the control stays hidden.
   */
  const hexCapable = paint.motif !== "diagonal-stripes" && paint.motif !== "crosshatch";

  return (
    <>
      <div className="shrink-0 space-y-1.5">
        <span className={SUB_LABEL_CLASS}>{t("pattern.motif")}</span>
        <div data-pattern-motifs="1" className="grid grid-cols-5 gap-1">
          {PATTERN_MOTIFS.map((motif) => (
            <button
              key={motif}
              type="button"
              data-pattern-motif={motif}
              title={t(`pattern.${motif}`)}
              aria-label={t(`pattern.${motif}`)}
              onClick={() =>
                set(
                  {
                    motif,
                    // A motif with no tile to stagger cannot keep a stale layout.
                    ...(motif === "diagonal-stripes" || motif === "crosshatch" ? { tileType: undefined } : {})
                  },
                  true
                )
              }
              className={`h-7 rounded-ctl overflow-hidden cursor-default bg-inset ${
                motif === paint.motif ? "ring-2 ring-inset ring-brand" : "ring-1 ring-inset ring-rule-strong"
              }`}
              style={{ background: swatch(motif) }}
            />
          ))}
        </div>
      </div>

      <div className={NUMBER_ROW}>
        <span className={`${SUB_LABEL_CLASS} w-10 shrink-0`}>{t("pattern.tile")}</span>
        <ScrubInput
          className={NUMBER_FIELD}
          label="W"
          title={t("pattern.tileWidth")}
          value={paint.tile.width}
          min={1}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
          onChange={(width) => set({ tile: { ...paint.tile, width } })}
        />
        <ScrubInput
          className={NUMBER_FIELD}
          label="H"
          title={t("pattern.tileHeight")}
          value={paint.tile.height}
          min={1}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
          onChange={(height) => set({ tile: { ...paint.tile, height } })}
        />
      </div>

      {hexCapable && (
        <div className="shrink-0 space-y-1.5">
          <span className={SUB_LABEL_CLASS}>{t("pattern.tileType")}</span>
          <SegmentedControl<PatternTileType>
            className="w-full"
            rowProps={{ "data-pattern-tile-types": "1" }}
            value={paint.tileType ?? "rectangular"}
            onChange={(tileType) => set({ tileType: tileType === "rectangular" ? undefined : tileType }, true)}
            items={[
              { value: "rectangular", label: t("pattern.rectangular"), grow: true, title: t("pattern.tileType") },
              {
                value: "horizontal-hexagonal",
                label: t("pattern.horizontalHexagonal"),
                grow: true,
                title: t("pattern.horizontalHexagonalHint")
              },
              {
                value: "vertical-hexagonal",
                label: t("pattern.verticalHexagonal"),
                grow: true,
                title: t("pattern.verticalHexagonalHint")
              }
            ]}
          />
        </div>
      )}

      {/* Scale and weight are one row: both scale the same tile, and two rows of
          one field each read as two separate ideas. */}
      <div className={NUMBER_ROW}>
        <span className={`${SUB_LABEL_CLASS} w-10 shrink-0`}>{t("pattern.scale")}</span>
        <ScrubInput
          className={NUMBER_FIELD}
          label="×"
          title={t("pattern.scale")}
          value={paint.scale ?? 1}
          min={0.05}
          step={0.05}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
          onChange={(scale) => set({ scale })}
        />
        <span className={`${SUB_LABEL_CLASS} w-10 shrink-0`}>{t("pattern.weight")}</span>
        <ScrubInput
          className={NUMBER_FIELD}
          label="S"
          title={t("pattern.weight")}
          value={paint.weight ?? 2}
          min={0}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
          onChange={(weight) => set({ weight })}
        />
      </div>

      {/* The angle rides here rather than beside Weight: three wells and two
          captions do not fit 220px, and a `30` clipped to `3(` is worse than an
          angle next to the spacing it shares a lattice with. */}
      <div className={NUMBER_ROW}>
        <span className={`${SUB_LABEL_CLASS} w-10 shrink-0`}>{t("pattern.spacing")}</span>
        <ScrubInput
          className={NUMBER_FIELD}
          label="↔"
          title={t("pattern.spacingX")}
          value={paint.spacing?.x ?? 0}
          min={0}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
          onChange={(x) => set({ spacing: { ...paint.spacing, x } })}
        />
        <ScrubInput
          className={NUMBER_FIELD}
          label="↕"
          title={t("pattern.spacingY")}
          value={paint.spacing?.y ?? 0}
          min={0}
          onDragStart={onGestureStart}
          onDragEnd={onGestureEnd}
          onChange={(y) => set({ spacing: { ...paint.spacing, y } })}
        />
        {isStripeMotif(paint.motif) && (
          <ScrubInput
            className={NUMBER_FIELD}
            label="°"
            title={t("pattern.angle")}
            value={paint.angle ?? 45}
            min={0}
            max={359}
            onDragStart={onGestureStart}
            onDragEnd={onGestureEnd}
            onChange={(angle) => set({ angle })}
          />
        )}
      </div>

      <div className={NUMBER_ROW}>
        <span className={`${SUB_LABEL_CLASS} w-10 shrink-0`}>{t("pattern.align")}</span>
        <SegmentedControl<"start" | "center" | "end">
          className="flex-1 min-w-0"
          value={paint.alignment ?? "start"}
          onChange={(alignment) => set({ alignment }, true)}
          items={[
            { value: "start", label: t("pattern.start"), grow: true },
            { value: "center", label: t("pattern.center"), grow: true },
            { value: "end", label: t("pattern.end"), grow: true }
          ]}
        />
      </div>

      {/* The colours are titled, not labelled in-row: a caption inside the row
          spends the hex field's width on a word the title already says. */}
      <div className="shrink-0 space-y-1.5">
        <span className={SUB_LABEL_CLASS}>{t("pattern.color")}</span>
        <ColorField
          panelTitle={t("pattern.color")}
          value={paint.foreground}
          onChange={(foreground, discrete) => set({ foreground }, discrete)}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      </div>

      <CheckRow
        checked={backgroundOn}
        onChange={(on) =>
          on
            ? set({ background: paint.foreground === "#FFFFFF" ? "#000000" : "#FFFFFF" }, true)
            : set({ background: undefined }, true)
        }
        label={t("pattern.backgroundOn")}
      />

      {backgroundOn && (
        <ColorField
          panelTitle={t("pattern.backgroundOn")}
          value={paint.background as string}
          onChange={(background, discrete) => set({ background }, discrete)}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
    </>
  );
}
