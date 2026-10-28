import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import {
  DesignDocument,
  DesignStyle,
  EffectStyle,
  Paint,
  PaintStyle,
  Stroke,
  StrokeStyle,
  StyleType,
  TextStyle,
  TextStyleDeclaration,
  TextStyleDefinition,
  Effect
} from "../../core/dsl/types";
import {
  createPaintStyle,
  createStrokeStyle,
  createTextStyle,
  createEffectStyle
} from "../../core/interactions/style-ops";
import { t } from "../../i18n";
import { createEffect } from "../EffectRows";
import { StyleListView } from "./StyleListView";
import { StyleEditorView } from "./StyleEditorView";
import { EffectTypeMenu } from "./EffectTypeMenu";
import { paintImageUri } from "./paint-preview";
import { loadImageFromFile } from "../../core/interactions/image-loader";
import { NEW_SOLID, DEFAULT_TEXT_STYLE, DEFAULT_STROKE_ROW } from "./style-draft-defaults";
import { toTextStyleDeclaration } from "../../core/dsl/text-style-declarations";
import { ColorPanel } from "../ColorPanel";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { setPickerOpen } from "../hooks/picker-focus";
import { POPOVER_SURFACE_CLASS } from "../menu-style";

export const POPOVER_WIDTH = 260;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

/** A fresh draft is a deep copy, so editing it cannot reach back into the element. */
function draft<T>(value: T): T {
  return structuredClone(value);
}

/** A layer's style cut down to what a text style may declare — one cutter, shared
 *  with `createTextStyle` and normalize, so a draft cannot hold a key the style
 *  would refuse. */
function declarationOf(style: TextStyle | TextStyleDeclaration): TextStyleDeclaration {
  return toTextStyleDeclaration(style as TextStyle).declaration;
}

export interface CurrentSelectionPreview {
  type: StyleType;
  /** The element being edited, so a saved style can bind itself in the same commit. */
  elementId?: string;
  paints?: Paint[];
  strokes?: Stroke[];
  textStyle?: TextStyle;
  effects?: Effect[];
}

const DEFAULT_STYLE_NAME: Record<string, string> = {
  paint: "New fill style",
  stroke: "New stroke style",
  text: "New text style",
  effect: "New effect style"
};

interface StyleDraft {
  paints: Paint[];
  strokes: Stroke[];
  /** A text style's declarations — type only, no ink (see `TextStyleDeclaration`). */
  textStyle: TextStyleDeclaration;
  effects: Effect[];
}

/** Seeds all draft kinds, so switching `styleType` never shows a stale one. */
function seedDrafts(
  styleType: StyleType,
  editTarget: DesignStyle | null,
  current: CurrentSelectionPreview | undefined
): StyleDraft {
  const defaults: StyleDraft = {
    paints: current?.paints?.length ? draft(current.paints) : [draft(NEW_SOLID)],
    strokes: current?.strokes?.length ? draft(current.strokes) : [draft(DEFAULT_STROKE_ROW)],
    textStyle: declarationOf(draft(current?.textStyle ?? DEFAULT_TEXT_STYLE)),
    // A text style is TYPE, and the editor offers no way to add anything else:
    // its properties are the fixed set of type rows. Effects still exist on the
    // shape (an imported or older style can carry one) but this editor neither
    // seeds nor shows them, so saving such a style is what strips them.
    effects: styleType === "text" ? [] : current?.effects?.length ? draft(current.effects) : [createEffect("drop-shadow")]
  };
  if (!editTarget) return defaults;
  if (editTarget.styleType === "paint" && (editTarget as PaintStyle).paints?.length) defaults.paints = draft((editTarget as PaintStyle).paints);
  else if (editTarget.styleType === "stroke" && (editTarget as StrokeStyle).strokes?.length) defaults.strokes = draft((editTarget as StrokeStyle).strokes);
  else if (editTarget.styleType === "text") {
    // `effects` is left at the seeded empty list: a style saved by an older
    // build may still carry them, and saving it again is how it loses them.
    defaults.textStyle = draft((editTarget as TextStyleDefinition).style);
  } else if (editTarget.styleType === "effect" && (editTarget as EffectStyle).effects?.length) defaults.effects = draft((editTarget as EffectStyle).effects);
  return defaults;
}

function buildSavedStyle(
  styleType: StyleType,
  editingStyleId: string | null,
  name: string,
  drafts: StyleDraft
): DesignStyle {
  const style =
    styleType === "paint"
      ? createPaintStyle(name, drafts.paints.length ? drafts.paints : [draft(NEW_SOLID)])
      : styleType === "stroke"
        ? createStrokeStyle(name, drafts.strokes.length ? drafts.strokes : [draft(DEFAULT_STROKE_ROW)])
        : styleType === "text"
          ? createTextStyle(name, drafts.textStyle)
          : createEffectStyle(name, drafts.effects);
  if (editingStyleId) (style as any).id = editingStyleId;
  return style;
}

export interface StylePickerPopoverProps {
  styleType: StyleType;
  boundStyleId?: string;
  availableStyles: DesignStyle[];
  anchorRef: { current: HTMLElement | null };
  currentSelection?: CurrentSelectionPreview;
  initialMode?: "list" | "create";
  initialEditStyle?: DesignStyle | null;
  onSelectStyle: (style: DesignStyle) => void;
  onDetachStyle?: () => void;
  onSaveStyle?: (style: DesignStyle) => void;
  /** The undo stream for a number-token edit saved from the draft text rows. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
  onCreateNew?: () => void;
  onEditStyle?: (style: DesignStyle) => void;
  onClose: () => void;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  /** Hide the style banner when editing from the design-system inspector. */
  showPreview?: boolean;
}

export function StylePickerPopover({
  styleType,
  boundStyleId,
  availableStyles,
  anchorRef,
  currentSelection,
  initialMode = "list",
  initialEditStyle,
  onSelectStyle,
  onDetachStyle,
  onSaveStyle,
  onCommitSnapshot,
  onCreateNew,
  onEditStyle,
  onClose,
  doc,
  docRef,
  showPreview = true
}: StylePickerPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const editTarget = initialEditStyle ?? null;

  const [viewMode, setViewMode] = useState<"list" | "create">(
    editTarget || initialMode === "create" ? "create" : "list"
  );
  const [filterText, setFilterText] = useState("");
  const [editingStyleId, setEditingStyleId] = useState<string | null>(editTarget?.id ?? null);
  const [createName, setCreateName] = useState(editTarget?.name ?? "");
  const [createDescription, setCreateDescription] = useState(editTarget?.description ?? "");
  const [drafts, setDrafts] = useState<StyleDraft>(() => seedDrafts(styleType, editTarget, currentSelection));
  // Which effect type a new layer gets is chosen when adding it, exactly like the
  // inspector's Add Effect menu — the rows themselves carry no type control.
  const [effectMenuAnchor, setEffectMenuAnchor] = useState<HTMLElement | null>(null);
  const [activePaintPicker, setActivePaintPicker] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [viewMode],
    compute: (anchor, panel) => {
      const a = anchor.getBoundingClientRect();
      if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) return null;
      let left = a.left - POPOVER_WIDTH - ANCHOR_GAP;
      if (left < VIEWPORT_MARGIN) {
        left = Math.min(a.right + ANCHOR_GAP, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
      }
      left = Math.max(VIEWPORT_MARGIN, left);

      const height = panel.offsetHeight || 320;
      const fitsBelow = a.top + height <= window.innerHeight - BOTTOM_MARGIN;
      const fitsAbove = a.top - height >= VIEWPORT_MARGIN;
      const top = fitsBelow
        ? a.top
        : fitsAbove
          ? a.top - height
          : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - BOTTOM_MARGIN);
      return { left, top };
    }
  });

  // Escape unwinds one layer at a time — the effect menu, then the colour picker,
  // then this panel — so a press inside a nested popover does not tear down the
  // editor you were working in.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useDismiss(
    true,
    () => {
      if (effectMenuAnchor) setEffectMenuAnchor(null);
      else if (activePaintPicker) setActivePaintPicker(null);
      else closeRef.current();
    },
    panelRef,
    anchorRef,
    ["[data-color-panel]", "[data-font-panel]", "[data-font-trigger]", "[data-effect-menu]"]
  );

  /* The popover owns the keyboard while it is up (see `picker-focus`). Without
     this, Escape closed it and then reached the shortcut layer, which read the
     same key as "clear the selection" — the selection going away took the panel
     that opened this popover with it, so one Escape looked like it closed two
     things. */
  useEffect(() => {
    setPickerOpen(true);
    return () => setPickerOpen(false);
  }, []);

  // The panel stays hidden until placed, and a hidden element cannot take focus
  // — so focus once, as soon as it is really visible. Guarded: `pos` also changes
  // on resize, which must not steal focus back.
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (viewMode !== "create" || focusedOnceRef.current || !pos) return;
    focusedOnceRef.current = true;
    nameInputRef.current?.focus();
  }, [viewMode, pos]);

  const filteredStyles = useMemo(
    () =>
      availableStyles.filter((s) => {
        if (s.styleType !== styleType) return false;
        if (!filterText) return true;
        const q = filterText.toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          Boolean(s.description?.toLowerCase().includes(q))
        );
      }),
    [availableStyles, styleType, filterText]
  );

  const startCreateMode = () => {
    // Some hosts own their own "create" surface (the Local Styles panel opens
    // straight into the editor); defer rather than duplicating the editor.
    if (!onSaveStyle && onCreateNew) {
      onCreateNew();
      onClose();
      return;
    }
    setEditingStyleId(null);
    setCreateName("");
    setCreateDescription("");
    setDrafts(seedDrafts(styleType, null, currentSelection));
    setViewMode("create");
  };

  const startEditMode = (style: DesignStyle) => {
    setEditingStyleId(style.id);
    setCreateName(style.name);
    setCreateDescription(style.description || "");
    setDrafts(seedDrafts(styleType, style, currentSelection));
    setViewMode("create");
  };

  const handleCreateSubmit = (e?: Event) => {
    e?.preventDefault();
    const finalName = createName.trim() || DEFAULT_STYLE_NAME[styleType];
    const saved = buildSavedStyle(styleType, editingStyleId, finalName, drafts);
    if (createDescription.trim()) saved.description = createDescription.trim();
    onSaveStyle?.(saved);
    onClose();
  };

  /**
   * A style's image layer names an asset the DOCUMENT holds, so picking a file
   * here has to do two things in one step: put the asset in the document and
   * point the draft at it. Writing the draft alone would save a style whose
   * bitmap no reader can find — which is exactly the "Missing image" this panel
   * used to open on.
   */
  const uploadImageIntoDraft = async (file: File) => {
    if (!activePaintPicker) return;
    const index = activePaintPicker.index;
    try {
      const { asset } = await loadImageFromFile(file, 0, 0, file.name);
      const live = doc ?? docRef?.current;
      if (live && !(live.assets ?? []).some((a) => a.id === asset.id)) {
        onCommitSnapshot?.({ ...live, assets: [...(live.assets ?? []), asset] });
      }
      setDrafts((cur) => {
        const paints = [...cur.paints];
        const curPaint = paints[index];
        paints[index] =
          curPaint && curPaint.type === "image"
            ? { ...curPaint, assetId: asset.id }
            : ({ type: "image", assetId: asset.id, fit: "cover" } as Paint);
        return { ...cur, paints };
      });
    } catch (err) {
      console.error("Failed to add image asset:", err);
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      data-host-popover="true"
      data-field-tab-scope="style-picker"
      data-inspector-activity="true"
      // Never a `duration-*` on the root: it sets only `transition-duration`
      // (`transition-property` stays `all`), so the `-9999` placeholder tweens
      // into place — and a mid-transition panel is not focusable.
      // `px-2.5 py-3`: the two axes want different amounts, so not a uniform `p-*`.

      // Popovers keep the panel-wide 6 px scrollbar (DESIGN.md §Scrollbars) — the
      // earlier `.scrollbar-narrow` override at 4 px made the thumb read as a
      // hairline next to the cards rather than as a scrollbar. The card list
      // still carries `scrollbar-gutter: stable both-edges` so its column stays
      // centred (see StyleListView); a 6 px thumb on a 6 px gutter on each side
      // leaves a card row 10 px (padding) + 6 px (gutter) = 16 px from either
      // border.
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed px-2.5 py-3 flex flex-col text-ui select-none max-h-[85vh] overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
    >
      {viewMode === "list" ? (
        <StyleListView
          styleType={styleType}
          boundStyleId={boundStyleId}
          styles={filteredStyles}
          filterText={filterText}
          imageUri={paintImageUri(doc ?? docRef?.current)}
          onFilterChange={setFilterText}
          onSelectStyle={(s) => {
            onSelectStyle(s);
            onClose();
          }}
          onEdit={(s) => (onEditStyle ? onEditStyle(s) : startEditMode(s))}
          onDetachStyle={onDetachStyle}
          onCreate={startCreateMode}
          onClose={onClose}
        />
      ) : (
        <StyleEditorView
          styleType={styleType}
          doc={doc ?? docRef?.current}
          docRef={docRef}
          name={createName}
          description={createDescription}
          drafts={drafts}
          setDrafts={setDrafts}
          editing={!!editingStyleId}
          nameInputRef={nameInputRef}
          activePaintPicker={activePaintPicker}
          setActivePaintPicker={setActivePaintPicker}
          effectMenuAnchor={effectMenuAnchor}
          setEffectMenuAnchor={setEffectMenuAnchor}
          onNameChange={setCreateName}
          onDescriptionChange={setCreateDescription}
          onSubmit={handleCreateSubmit}
          showPreview={showPreview}
          onCommitSnapshot={onCommitSnapshot}
          onCancel={() => {
            if (initialMode === "create" || editTarget) onClose();
            else setViewMode("list");
          }}
        />
      )}

      {activePaintPicker && drafts.paints[activePaintPicker.index] && (
        <ColorPanel
          title={t("paint.fill")}
          paint={drafts.paints[activePaintPicker.index]}
          anchor={activePaintPicker.anchor}
          doc={doc ?? docRef?.current}
          docRef={docRef}
          /* The style editor's own fill panel: without the document's assets it
             opened on a photo layer already painting one and could only say
             "Missing image" — the bitmap dropdown, the preview and the upload
             button all had nothing to resolve against. */
          assets={doc?.assets ?? docRef?.current?.assets}
          onUploadImage={uploadImageIntoDraft}
          onChange={(next) =>
            setDrafts((cur) => {
              const updated = [...cur.paints];
              updated[activePaintPicker.index] = next;
              return { ...cur, paints: updated };
            })
          }
          onClose={() => setActivePaintPicker(null)}
        />
      )}

      {/* Only an effect style reaches this menu now: a text style has no plus,
          so the `isText` filter the element inspector uses has no caller here. */}
      {effectMenuAnchor && (
        <EffectTypeMenu
          anchor={effectMenuAnchor}
          onPick={(kind) => {
            setDrafts((cur) => ({ ...cur, effects: [...cur.effects, createEffect(kind)] }));
            setEffectMenuAnchor(null);
          }}
          onClose={() => setEffectMenuAnchor(null)}
        />
      )}
    </div>,
    document.body
  );
}
