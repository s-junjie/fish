import { DesignElement, TextElement, DesignDocument } from "../../core/dsl/types";
import type { TextEditRange } from "../../core/interactions/text-spans";
import { OnPathGuide } from "../../core/geometry/on-path";
import { ViewportBox } from "../../core/geometry/cull";
import { Rect } from "../../core/geometry/bounds";
import { ReferenceRegistry } from "./reference-registry";

export interface NodeRenderContext {
  /** Shared with `CanvasDefs`; see the note on `CanvasDefsProps.onPathGuides`. */
  onPathGuides?: ReadonlyMap<string, OnPathGuide>;
  selectedIds: Set<string>;
  /**
   * The ids whose selected state changed on this render, and nothing else.
   *
   * A node's own state arrives as `isSelected`; a container still has to
   * re-render when a descendant's did, and this is how it tells. Compared by
   * identity, so the renderer builds it once per selection change and leaves it
   * alone for the rest of the gesture — see `selection-scope.ts`.
   */
  selectionChangedIds?: ReadonlySet<string>;
  setSelectedIds: (ids: Set<string>) => void;
  docRef: { current: DesignDocument };
  /** The COLOUR mode inherited by this element's subtree; `themeMode` may override it. */
  theme?: string;
  /** The NUMBER mode inherited by this element's subtree; `numberMode` may override it. */
  numberMode?: string;
  registry?: ReferenceRegistry;
  zoom: number;
  /**
   * `deviceScale(zoom)`, hoisted so a bake or a conic fan is not recomputed per
   * element — and compared by the node comparator instead of `zoom`, because it
   * is the only zoom-derived number left in node markup.
   *
   * NO node may read `zoom`. Everything that holds a constant number of screen
   * pixels is CSS against `--fish-zoom`, which CanvasArea writes on the root
   * <svg> when the zoom settles (and on painted chrome every tick). A node that
   * reads `zoom` puts it back into markup, and the
   * comparator — which deliberately does not look at `zoom` — will skip the
   * update and leave that chrome frozen at the old zoom.
   */
  rasterScale: number;
  activeTool: string;
  viewportBox?: ViewportBox | null;
  /**
   * Every element's subtree bounds in world coordinates, for the top-level cull.
   *
   * It is here rather than recomputed per node because the cull is the ONE thing
   * that must not be memoized away: it decides what is mounted, and the mounted
   * set is what the memo protects. See `worldSubtreeBounds`.
   */
  worldBounds: Map<string, Rect>;
  dragOverFrameId: string | null;
  editingCanvasTextId: string | null;
  canvasTextDraft: string;
  /**
   * The second argument is the splice the editor just performed, in the
   * coordinates of the text BEFORE it — the one thing the span reconciler cannot
   * recover from the two strings. Only the in-place editors can supply it.
   */
  setCanvasTextDraft: (s: string, edit?: TextEditRange) => void;
  canvasTextInputRef: { current: HTMLTextAreaElement | null };
  onTextSelect?: (range: { start: number; end: number } | null) => void;
  onElementMouseDown: (e: any, el: DesignElement) => void;
  onStartCanvasTextEdit: (el: TextElement) => void;
  onCommitCanvasText: () => void;
  onCancelCanvasText: () => void;
  /** Renderer measured the painted glyph-run box of an on-path text; write it
   * back into the element so selection/marquee/cull/alignment read real geometry. */
  onOnPathTextBounds?: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  editingPathId?: string | null;
  /**
   * Editor chrome: the name label drawn above every top-level frame and
   * component. Presentation mounts this renderer with it off — a slide is what
   * an audience sees, and the label sits above the frame, so leaving it on both
   * labels the deck and measures into the fit.
   */
  frameTitles?: boolean;
}

export interface SvgNodeProps {
  el: DesignElement;
  isSelected: boolean;
  isDragOver: boolean;
  isEditingText: boolean;
  isEditingPath: boolean;
  isMaskStencil: boolean;
  ctx: NodeRenderContext;
}
