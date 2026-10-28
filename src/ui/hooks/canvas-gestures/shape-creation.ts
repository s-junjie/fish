import {
  DesignDocument,
  DesignElement,
  EllipseElement,
  FrameElement,
  LineElement,
  PolygonElement,
  RectElement,
  StarElement,
  TextElement,
  updateActivePageElements
} from "../../../core/dsl/types";
import { getActivePage } from "../../../core/dsl/types";
import type { ToolType } from "../../../core/tools";
import { DEFAULT_ELEMENT_COLOR, DEFAULT_STROKE_COLOR } from "../../../core/dsl/defaults";
import { DEFAULT_FONT_FAMILY } from "../../../core/font-stack";
import { createId } from "../../../core/id";
import {
  findElementById,
  isContainer,
  mapElements,
  computeParentOrigin,
  findFrameAtPoint,
  findParentFrameForBox,
  insertElementIntoContainer,
  removeElementFromTree
} from "../../../core/geometry/tree-ops";
import { elementAABB } from "../../../core/geometry/element-bounds";
import { newTextInkAt } from "../../../core/geometry/ink-on";
import { ShapeDraftGeometry } from "../../../core/geometry/shape-creation";
import { applyAutoLayout } from "../../../core/layout/auto-layout";
import { layoutOf } from "../../../core/dsl/layout-flat";
import { syncTextSizing } from "../../../core/layout/text-sizing";

export interface CommitShapeContext {
  finalGeom: ShapeDraftGeometry;
  dist: number;
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  setSelectedIds: (ids: Set<string>) => void;
  setActiveTool: (tool: ToolType) => void;
  startCanvasTextEdit: (el: TextElement) => void;
}

export function commitCreatedShape({
  finalGeom,
  dist,
  docRef,
  commitSnapshot,
  setSelectedIds,
  setActiveTool,
  startCanvasTextEdit
}: CommitShapeContext) {
  let created: DesignElement | null = null;
  if (finalGeom.kind === "box") {
    if (finalGeom.tool === "rect") {
      created = {
        id: createId("rect"),
        type: "rect",
        name: "Rectangle",
        x: finalGeom.x,
        y: finalGeom.y,
        width: finalGeom.width,
        height: finalGeom.height,
        fills: [{ type: "solid", color: DEFAULT_ELEMENT_COLOR }]
      } as RectElement;
    } else if (finalGeom.tool === "ellipse") {
      created = {
        id: createId("ellipse"),
        type: "ellipse",
        name: "Ellipse",
        x: finalGeom.x,
        y: finalGeom.y,
        width: finalGeom.width,
        height: finalGeom.height,
        fills: [{ type: "solid", color: DEFAULT_ELEMENT_COLOR }]
      } as EllipseElement;
    } else if (finalGeom.tool === "polygon") {
      created = {
        id: createId("polygon"),
        type: "polygon",
        name: "Polygon",
        x: finalGeom.x,
        y: finalGeom.y,
        width: finalGeom.width,
        height: finalGeom.height,
        sides: 5,
        fills: [{ type: "solid", color: DEFAULT_ELEMENT_COLOR }]
      } as PolygonElement;
    } else if (finalGeom.tool === "star") {
      created = {
        id: createId("star"),
        type: "star",
        name: "Star",
        x: finalGeom.x,
        y: finalGeom.y,
        width: finalGeom.width,
        height: finalGeom.height,
        points: 5,
        innerRadius: 0.382,
        cornerSmoothing: 0,
        fills: [{ type: "solid", color: DEFAULT_ELEMENT_COLOR }]
      } as StarElement;
    } else if (finalGeom.tool === "frame") {
      created = {
        id: createId("frame"),
        type: "frame",
        name: "Frame",
        x: finalGeom.x,
        y: finalGeom.y,
        width: finalGeom.width,
        height: finalGeom.height,
        children: [],
        fills: [{ type: "solid", color: "#FFFFFF" }],
        clipContent: false
      } as FrameElement;
    } else if (finalGeom.tool === "text") {
      const ink = newTextInkAt(docRef.current, {
        x: finalGeom.x + finalGeom.width / 2,
        y: finalGeom.y + finalGeom.height / 2
      });
      created = {
        id: createId("text"),
        type: "text",
        name: "Text",
        x: finalGeom.x,
        y: finalGeom.y,
        width: finalGeom.width,
        height: Math.max(32, finalGeom.height),
        sizing: dist >= 3 ? { height: "fit-content" } : { width: "fit-content", height: "fit-content" },
        content: "New Text Layer",
        fills: [{ type: "solid", color: ink }],
        style: {
          fontSize: 28,
          color: ink,
          fontFamily: DEFAULT_FONT_FAMILY
        }
      } as TextElement;
    }
  } else {
    if (finalGeom.tool === "line") {
      created = {
        id: createId("line"),
        type: "line",
        name: "Line",
        x: finalGeom.x,
        y: finalGeom.y,
        dx: finalGeom.x2 - finalGeom.x,
        dy: finalGeom.y2 - finalGeom.y,
        width: finalGeom.width,
        height: finalGeom.height,
        strokes: [{ color: DEFAULT_STROKE_COLOR, width: 2 }]
      } as LineElement;
    } else if (finalGeom.tool === "arrow") {
      created = {
        id: createId("arrow"),
        type: "arrow",
        name: "Arrow",
        x: finalGeom.x,
        y: finalGeom.y,
        dx: finalGeom.x2 - finalGeom.x,
        dy: finalGeom.y2 - finalGeom.y,
        width: finalGeom.width,
        height: finalGeom.height,
        strokes: [{ color: DEFAULT_STROKE_COLOR, width: 2 }]
      } as any;
    }
  }

  if (created) {
    const centerX = created.type === "line" || created.type === "arrow"
      ? (created as LineElement).x + (created as LineElement).dx / 2
      : created.x + created.width / 2;
    const centerY = created.type === "line" || created.type === "arrow"
      ? (created as LineElement).y + (created as LineElement).dy / 2
      : created.y + created.height / 2;

    const parentFrame =
      created.type === "frame"
        ? findParentFrameForBox(getActivePage(docRef.current).children, {
          x: created.x,
          y: created.y,
          width: created.width,
          height: created.height
        })
        : findFrameAtPoint(getActivePage(docRef.current).children, centerX, centerY);
    if (created.type === "frame" && parentFrame && isContainer(parentFrame)) {
      created = { ...created, fills: [] } as DesignElement;
    }
    let nextElements: DesignElement[];
    if (parentFrame && isContainer(parentFrame)) {
      const parentOrigin = computeParentOrigin(getActivePage(docRef.current).children, parentFrame.id);
      const parentWorldX = parentOrigin.x + parentFrame.x;
      const parentWorldY = parentOrigin.y + parentFrame.y;
      created = {
        ...created,
        x: created.x - parentWorldX,
        y: created.y - parentWorldY
      };
      nextElements = insertElementIntoContainer(getActivePage(docRef.current).children, created, parentFrame.id);
      const updatedTarget = findElementById(nextElements, parentFrame.id) as FrameElement;
      if (layoutOf(updatedTarget)) {
        const laidOut = applyAutoLayout(updatedTarget);
        nextElements = mapElements(nextElements, (el) => el.id === laidOut.id ? laidOut : el);
      }
    } else {
      nextElements = [...getActivePage(docRef.current).children, created];
    }

    if (created.type === "frame" && dist >= 3) {
      const placed = findElementById(nextElements, created.id);
      if (placed && placed.type === "frame") {
        const parentId = parentFrame && isContainer(parentFrame) ? parentFrame.id : null;
        const siblings = parentId
          ? ((findElementById(nextElements, parentId) as FrameElement | null)?.children ?? [])
          : nextElements;
        const left = placed.x;
        const top = placed.y;
        const right = placed.x + placed.width;
        const bottom = placed.y + placed.height;
        const enclosedIds = siblings
          .filter((sib) => sib.id !== placed.id && !sib.locked)
          .filter((sib) => {
            const b = elementAABB(sib);
            return b.x >= left && b.y >= top && b.x + b.width <= right && b.y + b.height <= bottom;
          })
          .map((sib) => sib.id);
        for (const id of enclosedIds) {
          const [withoutSib, extracted] = removeElementFromTree(nextElements, id);
          if (extracted) {
            const adjusted: DesignElement = {
              ...extracted,
              x: extracted.x - left,
              y: extracted.y - top
            };
            nextElements = insertElementIntoContainer(withoutSib, adjusted, placed.id);
          }
        }
        if (enclosedIds.length > 0 && parentId) {
          const parent = findElementById(nextElements, parentId);
          if (parent && isContainer(parent) && layoutOf(parent)) {
            const laidOut = applyAutoLayout(parent);
            nextElements = mapElements(nextElements, (el) => el.id === laidOut.id ? laidOut : el);
          }
        }
      }
    }

    commitSnapshot(updateActivePageElements(docRef.current, syncTextSizing(nextElements)));
    setSelectedIds(new Set([created.id]));
    setActiveTool("select");

    if (created.type === "text") {
      startCanvasTextEdit(created as TextElement);
    }
  }
}
