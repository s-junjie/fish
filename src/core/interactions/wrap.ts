import { AutoLayout, ContainerElement, DesignElement, FrameElement, PaintStack } from "../dsl/types";
import { elementAABB } from "../geometry/element-bounds";
import { createId } from "../id";
import { sortChildrenByLayoutOrder } from "../compile";
import { withLayout } from "../dsl/layout-flat";

export interface WrapOptions {
  mode: "flex" | "grid";
  /** Flex only. Defaults to "column". */
  direction?: "row" | "column";
  gap?: number;
  padding?: number | [number, number, number, number];
  /** Grid only. Defaults to 2. */
  columns?: number;
  name?: string;
  fills?: PaintStack;
  borderRadius?: number;
}

/**
 * A wrapper frame around loose elements, for the keyboard shortcut that wraps a
 * selection in a Stack or Grid.
 *
 * The frame is sized by what it holds, not by the selection's bounding box: a box
 * equal to the union is exactly the box that clips the children once padding is
 * added around them. Children come out in reading order.
 */
export function buildWrapFrame(
  elements: DesignElement[],
  options: WrapOptions
): FrameElement | null {
  if (elements.length === 0) return null;

  const boxes = elements.map(elementAABB);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));

  // Each mode carries only the fields it reads, so the other family cannot
  // survive a round trip and "come back" on a mode switch.
  const layout: AutoLayout =
    options.mode === "grid"
      ? {
          mode: "grid",
          columns: options.columns ?? 2,
          gap: options.gap ?? 16,
          padding: options.padding ?? 24
        }
      : {
          mode: "flex",
          direction: options.direction || "column",
          gap: options.gap ?? 16,
          padding: options.padding ?? 24
        };

  // Reading order, not the order the caller listed the ids in. Clustering rows by
  // vertical overlap is what makes a horizontal row of loose elements come out
  // left-to-right; a column stack's own sort keys on `y` alone, which leaves that
  // order untouched.
  const ordered = sortChildrenByLayoutOrder(
    withLayout(
      {
        id: "wrap",
        type: "frame",
        children: elements
      } as ContainerElement,
      { mode: "grid", placement: "row" }
    )
  );

  return withLayout(
    {
      id: createId("frame"),
      type: "frame",
      name: options.name || (options.mode === "grid" ? "Grid Container" : "Stack Container"),
      x: minX,
      y: minY,
      width: Math.max(10, maxX - minX),
      height: Math.max(10, maxY - minY),
      sizing: { width: "fit-content", height: "fit-content" },
      children: ordered,
      fills: options.fills || [{ type: "solid", color: "#1E1E1E" }],
      borderRadius: options.borderRadius ?? 16,
      clipContent: false
    } as FrameElement,
    layout
  );
}
