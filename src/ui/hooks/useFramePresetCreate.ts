import { useCallback } from "preact/hooks";
import type { Rect } from "../../core/geometry/bounds";
import {
  DesignDocument,
  FrameElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import type { ToolType } from "../../core/tools";
import { type FramePreset, placeFrameOutsideSiblings } from "../../core/frame-presets";
import { createId } from "../../core/id";
import { t } from "../../i18n";

/** Figma's default frame fill. A drawn frame starts from the same plate. */
const PRESET_FRAME_FILL = "#FFFFFF";

/**
 * What the hook needs from the viewport, read at call time.
 *
 * A ref rather than three props because all three are rebuilt whenever the user
 * pans or zooms, and the command it produces is handed to a memoized inspector
 * whose comparison function does not look at callbacks — a captured `dropTopLeft`
 * would place the next frame at the centre of the view the panel last rendered
 * with, which is a coordinate nobody is looking at any more.
 */
export interface FramePresetViewport {
  dropTopLeft: (size: { width: number; height: number }) => { x: number; y: number };
  visibleWorldRect: () => Rect;
  focusOn: (bounds: Rect) => void;
}

interface FramePresetCreateOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  select: (ids: Set<string>) => void;
  setActiveTool: (tool: ToolType) => void;
  viewportRef: { current: FramePresetViewport };
}

/**
 * New frame from a size preset.
 *
 * Deliberately NOT `commitCreatedShape`: that path asks where the box landed and
 * adopts the frame under it as a parent, which is how a drawn frame nests. A
 * preset is a page-level board — the user picked a device, not a slot inside
 * something — so it always lands at the root.
 */
export function useFramePresetCreate({
  docRef,
  commitSnapshot,
  select,
  setActiveTool,
  viewportRef
}: FramePresetCreateOptions) {
  return useCallback(
    (preset: FramePreset) => {
      const viewport = viewportRef.current;
      const size = { width: preset.width, height: preset.height };
      const cur = docRef.current;
      const siblings = getActivePage(cur).children;
      const at = placeFrameOutsideSiblings(viewport.dropTopLeft(size), size, siblings);

      const frame: FrameElement = {
        id: createId("frame"),
        type: "frame",
        name: t(preset.nameKey),
        x: at.x,
        y: at.y,
        width: size.width,
        height: size.height,
        children: [],
        fills: [{ type: "solid", color: PRESET_FRAME_FILL }],
        clipContent: false
      };

      commitSnapshot(updateActivePageElements(cur, [...siblings, frame]));
      select(new Set([frame.id]));
      setActiveTool("select");

      // A phone fits the view at any zoom a person works at; a 1920 slide does
      // not, and a frame whose edges are off-screen reads as a background rather
      // than as the thing just made. Only frames that do not fit are revealed,
      // so the view never jumps for a preset that was already visible.
      const visible = viewport.visibleWorldRect();
      const contained =
        at.x >= visible.x &&
        at.y >= visible.y &&
        at.x + size.width <= visible.x + visible.width &&
        at.y + size.height <= visible.y + visible.height;
      if (!contained) viewport.focusOn({ x: at.x, y: at.y, width: size.width, height: size.height });
    },
    [docRef, commitSnapshot, select, setActiveTool, viewportRef]
  );
}
