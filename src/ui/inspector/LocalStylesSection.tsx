import { useState, useRef } from "preact/hooks";
import {
  DesignDocument,
  DesignStyle,
  EffectStyle,
  PaintStyle,
  StrokeStyle,
  StyleType,
  TextStyleDefinition
} from "../../core/dsl/types";
import {
  addStyleToDoc,
  removeStyleFromDoc,
  reorderStyles,
  updateStyleInDoc
} from "../../core/interactions/style-ops";
import { StylePickerPopover } from "./StylePickerPopover";
import { StyleGroupList } from "./StyleGroupList";
import { paintImageUri } from "./paint-preview";
import { t } from "../../i18n";

interface LocalStylesSectionProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  /** Which groups this surface owns. Defaults to all four. */
  styleTypes?: StyleType[];
  /** Narrows the paint group without hiding it — the surface half of Styles. */
  paintTitle?: string;
  /** Groups that may mint a new style. A group can be listed read-only. */
  createStyleTypes?: StyleType[];
  title?: string;
  /** The design-system tab edits in place, without the style banner preview. */
  showStylePreview?: boolean;
}

export function LocalStylesSection({
  doc,
  docRef,
  commitSnapshot,
  styleTypes = ["paint", "stroke", "text", "effect"],
  paintTitle,
  createStyleTypes = styleTypes,
  title,
  showStylePreview = true
}: LocalStylesSectionProps) {
  const [popoverState, setPopoverState] = useState<{
    styleType: StyleType;
    editingStyle: DesignStyle | null;
  } | null>(null);

  const activeAnchorRef = useRef<HTMLElement | null>(null);

  const styles = doc.styles || [];
  const paintStyles = styles.filter((s) => s.styleType === "paint") as PaintStyle[];
  const strokeStyles = styles.filter((s) => s.styleType === "stroke") as StrokeStyle[];
  const textStyles = styles.filter((s) => s.styleType === "text") as TextStyleDefinition[];
  const effectStyles = styles.filter((s) => s.styleType === "effect") as EffectStyle[];
  const owns = (type: StyleType) => styleTypes.includes(type);
  const canCreate = (type: StyleType) => createStyleTypes.includes(type);

  const handleSaveStyle = (style: DesignStyle) => {
    const existing = (docRef.current.styles || []).find((s) => s.id === style.id);
    const nextDoc = existing
      ? updateStyleInDoc(docRef.current, style)
      : addStyleToDoc(docRef.current, style);
    commitSnapshot(nextDoc);
  };

  const handleDeleteStyle = (styleId: string) => {
    commitSnapshot(removeStyleFromDoc(docRef.current, styleId));
  };

  const handleReorder = (styleType: StyleType) => (fromRow: number, insertBeforeRow: number) => {
    const current = docRef.current.styles || [];
    const next = reorderStyles(current, styleType, fromRow, insertBeforeRow);
    // A drop that lands where the row started must not spend a history entry.
    if (next.length === current.length && next.every((s, i) => s.id === current[i].id)) return;
    commitSnapshot({ ...docRef.current, styles: next });
  };

  const openPicker = (styleType: StyleType, anchor: HTMLElement, editingStyle: DesignStyle | null = null) => {
    activeAnchorRef.current = anchor;
    setPopoverState({ styleType, editingStyle });
  };

  const GROUPS: Array<{ type: StyleType; title: string; createTitle: string; list: DesignStyle[] }> = [
    { type: "paint", title: paintTitle ?? t("styles.colorStyles"), createTitle: t("styles.createColorStyle"), list: paintStyles },
    { type: "stroke", title: t("styles.strokeStyles"), createTitle: t("styles.createStrokeStyle"), list: strokeStyles },
    { type: "text", title: t("styles.textStyles"), createTitle: t("styles.createTextStyle"), list: textStyles },
    { type: "effect", title: t("styles.effectStyles"), createTitle: t("styles.createEffectStyle"), list: effectStyles },
  ];

  return (
    <div className="select-none space-y-4">
      {GROUPS.filter((g) => owns(g.type) && (g.list.length > 0 || canCreate(g.type))).map((g) => (
        <StyleGroupList
          key={g.type}
          styleType={g.type}
          title={g.title}
          createTitle={g.createTitle}
          styles={g.list}
          onCreate={(anchor) => openPicker(g.type, anchor)}
          onEdit={(style, anchor) => openPicker(g.type, anchor, style)}
          onDelete={handleDeleteStyle}
          onReorder={handleReorder(g.type)}
          canCreate={canCreate(g.type)}
          imageUri={paintImageUri(doc)}
        />
      ))}

      {popoverState && (
        <StylePickerPopover
          key={`${popoverState.styleType}-${popoverState.editingStyle?.id ?? "new"}`}
          styleType={popoverState.styleType}
          doc={docRef.current}
          docRef={docRef}
          initialMode="create"
          initialEditStyle={popoverState.editingStyle}
          availableStyles={docRef.current.styles || []}
          anchorRef={activeAnchorRef}
          onSelectStyle={() => {
            setPopoverState(null);
          }}
          onSaveStyle={handleSaveStyle}
          onCommitSnapshot={commitSnapshot}
          showPreview={showStylePreview}
          onClose={() => setPopoverState(null)}
        />
      )}
    </div>
  );
}
