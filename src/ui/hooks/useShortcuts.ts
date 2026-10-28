import { useEffect, useRef } from "preact/hooks";
import {
  DesignDocument,
  DesignElement,
  TextElement,
  FrameElement,
  ContainerElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { nudgeElements, reorderZIndex, reorderInAutoLayout, ArrowDirection } from "../../core/interactions/alignment";
import { mapElements, isContainer } from "../../core/geometry/tree-ops";
import { ancestorChain } from "../../core/interactions/component-swap";
import type { Rect } from "../../core/geometry/bounds";
import { applyAutoLayout } from "../../core/compile";
import { layoutOf, withLayout } from "../../core/dsl/layout-flat";
import { ToolType, ShapeToolType } from "../../core/tools";
import { runEditorCommand } from "../commands/editor-commands";
import { useEditorCommands } from "./useEditorCommands";
import { isPickerOpen } from "./picker-focus";
import { getImageCropTarget, setImageCropTarget } from "./image-crop-edit";
import { editableSelection, refuseDerivedEdit } from "./selection-guards";
import { PresentationKeys, presentKey, isBrowserReservedKey } from "../present/presentKeys";

/**
 * The in-file clipboard.
 *
 * `cut` is the whole difference between the two pastes, and it is not a detail:
 * a copy mints fresh ids, a cut has to keep them. A main component is addressed
 * by id from anywhere in the file, so a cut that re-minted its id would leave
 * every instance in the document naming a master that no longer exists — the
 * exact breakage the cut gesture is supposed to avoid.
 *
 * `origins` records where each source sat on the canvas when it was cut, because
 * a source's own `x` / `y` are parent-relative and mean nothing once the source
 * is out of its parent and back at the page root.
 */

interface UseShortcutsOptions {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  primarySelected: DesignElement | null;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  /** The live canvas element, the raster source for "copy as PNG". */
  canvasContainerRef: { current: HTMLDivElement | null };
  handleUndo: () => void;
  handleRedo: () => void;
  triggerSave: () => void;
  triggerSaveAs?: () => void;
  startRenaming: (id: string, name: string) => void;
  startCanvasTextEdit: (el: TextElement) => void;
  /** Turns the Scale tool on (`K`). A toggle, so it can also be turned off. */
  onSetScaleTool?: () => void;
  /**
   * `P` pressed while the pen is already up advances it through draw / add /
   * remove; pressed from any other tool it just picks the pen up in `draw`, which
   * is what `wasActive` is for.
   */
  onCyclePenMode?: (wasActive: boolean) => void;
  /** Whether the pen is the live tool. Read through a ref, never depended on. */
  penActive?: boolean;
  /**
   * The Scale tool is on, and `onLeaveScaleTool` is a stable way out of it.
   *
   * Both are needed, and neither alone is enough: the flag says WHETHER Enter
   * means "leave Scale" (without it, Enter on a single selected path would
   * silently drop the tool instead of opening the vector editor), and the stable
   * callback keeps the handler from closing over a fresh `leave` every render.
   */
  isScaleToolActive?: boolean;
  onLeaveScaleTool?: () => void;
  isSpacePressed: boolean;
  setIsSpacePressed: (pressed: boolean) => void;
  /** Announces a refused edit. */
  setHintMessage?: (msg: string) => void;
  /** Signals the span of a "copy as PNG" export (spinner up / down). */
  onPngCopyProgress?: (busy: boolean) => void;
  setActiveTool: (tool: ToolType) => void;
  /**
   * The tool currently armed.
   *
   * Read for Escape only: every tool that is not Move is a MODE the user can be
   * stranded in (Hand keeps the pointer from selecting, Frame keeps drawing
   * plates, a shape tool keeps drawing that shape), so Escape has to be able to
   * put the Move tool back. The pen is the exception — see the handler.
   */
  activeTool: ToolType;
  setCurrentNavTool: (tool: "select" | "hand") => void;
  setCurrentShapeTool: (tool: ShapeToolType) => void;
  editingPathId?: string | null;
  onStartPathEdit?: (el: DesignElement) => void;
  onExitPathEdit?: () => void;
  /** The world rect the user can see — the drop point of a positionless paste. */
  visibleWorldRect?: () => Rect;
  /** Frame every visible layer of the page (`1` or `Shift+1`). */
  onZoomToFit?: () => void;
  /** Sit at 1:1 (`0` / `Shift+0` / `Cmd+0`). */
  onZoomToActualSize?: () => void;
  /** One rung up / down the zoom ladder (`+` / `-`). */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  /** Frame the current selection (`2` or `Shift+2`). */
  onZoomToSelection?: () => void;
  onToggleUiVisible?: () => void;
  /**
   * Lands a FISH Figma export pasted from the clipboard, as TEXT.
   *
   * Threaded rather than reached for: the import hook lives in `main.tsx` with
   * the document, and a paste is the one gesture that reaches it from here.
   */
  onImportFigmaExport?: (text: string) => Promise<void> | void;
  /** Lands a FISH HTML clip payload that arrived on the clipboard. */
  onImportHtmlClip?: (
    text: string,
    placement?: { viewport?: { x: number; y: number; width: number; height: number } }
  ) => Promise<void> | void;
  /** Non-null exactly while presentation mode is open: it owns the keyboard. */
  presentation?: PresentationKeys | null;
  /** Starts or ends presentation mode (`Cmd/Ctrl + Enter`). */
  onTogglePresent?: () => void;
}

export function useShortcuts({
  selectedIds,
  setSelectedIds,
  primarySelected,
  docRef,
  commitSnapshot,
  canvasContainerRef,
  handleUndo,
  handleRedo,
  triggerSave,
  triggerSaveAs,
  startRenaming,
  startCanvasTextEdit,
  onSetScaleTool,
  onCyclePenMode,
  penActive = false,
  isScaleToolActive = false,
  onLeaveScaleTool,
  isSpacePressed,
  setIsSpacePressed,
  setHintMessage = () => {},
  onPngCopyProgress,
  setActiveTool,
  activeTool,
  setCurrentNavTool,
  setCurrentShapeTool,
  editingPathId,
  onStartPathEdit,
  onExitPathEdit,
  visibleWorldRect,
  onZoomToFit,
  onZoomToActualSize,
  onZoomIn,
  onZoomOut,
  onZoomToSelection,
  onToggleUiVisible,
  onImportFigmaExport,
  onImportHtmlClip,
  presentation = null,
  onTogglePresent
}: UseShortcutsOptions) {
  useEditorCommands({
    selectedIds,
    setSelectedIds,
    primarySelected,
    docRef,
    commitSnapshot,
    setHintMessage,
    onPngCopyProgress,
    visibleWorldRect,
    canvasContainerRef,
    onImportFigmaExport,
    onImportHtmlClip
  });

  // Same reasoning as `flattenRef`: the listener must not re-register every time
  // the tool changes, only read what the tool is now.
  const penActiveRef = useRef(penActive);
  useEffect(() => {
    penActiveRef.current = penActive;
  });

  /**
   * The five zoom commands, read through a ref.
   *
   * The listener below re-registers only on the dependencies named at its end, so
   * it keeps the callbacks of the render it was born in. That is safe for a
   * command whose identity never changes and silently wrong for one that does:
   * `+` used to re-run the first render's `zoomByStep`, which read that render's
   * zoom, so every press recomputed the same rung and the view froze after one.
   * The ref makes the listener call the command that is on screen now, whatever
   * identity a caller passes.
   */
  const zoomCommandsRef = useRef({ onZoomIn, onZoomOut, onZoomToActualSize, onZoomToFit, onZoomToSelection });
  zoomCommandsRef.current = { onZoomIn, onZoomOut, onZoomToActualSize, onZoomToFit, onZoomToSelection };

  useEffect(() => {
    const activeEls = () => getActivePage(docRef.current).children;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Guard against IME composition
      if (e.isComposing || (e as any).keyCode === 229) return;

      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      /**
       * The physical key, for a shortcut that carries Alt/Option.
       *
       * macOS applies the Option layer to the CHARACTER before the page sees it:
       * ⌥⌘C arrives as `key: "ç"`, ⌥⌘B as `"∫"`, ⌥⌘V as `"√"`. Matching
       * `e.key` there is matching a character the layout invented, so those
       * shortcuts silently did nothing — and the dead key could even open an IME
       * composition. `e.code` is the key the hardware reported and is the same
       * everywhere, so every Alt shortcut matches on it.
       */
      const altKeyIs = (letter: string) => e.code === `Key${letter.toUpperCase()}`;

      // Cmd/Ctrl + Enter toggles presentation. Ahead of the presentation block
      // below AND of the bare-Enter branch further down, which looks at no
      // modifiers and would read this as "enter vector edit mode": the deck drops
      // every key it does not own, so a branch sitting behind that block is a
      // branch that can never close the deck again.
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isInput && onTogglePresent) {
        e.preventDefault();
        e.stopPropagation();
        onTogglePresent();
        return;
      }

      // Presentation mode owns the keyboard, and it has to be asked for here
      // rather than handled in the overlay: this listener runs in the capture
      // phase, so anything the overlay does to stop propagation is too late —
      // the same reason `picker-focus` exists.
      if (presentation) {
        // The deck acts on the keys it knows and DROPS every other one, modified
        // or not, because the editor behind the overlay would otherwise nudge
        // with the arrows, delete with Backspace, or — the case a modifier test
        // misses — answer ⌥← and ⌘R, since the arrow branch reads `e.key` and
        // never looks at the modifiers. Only the browser's own chords get
        // through, so a deck really does change nothing.
        if (isBrowserReservedKey(e)) return;
        if (!presentKey(e, presentation)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // Crop mode is the innermost editing mode there is, and both keys mean
      // "leave it" before either means anything else. Enter especially: the
      // branch below reads a lone Enter as "open the vector editor", which would
      // put a pen on the very shape being cropped.
      //
      // Deliberately NOT gated on an open picker, unlike the two branches below.
      // Crop mode's panel is a FLOATING one, and it is open for as long as the
      // mode is — so a picker gate would hand both keys to the panel's own
      // dismissal and exit the mode as a side effect of closing a panel. The mode
      // owns its own exit; the panel's close still exits it too, through the row.
      if ((e.key === "Escape" || e.key === "Enter") && !isInput && getImageCropTarget()) {
        e.preventDefault();
        e.stopPropagation();
        setImageCropTarget(null);
        return;
      }

      // Escape: leave path edit mode, then the armed tool, then walk the
      // selection up its parent chain. At the page root there is nowhere left
      // to go, so the last press clears the selection.
      if (e.key === "Escape" && !isInput && !isPickerOpen()) {
        e.preventDefault();
        if (editingPathId && onExitPathEdit) {
          onExitPathEdit();
          return;
        }
        // The armed tool is the newest state on the stack, and it is what Escape
        // leaves first: the selection the tool was about to act on survives the
        // press, so one Escape returns to Move and the next one drops the
        // selection. Clearing both at once made the key feel like a reset, and a
        // user who only wanted out of the Hand tool lost what they were holding.
        //
        // The pen is exempt: it treats Escape as "leave the pen" itself (the
        // draft is cancelled and the tool stays up, which is what drawing a run
        // of paths means), so `path` must not be answered here.
        if (isScaleToolActive && onLeaveScaleTool) {
          onLeaveScaleTool();
          setCurrentNavTool("select");
          return;
        }
        if (activeTool !== "select" && activeTool !== "path") {
          setActiveTool("select");
          // The nav slot draws `currentNavTool`, not the active tool, so leaving
          // Hand has to put the SLOT back as well — otherwise the tool is Move
          // and the dock still shows a hand, which reads as "Escape did nothing".
          setCurrentNavTool("select");
          return;
        }
        const firstId = Array.from(selectedIds)[0];
        const chain = firstId ? ancestorChain(docRef.current, firstId) : [];
        const parent = chain.length > 1 ? chain[chain.length - 2] : null;
        setSelectedIds(parent ? new Set([parent.id]) : new Set());
        return;
      }

      // Enter: leave the Scale tool, else enter or exit vector edit mode.
      //
      // Scale first: it is a temporary mode with a panel and no draft to commit,
      // so Enter means "I am done with this tool" — and it must be asked before
      // the two below, which would otherwise answer Enter with a vector editor
      // the user did not ask for.
      //
      // An open floating picker answers Enter itself (it confirms and closes), and
      // this listener runs first — capture on `window` — so the picker cannot
      // block it from below. Hence the registry question rather than an event
      // ordering trick.
      if (e.key === "Enter" && !isInput && !isPickerOpen()) {
        if (isScaleToolActive && onLeaveScaleTool) {
          e.preventDefault();
          onLeaveScaleTool();
          return;
        }
        if (editingPathId && onExitPathEdit) {
          e.preventDefault();
          onExitPathEdit();
          return;
        }
        if (primarySelected && selectedIds.size === 1 && onStartPathEdit) {
          e.preventDefault();
          onStartPathEdit(primarySelected);
          return;
        }
      }

      // Cmd + R or F2: Rename selected layer (prevent browser refresh!)
      if ((((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") || e.key === "F2") && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        if (refuseDerivedEdit(docRef.current, selectedIds, setHintMessage)) return;
        if (primarySelected) {
          startRenaming(primarySelected.id, primarySelected.name || primarySelected.type);
        }
        return;
      }

      // Cmd + G: Group into Frame / Cmd + Shift + G: Ungroup
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g" && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        if (refuseDerivedEdit(docRef.current, selectedIds, setHintMessage)) return;
        if (e.shiftKey) {
          if (primarySelected && isContainer(primarySelected)) runEditorCommand("ungroup");
        } else if (e.altKey) {
          runEditorCommand("groupAsFrame");
        } else {
          runEditorCommand("group");
        }
        return;
      }

      // Shift + Cmd/Ctrl + L: Lock / unlock the selection (toggle, Figma parity)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l" && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        runEditorCommand("toggleLockSelection");
        return;
      }

      // Cmd + Option + K / Ctrl + Alt + K: Create Component
      if ((e.metaKey || e.ctrlKey) && e.altKey && altKeyIs("k") && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        runEditorCommand("createComponent");
        return;
      }

      // Cmd + Option + B / Ctrl + Alt + B: Detach Instance
      if ((e.metaKey || e.ctrlKey) && e.altKey && altKeyIs("b") && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        runEditorCommand("detachInstance");
        return;
      }

      // Tab or Cmd/Ctrl + . : collapse every chrome panel into a pure canvas
      if (!isInput && ((e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && (e.key === "." || e.code === "Period")))) {
        e.preventDefault();
        e.stopPropagation();
        onToggleUiVisible?.();
        return;
      }

      if (isInput) return;

      // `Shift+0` sits at 1:1, `Shift+1` frames the page, `Shift+2` frames the selection, and
      // `Plus` / `Minus` walk the zoom ladder.
      //
      // Matched on `e.code`, for the same reason `altKeyIs` exists: the character
      // Shift produces is layout-dependent ("!" on most, "+" and "_" here), and
      // the numpad is a second code entirely. They are also deliberately the
      // Cmd-less form, so they cannot be confused with a file/document command.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        // Number keys 0-9 set layer opacity: 1=10%, 2=20%, ..., 9=90%, 0=100%
        const digitMatch = e.code.match(/^(?:Digit|Numpad)([0-9])$/);
        if (digitMatch && selectedIds.size > 0) {
          const num = parseInt(digitMatch[1], 10);
          const opacity = num === 0 ? 1 : num / 10;
          if (refuseDerivedEdit(docRef.current, selectedIds, setHintMessage)) return;
          const ids = editableSelection(activeEls(), selectedIds);
          if (ids.size > 0) {
            e.preventDefault();
            e.stopPropagation();
            const nextElements = mapElements(activeEls(), (el) =>
              ids.has(el.id) ? { ...el, opacity } : el
            );
            commitSnapshot(updateActivePageElements(docRef.current, nextElements));
            return;
          }
        }
        if (e.code === "Equal" || e.code === "NumpadAdd") {
          e.preventDefault();
          e.stopPropagation();
          zoomCommandsRef.current.onZoomIn?.();
          return;
        }
        if (e.code === "Minus" || e.code === "NumpadSubtract") {
          e.preventDefault();
          e.stopPropagation();
          zoomCommandsRef.current.onZoomOut?.();
          return;
        }
      }
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.code === "Digit0" || e.code === "Numpad0") {
          e.preventDefault();
          e.stopPropagation();
          zoomCommandsRef.current.onZoomToActualSize?.();
          return;
        }
        if (e.code === "Digit1" || e.code === "Numpad1") {
          e.preventDefault();
          e.stopPropagation();
          zoomCommandsRef.current.onZoomToFit?.();
          return;
        }
        if (e.code === "Digit2" || e.code === "Numpad2") {
          e.preventDefault();
          e.stopPropagation();
          zoomCommandsRef.current.onZoomToSelection?.();
          return;
        }
      }

      // Cmd/Ctrl + 0 is also 1:1, and it is the chord people reach for out of
      // habit. Browsers bind it to "reset page zoom", so the default is
      // cancelled rather than left to race us for the key.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === "Digit0" || e.code === "Numpad0")) {
        e.preventDefault();
        e.stopPropagation();
        onZoomToActualSize?.();
        return;
      }

      // Enter on selected container: drill down into children (or edit text if text)
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        // Both branches open a canvas edit — the text editor, or the child scope of
        // a container. A locked layer is reachable only through the Layers Panel and
        // answers neither.
        if (primarySelected && !primarySelected.locked && primarySelected.type === "text" && selectedIds.size === 1) {
          e.preventDefault();
          e.stopPropagation();
          startCanvasTextEdit(primarySelected as TextElement);
          return;
        }
        if (primarySelected && !primarySelected.locked && isContainer(primarySelected) && selectedIds.size === 1) {
          const children = (primarySelected as ContainerElement).children || [];
          if (children.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            setSelectedIds(new Set(children.map((c) => c.id)));
            return;
          }
        }
      }

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Save: Cmd+S / Save As: Shift+Cmd+S
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey && triggerSaveAs) {
          triggerSaveAs();
        } else {
          triggerSave();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e" && !isInput) {
        e.preventDefault();
        runEditorCommand("flatten");
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o" && !isInput) {
        e.preventDefault();
        runEditorCommand("outlineText");
        return;
      }

      // Space temporary pan mode
      if (e.code === "Space" && !isSpacePressed) {
        e.preventDefault();
        setIsSpacePressed(true);
        return;
      }

      // Tool switching shortcuts
      const k = e.key.toLowerCase();

      // Cmd/Ctrl + A: every layer on the selection's own level (Figma's "select
      // all siblings"), or the page roots when nothing is selected. Not while an
      // inner mode holds the canvas — a vector edit is about its anchors, and crop
      // is bound to the one image it is framing, whose panel lives off the
      // selection this would replace.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && k === "a" && !editingPathId && !getImageCropTarget()) {
        e.preventDefault();
        e.stopPropagation();
        runEditorCommand("selectAll");
        return;
      }

      // Copy / paste properties: Figma parks these on Cmd+Alt+C / Cmd+Alt+V, and
      // the Alt is what keeps them clear of the plain clipboard below.
      if ((e.metaKey || e.ctrlKey) && e.altKey && (altKeyIs("c") || altKeyIs("v")) && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        runEditorCommand(altKeyIs("c") ? "copyStyle" : "pasteStyle");
        return;
      }

      // Copy as PNG at 2x: Shift+Cmd+C. Ahead of the plain clipboard block below
      // so it wins over Cmd+C, and Shift keeps it clear of Cmd+Alt+C (copy
      // properties). The same command at 1x is the context-menu "Copy as PNG".
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "c" && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        runEditorCommand("copyAsPng", { scale: 2 });
        return;
      }

      // Clipboard: Cmd+C / Cmd+X / Cmd+D. Cmd+V is deliberately left to the
      // browser so the `paste` event fires — handlePaste is the single paste
      // entry (images, cross-file payloads, plain text, in-memory fallback).
      if ((e.metaKey || e.ctrlKey) && (k === "c" || k === "x" || k === "d")) {
        e.preventDefault();
        e.stopPropagation();
        runEditorCommand(k === "c" ? "copy" : k === "x" ? "cut" : "duplicate");
        return;
      }

      // A path in vector edit is a mode of its own: the single letters belong to
      // the editor inside it, so R or O must not swap in a shape tool underneath
      // the user's hands mid-gesture. Escape and Enter are handled above and still
      // work, which is the only way out.
      if (editingPathId && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // P still cycles the pen's own mode, because that is the mode being
        // edited — but it must not also swap in the pen tool, or the draw overlay
        // and the anchor overlay end up on screen at once.
        if (k === "p") {
          e.preventDefault();
          e.stopPropagation();
          onCyclePenMode?.(true);
          return;
        }
        if ("vhlrotfk".includes(k) && k.length === 1) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        // K is the Scale TOOL, not a command: a mode with live handles, an anchor
        // and a factor, so it belongs in the Move/Hand group in the dock — and this
        // is the ONLY other way in, because a third entry point would give one mode
        // three places to be switched on from and the panel that goes with it has to
        // appear for all of them.
        if (k === "k" && onSetScaleTool) {
          e.preventDefault();
          e.stopPropagation();
          onSetScaleTool();
          return;
        }
        if (k === "v") { setActiveTool("select"); setCurrentNavTool("select"); return; }
        if (k === "h") { setActiveTool("hand"); setCurrentNavTool("hand"); return; }
        if (k === "r") { setActiveTool("rect"); setCurrentShapeTool("rect"); return; }
        if (k === "o") { setActiveTool("ellipse"); setCurrentShapeTool("ellipse"); return; }
        if (k === "l") { setActiveTool("line"); setCurrentShapeTool("line"); return; }
        if (k === "p") {
          // Pressing P again walks draw -> add -> remove, the way Figma's pen
          // changes its own cursor. Reaching for the pen twice should not be the
          // only way back to drawing, so the cycle returns to draw.
          setActiveTool("path");
          setCurrentShapeTool("path");
          onCyclePenMode?.(penActiveRef.current);
          return;
        }
        if (k === "t") { setActiveTool("text"); return; }
        if (k === "f") { setActiveTool("frame"); return; }
        if (k === "c") { setActiveTool(activeTool === "comment" ? "select" : "comment"); return; }
        if (k === "z") {
          e.preventDefault();
          e.stopPropagation();
          (selectedIds.size > 0 ? zoomCommandsRef.current.onZoomToSelection : zoomCommandsRef.current.onZoomToFit)?.();
          return;
        }
        if (k === "s" && selectedIds.size > 1) {
          e.preventDefault();
          e.stopPropagation();
          runEditorCommand(e.shiftKey ? "wrapGrid" : "wrapFlex");
          return;
        }
        // A component set arranges nothing: its variants are positioned freely and its
        // box comes from `fitComponentSet`, so a stack on one would be dropped again
        // by the next relayout. The shortcut is a no-op on it rather than a
        // half-applied edit.
        if (k === "s" && primarySelected && isContainer(primarySelected) && selectedIds.size === 1 && primarySelected.type !== "componentSet") {
          e.preventDefault();
          e.stopPropagation();
          const frame = primarySelected as FrameElement;
          const isStack = layoutOf(frame)?.mode === "flex";
          const nextLayout = isStack
            ? undefined
            : {
                mode: "flex" as const,
                direction: "row" as const,
                gap: 16,
                padding: 16,
                justify: "start" as const,
                align: "start" as const
              };
          const nextElements = mapElements(activeEls(), (el) => {
            if (el.id === frame.id) {
              const updated = withLayout(el, nextLayout);
              if (!isStack && (frame.children || []).length > 0) {
                const sizing = { ...(el.sizing || {}) };
                if (!sizing.width) sizing.width = "fit-content";
                if (!sizing.height) sizing.height = "fit-content";
                (updated as FrameElement).sizing = sizing;
              } else if (isStack && el.sizing) {
                const sizing = { ...el.sizing };
                delete sizing.width;
                delete sizing.height;
                if (Object.keys(sizing).length === 0) delete (updated as any).sizing;
                else (updated as FrameElement).sizing = sizing;
              }
              return nextLayout ? applyAutoLayout(updated as FrameElement) : (updated as FrameElement);
            }
            return el;
          });
          commitSnapshot(updateActivePageElements(docRef.current, nextElements));
          return;
        }
      }

      // While a path is in vector edit the arrows and Backspace belong to the
      // anchor overlay, not to the element. This listener runs in the capture
      // phase, so the overlay cannot protect them with stopPropagation — the same
      // reason `presentation` is handled above rather than in its own overlay.
      if (editingPathId) {
        if ((e.key === "Backspace" || e.key === "Delete") && selectedIds.size > 0) return;
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      }

      // Arrow keys nudge — except for a DIRECT child of an auto-layout stack,
      // which has no position of its own, so arrows walk it through the ordering.
      // A layer inside a plain frame within a stack is placed by that frame and
      // nudges like any other element.
      if (selectedIds.size > 0 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        if (refuseDerivedEdit(docRef.current, selectedIds, setHintMessage)) return;
        const ids = editableSelection(activeEls(), selectedIds);
        if (ids.size === 0) return;
        const dir: ArrowDirection =
          e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : "down";
        const stackMove = reorderInAutoLayout(activeEls(), ids, dir);
        if (stackMove) {
          if (stackMove.moved) commitSnapshot(updateActivePageElements(docRef.current, stackMove.elements));
          return;
        }
        if (dir === "left") {
          commitSnapshot(updateActivePageElements(docRef.current, nudgeElements(activeEls(), ids, -1, 0, e.shiftKey)));
        } else if (dir === "right") {
          commitSnapshot(updateActivePageElements(docRef.current, nudgeElements(activeEls(), ids, 1, 0, e.shiftKey)));
        } else if (dir === "up") {
          commitSnapshot(updateActivePageElements(docRef.current, nudgeElements(activeEls(), ids, 0, -1, e.shiftKey)));
        } else if (dir === "down") {
          commitSnapshot(updateActivePageElements(docRef.current, nudgeElements(activeEls(), ids, 0, 1, e.shiftKey)));
        }
        return;
      }

      // Layer ordering shortcuts: [, ], Cmd+[, Cmd+]
      //
      // Matched on `e.code`, for the same reason the Alt shortcuts are (LESSONS
      // §46): `e.key` is a CHARACTER, and a bare bracket is the one key a layout
      // or an IME most reliably rewrites on the way to the page. `Shift+[` already
      // arrives as `{`, a Chinese or Japanese IME composes it into something else
      // entirely, and a dead key can raise `isComposing` and be dropped by the
      // guard at the top of this handler — while `Cmd+[` short-circuits the IME and
      // arrives clean. `e.code` is the key the hardware reported, so both variants
      // resolve identically and neither depends on the layout in use.
      //
      // Figma's mapping, which is the one the context menu's hints advertise:
      // bare moves the layer to the very front / very back, Cmd+steps it one place.
      const bracket = e.code === "BracketRight" ? "]" : e.code === "BracketLeft" ? "[" : null;
      if (selectedIds.size > 0 && bracket) {
        e.preventDefault();
        if (refuseDerivedEdit(docRef.current, selectedIds, setHintMessage)) return;
        const ids = editableSelection(activeEls(), selectedIds);
        if (ids.size === 0) return;
        const isForward = bracket === "]";
        if (e.metaKey || e.ctrlKey) {
          const action = isForward ? "forward" : "backward";
          const current = activeEls();
          const next = reorderZIndex(current, ids, action);
          if (next !== current) commitSnapshot(updateActivePageElements(docRef.current, next));
        } else {
          const action = isForward ? "front" : "back";
          const current = activeEls();
          const next = reorderZIndex(current, ids, action);
          if (next !== current) commitSnapshot(updateActivePageElements(docRef.current, next));
        }
        return;
      }

      // Delete selected elements
      if ((e.key === "Backspace" || e.key === "Delete") && selectedIds.size > 0) {
        e.preventDefault();
        runEditorCommand("delete");
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp);
    };
    // `isScaleToolActive` is a dependency for the same reason `onSetScaleTool` is
    // not one of them: the handler above has to be able to tell whether Enter
    // means "leave Scale", and a flag frozen at the listener's registration would
    // answer the wrong question (LESSONS §59). The flag is a boolean, so the
    // listener re-registers only on the two transitions, not on every render.
    // `onLeaveScaleTool` is a stable `useCallback`, so it does not belong here.
    //
    // The zoom commands are the opposite case and are NOT listed: their identity
    // is not something this hook can guarantee, so they are read through
    // `zoomCommandsRef` instead. Listing them would re-register the listener on
    // every selection change (the fits depend on it) and still leave a window
    // where the captured command is older than the camera.
  }, [
    selectedIds,
    isSpacePressed,
    primarySelected,
    visibleWorldRect,
    commitSnapshot,
    setSelectedIds,
    isScaleToolActive,
    activeTool,
    presentation,
    onTogglePresent
  ]);
}
