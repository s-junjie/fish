import { DesignElement, FrameElement } from "../dsl/types";
import { layoutOf } from "../dsl/layout-flat";
import { elementAABB } from "./element-bounds";
import { transformBoundsToAABB, Rect } from "./bounds";
import { translation, type Matrix2D } from "./matrix";
import { gapsMatch, gridAxesEven } from "./smart-spacing";

export interface SmartGapHandle {
  id: string; // e.g. "gap_x_0", "gap_y_0"
  axis: "x" | "y";
  x: number; // center position on canvas
  y: number;
  gap: number;
  box: Rect; // the empty band the gap occupies, in canvas space
  indexA?: number; // index or row/col index
  indexB?: number;
}

export interface SmartDotHandle {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  elementId: string;
  index: number;
  row?: number;
  col?: number;
}

export interface SmartGridInfo {
  rows: number;
  cols: number;
  rowGap: number;
  colGap: number;
  matrix: (DesignElement | null)[][];
}

export interface SmartSelectionInfo {
  axis: "x" | "y" | "grid";
  gap: number;
  rowGap?: number;
  colGap?: number;
  handles: SmartGapHandle[];
  dots: SmartDotHandle[];
  sortedElements: DesignElement[];
  parentFrame?: FrameElement | null;
  grid?: SmartGridInfo | null;
  /** Every gap on every axis already measures the same — see
   *  {@link EVEN_SPACING_TOLERANCE} in `./smart-spacing`. False means the pills are
   *  withheld and a tidy-up button is offered instead. */
  gapsEven: boolean;
  /** The axes that are NOT even, in x-then-y order — one button each. Empty
   *  whenever `gapsEven` is true, and whenever the selection is an auto-layout
   *  frame, whose gap is one number the container owns. */
  unevenAxes: ("x" | "y")[];
  /** The union of the boxes, in canvas space — where the tidy-up button hangs. */
  bounds: Rect;
}

export interface SmartSelectionOptions {
  /**
   * The canvas origin an element's own `x` / `y` are relative to. Every handle
   * and dot this module reports is drawn on the canvas, so it has to come back
   * in canvas space: a stack's children are positioned in the FRAME's space, and
   * reading their boxes raw put the whole row of controls at the frame's origin
   * instead of over the children.
   */
  originOf?: (el: DesignElement) => { x: number; y: number };
  /**
   * The same answer as a MATRIX, for callers that have one.
   *
   * `originOf` is a translation, and a translation cannot say where a turned
   * element paints — the renderer draws a child inside its frame's turned group.
   * Pass this and it wins; pass only `originOf` and everything behaves exactly as
   * before, which is what keeps a caller that has no document to hand unaffected.
   */
  matrixOf?: (el: DesignElement) => Matrix2D;
}

/** The empty band between two adjacent boxes, spanning their full cross extent. */
function gapBand(a: Rect, b: Rect, axis: "x" | "y", gap: number): Rect {
  if (axis === "x") {
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x: a.x + a.width, y: top, width: Math.max(0, gap), height: bottom - top };
  }
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x + a.width, b.x + b.width);
  return { x: left, y: a.y + a.height, width: right - left, height: Math.max(0, gap) };
}

function unionBoxes(boxes: Rect[]): Rect {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Children grouped into the LINES a wrapping flex frame lays them out in.
 *
 * A line is a run of children whose cross extents overlap: `align-items: center`
 * leaves a short child's edges inside its line, so the test is overlap with the
 * line's running extent rather than equality of starts.
 *
 * Every reader that pairs two children has to group first. Sorting a wrapped
 * frame's whole child list along the main axis pairs the end of one line with the
 * start of the next, and draws a seam through the middle of the frame.
 */
export function groupFlexLines<T extends { box?: Rect } | Rect>(items: T[], main: "x" | "y"): T[][] {
  const boxOf = (it: T): Rect => ("box" in it && it.box ? it.box : (it as Rect));
  const start = (b: Rect) => (main === "x" ? b.y : b.x);
  const end = (b: Rect) => (main === "x" ? b.y + b.height : b.x + b.width);
  const lines: T[][] = [];
  let lineEnd = -Infinity;
  for (const item of [...items].sort((a, b) => start(boxOf(a)) - start(boxOf(b)))) {
    const b = boxOf(item);
    if (lines.length === 0 || start(b) >= lineEnd - 0.01) {
      lines.push([item]);
      lineEnd = end(b);
    } else {
      lines[lines.length - 1].push(item);
      lineEnd = Math.max(lineEnd, end(b));
    }
  }
  return lines;
}

/**
 * Detects if a set of 2+ elements or an Auto-Layout Frame are arranged in 1D or 2D grid.
 *
 * Every box it measures goes through `worldBox`, so the reported handles, dots
 * and gap bands are in canvas space — the space the overlay draws them in.
 */
export function detectSmartSelection(
  selectedElements: DesignElement[],
  options: SmartSelectionOptions = {}
): SmartSelectionInfo | null {
  const originOf = options.originOf ?? (() => ({ x: 0, y: 0 }));
  // The box as PAINTED: the stored box carried through the chain the renderer
  // draws with, so a turned element contributes the region it really covers
  // rather than the one it would cover if it had not been turned. What this
  // cannot express is a gap between two turned siblings — the gap is measured
  // between axis-aligned boxes, and a turned layer's box is not axis-aligned.
  // Measuring in the FRAME's own space instead is the fix for that, and is a
  // different answer to the question rather than a corrected one.
  const worldBox = (el: DesignElement): Rect => {
    const box = elementAABB(el);
    return transformBoundsToAABB(box, options.matrixOf?.(el) ?? translation(originOf(el).x, originOf(el).y))!;
  };

  // Case 1: Single Frame with Auto-Layout selected
  if (selectedElements.length === 1 && selectedElements[0].type === "frame") {
    const frame = selectedElements[0] as FrameElement;
    const frameLayout = layoutOf(frame);
    if (frameLayout && frameLayout.mode === "flex" && frame.children && frame.children.length >= 2) {
      const isRow = frameLayout.direction !== "column";
      const main = isRow ? "x" : "y";
      const childrenWithBoxes = frame.children.map((c) => ({
        el: c,
        box: worldBox(c)
      }));
      // Line-major, then along the main axis: a wrapped frame's pills sit between
      // neighbours IN a line, never across the seam between two lines.
      const lines = groupFlexLines(childrenWithBoxes, main).map((line) =>
        [...line].sort((a, b) => (isRow ? a.box.x - b.box.x : a.box.y - b.box.y))
      );
      const sorted = lines.flat();

      const handles: SmartGapHandle[] = [];
      const dots: SmartDotHandle[] = [];

      let index = 0;
      for (const line of lines) {
        for (let i = 0; i < line.length; i++, index++) {
          const item = line[i];
          dots.push({
            id: `dot_${item.el.id}`,
            x: item.box.x + item.box.width / 2,
            y: item.box.y + item.box.height / 2,
            width: item.box.width,
            height: item.box.height,
            elementId: item.el.id,
            index
          });

          // The last item of a line has no neighbour along this axis: the space
          // after it is where the next line begins.
          if (i === line.length - 1) continue;
          const nxt = line[i + 1];
          if (isRow) {
            const gap = Math.round(nxt.box.x - (item.box.x + item.box.width));
            const midY = (Math.max(item.box.y, nxt.box.y) + Math.min(item.box.y + item.box.height, nxt.box.y + nxt.box.height)) / 2;
            handles.push({
              id: `frame_gap_${index}`,
              axis: "x",
              x: item.box.x + item.box.width + gap / 2,
              y: midY,
              gap,
              box: gapBand(item.box, nxt.box, "x", gap),
              indexA: index,
              indexB: index + 1
            });
          } else {
            const gap = Math.round(nxt.box.y - (item.box.y + item.box.height));
            const midX = (Math.max(item.box.x, nxt.box.x) + Math.min(item.box.x + item.box.width, nxt.box.x + nxt.box.width)) / 2;
            handles.push({
              id: `frame_gap_${index}`,
              axis: "y",
              x: midX,
              y: item.box.y + item.box.height + gap / 2,
              gap,
              box: gapBand(item.box, nxt.box, "y", gap),
              indexA: index,
              indexB: index + 1
            });
          }
        }
      }

      return {
        axis: isRow ? "x" : "y",
        gap: frameLayout.gap ?? 0,
        handles,
        dots,
        sortedElements: sorted.map((s) => s.el),
        parentFrame: frame,
        // A flex gap is ONE number for the whole stack, so the children cannot sit
        // at different distances from each other — there is no unevenness to tidy.
        gapsEven: true,
        unevenAxes: [],
        bounds: unionBoxes(sorted.map((s) => s.box))
      };
    }
  }

  // Case 2: Multi-selection of 2+ elements
  if (selectedElements.length < 2) return null;

  const elements = selectedElements;
  const boxes = elements.map((el) => ({ el, box: worldBox(el) }));

  // 1. Check 1D horizontal row
  const sortedX = [...boxes].sort((a, b) => a.box.x - b.box.x);
  let isRow = true;
  for (let i = 0; i < sortedX.length - 1; i++) {
    const cur = sortedX[i].box;
    const nxt = sortedX[i + 1].box;
    const yOverlap = Math.min(cur.y + cur.height, nxt.y + nxt.height) - Math.max(cur.y, nxt.y);
    if (yOverlap <= 0 || nxt.x < cur.x + cur.width - 2) {
      isRow = false;
      break;
    }
  }

  // 2. Check 1D vertical column
  const sortedY = [...boxes].sort((a, b) => a.box.y - b.box.y);
  let isCol = true;
  for (let i = 0; i < sortedY.length - 1; i++) {
    const cur = sortedY[i].box;
    const nxt = sortedY[i + 1].box;
    const xOverlap = Math.min(cur.x + cur.width, nxt.x + nxt.width) - Math.max(cur.x, nxt.x);
    if (xOverlap <= 0 || nxt.y < cur.y + cur.height - 2) {
      isCol = false;
      break;
    }
  }

  if (isRow && !isCol) {
    const handles: SmartGapHandle[] = [];
    const dots: SmartDotHandle[] = [];
    let totalGap = 0;

    for (let i = 0; i < sortedX.length; i++) {
      const item = sortedX[i];
      dots.push({
        id: `dot_${item.el.id}`,
        x: item.box.x + item.box.width / 2,
        y: item.box.y + item.box.height / 2,
        width: item.box.width,
        height: item.box.height,
        elementId: item.el.id,
        index: i
      });
      if (i < sortedX.length - 1) {
        const a = sortedX[i].box;
        const b = sortedX[i + 1].box;
        const gap = Math.round(b.x - (a.x + a.width));
        totalGap += gap;
        const midY = (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2;
        handles.push({
          id: `gap_x_${i}`,
          axis: "x",
          x: a.x + a.width + gap / 2,
          y: midY,
          gap,
          box: gapBand(a, b, "x", gap),
          indexA: i,
          indexB: i + 1
        });
      }
    }
    return {
      axis: "x",
      gap: Math.round(totalGap / (sortedX.length - 1)),
      handles,
      dots,
      sortedElements: sortedX.map((s) => s.el),
      gapsEven: gapsMatch(handles, "x"),
      unevenAxes: gapsMatch(handles, "x") ? [] : ["x"],
      bounds: unionBoxes(boxes.map((b) => b.box))
    };
  }

  if (isCol && !isRow) {
    const handles: SmartGapHandle[] = [];
    const dots: SmartDotHandle[] = [];
    let totalGap = 0;

    for (let i = 0; i < sortedY.length; i++) {
      const item = sortedY[i];
      dots.push({
        id: `dot_${item.el.id}`,
        x: item.box.x + item.box.width / 2,
        y: item.box.y + item.box.height / 2,
        width: item.box.width,
        height: item.box.height,
        elementId: item.el.id,
        index: i
      });
      if (i < sortedY.length - 1) {
        const a = sortedY[i].box;
        const b = sortedY[i + 1].box;
        const gap = Math.round(b.y - (a.y + a.height));
        totalGap += gap;
        const midX = (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2;
        handles.push({
          id: `gap_y_${i}`,
          axis: "y",
          x: midX,
          y: a.y + a.height + gap / 2,
          gap,
          box: gapBand(a, b, "y", gap),
          indexA: i,
          indexB: i + 1
        });
      }
    }
    return {
      axis: "y",
      gap: Math.round(totalGap / (sortedY.length - 1)),
      handles,
      dots,
      sortedElements: sortedY.map((s) => s.el),
      gapsEven: gapsMatch(handles, "y"),
      unevenAxes: gapsMatch(handles, "y") ? [] : ["y"],
      bounds: unionBoxes(boxes.map((b) => b.box))
    };
  }

  // 3. Check 2D Grid (4+ elements arranged in distinct rows & columns)
  if (elements.length >= 4) {
    // Cluster centers by Y coordinate into distinct rows (threshold = element height / 2)
    const sortedByY = [...boxes].sort((a, b) => a.box.y - b.box.y);
    const rowGroups: (typeof boxes)[] = [];
    for (const b of sortedByY) {
      const lastGroup = rowGroups[rowGroups.length - 1];
      if (!lastGroup) {
        rowGroups.push([b]);
      } else {
        const avgY = lastGroup.reduce((sum, item) => sum + item.box.y, 0) / lastGroup.length;
        const threshold = b.box.height * 0.45;
        if (Math.abs(b.box.y - avgY) <= threshold) {
          lastGroup.push(b);
        } else {
          rowGroups.push([b]);
        }
      }
    }

    if (rowGroups.length >= 2) {
      // Sort each row horizontally
      for (const row of rowGroups) {
        row.sort((a, b) => a.box.x - b.box.x);
      }

      // Check if all rows have the same number of columns
      const firstRowLen = rowGroups[0].length;
      const isRegularGrid = firstRowLen >= 2 && rowGroups.every((r) => r.length === firstRowLen);

      if (isRegularGrid) {
        const numRows = rowGroups.length;
        const numCols = firstRowLen;
        const gridBox = unionBoxes(boxes.map((b) => b.box));

        const handles: SmartGapHandle[] = [];
        const dots: SmartDotHandle[] = [];
        const sortedAll: DesignElement[] = [];

        // Center dots for each element
        let dotIdx = 0;
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            const item = rowGroups[r][c];
            sortedAll.push(item.el);
            dots.push({
              id: `dot_${item.el.id}`,
              x: item.box.x + item.box.width / 2,
              y: item.box.y + item.box.height / 2,
              width: item.box.width,
              height: item.box.height,
              elementId: item.el.id,
              index: dotIdx++,
              row: r,
              col: c
            });
          }
        }

        // Column gap handles (X axis): placed between columns c and c+1
        let totalColGap = 0;
        let colGapCount = 0;
        for (let c = 0; c < numCols - 1; c++) {
          let avgGap = 0;
          let avgMidX = 0;
          let count = 0;
          for (let r = 0; r < numRows; r++) {
            const leftEl = rowGroups[r][c].box;
            const rightEl = rowGroups[r][c + 1].box;
            const gap = rightEl.x - (leftEl.x + leftEl.width);
            avgGap += gap;
            avgMidX += leftEl.x + leftEl.width + gap / 2;
            count++;
          }
          avgGap /= count;
          avgMidX /= count;
          totalColGap += avgGap;
          colGapCount++;

          // Place one handle per column gap (vertically centered across row 0 & 1 or whole grid)
          const firstBox = rowGroups[0][c].box;
          const lastBox = rowGroups[numRows - 1][c].box;
          const midY = (firstBox.y + lastBox.y + lastBox.height) / 2;

          handles.push({
            id: `grid_gap_col_${c}`,
            axis: "x",
            x: avgMidX,
            y: midY,
            gap: Math.round(avgGap),
            box: {
              x: avgMidX - Math.max(0, avgGap) / 2,
              y: gridBox.y,
              width: Math.max(0, avgGap),
              height: gridBox.height
            },
            indexA: c,
            indexB: c + 1
          });
        }

        // Row gap handles (Y axis): placed between rows r and r+1
        let totalRowGap = 0;
        let rowGapCount = 0;
        for (let r = 0; r < numRows - 1; r++) {
          let avgGap = 0;
          let avgMidY = 0;
          let count = 0;
          for (let c = 0; c < numCols; c++) {
            const topEl = rowGroups[r][c].box;
            const bottomEl = rowGroups[r + 1][c].box;
            const gap = bottomEl.y - (topEl.y + topEl.height);
            avgGap += gap;
            avgMidY += topEl.y + topEl.height + gap / 2;
            count++;
          }
          avgGap /= count;
          avgMidY /= count;
          totalRowGap += avgGap;
          rowGapCount++;

          const firstColBox = rowGroups[r][0].box;
          const lastColBox = rowGroups[r][numCols - 1].box;
          const midX = (firstColBox.x + lastColBox.x + lastColBox.width) / 2;

          handles.push({
            id: `grid_gap_row_${r}`,
            axis: "y",
            x: midX,
            y: avgMidY,
            gap: Math.round(avgGap),
            box: {
              x: gridBox.x,
              y: avgMidY - Math.max(0, avgGap) / 2,
              width: gridBox.width,
              height: Math.max(0, avgGap)
            },
            indexA: r,
            indexB: r + 1
          });
        }

        const calculatedRowGap = rowGapCount > 0 ? Math.round(totalRowGap / rowGapCount) : 0;
        const calculatedColGap = colGapCount > 0 ? Math.round(totalColGap / colGapCount) : 0;

        // A grid's two directions are independent — columns can line up while the
        // rows do not — so they are measured apart and each gets its own button.
        const even = gridAxesEven(rowGroups.map((rg) => rg.map((item) => item.el)), worldBox);
        const unevenAxes: ("x" | "y")[] = [!even.x ? "x" : null, !even.y ? "y" : null].filter(
          (a): a is "x" | "y" => a !== null
        );

        return {
          axis: "grid",
          gap: calculatedColGap,
          rowGap: calculatedRowGap,
          colGap: calculatedColGap,
          handles,
          dots,
          sortedElements: sortedAll,
          gapsEven: unevenAxes.length === 0,
          unevenAxes,
          bounds: gridBox,
          grid: {
            rows: numRows,
            cols: numCols,
            rowGap: calculatedRowGap,
            colGap: calculatedColGap,
            matrix: rowGroups.map((rg) => rg.map((item) => item.el))
          }
        };
      }
    }
  }

  return null;
}
