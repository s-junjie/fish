import { DesignDocument, CanvasSpec } from "../../core/dsl/types";
import { getActivePage, updateActivePage } from "../../core/dsl/document-ops";
import { DEFAULT_CANVAS_BACKGROUND } from "../../core/dsl/defaults";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { colorTokenColor } from "../../core/interactions/token-ops";
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
        tokenId={activeBg?.type === "solid" ? activeBg.tokenId : undefined}
        doc={doc}
        onBindToken={(token) => {
          if (!docRef.current.tokens?.some((entry) => entry.id === token.id)) {
            docRef.current = addTokenToDoc(docRef.current, token);
          }
          const color = colorTokenColor(token, docRef.current.activeTheme, docRef.current.tokens);
          const newBg: CanvasSpec["background"] = { type: "solid", color, tokenId: token.id };
          const next = updateActivePage(docRef.current, (p) => ({
            canvas: { ...p.canvas, background: newBg }
          }));
          setDoc(() => next);
        }}
        onDetachToken={() => {
          const curPage = getActivePage(docRef.current);
          const curBg = curPage.canvas?.background || docRef.current.canvas.background;
          if (!curBg || curBg.type !== "solid" || !curBg.tokenId) return;
          const { tokenId: _tokenId, ...rest } = curBg;
          const next = updateActivePage(docRef.current, (p) => ({
            canvas: { ...p.canvas, background: rest }
          }));
          setDoc(() => next);
        }}
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
