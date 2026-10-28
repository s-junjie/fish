import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { DesignDocument } from "../../core/dsl/types";
import { ToolType } from "../../core/tools";
import { DEFAULT_SCALE_ANCHOR, ScaleAnchor, selectionWorldBounds } from "../../core/interactions/scale-ops";

/**
 * The Scale tool's state, in one place.
 *
 * Three things have to agree for the tool to be usable, and all three are easy to
 * get subtly wrong when they are spread through the app shell: which tool is
 * active, where a scale grows from, and what the factor is measured against. They
 * live here so the toolbar button, the `K` shortcut, the canvas resize and the
 * inspector's fields cannot each hold a different answer.
 */

export interface ScaleTool {
  /** The Scale tool is the active one. */
  active: boolean;
  /** Where a scale grows from, as a fraction of the element's own box. */
  anchor: ScaleAnchor;
  setAnchor: (anchor: ScaleAnchor) => void;
  /**
   * The selection's size when the tool was entered, which the factor divides by.
   *
   * A scale stores no original — the document only holds the current one — so
   * without a captured reference "1x" has nothing to mean, and a field that
   * divides a size by a size it has just rewritten can never return to 1.
   */
  reference: { width: number; height: number } | null;
  /** Enter the tool, or leave it if it is already on. */
  toggle: () => void;
  /**
   * Leave the tool and go back to Move. Stable, so the global shortcut listener
   * can hold it without re-registering (LESSONS §59).
   */
  leave: () => void;
  /** True while a W / H / factor edit is live, so the Size block can stand down. */
  ownsSizeBlock: boolean;
}

export function useScaleTool(
  docRef: { current: DesignDocument },
  /**
   * The selected IDS, not the selected elements.
   *
   * `selectedElements` is rebuilt on every render, so depending on it made the
   * effect below re-fire after every edit — which reset the reference to the size
   * the tool had just produced and made the factor read 1x again the moment you
   * looked at it. The id set is stable between selection changes, which is the
   * only thing the effect is supposed to react to.
   */
  selectedIds: Set<string>,
  /**
   * The ONE switch, and the tool reads its own mode back out of it rather than
   * holding a second copy of "am I on".
   *
   * That is what makes Scale a temporary mode: every other tool in the app goes
   * through `setActiveTool`, so deriving `active` here means picking any other
   * tool — a dock button, a menu item, a shortcut — leaves Scale and takes its
   * inspector section down with it, with no second place that has to be told.
   * Space and the middle button are the exception and need no special case: they
   * never touch the active tool, they only OR into pan mode, so panning leaves
   * Scale standing for the release.
   */
  activeTool: ToolType,
  setActiveTool: (tool: ToolType) => void
): ScaleTool {
  const [anchor, setAnchor] = useState<ScaleAnchor>(DEFAULT_SCALE_ANCHOR);
  const [reference, setReference] = useState<{ width: number; height: number } | null>(null);
  const active = activeTool === "scale";
  // Mirrored in a ref so `toggle` can be STABLE while still reading the current
  // tool. It has to be stable: it is handed to the global shortcut listener,
  // whose effect does not list it as a dependency, so a `toggle` that closed over
  // `active` would be frozen at whatever it was on the first render — pressing K
  // twice would then set the tool on twice and never off.
  const activeRef = useRef(active);
  activeRef.current = active;

  const setTool = useCallback(
    (tool: ToolType) => {
      if (tool !== "scale") setReference(null);
      setActiveTool(tool);
    },
    [setActiveTool]
  );

  const leave = useCallback(() => {
    setTool("select");
  }, [setTool]);

  const toggle = useCallback(() => {
    setTool(activeRef.current ? "select" : "scale");
  }, [setTool]);

  /**
   * Recapture the reference when the tool is entered and when the selection
   * changes — and NOT after an edit.
   *
   * Keying on the selection is what keeps the two apart: an edit that leaves the
   * same ids selected cannot re-fire, so the first W you type does not reset the
   * reference and make the factor read 1x again the moment you look at it.
   */
  useEffect(() => {
    if (!active || selectedIds.size === 0) return;
    const bounds = selectionWorldBounds(getActivePage(docRef.current).children, selectedIds);
    if (bounds) setReference({ width: bounds.width, height: bounds.height });
  }, [active, selectedIds]);

  return {
    active,
    anchor,
    setAnchor,
    reference,
    toggle,
    leave,
    ownsSizeBlock: active
  };
}
