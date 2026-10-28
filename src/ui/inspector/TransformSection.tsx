import { DesignElement, DesignDocument, updateActivePageElements } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";
import { elementAABB, isLineElement } from "../../core/geometry/element-bounds";
import { mirrorElement } from "../../core/interactions/line-ops";
import { findParentById, mapElements } from "../../core/geometry/tree-ops";
import { layoutOf } from "../../core/dsl/layout-flat";
import { ScrubInput, FIELD_BUTTON_CLASS } from "../ScrubInput";
import { ConstraintsSection } from "./ConstraintsSection";
import { AlignmentToolbar } from "./AlignmentToolbar";
import {
  ACTION_BAR_TOGGLE_CLASS,
  ACTION_BAR_TOGGLE_OFF,
  ACTION_BAR_TOGGLE_ON
} from "./action-bar-style";
import { AlignmentType } from "../../core/interactions/alignment";
import { t } from "../../i18n";
import { Section } from "./SectionHeader";
// Lucide's two flip families name the axis the other way round — the `-2` set
// names the centreline the triangles straddle, the square set names the axis it
// mirrors across. These buttons keep the square set's orientation, so flipX
// wears `FlipVertical2` and flipY wears `FlipHorizontal2`.
import { Angle, FlipHorizontal2, FlipVertical2 } from "lucide-react";
import { ROW_TIGHT_CLASS } from "../row-style";
import { resolveAcross } from "./mixed";

interface TransformSectionProps {
  primarySelected: DesignElement | null;
  selectedElements: DesignElement[];
  selectedIds: Set<string>;
  docRef: { current: DesignDocument };
  multiBounds: { minX: number; minY: number; width: number; height: number } | null;
  onAlign: (type: AlignmentType) => void;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /**
   * The geometry belongs to the main component — a resolved instance child.
   *
   * The fields stay on screen and go dead rather than disappearing: a designer
   * looking for X or W has to find them where they always were, and a panel that
   * loses its whole transform block on one click reads as a different panel
   * rather than as the same layer with its geometry locked.
   */
  locked?: boolean;
}

/**
 * Where the layer SITS: align, position, constraints, rotation and flips.
 *
 * Size is no longer here — the W/H fields, the aspect lock, the bounds and the
 * shape-geometry rows render at the top of the LAYOUT section (`SizeFields` in
 * `AutoLayoutSection`), because how big a box is and how its container may
 * resize it are one subject. Corner radius and the blend/opacity rows live in
 * the APPEARANCE section.
 */
export function TransformSection({
  primarySelected,
  selectedElements,
  selectedIds,
  docRef,
  multiBounds,
  onAlign,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd,
  locked = false
}: TransformSectionProps) {
  if (!primarySelected && selectedElements.length === 0) return null;
  const lockedHint = locked ? t("component.geometryFromMain") : undefined;

  const singleSelected = !multiBounds && primarySelected ? primarySelected : null;
  // A child of an auto-layout container owns no coordinate — the stack does, and
  // it writes it on every layout pass. Align and X/Y go dead instead of
  // accepting a number that the next relayout drops: a typed X that leaves the
  // layer where it was reads as the field being broken. One layout-owned member
  // is enough — a partial move leaves the free layers behind, which reads the
  // same way. A child that left the flow is positioned by its own coordinates
  // again, so both apply to it like any other layer.
  const stackOwnsPosition = selectedElements.some(
    (el) => el.position !== "absolute" && Boolean(layoutOf(findParentById(getActivePage(docRef.current).children, el.id)))
  );
  // The escape hatch only exists relative to a stack, so it is only offered when
  // every selected layer has a layout parent — a toggle that silently no-ops for
  // one member of the selection is worse than no toggle.
  const layoutChildren = selectedElements.filter(
    (el) => Boolean(layoutOf(findParentById(getActivePage(docRef.current).children, el.id)))
  );
  const canIgnoreAutoLayout = layoutChildren.length > 0 && layoutChildren.length === selectedElements.length;
  const ignoringAutoLayout = canIgnoreAutoLayout && layoutChildren.every((el) => el.position === "absolute");
  const rotation = resolveAcross(selectedElements, (el) => el.rotation || 0);
  /**
   * X / Y / W / H are ONE OBJECT'S geometry, so a selection of several has no
   * value for them — not even the union's, which is a number about the group
   * wearing a label that claims to be about a layer.
   *
   * They read Mixed and refuse the edit rather than disappearing: the fields are
   * where a reader looks to find out what is selected and how big, and a panel
   * that loses four fields the moment a second layer is picked reads as broken.
   * Moving and resizing a group stays where it belongs — the canvas: drag it, nudge
   * it with the arrow keys, pull its eight handles.
   */
  const multi = multiBounds !== null;
  const perObjectHint = t("properties.perObjectOnly");
  // Pressed state is the same question for both buttons: do they all agree? Half
  // the selection flipped is not "flipped", and drawing the toggle as if it were
  // said that the click would unflip the rest.
  const flipX = resolveAcross(selectedElements, (el) => !!el.flipX);
  const flipY = resolveAcross(selectedElements, (el) => !!el.flipY);
  const tiltX = resolveAcross(selectedElements, (el) => el.rotateX || 0);
  const tiltY = resolveAcross(selectedElements, (el) => el.rotateY || 0);
  const perspective = resolveAcross(selectedElements, (el) => el.perspective || 800);

  return (
    <>
      {/* Align / Position / Rotation are three PEERS, not one "Transform" with two
          captions under it. The demo (`final-amber.html`) draws every group in the
          panel the same way — `.ann` + leader rule + controls — and has no parent
          level at all, so a 12px `Position` caption under a 9px `TRANSFORM` heading
          was the panel's one inverted pair: the group read as louder than the
          section containing it. One level, one size, no inversion.

          `data-inspector-section` marks where the transform block starts, so a
          probe can assert what the panel puts above it — it rides the ALIGN
          group, which is the first thing in the block, now that the two groups
          are their own boxes instead of the children of a wrapper. */}
      <Section id="transform-align" title={t("alignText.align")} data-inspector-section="transform">

        {/* Above the align grid, not below it: this button is not a fourth row of
            alignments — it decides whether the stack places this layer at all,
            which is the question the alignments underneath only make sense once
            answered. */}
        {canIgnoreAutoLayout && (
          <button
            type="button"
            data-ignore-auto-layout="true"
            onClick={() => {
              const next = ignoringAutoLayout ? undefined : "absolute" as const;
              onMutate((el) => {
                const updated = { ...el };
                if (next) updated.position = next;
                else delete updated.position;
                return updated;
              }, true);
            }}
            className={`${ACTION_BAR_TOGGLE_CLASS} ${ignoringAutoLayout ? ACTION_BAR_TOGGLE_ON : ACTION_BAR_TOGGLE_OFF}`}
            aria-pressed={ignoringAutoLayout}
            title={t("stack.ignoreAutoLayoutHint")}
          >
            <span>{t("stack.ignoreAutoLayout")}</span>
          </button>
        )}

        <AlignmentToolbar onAlign={onAlign} disabled={stackOwnsPosition || locked} />
      </Section>

      <Section id="transform-position" title={t("properties.position")}>
        {/* 4px between the two wells, not 8 — the demo's `.fldrow { gap:4px }`.
            At 8px they read as two separate fields; at 4px they read as one
            X/Y pair, which is what they are. */}
        <div className="grid grid-cols-2 gap-1">
          <ScrubInput
              key={singleSelected ? `${singleSelected.id}_x` : "multi_x"}
              label="X"
              value={multi ? undefined : elementAABB(primarySelected!).x}
              mixed={multi}
              disabled={locked || stackOwnsPosition || multi}
              title={locked ? lockedHint : multi ? perObjectHint : stackOwnsPosition ? t("stack.positionInFlow") : undefined}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(newX) => {
                if (multiBounds) {
                  onMutate((el) => {
                    const delta = newX - elementAABB(el).x;
                    return { ...el, x: el.x + delta };
                  });
                } else if (primarySelected) {
                  const targetId = primarySelected.id;
                  onMutate((el) => {
                    if (el.id !== targetId) return el;
                    const delta = newX - elementAABB(el).x;
                    return { ...el, x: el.x + delta };
                  });
                }
              }}
            />
            <ScrubInput
              key={singleSelected ? `${singleSelected.id}_y` : "multi_y"}
              label="Y"
              value={multi ? undefined : elementAABB(primarySelected!).y}
              mixed={multi}
              disabled={locked || stackOwnsPosition || multi}
              title={locked ? lockedHint : multi ? perObjectHint : stackOwnsPosition ? t("stack.positionInFlow") : undefined}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(newY) => {
                if (multiBounds) {
                  onMutate((el) => {
                    const delta = newY - elementAABB(el).y;
                    return { ...el, y: el.y + delta };
                  });
                } else if (primarySelected) {
                  const targetId = primarySelected.id;
                  onMutate((el) => {
                    if (el.id !== targetId) return el;
                    const delta = newY - elementAABB(el).y;
                    return { ...el, y: el.y + delta };
                  });
                }
              }}
            />
        </div>

        {/* Constraints answers "what happens to this layer when its parent
            resizes", which is a question about where the layer sits — so it
            belongs under Position rather than at the bottom of the Layout
            section, next to a stack it may not even be in. */}
        <ConstraintsSection primarySelected={primarySelected!} doc={docRef.current} onMutate={onMutate} />

        <div className={ROW_TIGHT_CLASS}>
          <div className="flex-1">
            <ScrubInput
              key={singleSelected ? `${singleSelected.id}_rot` : "multi_rot"}
              label={<Angle size={11} />}
              title={locked ? lockedHint : t("properties.rotation")}
              value={rotation.mixed ? undefined : rotation.value}
              mixed={rotation.mixed}
              min={-179}
              max={181}
              wrap
              disabled={locked}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(rot) => {
                // Allow continuous dragging with negative values down to -179; when hitting -180, wraps to 180 (positive).
                // Store rotation normalized in [0, 360).
                const norm = ((rot % 360) + 360) % 360;
                onMutate((el) => ({ ...el, rotation: norm }));
              }}
            />
          </div>
            <button
              onClick={() => {
                if (multiBounds) {
                  const cx = multiBounds.minX + multiBounds.width / 2;
                  onCommitSnapshot(
                    updateActivePageElements(
                      docRef.current,
                      mapElements(getActivePage(docRef.current).children, (el) =>
                        selectedIds.has(el.id) ? mirrorElement(el, "h", cx) : el
                      )
                    )
                  );
                } else if (primarySelected) {
                  onCommitSnapshot(
                    updateActivePageElements(
                      docRef.current,
                      mapElements(getActivePage(docRef.current).children, (item) =>
                        item.id === primarySelected.id
                          ? isLineElement(item)
                            ? mirrorElement(item, "h", elementAABB(item).x + elementAABB(item).width / 2)
                            : { ...item, flipX: !item.flipX }
                          : item
                      )
                    )
                  );
                }
              }}
              disabled={locked}
              className={`${FIELD_BUTTON_CLASS} bg-surface border-rule-strong ${
                locked ? "opacity-50 cursor-not-allowed" : flipX.value ? "text-brand" : "text-ink-dim hover:text-ink"
              }`}
              title={locked ? lockedHint : t("properties.flipHorizontal")}
              aria-label={t("properties.flipHorizontal")}
            >
              <FlipVertical2 size={13} />
            </button>
            <button
              onClick={() => {
                if (multiBounds) {
                  const cy = multiBounds.minY + multiBounds.height / 2;
                  onCommitSnapshot(
                    updateActivePageElements(
                      docRef.current,
                      mapElements(getActivePage(docRef.current).children, (el) =>
                        selectedIds.has(el.id) ? mirrorElement(el, "v", cy) : el
                      )
                    )
                  );
                } else if (primarySelected) {
                  onCommitSnapshot(
                    updateActivePageElements(
                      docRef.current,
                      mapElements(getActivePage(docRef.current).children, (item) =>
                        item.id === primarySelected.id
                          ? isLineElement(item)
                            ? mirrorElement(item, "v", elementAABB(item).y + elementAABB(item).height / 2)
                            : { ...item, flipY: !item.flipY }
                          : item
                      )
                    )
                  );
                }
              }}
              disabled={locked}
              className={`${FIELD_BUTTON_CLASS} bg-surface border-rule-strong ${
                locked ? "opacity-50 cursor-not-allowed" : flipY.value ? "text-brand" : "text-ink-dim hover:text-ink"
              }`}
              title={locked ? lockedHint : t("properties.flipVertical")}
              aria-label={t("properties.flipVertical")}
            >
              <FlipHorizontal2 size={13} />
            </button>
        </div>

        {/* Perspective tilt, the CSS 3D pair. Degrees scrub like the rotation
            field above, and the viewing distance rides beside them because
            tilting without it is an orthographic squash. The projection is paint-side only: the resize
            and rotate gestures still read the flat box, so this row stays a
            numbers row and grows no handles of its own. */}
        <div className={ROW_TIGHT_CLASS}>
          <div className="grid grid-cols-3 gap-1 flex-1">
            <ScrubInput
              key={singleSelected ? `${singleSelected.id}_tiltX` : "multi_tiltX"}
              label="X°"
              value={tiltX.mixed ? undefined : tiltX.value}
              mixed={tiltX.mixed}
              min={-89}
              max={89}
              disabled={locked}
              title={locked ? lockedHint : t("properties.tiltX")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onMutate((el) => ({ ...el, rotateX: v }))}
            />
            <ScrubInput
              key={singleSelected ? `${singleSelected.id}_tiltY` : "multi_tiltY"}
              label="Y°"
              value={tiltY.mixed ? undefined : tiltY.value}
              mixed={tiltY.mixed}
              min={-89}
              max={89}
              disabled={locked}
              title={locked ? lockedHint : t("properties.tiltY")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onMutate((el) => ({ ...el, rotateY: v }))}
            />
            <ScrubInput
              key={singleSelected ? `${singleSelected.id}_persp` : "multi_persp"}
              label="d"
              value={perspective.mixed ? undefined : perspective.value}
              mixed={perspective.mixed}
              min={50}
              max={100000}
              disabled={locked}
              title={locked ? lockedHint : t("properties.perspectiveDistance")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onMutate((el) => ({ ...el, perspective: v }))}
            />
          </div>
        </div>
      </Section>
    </>
  );
}
