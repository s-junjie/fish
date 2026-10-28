import { ToolType } from "../tools";

export type CreatableToolType =
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "polygon"
  | "star"
  | "frame"
  | "text";

export function isCreatableTool(tool: ToolType): tool is CreatableToolType {
  return (
    tool === "rect" ||
    tool === "ellipse" ||
    tool === "line" ||
    tool === "arrow" ||
    tool === "polygon" ||
    tool === "star" ||
    tool === "frame" ||
    tool === "text"
  );
}

/**
 * Tools that pick and move what is already there, rather than drawing something
 * new.
 *
 * `scale` is one of them, and that is the whole reason it is a tool rather than a
 * one-shot command: it picks, marquees, drags and shows the same transform box as
 * `select`, and the only thing that differs is what a resize does to the element's
 * properties. Splitting that by hand at every `activeTool === "select"` test would
 * be five places to forget, and a missed one makes the tool select a layer but
 * refuse to drag it.
 */
export function isSelectingTool(tool: ToolType): boolean {
  return tool === "select" || tool === "scale";
}

export interface BoxShapeDraft {
  kind: "box";
  tool: "rect" | "ellipse" | "polygon" | "star" | "frame" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LineShapeDraft {
  kind: "line";
  tool: "line" | "arrow";
  x: number;
  y: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
}

export type ShapeDraftGeometry = BoxShapeDraft | LineShapeDraft;

export interface DraftModifiers {
  shiftKey: boolean;
  altKey: boolean;
}

export function computeShapeDraftBounds(
  tool: CreatableToolType,
  start: { x: number; y: number },
  current: { x: number; y: number },
  modifiers: DraftModifiers
): ShapeDraftGeometry {
  const { shiftKey, altKey } = modifiers;
  const dx = current.x - start.x;
  const dy = current.y - start.y;

  if (tool === "line" || tool === "arrow") {
    let x = start.x;
    let y = start.y;
    let x2 = current.x;
    let y2 = current.y;

    if (shiftKey) {
      const angle = Math.atan2(dy, dx);
      const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      const dist = Math.hypot(dx, dy);
      x2 = Math.round(start.x + dist * Math.cos(snappedAngle));
      y2 = Math.round(start.y + dist * Math.sin(snappedAngle));
    }

    if (altKey) {
      x = 2 * start.x - x2;
      y = 2 * start.y - y2;
    }

    return {
      kind: "line",
      tool,
      x,
      y,
      x2,
      y2,
      width: Math.abs(x2 - x),
      height: Math.max(2, Math.abs(y2 - y))
    };
  }

  let x: number;
  let y: number;
  let width: number;
  let height: number;

  if (altKey) {
    if (shiftKey) {
      const halfSize = Math.max(Math.abs(dx), Math.abs(dy));
      const size = Math.max(1, Math.round(halfSize * 2));
      x = Math.round(start.x - halfSize);
      y = Math.round(start.y - halfSize);
      width = size;
      height = size;
    } else {
      const halfW = Math.abs(dx);
      const halfH = Math.abs(dy);
      width = Math.max(1, Math.round(halfW * 2));
      height = Math.max(1, Math.round(halfH * 2));
      x = Math.round(start.x - halfW);
      y = Math.round(start.y - halfH);
    }
  } else {
    if (shiftKey) {
      const size = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
      const signX = dx >= 0 ? 1 : -1;
      const signY = dy >= 0 ? 1 : -1;
      const targetX = start.x + signX * size;
      const targetY = start.y + signY * size;
      x = Math.min(start.x, targetX);
      y = Math.min(start.y, targetY);
      width = size;
      height = size;
    } else {
      x = Math.min(start.x, current.x);
      y = Math.min(start.y, current.y);
      width = Math.max(1, Math.round(Math.abs(dx)));
      height = Math.max(1, Math.round(Math.abs(dy)));
    }
  }

  return {
    kind: "box",
    tool,
    x,
    y,
    width,
    height
  };
}

export function getDefaultShapeBounds(
  tool: CreatableToolType,
  clickPoint: { x: number; y: number }
): ShapeDraftGeometry {
  const { x, y } = clickPoint;
  switch (tool) {
    case "rect":
      return { kind: "box", tool, x, y, width: 200, height: 120 };
    case "ellipse":
      return { kind: "box", tool, x, y, width: 140, height: 140 };
    case "polygon":
      return { kind: "box", tool, x, y, width: 150, height: 150 };
    case "star":
      return { kind: "box", tool, x, y, width: 150, height: 150 };
    case "frame":
      return { kind: "box", tool, x, y, width: 320, height: 240 };
    case "text":
      return { kind: "box", tool, x, y, width: 260, height: 48 };
    case "line":
    case "arrow":
      return {
        kind: "line",
        tool,
        x,
        y,
        x2: x + 160,
        y2: y,
        width: 160,
        height: 2
      };
  }
}
