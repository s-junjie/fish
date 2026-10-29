import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  DesignDocument,
  TextElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { EditorStore } from "../../core/store/editor-store";
import { mapElements } from "../../core/geometry/tree-ops";
import { useVectorPathEditing } from "./useVectorPathEditing";
import { relayoutDocumentTree } from "../../core/compile";
import { commitInstanceOverrides } from "../../core/interactions/instance-resolve";
import type { InstanceSelection } from "../../core/interactions/instance-resolve";
import { normalizeTextSpans } from "../../core/dsl/normalize/text-sizing";
import { reconcileSpansOnTextChange } from "../../core/interactions/text-spans";
import type { TextEditRange } from "../../core/interactions/text-spans";
import { resolveTextSizing } from "../../core/layout/text-sizing";
import { resolveAxis } from "../../core/geometry/resolve-axis";
import { textFontStatus } from "../../core/fonts/font-status";
import { openMissingFonts } from "../missing-fonts";

/**
 * Whether a content edit could have moved anything but this element's own box.
 *
 * The rest of the tree can only move because THIS box moved, so an unchanged box
 * means the full layout pass would re-derive the layout that is already there —
 * and that pass is what a keystroke used to repeat across the whole page.
 *
 * Two axes are held out. `fill` is written by the layout pass, so nothing here
 * can see the answer for it. An on-path text is sized by the renderer's glyph
 * measurement rather than by its box.
 */
function textBoxCouldMove(el: TextElement, updated: TextElement): boolean {
  if (el.onPath?.pathId) return true;
  if (resolveAxis(el, null, "width") === "fill") return true;
  if (resolveAxis(el, null, "height") === "fill") return true;
  const before = resolveTextSizing(el, null);
  const after = resolveTextSizing(updated, null);
  return before.width !== after.width || before.height !== after.height;
}

/**
 * The text an override should carry after `value` replaced its content: the new
 * string, and the runs re-spliced around the edit.
 *
 * A resolved instance child's runs come from the master, so a content override
 * that left them alone would keep styling characters that are no longer there —
 * `"Buy now"` bold in the middle stays bold over whatever now sits at those
 * offsets. The runs are reconciled exactly as they are on a stored layer, and an
 * emptied run list is dropped rather than stored as `[]`.
 */
function withReconciledSpans(el: TextElement, value: string, edit?: TextEditRange): TextElement {
  const spans = reconcileSpansOnTextChange(el.spans, el.content || "", value, edit);
  const updated: TextElement = { ...el, content: value };
  if (spans && spans.length > 0) updated.spans = spans;
  else delete updated.spans;
  return updated;
}

export interface InlineEditingDeps {
  store: EditorStore;
  docRef: { current: DesignDocument };
  setDoc: (updater: DesignDocument | ((prev: DesignDocument) => DesignDocument)) => void;
  commitSnapshot: (doc: DesignDocument) => void;
  startDragGesture: () => void;
  endDragGesture: () => void;
  // The updater form is used to hand the editor's own selection back (below),
  // where the answer has to be read at the moment the update lands, not when the
  // commit was asked for.
  setSelectedIds: (ids: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  selectedIds: Set<string>;
  virtualSelections: InstanceSelection[];
}

/**
 * A character range, and the text it was made in.
 *
 * The id is what makes the range safe to keep alive: a range is only ever a
 * RANGE OF ONE TEXT, so binding it to that text is what lets the panel read it
 * after the editor has closed without a stale range from a text the author has
 * since left being taken for a live one.
 */
export interface ActiveTextRange {
  elementId: string;
  start: number;
  end: number;
}

/**
 * The three kinds of editing that happen in place rather than in a panel:
 * renaming a layer row, typing directly on the canvas text, and dragging a
 * vector path's anchors.
 *
 * Each owns a "which thing is being edited" id plus the draft/transient state
 * that only means something while that id is set, which is why they travel
 * together — leaving the id behind without the draft is the bug that made
 * cancelling commit the very text it had just rolled back.
 */
export function useInlineEditing(deps: InlineEditingDeps) {
  const {
    store,
    docRef,
    setDoc,
    commitSnapshot,
    startDragGesture,
    endDragGesture,
    setSelectedIds,
    selectedIds,
    virtualSelections
  } = deps;

  // Layer rename
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [, setRenameDraft] = useState<string>("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const startRenaming = (id: string, name: string) => {
    setRenamingId(id);
    setRenameDraft(name);
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };

  // Double-click on a layer row: the row label drafts its name in the panel
  // effect that watches `renamingId`, so only the id is needed here.
  const handleLayerStartRename = useCallback((id: string) => {
    setRenamingId(id);
  }, []);

  // Canvas direct text edit
  const [editingCanvasTextId, setEditingCanvasTextId] = useState<string | null>(null);
  const [canvasTextDraft, setCanvasTextDraft] = useState<string>("");
  const [activeTextSelection, setActiveTextSelection] = useState<ActiveTextRange | null>(null);

  /**
   * The range belongs to the text it was made in, so it goes when the author
   * leaves that text — never before.
   *
   * It used to be dropped on COMMIT as well, and committing is what a press on
   * any inspector control does (the press moves focus, the editor blurs, the
   * draft commits). That made range styling unreachable: the panel read no range
   * a keystroke before its own handler ran, so a size or an italic meant for the
   * selected characters was written onto the whole layer instead.
   *
   * What that clear was guarding against is real — a range left behind outlives
   * the run it describes — but the answer is to scope it, not to throw it away at
   * the first blur. `elementId` makes a range from another text unreadable, and
   * this drops it the moment its own text stops being the whole selection.
   *
   * The `size === 1` half is not decoration: an inspector write fans out over
   * every selected id, so a range that stayed armed through a multi-selection
   * would be cut out of each of them — applying a run of one text to the
   * characters of another.
   */
  useEffect(() => {
    setActiveTextSelection((prev) =>
      prev && (selectedIds.size !== 1 || !selectedIds.has(prev.elementId)) ? null : prev
    );
  }, [selectedIds]);

  // Typed as HTMLTextAreaElement because that is what `<textarea>` (the on-path
  // editor) ref-assigns; the contentEditable div attaches the same object
  // through an explicit cast in SvgElementRenderer. One ref serves both.
  const canvasTextInputRef = useRef<HTMLTextAreaElement>(null);
  const isTextEditCancelledRef = useRef(false);

  /**
   * Hand back the selection the editor made for itself — on Escape, and only
   * there.
   *
   * Opening the editor selects the layer so the caret has something to live in.
   * Nothing takes that selection back when the editor is dismissed with Escape,
   * so it stayed on the canvas, and the next double click then arrived on an
   * already-selected text — the one case that EDITS rather than selects, which
   * is how a text nested in a frame could never be selected without being
   * edited. Escape means "drop it" everywhere else in the canvas; with the
   * editor open it has to mean the same thing.
   *
   * A commit keeps the selection on purpose: the author is done typing, not done
   * with the layer, and the panel they are about to click into has to still have
   * a target. And the updater form is what keeps this honest — if the dismissing
   * gesture selected something else (another layer, empty canvas), that answer
   * wins, because this runs after the click's own `setSelectedIds`.
   */
  const releaseEditorSelection = (id: string) => {
    setSelectedIds((prev) => (prev.size === 1 && prev.has(id) ? new Set<string>() : prev));
  };

  const startCanvasTextEdit = (el: TextElement) => {
    // A family this machine does not have freezes the box at the size the file
    // was saved with (`resolveTextSizing`), so a caret here would write content
    // into bounds that are not allowed to grow: the text would paint outside its
    // own rectangle and the saved geometry would stop describing it. The panel
    // that can fix the family opens instead — replace it and the box thaws.
    //
    // Any missing family gates canvas editing (including fixed-size text boxes):
    // typing without the font would corrupt layout or render unrepresentative glyphs.
    //
    // `remote` is not refused: that family is waiting to be fetched, and the
    // phase that fetches it decides what an unloaded face may do.
    const problem = textFontStatus(el);
    if (problem?.status === "missing") {
      setSelectedIds(new Set([el.id]));
      openMissingFonts({
        elementId: el.id,
        name: el.name || el.content || "",
        family: problem.family
      });
      return;
    }
    isTextEditCancelledRef.current = false;
    setEditingCanvasTextId(el.id);
    setSelectedIds(new Set([el.id]));
    setCanvasTextDraft(el.content || el.name || "");
    setActiveTextSelection(null);
    startDragGesture();
    requestAnimationFrame(() => {
      const node = canvasTextInputRef.current;
      if (node) {
        node.focus();
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {}
      }
    });
  };

  /**
   * Drop the browser's own selection when the editor closes.
   *
   * Opening the editor selects the whole run, and nothing put it back: the
   * caret's node stopped being editable but kept the range, so the text stayed
   * painted as selected after the edit was over. Only a range that is still
   * inside the editor is cleared — by the time a blur-driven commit runs, the
   * author may have clicked into another editor, and that selection is theirs.
   */
  const clearEditorDomSelection = () => {
    const node = canvasTextInputRef.current;
    if (!node) return;
    const sel = window.getSelection();
    if (sel?.rangeCount && node.contains(sel.getRangeAt(0).startContainer)) {
      sel.removeAllRanges();
    }
  };

  const virtualTextTarget = useCallback(
    (id: string) => virtualSelections.find((s) => s.node.id === id && s.overridable) ?? null,
    [virtualSelections]
  );

  /**
   * The canvas reports the editor's own range. Tagged here rather than at the
   * call site: the id has to be the one the editor is open ON, and the editor is
   * the only thing that could know it — a reporter that could name a range for a
   * text that is not being edited is exactly the leak `elementId` exists to close.
   */
  const reportCanvasTextSelection = useCallback(
    (range: { start: number; end: number } | null) => {
      const id = editingCanvasTextId;
      // A range is a RUN-scoped edit, and a resolved instance child carries runs
      // like any other text: `spans` is overridable, so the panel offers the scope
      // here the same way it does on a stored layer.
      if (!id || !range) {
        setActiveTextSelection(null);
        return;
      }
      setActiveTextSelection({ elementId: id, start: range.start, end: range.end });
    },
    [editingCanvasTextId]
  );

  // Re-measures on every keystroke so the box tracks the draft and the painted
  // text never outgrows it. No history entry: the whole edit is one gesture.
  //
  // `edit` is the splice the editor performed, when it could describe one. It is
  // what the run styles are reconciled against, and the differerence between a
  // replacement inheriting the run it replaced and it inheriting whatever sat to
  // its left.
  const changeCanvasTextDraft = (value: string, edit?: TextEditRange) => {
    setCanvasTextDraft(value);
    if (!editingCanvasTextId) return;
    const virtual = virtualTextTarget(editingCanvasTextId);
    if (virtual) {
      // Typing inside an instance edits an override, not the master — and the
      // runs travel with the text, or a typed-over master run would go on
      // styling characters that no longer exist.
      const next = commitInstanceOverrides(docRef.current, [virtual], (el) =>
        withReconciledSpans(el as TextElement, value, edit)
      );
      if (!next) return;
      setDoc(next);
      return;
    }
    const curActive = getActivePage(docRef.current);
    let boxCouldMove = false;
    const nextElements = mapElements(curActive.children, (el) => {
      if (el.id !== editingCanvasTextId) return el;
      const textEl = el as TextElement;
      const updatedSpans =
        textEl.spans && textEl.spans.length > 0
          ? reconcileSpansOnTextChange(textEl.spans, textEl.content || "", value, edit)
          : undefined;
      const updated: TextElement = {
        ...textEl,
        content: value
      };
      if (updatedSpans && updatedSpans.length > 0) {
        updated.spans = updatedSpans;
      } else {
        delete updated.spans;
      }
      boxCouldMove = textBoxCouldMove(textEl, updated);
      return updated;
    });
    setDoc(updateActivePageElements(docRef.current, boxCouldMove ? relayoutDocumentTree(nextElements) : nextElements));
  };

  const commitCanvasText = () => {
    // Escape unmounts the textarea, which fires this blur handler from a render
    // that still has `editingCanvasTextId` set — without the guard, cancelling
    // would commit the very draft it just rolled back.
    if (isTextEditCancelledRef.current) return;
    if (!editingCanvasTextId) return;
    clearEditorDomSelection();
    const val = canvasTextDraft;
    const virtual = virtualTextTarget(editingCanvasTextId);
    if (virtual) {
      const next = commitInstanceOverrides(docRef.current, [virtual], (el) =>
        withReconciledSpans(el as TextElement, val)
      );
      if (next) {
        setDoc(next);
      }
      setEditingCanvasTextId(null);
      endDragGesture();
      return;
    }
    const curActive = getActivePage(docRef.current);
    const parsed = normalizeTextSpans(undefined, val);
    const nextElements = relayoutDocumentTree(
      mapElements(curActive.children, (el) => {
        if (el.id === editingCanvasTextId) {
          const textEl = el as TextElement;
          const isDefaultName =
            textEl.name === (textEl as any).content ||
            textEl.name === "Text" ||
            textEl.name === "Headline" ||
            textEl.name === "Subtext";
          const updatedSpans =
            parsed.spans && parsed.spans.length > 0
              ? parsed.spans
              : textEl.spans && textEl.spans.length > 0
                ? reconcileSpansOnTextChange(textEl.spans, textEl.content || "", parsed.content)
                : undefined;
          const updated: TextElement = {
            ...textEl,
            content: parsed.content,
            name: isDefaultName ? parsed.content.slice(0, 30) || textEl.name : textEl.name
          };
          if (updatedSpans && updatedSpans.length > 0) {
            updated.spans = updatedSpans;
          } else {
            delete updated.spans;
          }
          return updated;
        }
        return el;
      })
    );
    setDoc(updateActivePageElements(docRef.current, nextElements));
    setEditingCanvasTextId(null);
    // The range SURVIVES the commit. Committing ends the typing, not the
    // author's interest in the characters they selected: for the ordinary case
    // the commit is the blur caused by the very press that is about to write the
    // run, and dropping the range here means the press writes the whole layer
    // instead. It is dropped by the selection effect above, when the author
    // leaves the text, and by `cancelCanvasText` for Escape.
    endDragGesture();
  };

  const cancelCanvasText = () => {
    isTextEditCancelledRef.current = true;
    clearEditorDomSelection();
    store.cancelGesture();
    const editedId = editingCanvasTextId;
    setEditingCanvasTextId(null);
    if (editedId) releaseEditorSelection(editedId);
    setActiveTextSelection(null);
  };

  const vectorPath = useVectorPathEditing({
    store,
    docRef,
    commitSnapshot,
    selectedIds,
    setSelectedIds
  });

  return {
    renamingId,
    setRenamingId,
    renameInputRef,
    setRenameDraft,
    startRenaming,
    handleLayerStartRename,
    editingCanvasTextId,
    setEditingCanvasTextId,
    canvasTextDraft,
    activeTextSelection,
    reportCanvasTextSelection,
    canvasTextInputRef,
    startCanvasTextEdit,
    changeCanvasTextDraft,
    commitCanvasText,
    cancelCanvasText,
    ...vectorPath
  };
}
