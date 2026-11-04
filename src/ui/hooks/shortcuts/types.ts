import type { DesignDocument, DesignElement, TextElement } from "../../../core/dsl/types";
import type { Rect } from "../../../core/geometry/bounds";
import type { ShapeToolType, ToolType } from "../../../core/tools";
import type { PresentationKeys } from "../../present/presentKeys";

/** The five camera commands, as the render that is on screen defines them. */
export interface ZoomCommands {
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomToActualSize?: () => void;
  onZoomToFit?: () => void;
  onZoomToSelection?: () => void;
}

export interface UseShortcutsOptions {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  primarySelected: DesignElement | null;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  /** The live canvas element, the raster source for "copy as PNG". */
  canvasContainerRef: { current: HTMLDivElement | null };
  handleUndo: () => void;
  handleRedo: () => void;
  /** Absent on a read-only file, where there is no file this tab may write. */
  triggerSave?: () => void;
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
   * put the Move tool back. The pen is the exception — see `escape`.
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

/**
 * What a rule may read and do.
 *
 * Every field is a value of the render the listener registered in — the same
 * thing the handler saw when it closed over its options — with three exceptions.
 * `activeEls`, `zoom` and `penActive` are accessors because their subjects change
 * between renders: a captured page children array or callback would answer with
 * the state of the render the key was bound in.
 */
export interface ShortcutContext {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  primarySelected: DesignElement | null;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  handleUndo: () => void;
  handleRedo: () => void;
  triggerSave?: () => void;
  triggerSaveAs?: () => void;
  startRenaming: (id: string, name: string) => void;
  startCanvasTextEdit: (el: TextElement) => void;
  onSetScaleTool?: () => void;
  onCyclePenMode?: (wasActive: boolean) => void;
  isScaleToolActive: boolean;
  onLeaveScaleTool?: () => void;
  isSpacePressed: boolean;
  setIsSpacePressed: (pressed: boolean) => void;
  setHintMessage: (msg: string) => void;
  setActiveTool: (tool: ToolType) => void;
  activeTool: ToolType;
  setCurrentNavTool: (tool: "select" | "hand") => void;
  setCurrentShapeTool: (tool: ShapeToolType) => void;
  editingPathId?: string | null;
  onStartPathEdit?: (el: DesignElement) => void;
  onExitPathEdit?: () => void;
  onToggleUiVisible?: () => void;
  presentation: PresentationKeys | null;
  onTogglePresent?: () => void;
  /** The active page's top level, read now. */
  activeEls: () => DesignElement[];
  /** The five camera commands, read now. */
  zoom: () => ZoomCommands;
  /** Whether the pen is the live tool, read now. */
  penActive: () => boolean;
}

/**
 * One entry in the keymap. Order in `keymap.ts` IS priority.
 *
 * `run` answers whether the key was this rule's business. `false` means it was
 * not — a bare Enter that matched no branch, a digit with nothing editable under
 * it — and the dispatcher keeps walking. `true` ends the walk, whether or not the
 * rule called `preventDefault`: a rule that hands the key to an overlay (vector
 * edit's arrows) consumes the CHAIN without consuming the event.
 */
export interface KeyRule {
  when: (e: KeyboardEvent, ctx: ShortcutContext) => boolean;
  run: (e: KeyboardEvent, ctx: ShortcutContext) => boolean;
}
