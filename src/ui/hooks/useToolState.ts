import { useState } from "preact/hooks";
import { DesignDocument } from "../../core/dsl/types";
import { NavToolType, ShapeToolType, ToolType } from "../../core/tools";
import { useScaleTool } from "./useScaleTool";
import type { ScaleTool } from "./useScaleTool";

export interface ToolState {
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  currentNavTool: NavToolType;
  setCurrentNavTool: (tool: NavToolType) => void;
  currentShapeTool: ShapeToolType;
  setCurrentShapeTool: (tool: ShapeToolType) => void;
  scaleTool: ScaleTool;
  /** The Scale tool is the active one. */
  isScaleTool: boolean;
}

/**
 * Which tool is selected, plus the Scale tool that derives its own mode from it.
 *
 * They are one hook because Scale has no switch of its own: it reads `active`
 * back out of `activeTool`, which is what makes it a temporary mode every other
 * dock button, menu item and shortcut can cancel without being told twice.
 */
export function useToolState(
  docRef: { current: DesignDocument },
  selectedIds: Set<string>
): ToolState {
  const [activeTool, setActiveTool] = useState<ToolType>("select");
  const [currentNavTool, setCurrentNavTool] = useState<NavToolType>("select");
  const [currentShapeTool, setCurrentShapeTool] = useState<ShapeToolType>("rect");
  const scaleTool = useScaleTool(docRef, selectedIds, activeTool, setActiveTool);

  return {
    activeTool,
    setActiveTool,
    currentNavTool,
    setCurrentNavTool,
    currentShapeTool,
    setCurrentShapeTool,
    scaleTool,
    isScaleTool: scaleTool.active
  };
}
