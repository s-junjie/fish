import { useMemo, useRef } from "preact/hooks";
import { DesignElement, TextElement, DesignDocument } from "../../core/dsl/types";
import { OnPathGuide } from "../../core/geometry/on-path";
import type { TextEditRange } from "../../core/interactions/text-spans";
import { ViewportBox } from "../../core/geometry/cull";
import { worldSubtreeBounds } from "../../core/geometry/element-bounds";
import { deviceScale } from "./device-scale";
import { buildReferenceRegistry } from "./reference-registry";
import { NodeRenderContext, SvgNodeProps } from "./NodeRenderContext";
import { SvgNodeRenderer, MemoizedSvgNode, renderNodeList } from "./SvgNodeRenderer";
import { getActiveNumberMode, getActiveTheme } from "../../core/interactions/mode-ops";

export type { NodeRenderContext, SvgNodeProps };
export { SvgNodeRenderer, MemoizedSvgNode, renderNodeList };

const NO_CHANGE: ReadonlySet<string> = new Set();

/**
 * The ids whose selected state differs from the previous render.
 *
 * The node memo compares this set's identity and asks whether a changed id
 * lives in its subtree (`selection-scope.ts`), so a mousedown re-renders the
 * path to the new selection instead of every node on the page. `selectedIds` is
 * replaced rather than mutated by every writer, and a gesture leaves it alone
 * for its whole duration, which is why this costs one diff per selection change
 * and nothing per drag frame.
 */
function useSelectionChangedIds(selectedIds: Set<string>): ReadonlySet<string> {
  const previous = useRef<Set<string> | null>(null);
  return useMemo(() => {
    const before = previous.current;
    previous.current = selectedIds;
    if (!before || before === selectedIds) return NO_CHANGE;
    const changed = new Set<string>();
    for (const id of selectedIds) if (!before.has(id)) changed.add(id);
    for (const id of before) if (!selectedIds.has(id)) changed.add(id);
    return changed.size > 0 ? changed : NO_CHANGE;
  }, [selectedIds]);
}

export interface SvgElementRendererProps {
  /** Shared with `CanvasDefs`; see the note on `CanvasDefsProps.onPathGuides`. */
  onPathGuides?: ReadonlyMap<string, OnPathGuide>;
  elements: DesignElement[];
  /**
   * The same tree before device-grid alignment, for the top-level cull.
   *
   * Snapping moves an edge by under half a screen pixel; the cull spends a
   * 250 px buffer, so the two answers are the same while the aligned array is
   * a new identity on every settle. Measuring the raw tree keeps that walk off
   * the settle frame, where it re-walked all 1,841 elements to move the answer
   * nowhere.
   */
  boundsElements?: DesignElement[];
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  docRef: { current: DesignDocument };
  /** Effective COLOUR mode for the rendered roots; defaults to the document's active one. */
  theme?: string;
  /** Effective NUMBER mode for the rendered roots; defaults to the document's active one. */
  numberMode?: string;
  zoom: number;
  activeTool: string;
  viewportBox?: ViewportBox | null;
  dragOverFrameId: string | null;
  editingCanvasTextId: string | null;
  canvasTextDraft: string;
  setCanvasTextDraft: (s: string, edit?: TextEditRange) => void;
  canvasTextInputRef: { current: HTMLTextAreaElement | null };
  onElementMouseDown: (e: any, el: DesignElement) => void;
  onStartCanvasTextEdit: (el: TextElement) => void;
  onCommitCanvasText: () => void;
  onCancelCanvasText: () => void;
  onOnPathTextBounds?: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  editingPathId?: string | null;
  frameTitles?: boolean;
  onTextSelect?: (range: { start: number; end: number } | null) => void;
}

export function SvgElementRenderer(props: SvgElementRendererProps) {
  const { elements, boundsElements, docRef, zoom } = props;
  // Keyed on the document, not on the rendered array: the registry is an index
  // of the document, and it self-caches per commit anyway.
  const registry = useMemo(() => buildReferenceRegistry(docRef.current), [docRef.current]);
  const worldBounds = useMemo(
    () => worldSubtreeBounds(boundsElements ?? elements),
    [boundsElements, elements]
  );
  // A pure function of `zoom`, derived once per host render rather than once per
  // element: the comparator compares this, not `zoom`.
  const rasterScale = useMemo(() => deviceScale(zoom), [zoom]);

  const selectionChangedIds = useSelectionChangedIds(props.selectedIds);

  const ctx: NodeRenderContext = {
    ...props,
    theme: props.theme ?? getActiveTheme(docRef.current),
    numberMode: props.numberMode ?? getActiveNumberMode(docRef.current),
    registry,
    worldBounds,
    rasterScale,
    selectionChangedIds
  };

  return <>{renderNodeList(elements, ctx, true)}</>;
}
