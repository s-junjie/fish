import { AutoLayout, DesignElement, DesignDocument, FrameElement, PolygonElement, getActivePage } from "../../core/dsl/types";
import { applyAutoLayout } from "../../core/compile";
import { findParentById, isContainer } from "../../core/geometry/tree-ops";
import { ScrubInput } from "../ScrubInput";
import { AlignmentPicker } from "./AlignmentPicker";
import { Button } from "../Button";
import { MoveHorizontal, MoveVertical, Minimize } from "lucide-react";
import { t } from "../../i18n";
import { useEffect, useState } from "preact/hooks";
import { Section } from "./SectionHeader";
import { AutoLayoutControls, LayoutMode } from "./AutoLayoutControls";
import { PadMode, PadTuple, PadModeSegmented, PaddingFields } from "./pad-fields";
import { SizeFields } from "./SizeFields";
import { CheckRow } from "../CheckRow";
import { fitFrameInDocument, frameFitRefusal, FRAME_FIT_REFUSALS } from "../../core/interactions/frame-fit";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_SPREAD_CLASS } from "../row-style";
import { alignSelfOf, layoutOf, toCssLine, withLayout } from "../../core/dsl/layout-flat";

type AlignSelf = NonNullable<AutoLayout["align"]>;

/**
 * `auto` is not one of the DSL's values — it is the absence of the key, which is
 * the only spelling of "inherit the container's align". The dropdown needs a
 * name for that state, so it gets one here rather than in the document.
 */
function withAlignSelf(el: DesignElement, value: string): DesignElement {
  if (value === "auto") {
    const { "align-self": _dropped, ...rest } = el;
    return rest as DesignElement;
  }
  return { ...el, "align-self": toCssLine(value as AlignSelf) as NonNullable<DesignElement["align-self"]> };
}

function withFlexGrow(el: DesignElement, value: number): DesignElement {
  if (!(value > 1)) {
    const { "flex-grow": _dropped, ...rest } = el;
    return rest as DesignElement;
  }
  return { ...el, "flex-grow": value };
}

function marginTuple(margin: DesignElement["margin"]): PadTuple {
  if (Array.isArray(margin)) return [margin[0] ?? 0, margin[1] ?? 0, margin[2] ?? 0, margin[3] ?? 0];
  const v = typeof margin === "number" ? margin : 0;
  return [v, v, v, v];
}

function withMargin(el: DesignElement, next: PadTuple): DesignElement {
  if (next.every((v) => v === 0)) {
    const { margin: _dropped, ...rest } = el;
    return rest as DesignElement;
  }
  return { ...el, margin: next };
}

/**
 * `auto` is not a DSL value either — it is the absence of `grid-area`, which is
 * the only spelling of "let the grid's flow decide".
 */
function withCell(el: DesignElement, cell: DesignElement["grid-area"] | null): DesignElement {
  if (!cell) {
    const { "grid-area": _dropped, ...rest } = el;
    return rest as DesignElement;
  }
  return { ...el, "grid-area": cell };
}

function cellWith(el: DesignElement, patch: Partial<NonNullable<DesignElement["grid-area"]>>): DesignElement {
  const next: NonNullable<DesignElement["grid-area"]> = { ...(el["grid-area"] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (next as Record<string, unknown>)[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return withCell(el, Object.keys(next).length > 0 ? next : null);
}

interface AutoLayoutSectionProps {
  primarySelected: DesignElement | null;
  selectedElements: DesignElement[];
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  /** The Scale tool owns the size while it is on: its own panel carries W / H /
   *  factor / anchor, and a second live copy of the same two numbers would have
   *  to be kept in agreement by hand. False also while a path is in edit mode. */
  showSize: boolean;
  multiBounds: { minX: number; minY: number; width: number; height: number } | null;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/**
 * The LAYOUT section: the element's own size fields first (`SizeFields`), then
 * how its parent places it and how it places its children.
 */
export function AutoLayoutSection({
  primarySelected,
  selectedElements,
  doc,
  docRef,
  showSize,
  multiBounds,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd
}: AutoLayoutSectionProps) {
  // `padMode` is the user's current intent, which is not always what the stored
  // padding happens to look like: picking "uniform" on four unequal sides makes
  // them equal, but picking it while they are already equal must not be undone by
  // re-deriving the mode from the values on the next render.
  const [padMode, setPadMode] = useState<PadMode | null>(null);
  // The same "user's current intent" rule as `padMode`, for the margin editor.
  const [marginMode, setMarginMode] = useState<PadMode | null>(null);

  useEffect(() => {
    setPadMode(null);
    setMarginMode(null);
  }, [primarySelected?.id]);

  if (!primarySelected) return null;

  // An instance clips the same way a frame does — its resolved children are
  // painted into its box — so the clip switch belongs to the layout section.
  const clipsChildren =
    primarySelected.type === "frame" ||
    primarySelected.type === "component" ||
    primarySelected.type === "instance";
  const clipRow = clipsChildren && (
    <CheckRow
      testId="clip-content"
      checked={!!(primarySelected as { clipContent?: boolean }).clipContent}
      onChange={(checked) =>
        onMutate((el) => ({ ...el, clipContent: checked } as DesignElement), true)
      }
      label={t("stack.clipContent")}
    />
  );

  // A resolved instance child owns no layout of its own — geometry and stack
  // belong to the master. `clipContent` is the one layout-adjacent property that
  // IS override-capable, so everything else reduces to a disabled box the user
  // can still READ: where the layer sits and how big it came out are things one
  // asks this panel, and a panel that answers "nothing here" answers worse.
  if (primarySelected.__instanceId) {
    if (!clipsChildren && !showSize) return null;
    return (
      <Section id="layout" title={t("properties.layout")}>
        {showSize && (
          <SizeFields
            primarySelected={primarySelected}
            selectedElements={selectedElements}
            docRef={docRef}
            multiBounds={multiBounds}
            onMutate={onMutate}
            onCommitSnapshot={onCommitSnapshot}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            locked
          />
        )}
        {clipRow}
      </Section>
    );
  }

  const isContainerEl = isContainer(primarySelected);
  const parent = findParentById(getActivePage(doc).children, primarySelected.id);
  const isPolygon = primarySelected.type === "polygon";

  const margin = marginTuple(primarySelected.margin);
  const cell = primarySelected["grid-area"];
  const pinned = cell?.column !== undefined || cell?.row !== undefined;
  // `flex-grow` is a share of a flex parent's main-axis leftover, so it only
  // means something for a child that fills that axis — otherwise showing it is a
  // control that does nothing when dragged.
  const parentLayout = parent ? layoutOf(parent) : undefined;
  const flexParent = parentLayout?.mode === "flex" ? parentLayout : undefined;
  const fillsMainAxis =
    !!flexParent &&
    primarySelected.sizing?.[flexParent.direction === "row" ? "width" : "height"] === "fill";
  /**
   * The same test padding's mode uses — all four equal is mode "1" — and the
   * order matters. This used to ask "are they all ZERO", which is a different
   * question: a uniform `[4,4,4,4]` fell through to the vertical/horizontal
   * test and matched it, so the very first drag out of the uniform field flipped
   * the panel to mode 2 — and because mode 2 renders two fields where mode 1
   * rendered one, the input under the pointer was REPLACED mid-drag.
   */
  const effMarginMode: PadMode =
    marginMode ??
    (margin[0] === margin[1] && margin[1] === margin[2] && margin[2] === margin[3]
      ? "1"
      : margin[0] === margin[2] && margin[1] === margin[3]
        ? "2"
        : "4");

  const frame = isContainerEl ? (primarySelected as FrameElement) : undefined;
  const frameLayout = frame ? layoutOf(frame) : undefined;
  const pad: PadTuple = (() => {
    const p = frameLayout?.padding;
    if (Array.isArray(p)) return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0];
    const v = typeof p === "number" ? p : 0;
    return [v, v, v, v];
  })();
  const effPadMode: PadMode =
    padMode ??
    (pad[0] === pad[1] && pad[1] === pad[2] && pad[2] === pad[3]
      ? "1"
      : pad[0] === pad[2] && pad[1] === pad[3]
        ? "2"
        : "4");

  const setPaddingMode = (next: PadMode) => {
    setPadMode(next);
    if (!frameLayout) return;
    const [t0, r0, b0, l0] = pad;
    const nextPad: PadTuple =
      next === "1" ? [t0, t0, t0, t0] : next === "2" ? [t0, r0, t0, r0] : [t0, r0, b0, l0];
    if (nextPad.every((v, i) => v === [t0, r0, b0, l0][i])) return;
    onMutate((el) => applyAutoLayout(withLayout(el as FrameElement, { ...layoutOf(el)!, padding: nextPad })), true);
  };

  const patchLayout = (
    patch: Partial<AutoLayout>,
    commit = false,
    tokenBindingsPatch?: Record<string, string | undefined>
  ) => {
    onMutate((el) => {
      let frame = el as FrameElement;
      if (tokenBindingsPatch) {
        const nextBindings = { ...(frame.tokenBindings || {}) };
        for (const [k, v] of Object.entries(tokenBindingsPatch)) {
          if (v === undefined) delete nextBindings[k];
          else nextBindings[k] = v;
        }
        frame = {
          ...frame,
          tokenBindings: Object.keys(nextBindings).length > 0 ? nextBindings : undefined
        };
      }
      const nextLayout = { ...(layoutOf(frame) || {}), ...patch } as AutoLayout;
      let nextSizing = frame.sizing ? { ...frame.sizing } : undefined;

      // Turning on wrap: main axis needs a fixed boundary, cross axis automatically hugs
      if (patch.wrap === "wrap") {
        const isCol = nextLayout.direction === "column";
        const mainAxis = isCol ? "height" : "width";
        const crossAxis = isCol ? "width" : "height";

        nextSizing = nextSizing ? { ...nextSizing } : {};
        if (nextSizing[mainAxis] === "fit-content" || nextSizing[mainAxis] === "max-content") {
          delete nextSizing[mainAxis];
        }
        nextSizing[crossAxis] = "fit-content";
      }

      const updated = withLayout({
        ...frame,
        ...(nextSizing ? { sizing: nextSizing } : {})
      } as FrameElement, nextLayout);
      return applyAutoLayout(updated);
    }, commit);
  };

  const layoutMode: LayoutMode = !frameLayout
    ? "free"
    : frameLayout.mode === "grid"
      ? "grid"
      : frameLayout.direction === "column"
        ? "vertical"
        : "horizontal";

  const switchLayoutMode = (m: LayoutMode) => {
    if (m === layoutMode) return;
    onMutate((el) => {
      const target = el as FrameElement;
      const cur = layoutOf(target);
      if (m === "free") {
        // Children keep their baked absolute positions when the layout is stripped.
        const next = withLayout(target, undefined);
        if (next.sizing) {
          const nextSizing = { ...next.sizing };
          delete nextSizing.width;
          delete nextSizing.height;
          if (Object.keys(nextSizing).length === 0) delete (next as any).sizing;
          else next.sizing = nextSizing;
        }
        return next;
      }
      const hasChildren = (target.children || []).length > 0;
      const nextSizing = target.sizing ? { ...target.sizing } : {};
      if (!cur && hasChildren) {
        if (!nextSizing.width) nextSizing.width = "fit-content";
        if (!nextSizing.height) nextSizing.height = "fit-content";
      }
      const sizedBase = (Object.keys(nextSizing).length > 0 ? { ...target, sizing: nextSizing } : { ...target }) as FrameElement;
      if (m === "vertical" || m === "horizontal") {
        const dir = m === "vertical" ? ("column" as const) : ("row" as const);
        if (!cur || cur.mode !== "flex") {
          return applyAutoLayout(withLayout(sizedBase, {
            mode: "flex" as const,
            direction: dir,
            gap: cur?.columnGap ?? cur?.rowGap ?? cur?.gap ?? 16,
            ...(cur?.padding !== undefined
              ? { padding: cur.padding }
              : { padding: [0, 0, 0, 0] as PadTuple }),
            justify: "start" as const,
            align: "start" as const
          }));
        }
        return applyAutoLayout(withLayout(target, { ...cur, direction: dir }));
      }
      if (cur?.mode === "grid") return target;
      return applyAutoLayout(withLayout(sizedBase, {
        mode: "grid" as const,
        ...(cur?.gap !== undefined ? { gap: cur.gap } : {}),
        ...(cur?.padding !== undefined ? { padding: cur.padding } : {}),
        columns: cur?.columns ?? 2,
        columnGap: cur?.columnGap ?? cur?.gap ?? 16,
        rowGap: cur?.rowGap ?? cur?.gap ?? 16,
        cellAlign: cur?.cellAlign ?? "stretch",
        placement: cur?.placement ?? "row"
      }));
    }, true);
  };

  if (!isContainerEl && !parent && !isPolygon && !showSize) return null;

  const childPlacement = Boolean(parentLayout);
  const fitTarget = showSize && !multiBounds && primarySelected && isContainer(primarySelected) ? primarySelected : null;
  const fitRefusal = frameFitRefusal(fitTarget);

  // `auto` is the absence of the key, so its label has to say where the value
  // then comes from rather than naming a value the document can hold.
  const ALIGN_SELF_OPTIONS = [
    { value: "auto", label: t("stack.alignSelfAuto") },
    { value: "start", label: t("stack.alignStart") },
    { value: "center", label: t("stack.alignCenter") },
    { value: "end", label: t("stack.alignEnd") },
    { value: "stretch", label: t("stack.cellStretch") }
  ] as const;

  return (
    <Section
      id="layout"
      title={t("properties.layout")}
      /* The heading is drawn only when one of the three halves below contributes.
         A polygon in path-edit mode reaches here with none of them and renders
         its side-count row with no heading above it — the state as it was, kept
         rather than quietly given a heading it never had. */
      header={Boolean(frame || childPlacement || showSize)}
      trailing={
        fitTarget ? (
          <button
            type="button"
            data-resize-to-fit="true"
            disabled={fitRefusal !== null}
            title={fitRefusal ? t(FRAME_FIT_REFUSALS[fitRefusal]) : t("frame.resizeToFit")}
            aria-label={t("frame.resizeToFit")}
            onClick={() => {
              const result = fitFrameInDocument(docRef.current, fitTarget.id);
              if (result.changed) onCommitSnapshot(result.doc);
            }}
            className={`p-1 rounded-ctl transition-colors ${fitRefusal !== null ? "text-ink-muted cursor-default" : "text-ink-dim hover:text-ink hover:bg-raised"
              }`}
          >
            <Minimize size={13} />
          </button>
        ) : undefined
      }
    >

      {/* The element's own size first — W/H, aspect lock, bounds, shape
          geometry — then the relationships: how the parent places this element
          and how it places its children. */}
      {showSize && (
        <SizeFields
          primarySelected={primarySelected}
          selectedElements={selectedElements}
          docRef={docRef}
          multiBounds={multiBounds}
          onMutate={onMutate}
          onCommitSnapshot={onCommitSnapshot}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      )}

      {/* The child's own cross-axis placement and its own breathing room. Both
          are only meaningful where a container is placing the element, so they
          appear with the parent's layout and nowhere else — a control that does
          nothing when dragged is worse than an absent one.

          FIRST in the section, above the element's own layout. It is the outer
          relationship ("how my parent places me") and the inner one is what
          follows ("how I place my children"), which is also how
          `TransformSection`'s own Align reads. The order matters more than it
          looks: an imported page is mostly containers inside stacks, so putting
          these after a container's own controls buried them below the fold —
          which is the reported symptom this header was asked for. */}
      {childPlacement && (
        <div className="space-y-1.5 pt-1">
          <div className={ROW_SPREAD_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("stack.alignSelf")}</span>
            <AlignmentPicker
              kind="align-self"
              className="w-36"
              attrs={{ "data-stack-align-self": "true" }}
              label={t("stack.alignSelf")}
              value={alignSelfOf(primarySelected) ?? "auto"}
              options={ALIGN_SELF_OPTIONS}
              onChange={(val) => onMutate((el) => withAlignSelf(el, val), true)}
            />
          </div>

          {(fillsMainAxis || (primarySelected["flex-grow"] ?? 0) > 0) && (
            <div className={ROW_SPREAD_CLASS}>
              <span className={SUB_LABEL_CLASS}>{t("stack.flexGrow")}</span>
              <div className="w-36" data-stack-flex-grow="true">
                <ScrubInput
                  label=""
                  value={primarySelected["flex-grow"] ?? 1}
                  min={1}
                  max={100}
                  step={1}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onChange={(v) => onMutate((el) => withFlexGrow(el, v))}
                />
              </div>
            </div>
          )}

          <div className={ROW_SPREAD_CLASS} data-stack-margin="true">
            <span className={`${SUB_LABEL_CLASS} block`}>{t("stack.margin")}</span>
            <PadModeSegmented value={effMarginMode} onChange={setMarginMode} />
          </div>
          {/* Signed: `min` is the one thing the padding editor cannot say, and a
              negative margin is the only way this dialect overlaps two siblings
              without taking one out of the flow. */}
          <div data-stack-spacing="margin">
            <PaddingFields
              pad={margin}
              mode={effMarginMode}
              elementId={primarySelected.id}
              kind="margin"
              min={-200}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(next) => onMutate((el) => withMargin(el, next))}
            />
          </div>

          {/* How many tracks a grid child covers. WHERE it sits is not a field:
              that is what dragging it on the canvas is, and a number typed here
              could only ever disagree with the box on screen. Only where the
              parent is a GRID — a flex parent flows on one axis and has no
              tracks to span. */}
          {parentLayout?.mode === "grid" && (
            <div className="space-y-1.5 pt-1">
              <div className={ROW_SPREAD_CLASS}>
                <span className={SUB_LABEL_CLASS}>{t("stack.cellSpan")}</span>
                {/* Only when the document pins this child to a track, which the
                    import is the one thing that does (`grid-column: 3`). The pin
                    has no field of its own any more, so this is the way out of
                    it — and it is absent the rest of the time, because a reset
                    for nothing is a button that does nothing. */}
                {pinned && (
                  <Button
                    size="text"
                    type="button"
                    data-stack-cell-auto="true"
                    title={t("stack.cellAutoHint")}
                    onClick={() => onMutate((el) => withCell(el, null), true)}
                  >
                    {t("stack.cellAuto")}
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <div data-stack-cell-span="column" title={t("stack.cellSpanColumn")}>
                  <ScrubInput
                    label={<MoveHorizontal size={12} />}
                    value={cell?.columnSpan ?? 1}
                    min={1}
                    max={24}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onChange={(v) => onMutate((el) => cellWith(el, { columnSpan: v > 1 ? Math.round(v) : undefined }))}
                  />
                </div>
                <div data-stack-cell-span="row" title={t("stack.cellSpanRow")}>
                  <ScrubInput
                    label={<MoveVertical size={12} />}
                    value={cell?.rowSpan ?? 1}
                    min={1}
                    max={24}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onChange={(v) => onMutate((el) => cellWith(el, { rowSpan: v > 1 ? Math.round(v) : undefined }))}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {frame && (
        <AutoLayoutControls
          frame={frame}
          doc={doc}
          docRef={docRef}
          layoutMode={layoutMode}
          switchLayoutMode={switchLayoutMode}
          pad={pad}
          padMode={effPadMode}
          setPaddingMode={setPaddingMode}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onLayout={patchLayout}
          onCommitSnapshot={onCommitSnapshot}
        />
      )}

      {isPolygon && (
        <div className="flex items-center justify-between pt-1">
          <span className={SUB_LABEL_CLASS}>{t("shape.sides")}</span>
          <div className="w-24">
            <ScrubInput
              label={t("stack.sides")}
              value={(primarySelected as PolygonElement).sides || 5}
              min={3}
              max={60}
              step={1}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(val) => {
                const sides = Math.max(3, Math.min(60, Math.round(val)));
                onMutate((el) => ({ ...el, sides }));
              }}
            />
          </div>
        </div>
      )}
      {clipRow}
    </Section>
  );
}
