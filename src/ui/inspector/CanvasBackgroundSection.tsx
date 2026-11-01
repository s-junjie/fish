import { DesignDocument, CanvasSpec, getActivePage, updateActivePage } from "../../core/dsl/types";
import { DEFAULT_CANVAS_BACKGROUND } from "../../core/dsl/defaults";
import { ColorField } from "../ColorField";
import { t } from "../../i18n";
import { Section } from "./SectionHeader";

interface CanvasBackgroundSectionProps {
  doc: DesignDocument;
  setDoc: (updater: (d: DesignDocument) => DesignDocument) => void;
  docRef: { current: DesignDocument };
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

/**
 * The page's canvas colour — the surface its artboards sit on.
 *
 * Nothing here talks about presentation: a slide's backdrop is chosen while the
 * deck is on screen (the deck's own switch), because a setting whose effect is a
 * fullscreen slide cannot be judged from a 288px rail.
 */
export function CanvasBackgroundSection({
  doc,
  setDoc,
  docRef,
  onDragStart,
  onDragEnd
}: CanvasBackgroundSectionProps) {
  const activePage = getActivePage(doc);
  const activeBg = activePage.canvas?.background || doc.canvas.background;

  return (
    <Section id="canvas-background" title={t("properties.background")} className="space-y-3">
      <ColorField
        panelTitle={t("properties.background")}
        value={activeBg?.type === "solid" ? activeBg.color : DEFAULT_CANVAS_BACKGROUND}
        onGestureStart={onDragStart}
        onGestureEnd={onDragEnd}
        onChange={(col) => {
          onDragStart?.();
          const newBg: CanvasSpec["background"] = { type: "solid", color: col };
          const next = updateActivePage(docRef.current, (p) => ({
            canvas: { ...p.canvas, background: newBg }
          }));
          setDoc(() => next);
        }}
        onCommit={() => {
          onDragEnd?.();
        }}
      />
    </Section>
  );
}
