import { useState, useRef, useEffect } from "preact/hooks";
import { memo } from "../memo";
import { tabClass } from "../panel-tabs-style";
import { DesignElement, DesignDocument, ElementType, InstanceElement, TextElement, updateActivePageElements } from "../../core/dsl/types";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { resolveInstanceBox } from "../../core/interactions/instance-inherit";
import { resolveInstanceContent } from "../../core/interactions/instance-resolve";
import { BooleanOp } from "../../core/geometry/boolean-ops";
import type { PenMode } from "../../core/tools";
import type { FramePreset } from "../../core/frame-presets";
import { AlignmentType } from "../../core/interactions/alignment";
import { childrenOf, isContainer } from "../../core/geometry/tree-ops";
import {
  DEFAULT_THEME,
  getDocumentModes,
  getDocumentNumberModes,
  getElementInheritedNumberMode,
  getElementInheritedTheme,
  setElementNumberMode,
  setElementThemeMode
} from "../../core/interactions/mode-ops";
import { styleTables } from "../../core/interactions/style-tables";
import { TransformSection } from "./TransformSection";
import { AutoLayoutSection } from "./AutoLayoutSection";
import { AppearanceSection } from "./AppearanceSection";
import { FillSection } from "./FillSection";
import { StrokeSection } from "./StrokeSection";
import { EffectsSection } from "./EffectsSection";
import { MaskSection } from "./MaskSection";
import type { ActiveTextRange } from "../hooks/useInlineEditing";
import { TypographySection } from "./TypographySection";
import { LinkSection } from "./LinkSection";
import { ExportSection } from "./ExportSection";
import { CanvasBackgroundSection } from "./CanvasBackgroundSection";
import { DesignSystemSection } from "./DesignSystemSection";
import { VectorSection } from "./VectorSection";
import { ComponentSection } from "./ComponentSection";
import { InstanceChildSection } from "./InstanceChildSection";
import { PathElement } from "../../core/dsl/types";
import { useFieldTabOrder } from "../field-tab-order";
import { useInspectorActivityWatcher } from "../hooks/inspector-activity";
import { useMutate } from "./mutate-channel";
import { SelectedColorsStrip } from "../SelectedColorsStrip";
import { ScaleSection } from "./ScaleSection";
import { SlideSection } from "./SlideSection";
import { FramePresetList } from "./FramePresetList";
import { VideoSection } from "./VideoSection";
import { HtmlEmbedSection } from "./HtmlEmbedSection";
import { ScaleAnchor, DEFAULT_SCALE_ANCHOR } from "../../core/interactions/scale-ops";
import { t } from "../../i18n";
import { TITLE_BAR_HEIGHT } from "../toolbar/titlebar-layout";
import {
  Contrast,
  SquaresUnite,
  SquaresSubtract,
  SquaresIntersect,
  SquaresExclude,
  ChevronDown,
  SwatchBook,
  Check,
  Lock,
  LockOpen,
  Eye,
  EyeOff
} from "lucide-react";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../menu-style";
import { ROW_DENSE_CLASS } from "../row-style";

const MENU_GROUP_LABEL_CLASS = "px-2.5 pt-1 pb-1 text-micro uppercase text-ink-muted";

const NO_ANCHORS = new Set<number>();
const noop = () => { };

export interface InspectorPanelProps {
  hidden?: boolean;
  doc: DesignDocument;
  setDoc: (updater: (d: DesignDocument) => DesignDocument) => void;
  docRef: { current: DesignDocument };
  selectedElements: DesignElement[];
  primarySelected: DesignElement | null;
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  multiBounds: { minX: number; minY: number; width: number; height: number } | null;
  is4Corners: boolean;
  onToggle4Corners: (val: boolean) => void;
  /** The canvas is drawing the morph pairing lines. */
  showMorphLines?: boolean;
  onToggleMorphLines?: (val: boolean) => void;
  /** The pair whose row the pointer is on, so the canvas can light that line. */
  onHoverMorphPair?: (id: string | null) => void;
  /** Lock / unlock every selected layer (`Shift+Cmd+L` does the same). */
  onToggleLock: () => void;
  /** Show / hide every selected layer. Visibility is a layer property, so this
   *  toggles the selection as a whole rather than any one field. */
  onToggleVisibility: () => void;
  onAlign: (type: AlignmentType) => void;
  /** Selects every layer carrying a colour, replacing the current selection. */
  onSelectByColor?: (ids: string[]) => void;
  /** The Scale tool is active, so its parameters are shown. */
  isScaleToolActive?: boolean;
  /** The Frame tool is armed with nothing selected, so the size presets show. */
  isFrameToolActive?: boolean;
  /** Creates a frame at one of those preset sizes. */
  onCreateFramePreset?: (preset: FramePreset) => void;
  scaleAnchor?: ScaleAnchor;
  onScaleAnchorChange?: (anchor: ScaleAnchor) => void;
  /** The selection's size when the tool was entered; the factor reads against it. */
  scaleReference?: { width: number; height: number } | null;
  onLeaveScaleTool?: () => void;
  onBooleanAction: (op: BooleanOp) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  /** Selects a main component, switching pages first when it lives elsewhere. */
  onLocateComponent?: (componentId: string) => void;
  /** One-line notice for a change that happens outside the panel. */
  onHint?: (message: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  canvasContainerRef: { current: HTMLDivElement | null };
  editingPathElement?: PathElement | null;
  selectedAnchorIdxs?: Set<number>;
  onSelectOnlyAnchor?: (idx: number) => void;
  penMode?: PenMode;
  onPenModeChange?: (mode: PenMode) => void;
  onCommitPathEdit?: (newD: string) => void;
  /** Drag-time path writes: one undo step for the whole gesture. */
  onCommitPathTransient?: (newD: string) => void;
  onExitPathEdit?: () => void;
  /** Range of text selected in inline canvas editing, if any. */
  activeTextSelection?: ActiveTextRange | null;
  /** Opens the version-history panel; optional legacy hook. */
  onOpenHistory?: () => void;
}

function InspectorPanelBase({
  hidden = false,
  doc,
  setDoc,
  docRef,
  selectedElements,
  primarySelected,
  selectedIds,
  setSelectedIds,
  multiBounds,
  is4Corners,
  onToggle4Corners,
  showMorphLines = true,
  onToggleMorphLines,
  onHoverMorphPair,
  onToggleLock,
  onToggleVisibility,
  onAlign,
  onSelectByColor,
  isScaleToolActive = false,
  isFrameToolActive = false,
  onCreateFramePreset,
  scaleAnchor = DEFAULT_SCALE_ANCHOR,
  onScaleAnchorChange,
  scaleReference = null,
  onLeaveScaleTool,
  onBooleanAction,
  onCommitSnapshot,
  onLocateComponent,
  onHint,
  onDragStart,
  onDragEnd,
  canvasContainerRef,
  editingPathElement,
  selectedAnchorIdxs,
  onSelectOnlyAnchor,
  penMode = "draw",
  onPenModeChange = noop,
  onCommitPathEdit,
  onCommitPathTransient,
  onExitPathEdit,
  activeTextSelection,
  onOpenHistory
}: InspectorPanelProps) {
  const [booleanMenuOpen, setBooleanMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"properties" | "design-system">("properties");
  const prevSelectedCountRef = useRef(selectedElements.length);
  useEffect(() => {
    if (prevSelectedCountRef.current === 0 && selectedElements.length > 0) {
      setInspectorTab("properties");
    }
    prevSelectedCountRef.current = selectedElements.length;
  }, [selectedElements.length]);

  useFieldTabOrder();
  useInspectorActivityWatcher();
  const onMutate = useMutate();

  // The selection holds a subtree, so its palette is bigger than the layer the
  // paint sections read. Only real children count: a resolved node inside an
  // instance carries no subtree of its own, and a component's children belong to
  // the instance, not to this selection. An INSTANCE is the exception — its
  // children live on the master and the palette projects them, so gating on
  // `childrenOf` alone hid every colour of a selected instance.
  const hasNestedColors = selectedElements.some(
    (el) => childrenOf(el).length > 0 || el.type === "instance"
  );

  // A node reached inside an instance is a resolved clone: geometry and layout
  // belong to the master, so only the override-capable sections may render.
  const isInstanceChild = Boolean(primarySelected?.__instanceId);

  // An instance DISPLAYS its master's fields wherever it does not set its own
  // (fills / strokes / effects / borderRadius). Panels must show what the canvas
  // paints: reading `inst.fills` directly is how the panel came to say "no fill"
  // while the canvas painted the master's. Edits still land on the instance and
  // become overrides, because every section writes through `onMutate`.
  const displaySelected = (() => {
    if (primarySelected?.type !== "instance") return primarySelected;
    const inst = primarySelected as InstanceElement;
    const master = findMasterComponent(docRef.current, inst.componentId);
    if (!master) return primarySelected;
    // The size the layout pass arrived at, not the stored one: a hugging master
    // makes the instance hug, and a field reading the stored box would report a
    // number the canvas is not drawing at.
    const box = resolveInstanceBox(inst, master, resolveInstanceContent(inst, master));
    return {
      ...inst,
      width: box.width,
      height: box.height,
      fills: box.fills,
      strokes: box.strokes,
      borderRadius: box.borderRadius,
      effects: box.effects,
      // The style bindings have to travel with the values. Handing over
      // `fills` alone made an instance of a style-bound component show the
      // master's colours with no binding pill — indistinguishable from a
      // component carrying its own local copy, which is the one reading the
      // dual-storage invariant exists to prevent.
      fillStyleId: box.fillStyleId,
      strokeStyleId: box.strokeStyleId,
      textStyleId: box.textStyleId,
      effectStyleId: box.effectStyleId
    } as DesignElement;
  })();

  // Which selection the geometry sections belong to. A section holding input drafts
  // remounts when this changes, which is how a new selection arrives with clean fields
  // instead of the previous element's half-typed one. The value must be UNIQUE among
  // the stack's children: `key` is matched together with `type`, so a second sibling
  // spelling the same string is handed the first one's old node — and a same-typed
  // sibling taking it keeps the PREVIOUS element's state (measured in
  // `scratch/probe-duplicate-keys-same-type.mjs`). Two sections were added here sharing
  // one string; each is namespaced below.
  const selectionKey = multiBounds
    ? selectedElements.map((e) => e.id).sort().join(",")
    : primarySelected?.id;

  const hasContainerSelection = selectedElements.some((el) => isContainer(el) || el.type === "instance");
  const docModes = getDocumentModes(docRef.current);
  const inheritedThemeId = primarySelected
    ? getElementInheritedTheme(docRef.current, primarySelected.id)
    : DEFAULT_THEME;
  const inheritedModeName = docModes.find((m) => m.id === inheritedThemeId)?.name || inheritedThemeId;
  const currentThemeMode = primarySelected?.themeMode;

  // The NUMBER axis, resolved the same way. Either axis alone is a plain list;
  // both together share one menu, split into two labelled groups, so a container
  // can be `Dark` AND `Compact` — the combination the single-mode field could not
  // express at all.
  const docNumberModes = getDocumentNumberModes(docRef.current);
  const inheritedNumberModeId = primarySelected
    ? getElementInheritedNumberMode(docRef.current, primarySelected.id)
    : DEFAULT_THEME;
  const inheritedNumberModeName =
    docNumberModes.find((m) => m.id === inheritedNumberModeId)?.name || inheritedNumberModeId;
  const currentNumberMode = primarySelected?.numberMode;
  const currentThemeModeName =
    docModes.find((m) => m.id === currentThemeMode)?.name || currentThemeMode;
  const currentNumberModeName =
    docNumberModes.find((m) => m.id === currentNumberMode)?.name || currentNumberMode;
  // What the trigger's tooltip says per axis: the pinned mode, or the one it inherits.
  const colorModeSummary = currentThemeModeName || t("tokens.inheritedTheme", { name: inheritedModeName });
  const numberModeSummary =
    currentNumberModeName || t("tokens.inheritedTheme", { name: inheritedNumberModeName });
  const showsColorModes = docModes.length > 1;
  const showsNumberModes = docNumberModes.length > 1;
  const showsModeMenu = hasContainerSelection && (showsColorModes || showsNumberModes);
  const bothAxes = showsColorModes && showsNumberModes;

  const setAxisMode = (axis: "color" | "number", mode: string | undefined) => {
    const currentDoc = docRef.current;
    const tables = styleTables(currentDoc);
    onMutate((el) => {
      if (!isContainer(el) && el.type !== "instance") return el;
      const inheritedTheme = getElementInheritedTheme(currentDoc, el.id);
      const inheritedNumberMode = getElementInheritedNumberMode(currentDoc, el.id);
      return axis === "color"
        ? setElementThemeMode(el, mode, tables, inheritedTheme, inheritedNumberMode)
        : setElementNumberMode(el, mode, tables, inheritedTheme, inheritedNumberMode);
    }, true);
    setThemeMenuOpen(false);
  };

  const renderAxisItems = (
    axis: "color" | "number",
    modes: typeof docModes,
    inheritedId: string,
    current: string | undefined
  ) => {
    const inheritedName = modes.find((m) => m.id === inheritedId)?.name || inheritedId;
    return (
      <>
        <button
          type="button"
          onClick={() => setAxisMode(axis, undefined)}
          className={`flex items-center justify-between w-full ${MENU_ITEM_CLASS} ${!current ? "text-brand" : ""
            }`}
        >
          <span className="truncate">{t("tokens.inheritedTheme", { name: inheritedName })}</span>
          {!current && <Check size={12} className="shrink-0 ml-1 text-brand" />}
        </button>

        {modes.map((mode) => {
          const isSelected = current === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => setAxisMode(axis, mode.id)}
              className={`flex items-center justify-between w-full ${MENU_ITEM_CLASS} ${isSelected ? "text-brand" : ""
                }`}
            >
              <span className="truncate">{mode.name}</span>
              {isSelected && <Check size={12} className="shrink-0 ml-1 text-brand" />}
            </button>
          );
        })}
      </>
    );
  };

  return (
    <div
      data-ui-panel="right"
      data-field-tab-scope="inspector"
      data-inspector-activity="true"
      style={{ top: TITLE_BAR_HEIGHT }}
      className={`absolute right-0 bottom-0 w-72 bg-panel border-l border-rule flex flex-col z-20 shrink-0 text-ui overflow-hidden transition-transform duration-slide ease-slide ${hidden ? "translate-x-full" : "translate-x-0"
        }`}
    >
      {/* Top Header Row with Tabs */}
      <div className="h-10 px-2.5 border-b border-rule flex items-stretch gap-1 pt-2 shrink-0 bg-panel">
        <button
          type="button"
          data-testid="inspector-tab-properties"
          onClick={() => setInspectorTab("properties")}
          title={t("properties.tabProperties")}
          className={tabClass(inspectorTab === "properties")}
        >
          {t("properties.tabProperties")}
        </button>
        <button
          type="button"
          data-testid="inspector-tab-design-system"
          onClick={() => setInspectorTab("design-system")}
          title={t("tokens.designSystem")}
          className={tabClass(inspectorTab === "design-system")}
        >
          {t("tokens.designSystem")}
        </button>
      </div>

      {/* Second Row: Layer name / count and actions */}
      {inspectorTab === "properties" && selectedElements.length > 0 && (
        <div className="h-9 px-3 border-b border-rule flex items-center justify-between shrink-0 bg-panel">
          <span className="text-row font-semibold text-ink truncate mr-2">
            {selectedElements.length > 1
              ? t("properties.selectedCount", { n: selectedElements.length })
              : primarySelected
                ? primarySelected.name || primarySelected.type
                : ""}
          </span>

          <div className={ROW_DENSE_CLASS}>
            {/* Visibility toggle: the selection can hold hidden layers, so this
                reads as "all hidden" (showing the eye-off state) when every
                selected layer is hidden. Clicking toggles the whole selection. */}
            <button
              onClick={onToggleVisibility}
              className={`p-1.5 rounded-ctl transition-colors ${selectedElements.every((el) => el.visible === false)
                  ? "bg-brand-wash text-brand"
                  : "hover:bg-raised text-ink-dim hover:text-ink"
                }`}
              title={
                selectedElements.every((el) => el.visible === false) ? t("layers.show") : t("layers.hide")
              }
            >
              {selectedElements.every((el) => el.visible === false) ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>

            {/* Lock toggle: the selection can hold locked layers (they stay
                selectable in the Layers Panel), so this reads as "all locked". */}
            <button
              onClick={onToggleLock}
              className={`p-1.5 rounded-ctl transition-colors ${selectedElements.every((el) => el.locked === true)
                  ? "bg-brand-wash text-brand"
                  : "hover:bg-raised text-ink-dim hover:text-ink"
                }`}
              title={
                selectedElements.every((el) => el.locked === true) ? t("layers.unlock") : t("layers.lock")
              }
            >
              {selectedElements.every((el) => el.locked === true) ? <Lock size={14} /> : <LockOpen size={14} />}
            </button>

            {/* Mask toggle button */}
            <button
              onClick={() => {
                const cur = !!primarySelected?.isMask;
                onMutate((el) => ({ ...el, isMask: !cur }), true);
              }}
              className={`p-1.5 rounded-ctl transition-colors ${primarySelected?.isMask
                  ? "bg-brand-wash text-brand"
                  : "hover:bg-raised text-ink-dim hover:text-ink"
                }`}
              title={primarySelected?.isMask ? t("mask.remove") : t("mask.use")}
            >
              <Contrast size={14} />
            </button>

            {/* Boolean Operations Dropdown when 2+ elements selected */}
            {selectedElements.length >= 2 && (
              <div className="relative">
                <button
                  onClick={() => setBooleanMenuOpen((prev) => !prev)}
                  className="flex items-center gap-0.5 p-1.5 hover:bg-raised text-ink-dim hover:text-ink rounded-ctl transition-colors"
                  title={t("boolean.label")}
                  aria-label={t("boolean.label")}
                >
                  <SquaresUnite size={14} />
                  <ChevronDown size={10} />
                </button>

                {booleanMenuOpen && (
                  <div className={`absolute right-0 top-8 w-36 ${MENU_SURFACE_CLASS}`}>
                    <button
                      onClick={() => {
                        onBooleanAction("union");
                        setBooleanMenuOpen(false);
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      <SquaresUnite size={13} />
                      <span>{t("boolean.union")}</span>
                    </button>
                    <button
                      onClick={() => {
                        onBooleanAction("subtract");
                        setBooleanMenuOpen(false);
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      <SquaresSubtract size={13} />
                      <span>{t("boolean.subtract")}</span>
                    </button>
                    <button
                      onClick={() => {
                        onBooleanAction("intersect");
                        setBooleanMenuOpen(false);
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      <SquaresIntersect size={13} />
                      <span>{t("boolean.intersect")}</span>
                    </button>
                    <button
                      onClick={() => {
                        onBooleanAction("exclude");
                        setBooleanMenuOpen(false);
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      <SquaresExclude size={13} />
                      <span>{t("boolean.exclude")}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Container mode switcher: the two token axes, one menu. */}
            {showsModeMenu && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="container-theme-toggle"
                  onClick={() => setThemeMenuOpen((prev) => !prev)}
                  className={`p-1.5 rounded-ctl transition-colors ${currentThemeMode || currentNumberMode
                      ? "bg-brand-wash text-brand"
                      : "hover:bg-raised text-ink-dim hover:text-ink"
                    }`}
                  title={
                    bothAxes
                      ? `${t("tokens.colorMode")}: ${colorModeSummary} · ${t("tokens.numberMode")}: ${numberModeSummary}`
                      : showsColorModes
                        ? `${t("tokens.colorMode")}: ${colorModeSummary}`
                        : `${t("tokens.numberMode")}: ${numberModeSummary}`
                  }
                  aria-label={t("tokens.themeMode")}
                >
                  <SwatchBook size={14} />
                </button>

                {themeMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-30"
                      onClick={() => setThemeMenuOpen(false)}
                    />
                    <div className={`absolute right-0 top-8 w-44 z-40 ${MENU_SURFACE_CLASS}`}>
                      {/* Two categories, one divider between them: a second rule
                          inside each list made the menu read as four blocks. */}
                      {showsColorModes && (
                        <>
                          {bothAxes && (
                            <div className={MENU_GROUP_LABEL_CLASS}>{t("tokens.colorMode")}</div>
                          )}
                          {renderAxisItems("color", docModes, inheritedThemeId, currentThemeMode)}
                        </>
                      )}
                      {bothAxes && <div className="my-1 border-t border-rule" />}
                      {showsNumberModes && (
                        <>
                          {bothAxes && (
                            <div className={MENU_GROUP_LABEL_CLASS}>{t("tokens.numberMode")}</div>
                          )}
                          {renderAxisItems("number", docNumberModes, inheritedNumberModeId, currentNumberMode)}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* `space-y-2` and nothing more: every group's top gap is owned by the
          `Section` heading above it (`pt-[15px]`), so a section boundary and a
          group boundary inside one section are spaced by the same rule. The stack
          used to be `space-y-4`, which made a section boundary 42px and a group
          boundary 22px for the same visual event. */}
      {/* `px-3 pt-4 pb-4`: the reference layout's `.rbody` is `0 12px 12px`, so its
          top is flush and the breathing room comes entirely from the section
          header's own `pt-[15px]`. This rail used `p-3` symmetric, which stacked
          12px on top of that 15px and left the first group twice as far from the
          header rule as the last group was from the floor. A step looser than the
          demo's 12px bottom, and top/bottom now EQUAL so the stack reads as one
          column with margins rather than a list that starts too early. */}
      {inspectorTab === "design-system" ? (
        <DesignSystemSection
          doc={doc}
          docRef={docRef}
          commitSnapshot={onCommitSnapshot}
        />
      ) : (
        <div className="px-3 pt-1 pb-4 flex-1 overflow-y-auto space-y-2">
          {/* Outside the "something is selected" branch on purpose: the Scale tool can
                be on with an empty selection, and a panel that appears only once a layer
                is picked reads as the tool not having turned on. */}
          {isScaleToolActive && (
            <ScaleSection
              selectedElements={selectedElements}
              docRef={docRef}
              anchor={scaleAnchor}
              onAnchorChange={(next) => onScaleAnchorChange?.(next)}
              onClose={() => onLeaveScaleTool?.()}
              reference={scaleReference}
              onCommitSnapshot={onCommitSnapshot}
              setDoc={setDoc}
              onHint={onHint}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          )}

          {isFrameToolActive && onCreateFramePreset ? (
            /* The armed Frame tool owns the panel, whatever is selected: the whole
               point of arming it is to place a NEW board, and the sections that
               describe the current selection answer a question the user has
               already left. They come back the moment the tool is left. */
            <FramePresetList onCreate={onCreateFramePreset} />
          ) : selectedElements.length > 0 ? (
            <>
              {/* The mask layer's own setting, ABOVE the component relation and the
                geometry: it is the one choice that decides whether the paint listed
                below this panel is seen at all, so everything under this row is
                subject to it. It renders nothing unless the selection is actually a
                mask with a channel that varies, so when it is absent the component
                section stays the stack's first visible group and picks up no dead
                space — the same reason SlideSection is left wrapper-free below. */}
              <MaskSection elements={selectedElements} primarySelected={displaySelected} onMutate={onMutate} />

              {/* The component relation: it is what decides how much of the rest of
                this panel is editable, but the mask mode above it is the one choice
                that governs whether the paint is seen at all. A master carries its
                property contract; an instance carries its overrides and its swap; a
                node reached inside an instance is a clone whose geometry and layout
                belong to the master, which is why the two sections are alternatives
                rather than one panel with a disabled half.

                They used to sit below Transform, so on an instance the first thing
                the panel said was a size the user could not edit.

                The wrapper exists so the ORDER is assertable — one attribute naming
                the group, rather than a probe matching on heading text. It holds at
                most one child (the two are alternatives) and is a direct child of the
                section stack.

                It is rendered UNCONDITIONALLY, which is only safe because
                `ComponentSection` answers with content for every selection that
                reaches it (a plain layer gets the promote button). An empty wrapper
                would still be the stack's first child, so its successor would pick up
                a `space-y-4` top margin — 16px of dead space. Render it
                conditionally the day that stops holding. */}
              {!editingPathElement && (
                <div data-inspector-section="component">
                  {primarySelected && isInstanceChild && (
                    <InstanceChildSection
                      primarySelected={primarySelected}
                      docRef={docRef}
                      onCommitSnapshot={onCommitSnapshot}
                      setSelectedIds={setSelectedIds}
                      onLocateComponent={onLocateComponent}
                      onHint={onHint}
                    />
                  )}

                  {primarySelected && !isInstanceChild && (
                    <ComponentSection
                      primarySelected={primarySelected}
                      selectedElements={selectedElements}
                      docRef={docRef}
                      onCommitSnapshot={onCommitSnapshot}
                      setSelectedIds={setSelectedIds}
                      onLocateComponent={onLocateComponent}
                      onHint={onHint}
                    />
                  )}
                </div>
              )}

              {/* How the slide leaves, above the geometry: it is a property of the
                whole frame, decided before its pixels are, and a nested layer has
                no slide of its own. Figma puts its prototype panel above Design
                for the same reason.

                No wrapper div around it: the section renders nothing for a
                selection with no slide, and an empty wrapper would still be the
                stack's first child — so its successor would pick up the stack's
                own gap and the panel would open on 8px of dead space. The
                section tags itself instead. */}
              <SlideSection
                primarySelected={primarySelected}
                doc={doc}
                onMutate={onMutate}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                showMorphLines={showMorphLines}
                onToggleMorphLines={onToggleMorphLines}
                onHoverPair={onHoverMorphPair}
                onSelectLayer={(id) => setSelectedIds(new Set([id]))}
              />

              {primarySelected?.type === "video" && (
                <VideoSection
                  primarySelected={displaySelected ?? primarySelected}
                  docRef={docRef}
                  onMutate={onMutate}
                  onCommitSnapshot={onCommitSnapshot}
                />
              )}

              {primarySelected?.type === "html" && (
                <HtmlEmbedSection primarySelected={displaySelected ?? primarySelected} onMutate={onMutate} />
              )}

              {/* Edit mode only. A selected-but-unedited path needs nothing here,
                and a section whose only controls are "Edit Object" and "Done"
                spends a row of the panel on two ways of not being in edit mode. */}
              {editingPathElement && (
                <VectorSection
                  pathElement={editingPathElement}
                  selectedAnchorIdxs={selectedAnchorIdxs ?? NO_ANCHORS}
                  onSelectOnlyAnchor={onSelectOnlyAnchor ?? noop}
                  penMode={penMode}
                  onPenModeChange={onPenModeChange}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onCommitPathTransient={onCommitPathTransient}
                  onCommitPath={onCommitPathEdit ?? noop}
                  onExitPathEdit={onExitPathEdit ?? noop}
                />
              )}

              {!editingPathElement && (
                <TransformSection
                  key={`transform:${selectionKey}`}
                  primarySelected={primarySelected}
                  selectedElements={selectedElements}
                  selectedIds={selectedIds}
                  docRef={docRef}
                  multiBounds={multiBounds}
                  onAlign={onAlign}
                  onMutate={onMutate}
                  onCommitSnapshot={onCommitSnapshot}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  locked={isInstanceChild}
                />
              )}

              {/* Size lives here, under the one LAYOUT header: how big the box is
                and how its container may resize it are one subject. Hidden while
                the Scale tool owns the size. The section renders for a resolved
                instance child too — the box then reads out the size the clone
                resolved to and refuses the edit, because the master owns it. */}
              <AutoLayoutSection
                key={`layout:${selectionKey}`}
                primarySelected={primarySelected}
                selectedElements={selectedElements}
                doc={doc}
                docRef={docRef}
                showSize={!editingPathElement && !isScaleToolActive}
                multiBounds={multiBounds}
                onMutate={onMutate}
                onCommitSnapshot={onCommitSnapshot}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />

              {/* Corners + blend / opacity / clip under the one APPEARANCE header.
                Corners are OFFERED to a resolved instance child: `borderRadius`
                is an override, not geometry, so it cannot move anything the
                master owns. Withholding it meant the one surface a card's corner
                is edited on disappeared exactly inside the component that has
                corners. A path in edit mode still hides them — a corner belongs
                to a box, and an edited path is not one. */}
              <AppearanceSection
                elements={selectedElements}
                primarySelected={displaySelected}
                doc={doc}
                docRef={docRef}
                showCorners={!editingPathElement}
                is4Corners={is4Corners}
                onToggle4Corners={onToggle4Corners}
                onMutate={onMutate}
                onCommitSnapshot={onCommitSnapshot}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />

              <FillSection
                elements={selectedElements}
                primarySelected={displaySelected}
                activeSelection={activeTextSelection}
                docRef={docRef}
                onMutate={onMutate}
                onCommitSnapshot={onCommitSnapshot}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onHint={onHint}
              />

              <StrokeSection
                elements={selectedElements}
                primarySelected={displaySelected}
                docRef={docRef}
                onMutate={onMutate}
                onCommitSnapshot={onCommitSnapshot}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />

              <EffectsSection
                elements={selectedElements}
                primarySelected={displaySelected}
                docRef={docRef}
                onMutate={onMutate}
                onCommitSnapshot={onCommitSnapshot}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />

              {/* Below Effects. With one leaf layer the Fill section is already
                showing that layer's colours, and a second copy of the same swatches
                answers nothing new — but a CONTAINER is not one layer. Its Fill
                section reads the frame's own paint, and a frame usually has none, so
                without this the colours of everything inside it were nowhere in the
                panel while the selection was visibly several colours. */}
              {(selectedElements.length > 1 || hasNestedColors) && (
                <SelectedColorsStrip
                  elements={selectedElements}
                  docRef={docRef}
                  onSelectByColor={onSelectByColor}
                  onWrite={(nextDoc, discrete) =>
                    discrete === false ? setDoc(() => nextDoc) : onCommitSnapshot(nextDoc)
                  }
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              )}

              {primarySelected?.type === "text" && (
                <TypographySection
                  textElement={(displaySelected ?? primarySelected) as TextElement}
                  elements={selectedElements}
                  activeSelection={activeTextSelection}
                  docRef={docRef}
                  onMutate={onMutate}
                  onCommitSnapshot={onCommitSnapshot}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              )}

              {/* Not gated on `isInstanceChild`: a link is overridable, and a layer
                inside a component is exactly where one instance's link has to
                differ from the master's. */}
              <LinkSection elements={selectedElements} primarySelected={primarySelected} onMutate={onMutate} />

              {!isInstanceChild && (
                <ExportSection
                  doc={doc}
                  docRef={docRef}
                  canvasContainerRef={canvasContainerRef}
                  selectedElements={selectedElements}
                  primarySelected={primarySelected}
                />
              )}
            </>
          ) : (
            <CanvasBackgroundSection
              doc={doc}
              setDoc={setDoc}
              docRef={docRef}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          )}
        </div>
      )}

    </div>
  );
}

export function inspectorPanelPropsEqual(
  prev: InspectorPanelProps,
  next: InspectorPanelProps
): boolean {
  return (
    prev.hidden === next.hidden &&
    prev.doc === next.doc &&
    prev.selectedElements === next.selectedElements &&
    prev.primarySelected === next.primarySelected &&
    prev.selectedIds === next.selectedIds &&
    prev.multiBounds === next.multiBounds &&
    prev.is4Corners === next.is4Corners &&
    prev.showMorphLines === next.showMorphLines &&
    prev.isScaleToolActive === next.isScaleToolActive &&
    prev.isFrameToolActive === next.isFrameToolActive &&
    prev.onCreateFramePreset === next.onCreateFramePreset &&
    prev.scaleAnchor === next.scaleAnchor &&
    prev.scaleReference === next.scaleReference &&
    prev.penMode === next.penMode &&
    prev.editingPathElement === next.editingPathElement &&
    prev.selectedAnchorIdxs === next.selectedAnchorIdxs &&
    prev.activeTextSelection === next.activeTextSelection
  );
}

export const InspectorPanel = memo(InspectorPanelBase, inspectorPanelPropsEqual);

