import { useRef, useState } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { DesignDocument, DesignElement } from "../../core/dsl/types";
import { ScrubInput } from "../ScrubInput";
import { useDismiss } from "../hooks/useDismiss";
import { t } from "../../i18n";
import {
  scaleSelectionToSizeInDocument,
  selectionWorldBounds,
  SCALE_ANCHORS,
  SCALE_REFUSALS,
  ScaleAnchor,
  ScaleResult
} from "../../core/interactions/scale-ops";
import { Scaling, ChevronDown, Check, X } from "lucide-react";
import { floorScaleFactor } from "../../core/geometry/scale-geometry";
import { Section } from "./SectionHeader";
import { FieldDropdown } from "./FieldDropdown";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";

/**
 * The Scale tool's parameters, as a panel rather than a popover.
 *
 * A popover is the wrong shape here: a scale is not one completed action, it is a
 * mode the user works in, and the three things that govern it — the size, the
 * factor, and where the growth comes from — all stay live while they work. A
 * dialog-shaped popover that closes on Enter is a command's UI; a section that
 * stays open, with an X to leave it, is a tool's.
 *
 * W / H and the factor are the same edit expressed twice, so both read the
 * document rather than a local draft: a scrub that rewrote the other's value
 * locally would leave one of the two fields lying between keystrokes.
 */

interface ScaleSectionProps {
  selectedElements: DesignElement[];
  docRef: { current: DesignDocument };
  /** Where a scale grows from, as a fraction of the element's own box. */
  anchor: ScaleAnchor;
  onAnchorChange: (anchor: ScaleAnchor) => void;
  /** Leaves the Scale tool and returns to Move. */
  onClose: () => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  /** A scrub's frames: bracketed by `onDragStart`/`onDragEnd`, one undo step. */
  setDoc: (updater: (d: DesignDocument) => DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /**
   * The selection's size when the tool was entered, which the factor is measured
   * against. A scale has no other original — the document only holds the current
   * one — so without this the factor would have to be read from a value the
   * previous keystroke already changed, and "1x" would mean nothing.
   */
  reference: { width: number; height: number } | null;
  /** Says WHY a refused scale did nothing, so the field is not just inert. */
  onHint?: (message: string) => void;
}

const PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function ScaleSection({
  selectedElements,
  docRef,
  anchor,
  onAnchorChange,
  onClose,
  onCommitSnapshot,
  setDoc,
  onDragStart,
  onDragEnd,
  reference,
  onHint
}: ScaleSectionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuHost = useRef<HTMLDivElement | null>(null);
  useDismiss(menuOpen, () => setMenuOpen(false), menuHost);

  const ids = new Set(selectedElements.map((el) => el.id));
  // Read from the document, which is the only writer of a size: a local copy
  // would be one keystroke behind the W / H fields beside it.
  const bounds = ids.size ? selectionWorldBounds(getActivePage(docRef.current).children, ids) : null;
  const factor =
    reference && reference.width > 0 && bounds ? bounds.width / reference.width : 1;
  const heightFactor =
    reference && reference.height > 0 && bounds ? bounds.height / reference.height : 1;
  // A uniform scale is the norm, so a factor that already differs per axis is
  // reported as the horizontal one and the preset tick is simply not shown —
  // claiming "2x" for a box that is 2x wide and 1.5x tall would be a lie.
  const uniform = Math.abs(factor - heightFactor) < 0.005;

  const commitResult = (result: ScaleResult, discrete = true) => {
    if (result.changed) {
      if (discrete) onCommitSnapshot(result.doc);
      else setDoc(() => result.doc);
      return;
    }
    // A refusal is computed on purpose and then has nowhere to go, which is how a
    // locked layer or a layout-owned size ends up looking like a dead field:
    // the number moves, nothing does, nothing says why (LESSONS §15).
    if (result.refusal && onHint) onHint(t(SCALE_REFUSALS[result.refusal]));
  };

  const commitSize = (width: number, height: number, discrete?: boolean) => {
    commitResult(scaleSelectionToSizeInDocument(docRef.current, ids, { width, height }, anchor), discrete);
  };

  // The header row's trailing slot, in both of the returns below — the tool is
  // the one section that can be on with nothing to act on, and leaving the tool
  // has to stay reachable from the empty state too.
  const closeButton = (
    <Button
      size="icon"
      type="button"
      data-scale-close="true"
      onClick={onClose}
      title={t("scale.leave")}
      aria-label={t("scale.leave")}
    >
      <X size={13} />
    </Button>
  );

  // With nothing selected there is no box to scale, and every control here would be
  // a button that silently does nothing. Say so instead (LESSONS §15).
  if (selectedElements.length === 0) {
    return (
      <Section id="scale" title={t("scale.title")} trailing={closeButton} data-scale-section="true">
        <div className="text-ui text-ink-muted" data-scale-empty="true">
          {t("scale.nothingSelected")}
        </div>
      </Section>
    );
  }

  /**
   * Apply a factor against the REFERENCE size, never the current one.
   *
   * Multiplying the current size by the factor compounds: type 2, then 1, and you
   * are left at 2x — the field would read "1x" over a box that is not what it was
   * when you started, and "back to how I found it" would be unreachable from the
   * field whose whole job is that number.
   */
  const commitFactor = (next: number, discrete?: boolean) => {
    if (!reference) return;
    // The floor is ONE factor, not a clamp on each target. `Math.max(1, w * f)`
    // beside `Math.max(1, h * f)` turns a 200x100 asked for 0.5% into 1x1 here,
    // and by the time the geometry layer runs the aspect is already gone — the
    // panel's own clamp is what a fix further down cannot reach.
    const floored = floorScaleFactor(reference, next);
    commitSize(reference.width * floored, reference.height * floored, discrete);
  };

  return (
    <Section id="scale" title={t("scale.title")} trailing={closeButton} data-scale-section="true">

      {/*
        W, H and the factor are three views of ONE proportional scale, so all three
        route through `commitFactor`. A W edit that left the height alone would be a
        resize wearing the scale tool's fields — and a corner drag, which is where
        a free two-axis scale belongs, would then disagree with the panel about what
        the tool does.
      */}
      <div className="grid grid-cols-2 gap-2">
        <ScrubInput
          label="W"
          value={Math.max(1, Math.round(bounds?.width ?? 1))}
          min={1}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => {
            if (!reference || reference.width <= 0) return;
            commitFactor(Math.max(0.01, v) / reference.width, false);
          }}
          title={t("scale.width")}
        />
        <ScrubInput
          label="H"
          value={Math.max(1, Math.round(bounds?.height ?? 1))}
          min={1}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => {
            if (!reference || reference.height <= 0) return;
            commitFactor(Math.max(0.01, v) / reference.height, false);
          }}
          title={t("scale.height")}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 items-start">
        <div className="space-y-1">
          <span className={SUB_LABEL_CLASS}>{t("scale.factor")}</span>
          {/* `data-scale-factor` because `ScrubInput` only stamps
              `data-scrub-field` for a string label, and this field's label is an
              icon — without a hook of its own the factor is unreachable to a
              test, which is how the reference-drift bug below went unnoticed. */}
          <div className="relative" ref={menuHost} data-scale-factor="true">
            <ScrubInput
              label={<Scaling size={11} />}
              value={Math.round(factor * 1000) / 1000}
              min={1}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => commitFactor(Math.max(0.01, v), false)}
              trailing={
                <button
                  type="button"
                  data-scale-factor-menu="true"
                  onClick={() => setMenuOpen((prev) => !prev)}
                  className="flex-none h-full pl-1 pr-1.5 flex items-center border-l border-rule text-ink-muted hover:text-ink transition-colors"
                  title={t("scale.presets")}
                >
                  <ChevronDown size={10} />
                </button>
              }
              title={t("scale.factor")}
            />
            {menuOpen && (
              <FieldDropdown data-scale-factor-presets="true">
                {PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    data-scale-preset-option={preset}
                    onClick={() => {
                      setMenuOpen(false);
                      commitFactor(preset);
                    }}
                    className="w-full flex items-center justify-between rounded-ctl px-2 py-1 text-left text-ui text-ink-dim hover:bg-raised hover:text-ink transition-colors duration-micro ease-snap"
                  >
                    <span className="">{preset}x</span>
                    {uniform && Math.abs(factor - preset) < 0.005 && <Check size={11} />}
                  </button>
                ))}
              </FieldDropdown>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <span className={SUB_LABEL_CLASS}>{t("scale.anchor")}</span>
          <div
            role="radiogroup"
            aria-label={t("scale.anchor")}
            data-scale-anchor="true"
            className="grid grid-cols-3 gap-1 rounded-ctl border border-rule bg-panel p-1"
          >
            {SCALE_ANCHORS.map((point, index) => {
              const active = point.x === anchor.x && point.y === anchor.y;
              return (
                <button
                  key={index}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-scale-anchor-option={`${point.x},${point.y}`}
                  onClick={() => onAnchorChange(point)}
                  className="flex h-5 items-center justify-center rounded-ctl transition-colors duration-micro ease-snap hover:bg-raised"
                  title={t("scale.anchor")}
                >
                  <span
                    className={`block rounded-full transition-colors ${
                      active ? "bg-brand w-2.5 h-2.5" : "bg-ink-muted w-1.5 h-1.5"
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}

