import { Trash2, Check, Plus, Minus, MousePointer2 } from "lucide-react";
import type { ComponentChildren } from "preact";
import { PathElement } from "../../core/dsl/types";
import { PenMode } from "../../core/tools";
import { SegmentedControl } from "../SegmentedControl";
import { ScrubInput } from "../ScrubInput";
import {
  parsePathData,
  serializePathData,
  removeAnchor,
  getAnchorMirrorMode,
  setAnchorMirrorMode
} from "../../core/geometry/path-data";
import { t } from "../../i18n";
import { Section } from "./SectionHeader";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_SPREAD_GAP_CLASS } from "../row-style";

function MirrorIcon({ children }: { children: ComponentChildren }) {
  return (
    <svg width="22" height="16" viewBox="0 0 24 18" fill="none">
      <path d="M 4 15 C 4 10, 8 7, 12 7 C 15 7, 19 10, 20 15" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.2" fill="none" />
      {children}
    </svg>
  );
}

interface VectorSectionProps {
  pathElement: PathElement;
  selectedAnchorIdxs: Set<number>;
  onSelectOnlyAnchor: (idx: number) => void;
  onCommitPath: (newD: string) => void;
  onExitPathEdit: () => void;
  penMode: PenMode;
  onPenModeChange: (mode: PenMode) => void;
  /** Frames an X/Y scrub so a drag is one undo step, not one per pixel. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onCommitPathTransient?: (newD: string) => void;
}

export function VectorSection({
  pathElement,
  selectedAnchorIdxs,
  onSelectOnlyAnchor,
  onCommitPath,
  onExitPathEdit,
  penMode,
  onPenModeChange,
  onDragStart,
  onDragEnd,
  onCommitPathTransient
}: VectorSectionProps) {
  const editable = parsePathData(pathElement.d);
  if (!editable) return null;

  // Sorted so "the" primary anchor of a multi-selection is stable across renders
  // — otherwise the X/Y fields jump between the first and last index.
  const selected = [...selectedAnchorIdxs]
    .filter((i) => i < editable.anchors.length)
    .sort((a, b) => a - b);
  const primaryIdx = selected.length === 1 ? selected[0] : null;
  const selectedAnchor = primaryIdx !== null ? editable.anchors[primaryIdx] : null;

  const handleUpdateAnchorCoord = (axis: "x" | "y", val: number) => {
    if (primaryIdx === null || !selectedAnchor) return;
    const newX = axis === "x" ? val : selectedAnchor.x;
    const newY = axis === "y" ? val : selectedAnchor.y;
    const dx = newX - selectedAnchor.x;
    const dy = newY - selectedAnchor.y;

    const nextAnchors = editable.anchors.map((p, i) =>
      i === primaryIdx ? { x: newX, y: newY } : p
    );
    const nextSegments = editable.segments.map((seg) => {
      if (seg.kind === "quad") {
        return seg.a === primaryIdx ? { ...seg, c: { x: seg.c.x + dx, y: seg.c.y + dy } } : seg;
      }
      if (seg.kind === "cubic") {
        let ca = seg.ca;
        let cb = seg.cb;
        if (seg.a === primaryIdx) ca = { x: ca.x + dx, y: ca.y + dy };
        if (seg.b === primaryIdx) cb = { x: cb.x + dx, y: cb.y + dy };
        return { ...seg, ca, cb };
      }
      return seg;
    });

    const next = { ...editable, anchors: nextAnchors, segments: nextSegments };
    // Transient, so dragging X lays down one undo step rather than one per pixel.
    (onCommitPathTransient ?? onCommitPath)(serializePathData(next));
  };

  const handleDeleteAnchors = () => {
    if (selected.length === 0) return;
    let next = editable;
    // Highest first: removeAnchor renumbers everything above the one it drops.
    // And it empties a path rather than strip it below two anchors, so the loop
    // has to stop there — otherwise deleting three of four points wipes the shape.
    for (const i of [...selected].sort((a, b) => b - a)) {
      if (next.anchors.length <= 2) break;
      next = removeAnchor(next, i);
    }
    onCommitPath(serializePathData(next));
    onSelectOnlyAnchor(-1);
  };

  const handleToggleClosed = () => {
    const next = { ...editable, closed: !editable.closed };
    onCommitPath(serializePathData(next));
  };

  return (
    <Section id="vector" title={t("vector.title")}>

      {/* The pen's mode switch and the commit action sit BELOW the header, on
          their own row. In the header's trailing slot they were ~150px of
          chrome in a 31px row: the leader rule was squeezed to a stub, and this
          was the only section whose header carried a toolbar. */}
      <div className={ROW_SPREAD_GAP_CLASS}>
        <SegmentedControl<PenMode>
          value={penMode}
          onChange={onPenModeChange}
          items={[
            { value: "draw", title: t("pen.modeDraw"), icon: <MousePointer2 size={11} /> },
            { value: "add", title: t("pen.modeAdd"), icon: <Plus size={11} /> },
            { value: "remove", title: t("pen.modeRemove"), icon: <Minus size={11} /> }
          ]}
        />
        {/* The commit action, so it is the `primary` variant — solid amber with
            `brand-ink` on it, not `ink`: white on #E8A33D is 2.2:1. */}
        <Button
          variant="primary"
          size="field"
          className="gap-1"
          onClick={onExitPathEdit}
          title={t("vector.exitEdit")}
          aria-label={t("vector.exitEdit")}
        >
          <Check size={12} />
          <span>{t("vector.done")}</span>
        </Button>
      </div>

      {/* Nothing is drawn while no anchor is picked: an empty state that says
          "select an anchor point" is a caption for controls that are absent. */}
      {selected.length > 0 && (
        <>
          <div className={`${SUB_LABEL_CLASS} flex items-center justify-between`}>
            <span>
              {selected.length === 1
                ? `${t("vector.point")} #${selected[0] + 1}`
                : t("vector.pointsSelected", { count: selected.length })}
            </span>
            <Button
              variant="danger"
              size="icon"
              onClick={handleDeleteAnchors}
              title={t("vector.deletePoint")}
            >
              <Trash2 size={12} />
            </Button>
          </div>

          {selectedAnchor && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <ScrubInput
                  label="X"
                  value={Math.round(selectedAnchor.x * 10) / 10}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onChange={(v) => handleUpdateAnchorCoord("x", v)}
                />
                <ScrubInput
                  label="Y"
                  value={Math.round(selectedAnchor.y * 10) / 10}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onChange={(v) => handleUpdateAnchorCoord("y", v)}
                />
              </div>

              {/* Figma-style Mirroring Segmented Control */}
              <div className="pt-2">
                <div className={`${SUB_LABEL_CLASS} mb-1.5`}>{t("vector.mirroring")}</div>
                <SegmentedControl<string>
                  className="w-full"
                  value={getAnchorMirrorMode(editable, primaryIdx!)}
                  onChange={(m) => {
                    const next = setAnchorMirrorMode(editable, primaryIdx!, m as "none" | "angle" | "all");
                    onCommitPath(serializePathData(next));
                  }}
                  items={[
                    {
                      value: "none", title: t("vector.mirrorNone"), grow: true,
                      icon: (
                        <MirrorIcon>
                          <line x1="8" y1="13" x2="12" y2="7" stroke="currentColor" strokeWidth="1.2" />
                          <line x1="12" y1="7" x2="18" y2="7" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="12" cy="7" r="1.6" className="fill-field" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="8" cy="13" r="1.1" fill="currentColor" />
                          <circle cx="18" cy="7" r="1.1" fill="currentColor" />
                        </MirrorIcon>
                      )
                    },
                    {
                      value: "angle", title: t("vector.mirrorAngle"), grow: true,
                      icon: (
                        <MirrorIcon>
                          <line x1="7" y1="7" x2="18" y2="7" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="12" cy="7" r="1.6" className="fill-field" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="7" cy="7" r="1.1" fill="currentColor" />
                          <circle cx="18" cy="7" r="1.1" fill="currentColor" />
                        </MirrorIcon>
                      )
                    },
                    {
                      value: "all", title: t("vector.mirrorAll"), grow: true,
                      icon: (
                        <MirrorIcon>
                          <line x1="5" y1="7" x2="19" y2="7" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="12" cy="7" r="1.6" className="fill-field" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="5" cy="7" r="1.1" fill="currentColor" />
                          <circle cx="19" cy="7" r="1.1" fill="currentColor" />
                        </MirrorIcon>
                      )
                    }
                  ]}
                />
              </div>
            </>
          )}
        </>
      )}

      <div className="pt-1">
        <Button variant="bar" onClick={handleToggleClosed}>
          {editable.closed ? t("vector.openPath") : t("vector.closePath")}
        </Button>
      </div>
    </Section>
  );
}
