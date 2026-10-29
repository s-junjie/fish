import { createContext } from "preact";
import { useContext, useMemo, useRef } from "preact/hooks";
import type { DesignDocument, DesignStyle } from "../../core/dsl/types";
import { previewStyleInDoc } from "../../core/interactions/style-ops";

/**
 * The draft an open style editor is showing, on the canvas.
 *
 * The canvas is a pure function of element identity, and a style's values live on
 * the layers that wear it — so a draft that stays in the editor's own state can
 * never repaint anything. The preview is therefore the same materialisation a save
 * runs, written TRANSIENTLY: every keystroke moves the document, none of them
 * records an undo step, and `discard` puts back the document the editor opened on.
 *
 * A channel rather than props because the draft belongs to the popover, while the
 * write belongs to the shell: the popover is mounted from five different sections
 * (design system, fill, stroke, typography, effects, selected colours), and each
 * of those would otherwise carry the same three props down to it.
 */
export interface StylePreview {
  /** Show `style` as the document's live value. `elementIds` is the selection a save would bind. */
  preview(style: DesignStyle, elementIds?: readonly string[]): void;
  /** Put the document back the way it was before the first preview. */
  discard(): void;
}

const INERT: StylePreview = {
  preview() {},
  discard() {}
};

export const StylePreviewContext = createContext<StylePreview>(INERT);

export function useStylePreview(): StylePreview {
  return useContext(StylePreviewContext);
}

export function useStylePreviewController(
  docRef: { current: DesignDocument },
  setDoc: (updater: (doc: DesignDocument) => DesignDocument) => void
): StylePreview {
  /** The document to put back, captured once, before the first preview lands. */
  const before = useRef<DesignDocument | null>(null);
  /** What the last preview wrote, so a write from somewhere else is not mistaken for ours. */
  const shown = useRef<DesignDocument | null>(null);

  return useMemo<StylePreview>(
    () => ({
      preview(style, elementIds = []) {
        const current = docRef.current;
        if (!before.current) before.current = current;
        const next = previewStyleInDoc(current, style, elementIds);
        shown.current = next;
        setDoc(() => next);
      },
      discard() {
        const original = before.current;
        const previewed = shown.current;
        before.current = null;
        shown.current = null;
        // Undo, a page switch or a second editor may have moved the document
        // since the last frame. Restoring then would silently undo that edit too.
        if (!original || docRef.current !== previewed) return;
        setDoc(() => original);
      }
    }),
    [docRef, setDoc]
  );
}
