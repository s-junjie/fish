import { DesignElement, DesignDocument, SizeMode } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";
import { isLineElement } from "../../core/geometry/element-bounds";
import { setLineSize } from "../../core/interactions/line-ops";
import { findParentById } from "../../core/geometry/tree-ops";
import { layoutOf } from "../../core/dsl/layout-flat";
import { containerSizesAxis, resolveAxis, withAxisMode, SizingAxis } from "../../core/geometry/resolve-axis";
import { resizeElementWithConstraints } from "../../core/geometry/constraints";
import { isAspectLocked as elementIsAspectLocked, withAspectLock } from "../../core/geometry/aspect-lock";
import { sizeModeLabel, sizeModeOptions, sizeModeShortLabel } from "../size-modes";
import { ScrubInput, FIELD_BUTTON_CLASS } from "../ScrubInput";
import { bindNumberTokenToElement, unbindNumberTokenFromElement, findNumberToken } from "../../core/interactions/number-token-ops";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { FieldDropdown } from "./FieldDropdown";
import {
  MENU_OPTION_CLASS,
  MENU_OPTION_NAME_CLASS,
  MENU_OPTION_NAME_ON_CLASS,
  MENU_OPTION_NOTE_CLASS
} from "../menu-style";
import { ShapeGeometrySection } from "./ShapeGeometrySection";
import { SUB_LABEL_CLASS } from "../label-tier";
import { t } from "../../i18n";
import { useDismiss } from "../hooks/useDismiss";
import { useState, useCallback, useRef } from "preact/hooks";
import {
  Lock,
  Unlock,
  ChevronDown,
  SquareDimensions,
  Check
} from "lucide-react";
import { ROW_TIGHT_CLASS } from "../row-style";
import { resolveAcross } from "./mixed";

type BoundKind = "min" | "max";
type BoundKey = "minWidth" | "maxWidth" | "minHeight" | "maxHeight";

const boundKey = (kind: BoundKind, axis: SizingAxis): BoundKey =>
  `${kind}${axis === "width" ? "Width" : "Height"}` as BoundKey;

/** `0` is the absent spelling: a bound of zero bounds nothing. */
const boundOf = (el: DesignElement, kind: BoundKind, axis: SizingAxis): number =>
  el.sizing?.[boundKey(kind, axis)] ?? 0;

function withBound(el: DesignElement, kind: BoundKind, axis: SizingAxis, value: number): DesignElement {
  const sizing = { ...(el.sizing ?? {}) };
  const key = boundKey(kind, axis);
  if (value > 0) sizing[key] = value;
  else delete sizing[key];
  const empty = (
    ["width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight"] as const
  ).every((k) => sizing[k] === undefined);
  return { ...el, sizing: empty ? undefined : sizing };
}

interface SizeFieldsProps {
  primarySelected: DesignElement | null;
  selectedElements: DesignElement[];
  docRef: { current: DesignDocument };
  multiBounds: { minX: number; minY: number; width: number; height: number } | null;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  /** The undo stream for a token edit saved from its token picker. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** The box belongs to the main component — a resolved instance child. The
   *  fields stay, drawn at the size the clone resolved to, and refuse the edit. */
  locked?: boolean;
}

/**
 * The size fields — W / H with their sizing-mode menus, the aspect lock, the
 * min/max bounds and the shape-geometry rows — as headerless content.
 *
 * They render at the top of the LAYOUT section (`AutoLayoutSection` draws the
 * one header): how big a box is and how its container may resize it are one
 * subject, and a second "SIZE" heading between the layout controls and W/H
 * split the subject in two. The Scale tool owns the size while it is on, so
 * the panel simply does not render this block then (`showSize`).
 *
 * `data-inspector-section="size"` keeps the block's historical marker so
 * probes can still address the fields.
 */
export function SizeFields({
  primarySelected,
  selectedElements,
  docRef,
  multiBounds,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd,
  locked = false
}: SizeFieldsProps) {
  const [openAxis, setOpenAxis] = useState<SizingAxis | null>(null);
  const [showBounds, setShowBounds] = useState(false);
  const [tokenPicker, setTokenPicker] = useState<{ axis: "width" | "height"; anchor: HTMLElement } | null>(null);
  const menuHost = useRef<HTMLDivElement | null>(null);
  useDismiss(openAxis !== null, useCallback(() => setOpenAxis(null), []), menuHost);

  const singleSelected = !multiBounds && primarySelected ? primarySelected : null;
  const parent = singleSelected ? findParentById(getActivePage(docRef.current).children, singleSelected.id) : null;
  // A bound qualifies the size a layout pass WRITES, so it is only offered where
  // such a pass exists — for every member of the selection, not just one. A
  // control that silently no-ops for part of a selection is worse than no control.
  const boundsEveryMember =
    selectedElements.length > 0 &&
    selectedElements.every((el) => Boolean(layoutOf(findParentById(getActivePage(docRef.current).children, el.id))));
  const sizingHint = t("stack.sizingControlled");
  // The proportion lock rides on the element, so the button reads the selection
  // rather than a session flag — which is what lets a newly drawn shape start
  // unlocked even when whatever was selected last was locked.
  const isAspectLocked = elementIsAspectLocked(primarySelected);
  const aspectLockedCount = selectedElements.filter(elementIsAspectLocked).length;
  const aspectMixed = aspectLockedCount > 0 && aspectLockedCount < selectedElements.length;
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
  /**
   * W and H are one LAYER's length, and they stay editable: a selection can be
   * given one. Typing a number writes it to every member, so the edit is the same
   * edit whether one layer or five are selected — which is why this is a `Mixed`
   * field and not a disabled one.
   *
   * The value shown is the one the LAYERS share, not the union's: a selection of
   * three 90px boxes reads 90, not 350, because 350 is the width of nothing in
   * the document. Scaling the group stays on the canvas's eight handles and on the
   * Scale tool.
   */
  const sharedWidth = resolveAcross(selectedElements, (el) => el.width);
  const sharedHeight = resolveAcross(selectedElements, (el) => el.height);
  const menuOptions = openAxis ? sizeModeOptions(singleSelected, parent, openAxis) : [];
  const menuMode = openAxis && singleSelected ? resolveAxis(singleSelected, parent, openAxis) : null;

  // The document is the truth: every mutation re-measures `fit-content` boxes
  // and bakes them in, and the renderer paints from those same numbers.
  const axisValue = (axis: SizingAxis, fallback: number): number => {
    if (!singleSelected) return fallback;
    return axis === "width" ? singleSelected.width : singleSelected.height;
  };

  /**
   * A typed size is a claim about this axis, so the axis is pinned to say so.
   * Without it the number is only stored: a grid cell — and `align-self: stretch`
   * in a stack — sizes every axis a child left unsaid, and the next pass writes
   * the cell over what was just typed.
   */
  const pinResizedAxis = (el: DesignElement, axis: SizingAxis): DesignElement =>
    containerSizesAxis(el, parent, axis) ? withAxisMode(el, axis, "fixed") : el;

  const renderSizeField = (axis: SizingAxis, label: string, onResize: (v: number) => void) => {
    const mode: SizeMode = singleSelected ? resolveAxis(singleSelected, parent, axis) : "fixed";
    // `readOnly` is the same treatment either way — the number is shown, the
    // field refuses the edit — so a master-owned box borrows it rather than
    // growing a second disabled style beside it.
    const readOnly = locked || (!!singleSelected && mode !== "fixed");
    const selectable = !locked && !!singleSelected && openAxis !== null;
    const boundTokenId = singleSelected?.tokenBindings?.[axis];
    const boundToken = boundTokenId ? findNumberToken(docRef.current.tokens ?? [], boundTokenId) : undefined;
    return (
      <ScrubInput
        key={singleSelected ? `${singleSelected.id}_${axis}` : `multi_${axis}`}
        label={label}
        value={multi
          ? (axis === "width" ? sharedWidth : sharedHeight).mixed
            ? undefined
            : (axis === "width" ? sharedWidth : sharedHeight).value
          : axisValue(axis, primarySelected?.[axis] ?? 1)}
        mixed={multi ? (axis === "width" ? sharedWidth : sharedHeight).mixed : false}
        min={1}
        disabled={readOnly}
        tokenName={boundToken?.name}
        onDetachToken={
          boundTokenId
            ? () => onMutate((el) => unbindNumberTokenFromElement(el, axis), true)
            : undefined
        }
        onOpenTokenPicker={
          !readOnly
            ? (anchor) => setTokenPicker({ axis, anchor })
            : undefined
        }
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onChange={onResize}
        title={locked ? t("component.geometryFromMain") : readOnly ? sizingHint : undefined}
        trailing={
          singleSelected ? (
            /* No divider on the caret's left. The well already ends in a 7px
               gutter, and a hairline there cut the field into "number" and
               "button" — the demo's `.fld` is one recessed box holding a key and
               a right-aligned value, with nothing ruled off. The badge is the
               mode's SHORT name (`fit` / `max` / `fill`) at the value's own size,
               because the full translated label does not fit beside a number and
               the menu repeats it in full anyway. */
            <button
              type="button"
              disabled={locked}
              onClick={() => setOpenAxis(openAxis === axis ? null : axis)}
              className={`flex-none h-full pl-1 pr-[7px] flex items-center gap-0.5 text-row leading-none transition-colors ${
                readOnly
                  ? "text-brand hover:text-brand"
                  : "text-ink-muted hover:text-ink"
              } ${locked ? "opacity-50 cursor-not-allowed" : ""} ${selectable && openAxis === axis ? "bg-raised" : ""}`}
              title={locked ? t("component.geometryFromMain") : sizeModeLabel(mode)}
            >
              {readOnly ? sizeModeShortLabel(mode) : <ChevronDown size={10} />}
            </button>
          ) : undefined
        }
      />
    );
  };

  return (
    <div className="space-y-2" data-inspector-section="size">
      <div className="relative flex items-center gap-1.5" ref={menuHost}>
        <div className="grid grid-cols-2 gap-1 flex-1">
          {renderSizeField("width", "W", (newW) => {
              if (multiBounds) {
                onMutate((el) => unbindNumberTokenFromElement({ ...el, width: newW }, "width"));
              } else if (primarySelected) {
                const targetId = primarySelected.id;
                const curW = primarySelected.width;
                const curH = primarySelected.height;
                const ratio = curW / Math.max(1, curH);
                const newH = isAspectLocked ? Math.max(1, Math.round(newW / ratio)) : curH;
                if (isLineElement(primarySelected)) {
                  onMutate((el) =>
                    el.id === targetId && isLineElement(el)
                      ? setLineSize(unbindNumberTokenFromElement(el, "width") as any, newW, newH)
                      : el
                  );
                } else {
                  onMutate((el) =>
                    el.id === targetId
                      ? pinResizedAxis(
                          resizeElementWithConstraints(unbindNumberTokenFromElement(el, "width"), {
                            width: newW,
                            height: newH
                          }),
                          "width"
                        )
                      : el
                  );
                }
              }
            })}
            {renderSizeField("height", "H", (newH) => {
              if (multiBounds) {
                onMutate((el) => unbindNumberTokenFromElement({ ...el, height: newH }, "height"));
              } else if (primarySelected) {
                const targetId = primarySelected.id;
                const curW = primarySelected.width;
                const curH = primarySelected.height;
                const ratio = curW / Math.max(1, curH);
                const newW = isAspectLocked ? Math.max(1, Math.round(newH * ratio)) : curW;
                if (isLineElement(primarySelected)) {
                  onMutate((el) =>
                    el.id === targetId && isLineElement(el)
                      ? setLineSize(unbindNumberTokenFromElement(el, "height") as any, newW, newH)
                      : el
                  );
                } else {
                  onMutate((el) =>
                    el.id === targetId
                      ? pinResizedAxis(
                          resizeElementWithConstraints(unbindNumberTokenFromElement(el, "height"), {
                            width: newW,
                            height: newH
                          }),
                          "height"
                        )
                      : el
                  );
                }
              }
            })}
          </div>

          <button
            type="button"
            data-aspect-lock={isAspectLocked ? "locked" : "unlocked"}
            aria-pressed={isAspectLocked}
            disabled={locked}
            onClick={() => {
              const targetId = singleSelected?.id;
              onMutate((el) => (!targetId || el.id === targetId ? withAspectLock(el, !isAspectLocked) : el), true);
            }}
            className={`${FIELD_BUTTON_CLASS} bg-raised border-rule-strong ${
              locked
                ? "opacity-50 cursor-not-allowed"
                : isAspectLocked
                ? "text-brand"
                : "text-ink-dim hover:text-ink"
            }`}
            title={
              locked
                ? t("component.geometryFromMain")
                : aspectMixed
                ? t("properties.aspectMixed")
                : isAspectLocked
                ? t("properties.aspectLocked")
                : t("properties.aspectUnlocked")
            }
          >
            {aspectMixed ? <Unlock size={13} className="opacity-50" /> : isAspectLocked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>

          {boundsEveryMember && (
            <button
              type="button"
              data-bounds-toggle={showBounds ? "visible" : "hidden"}
              aria-pressed={showBounds}
              onClick={() => setShowBounds((prev) => !prev)}
              className={`${FIELD_BUTTON_CLASS} bg-raised border-rule-strong ${
                showBounds ? "text-brand" : "text-ink-dim hover:text-ink"
              }`}
              title={showBounds ? t("properties.hideBounds") : t("properties.showBounds")}
              aria-label={showBounds ? t("properties.hideBounds") : t("properties.showBounds")}
            >
              <SquareDimensions size={13} />
            </button>
          )}

          {openAxis && menuMode && (
            <FieldDropdown>
              {menuOptions.map((opt) => {
                const active = menuMode === opt.mode;
                const detail = !opt.effective ? (opt.reason ?? opt.note) : opt.note;
                return (
                  <button
                    key={opt.mode}
                    type="button"
                    disabled={!opt.effective}
                    title={opt.reason ?? opt.note}
                    onClick={() => {
                      const axis = openAxis;
                      onMutate((el) => withAxisMode(el, axis, opt.mode), true);
                      setOpenAxis(null);
                    }}
                    className={`${MENU_OPTION_CLASS} ${
                      !opt.effective ? "cursor-not-allowed opacity-60" : ""
                    }`}
                  >
                    <span className="flex items-center gap-2 w-full">
                      <span className={active ? MENU_OPTION_NAME_ON_CLASS : MENU_OPTION_NAME_CLASS}>
                        {opt.label}
                      </span>
                      {active && <Check size={11} className={`${MENU_OPTION_NAME_ON_CLASS} flex-none`} />}
                    </span>
                    <span
                      className={
                        opt.effective
                          ? MENU_OPTION_NOTE_CLASS
                          : `${MENU_OPTION_NOTE_CLASS} text-measure-coral/80`
                      }
                    >
                      {detail}
                    </span>
                  </button>
                );
              })}
            </FieldDropdown>
          )}
      </div>

      {/* Min / Max, both axes — and only where they can do anything. A bound
          applies to the size a layout pass WRITES, and only an element inside
          a layout parent has one, so this is the same condition under which
          `fill` and `hug` resolve to anything at all. They sit under W because
          they qualify THIS element's own length, which is what the fields above
          them are; `0` is the absent spelling, so there is no empty state to
          discover. */}
      {boundsEveryMember && showBounds && (
        <div className="space-y-1.5" data-inspector-bounds="true">
          {(["min", "max"] as const).map((kind) => (
            <div key={kind} className={ROW_TIGHT_CLASS}>
              <span className={`${SUB_LABEL_CLASS} w-8 shrink-0`} title={t("stack.boundsHint")}>
                {kind === "min" ? t("stack.min") : t("stack.max")}
              </span>
              <div className="grid grid-cols-2 gap-1 flex-1">
                {(["width", "height"] as const).map((axis) => (
                  <ScrubInput
                    key={axis}
                    label={axis === "width" ? "W" : "H"}
                    value={(() => {
                      const r = resolveAcross(selectedElements, (el) => boundOf(el, kind, axis));
                      return r.mixed ? undefined : r.value;
                    })()}
                    mixed={resolveAcross(selectedElements, (el) => boundOf(el, kind, axis)).mixed}
                    min={0}
                    max={100000}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onChange={(v) => onMutate((el) => withBound(el, kind, axis, Math.max(0, v)))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <ShapeGeometrySection
        elements={selectedElements}
        onMutate={onMutate}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />

      {tokenPicker && (
        <NumberTokenPicker
          doc={docRef.current}
          docRef={docRef}
          anchor={tokenPicker.anchor}
          boundTokenId={singleSelected?.tokenBindings?.[tokenPicker.axis]}
          currentValue={axisValue(tokenPicker.axis, primarySelected?.[tokenPicker.axis] ?? 1)}
          category="size"
          onSelect={(tok) => {
            if (!docRef.current.tokens?.some((t) => t.id === tok.id)) {
              docRef.current = addTokenToDoc(docRef.current, tok);
            }
            const axis = tokenPicker.axis;
            if (primarySelected) {
              const targetId = primarySelected.id;
              const ratio = primarySelected.width / Math.max(1, primarySelected.height);
              const otherAxisVal = isAspectLocked
                ? (axis === "width" ? Math.max(1, Math.round(tok.value / ratio)) : Math.max(1, Math.round(tok.value * ratio)))
                : (axis === "width" ? primarySelected.height : primarySelected.width);
              const newW = axis === "width" ? tok.value : otherAxisVal;
              const newH = axis === "height" ? tok.value : otherAxisVal;
              onMutate((el) => {
                if (el.id !== targetId) return el;
                const bound = bindNumberTokenToElement(el, axis, tok.id, tok.value);
                if (isLineElement(bound)) {
                  return setLineSize(bound, newW, newH);
                }
                return pinResizedAxis(resizeElementWithConstraints(bound, { width: newW, height: newH }), axis);
              }, true);
            }
            setTokenPicker(null);
          }}
          onDetach={() => {
            const axis = tokenPicker.axis;
            onMutate((el) => unbindNumberTokenFromElement(el, axis), true);
            setTokenPicker(null);
          }}
          onCommitSnapshot={onCommitSnapshot}
          onClose={() => setTokenPicker(null)}
        />
      )}
    </div>
  );
}
