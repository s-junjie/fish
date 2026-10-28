import { AutoLayout, DesignElement, FrameElement, TextElement } from "../dsl/types";
import { DEFAULT_FLEX_ALIGN, alignSelfOf, layoutOf } from "../dsl/layout-flat";
import { SizingAxis, axisIsPinned, resolveAxis } from "../geometry/resolve-axis";
import { measureText } from "../geometry/text-measure";
import { envelopeOf, placeChildAt } from "../geometry/element-bounds";
import {
  childBox,
  clampAxis,
  hugsAxis,
  isFillAxis,
  maxFrom,
  resolveMargin,
  resolvePadding,
  round2,
  sizeForEnvelope,
  ChildSizeResolver
} from "./box";
import { textSpec } from "./text-sizing";
import { inFlowChildren } from "./auto-layout";

/**
 * A child's size along the parent's main axis, before `fill` distribution.
 *
 * `mainLimit` / `crossLimit` are the wrap constraints *for measurement only*:
 * on an axis the container hugs they are unbounded, because that axis is what
 * this pass is about to recompute. Measuring against the stale value instead
 * makes the result depend on whatever the document happened to contain — a hug
 * container can then only shrink, never grow back, and repeated relayouts drift.
 */
function childMainSize(
  child: DesignElement,
  parent: FrameElement,
  isRow: boolean,
  mainLimit: number,
  crossLimit: number,
  resolveChild?: ChildSizeResolver
): number {
  if (child.type === "text") {
    const mainMode = resolveAxis(child, parent, isRow ? "width" : "height");
    const crossMode = resolveAxis(child, parent, isRow ? "height" : "width");
    if (mainMode === "max-content" || mainMode === "fit-content") {
      const spec = textSpec(child.style, (child as TextElement).spans);
      let limit: number;
      if (isRow) {
        limit = mainMode === "max-content" ? Infinity : mainLimit;
      } else {
        // Column: the wrap constraint has to be the width the child is actually
        // given. Only a genuinely `fixed` cross axis keeps its own number —
        // `fit-content` and `fill` are both derived from the container, and
        // `max-content` is unbounded. Measuring against the stale authored width
        // made the height disagree with the width this same pass assigns.
        limit =
          crossMode === "fixed"
            ? child.width
            : crossMode === "max-content"
              ? Infinity
              : crossLimit;
      }
      const measured = measureText(child.content, spec, limit);
      return isRow ? measured.width : measured.height;
    }
  }
  const box = childBox(child, resolveChild);
  return isRow ? box.width : box.height;
}

/** A child's size along the parent's cross axis, once its main size is final. */
function childCrossSize(
  child: DesignElement,
  parent: FrameElement,
  isRow: boolean,
  finalMain: number,
  crossLimit: number,
  fallback: number,
  resolveChild?: ChildSizeResolver
): number {
  if (child.type !== "text") return fallback;
  const mode = resolveAxis(child, parent, isRow ? "height" : "width");
  if (mode !== "fit-content" && mode !== "max-content") return fallback;
  const spec = textSpec(child.style, (child as TextElement).spans);
  if (isRow) {
    // Height is never a wrap constraint: the line count follows the width the
    // child was just given. Using the container's height here wrapped text
    // against a box that is itself derived from that height.
    return measureText(child.content, spec, finalMain).height;
  }
  return measureText(child.content, spec, mode === "max-content" ? Infinity : crossLimit).width;
}

/**
 * How `align-content` turns the cross-axis slack between wrapped lines into an
 * initial offset, a per-gap addition (the same shape `justify` uses for the main
 * axis) and, for `stretch`, an amount every line GROWS by. Anything unrecognised
 * — including the absent value — is `start`, so an author who never writes
 * `alignContent` gets the pre-existing top/left stack.
 */
function alignContentPlan(
  value: AutoLayout["alignContent"],
  free: number,
  count: number
): { offset: number; extraGap: number; growPerLine: number } {
  if (value === "center") return { offset: free / 2, extraGap: 0, growPerLine: 0 };
  if (value === "end") return { offset: free, extraGap: 0, growPerLine: 0 };
  if (value === "stretch" && count > 0) return { offset: 0, extraGap: 0, growPerLine: free / count };
  if (value === "space-between") {
    return { offset: 0, extraGap: count > 1 ? free / (count - 1) : 0, growPerLine: 0 };
  }
  if (value === "space-around" && count > 0) {
    const per = free / count;
    return { offset: per / 2, extraGap: per, growPerLine: 0 };
  }
  if (value === "space-evenly" && count > 0) {
    const per = free / (count + 1);
    return { offset: per, extraGap: per, growPerLine: 0 };
  }
  return { offset: 0, extraGap: 0, growPerLine: 0 };
}

/**
 * Which reason, if any, `align-content` has nothing to act on.
 *
 * The engine already knows: a hugging cross axis is sized by its own lines and a
 * single line has nothing to divide, so both leave `freeCross` at 0 and the
 * control cannot be seen to move. The inspector asks this instead of re-deriving
 * the lines from stored coordinates — a second derivation disagrees with this
 * pass on any child whose envelope is not its stored box (a turned child is the
 * common case), which shows up as a control that is enabled and inert.
 */
export type FlexCrossAlignReason = "hug" | "one-line" | "no-room";

export function flexCrossAlignReason(frame: FrameElement): FlexCrossAlignReason | null {
  const layout = layoutOf(frame);
  if (!layout || layout.mode !== "flex" || layout.wrap !== "wrap") return null;
  const isRow = layout.direction === "row";
  const crossAxis: SizingAxis = isRow ? "height" : "width";
  if (hugsAxis(frame, crossAxis)) return "hug";

  const columnGap = layout.columnGap ?? layout.gap ?? 0;
  const rowGap = layout.rowGap ?? layout.gap ?? 0;
  const crossGap = isRow ? rowGap : columnGap;

  const [pt, pr, pb, pl] = resolvePadding(layout.padding);
  const availableCross = isRow
    ? Math.max(0, frame.height - pt - pb)
    : Math.max(0, frame.width - pl - pr);

  // What a child covers across the axis the lines stack on, margin included —
  // the same outer number `applyFlexLayout` adds up into `lineCrossSizes`.
  const outerCrossOf = (child: DesignElement) => {
    const box = childBox(child);
    const m = resolveMargin(child.margin);
    return (isRow ? box.height : box.width) + (isRow ? m.top + m.bottom : m.left + m.right);
  };
  const crossStartOf = (child: DesignElement) => (isRow ? child.y : child.x);

  // A line is a run of children whose cross extents overlap — the same grouping
  // `groupFlexLines` gives the canvas overlay, read off the coordinates the last
  // pass placed. A child that has not been placed yet groups by its stored box,
  // which is the best answer available before a pass has run.
  const children = inFlowChildren(frame.children ?? []);
  const lineEnds: number[] = [];
  const lineSizes: number[] = [];
  for (const child of children) {
    const start = crossStartOf(child);
    const outer = outerCrossOf(child);
    const last = lineEnds.length - 1;
    if (last < 0 || start >= lineEnds[last] - 0.01) {
      lineEnds.push(start + outer);
      lineSizes.push(outer);
    } else {
      lineEnds[last] = Math.max(lineEnds[last], start + outer);
      lineSizes[last] = Math.max(lineSizes[last], outer);
    }
  }

  if (lineSizes.length < 2) return "one-line";

  const totalLinesCross =
    lineSizes.reduce((a, b) => a + b, 0) + Math.max(0, lineSizes.length - 1) * crossGap;
  return availableCross - totalLinesCross < 0.5 ? "no-room" : null;
}


export function applyFlexLayout(
  frameEl: FrameElement,
  children: DesignElement[],
  resolveChild?: ChildSizeResolver
): FrameElement {
  const layout = layoutOf(frameEl)!;
  const isRow = layout.direction === "row";
  const columnGap = layout.columnGap ?? layout.gap ?? 0;
  const rowGap = layout.rowGap ?? layout.gap ?? 0;
  // A row lays items along x, so the gap BETWEEN ITEMS is the column gap and the
  // gap between wrapped LINES is the row gap; a column swaps the two — how CSS
  // maps `column-gap` / `row-gap` onto the two flex axes.
  const mainGap = isRow ? columnGap : rowGap;
  const crossGap = isRow ? rowGap : columnGap;
  const isWrap = layout.wrap === "wrap";

  const [pt, pr, pb, pl] = resolvePadding(layout.padding);

  const contentStartX = pl;
  const contentStartY = pt;
  const availableMain = isRow
    ? Math.max(0, frameEl.width - pl - pr)
    : Math.max(0, frameEl.height - pt - pb);
  const availableCross = isRow
    ? Math.max(0, frameEl.height - pt - pb)
    : Math.max(0, frameEl.width - pl - pr);

  const mainAxis: SizingAxis = isRow ? "width" : "height";
  const crossAxis: SizingAxis = isRow ? "height" : "width";

  // A hug axis is being recomputed by this very pass, so it cannot also be the
  // constraint children are measured against — that is the cycle that made the
  // pipeline non-idempotent. `fill` distribution still uses the real extent.
  const hugMain = hugsAxis(frameEl, mainAxis);
  const hugCross = hugsAxis(frameEl, crossAxis);
  const mainLimit = hugMain ? Infinity : availableMain;
  const crossLimit = hugCross ? Infinity : availableCross;

  interface LineItem {
    child: DesignElement;
    baseMainSize: number;
    baseCrossSize: number;
    mainStart: number;
    mainEnd: number;
    crossStart: number;
    crossEnd: number;
  }

  /**
   * A child's margin resolved onto the axes this pass works in. Signed, and not
   * clamped: a negative margin is how CSS pulls a child back over its neighbour.
   */
  const marginAxes = (child: DesignElement) => {
    const m = resolveMargin(child.margin);
    return isRow
      ? { mainStart: m.left, mainEnd: m.right, crossStart: m.top, crossEnd: m.bottom }
      : { mainStart: m.top, mainEnd: m.bottom, crossStart: m.left, crossEnd: m.right };
  };

  /**
   * The envelope an item covers, read on the pass's own two axes.
   *
   * Both sizes go in because a turn reads both — they trade into each other — so
   * a child measured on one axis alone would reserve an extent the painted
   * envelope disagrees with.
   *
   * `push` is the second half of the same question: the pass decides where the
   * ENVELOPE goes, and the anchor the document stores sits that far back from its
   * near edge. A box's anchor is half the overhang in; a line's is wherever its
   * turned segment happens to start.
   */
  const envelope = (item: LineItem, main: number, cross: number) => {
    const env = isRow
      ? envelopeOf(item.child, main, cross)
      : envelopeOf(item.child, cross, main);
    return {
      main: isRow ? env.width : env.height,
      cross: isRow ? env.height : env.width,
      mainPush: isRow ? -env.left : -env.top,
      crossPush: isRow ? -env.top : -env.left
    };
  };

  /** A share is a share of the envelope, not of the box. */
  const mainForExtent = (item: LineItem, extent: number, cross: number) =>
    sizeForEnvelope(item.child, extent, cross, item.baseMainSize);

  // What the child consumes in the line, margin included. Everything that adds
  // up along an axis — line breaking, free space, a hug extent — has to use the
  // outer number, or the margin is space nobody reserved.
  const outerMain = (item: LineItem, main = item.baseMainSize, cross = item.baseCrossSize) =>
    item.mainStart + envelope(item, main, cross).main + item.mainEnd;
  const outerCross = (item: LineItem, main = item.baseMainSize, cross = item.baseCrossSize) =>
    item.crossStart + envelope(item, main, cross).cross + item.crossEnd;

  // Group children into lines (single line if not wrap)
  const lines: LineItem[][] = [];
  let currentLine: LineItem[] = [];
  let currentLineAccumulated = 0;

  for (const child of children) {
    const box = childBox(child, resolveChild);
    // `childMainSize` measures a text child and defers to `childBox` for
    // everything else, so it has to be called on BOTH axes. Reading `box.width`
    // here instead would skip the text measurement and place a `max-content`
    // label at its stored width — the exact bug `childBox` exists to fix.
    const baseMain = childMainSize(child, frameEl, isRow, mainLimit, crossLimit, resolveChild);
    let baseCross = isRow ? box.height : box.width;
    if (child.type === "text") {
      const crossMode = resolveAxis(child, frameEl, crossAxis);
      const crossSpec = textSpec(child.style, (child as TextElement).spans);
      if (crossMode === "max-content") {
        baseCross = measureText(child.content, crossSpec, Infinity).width;
      } else if (crossMode === "fit-content") {
        baseCross = isRow
          ? measureText(child.content, crossSpec, baseMain).height
          : measureText(child.content, crossSpec, crossLimit).width;
      }
    }
    const item: LineItem = {
      child,
      // A bound is read HERE rather than at placement, because everything that
      // adds up along an axis — line breaking, free space, a hug extent — has to
      // be adding up the size the child will actually be given.
      baseMainSize: clampAxis(child, mainAxis, baseMain),
      baseCrossSize: clampAxis(child, crossAxis, baseCross),
      ...marginAxes(child)
    };

    if (!isWrap) {
      currentLine.push(item);
    } else {
      // A `fill` child is asking for the leftovers, so it has no intrinsic claim
      // on the main axis and must not be the thing that forces a line break —
      // otherwise the break is decided by a size it never keeps (it is stretched
      // right after), and the two disagree. Its MARGIN still takes room: that is
      // space it keeps whatever the flex pass decides about its size.
      const breakMain = isFillAxis(child, frameEl, mainAxis)
        ? item.mainStart + item.mainEnd
        : outerMain(item);
      const addedGap = currentLine.length > 0 ? mainGap : 0;
      if (currentLine.length > 0 && currentLineAccumulated + addedGap + breakMain > mainLimit) {
        lines.push(currentLine);
        currentLine = [item];
        currentLineAccumulated = breakMain;
      } else {
        currentLine.push(item);
        currentLineAccumulated += addedGap + breakMain;
      }
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  // Each line's cross size, before placement, so `align-content` can distribute
  // the slack between the lines. A hugging cross axis is sized by the line's own
  // content; an unwrapped line fills the whole cross extent and leaves no slack.
  const lineCrossSizes = lines.map((line) =>
    isWrap || hugCross
      ? maxFrom(line.map((item) => outerCross(item)), 0)
      : availableCross
  );
  const totalLinesCross =
    lineCrossSizes.reduce((a, b) => a + b, 0) + Math.max(0, lines.length - 1) * crossGap;
  const freeCross = hugCross ? 0 : Math.max(0, availableCross - totalLinesCross);
  const alignContent = alignContentPlan(layout.alignContent, freeCross, lines.length);

  // Second pass: layout each line
  let lineCrossStart = alignContent.offset;
  const laidOutChildren: DesignElement[] = [];
  const lineMetrics: { main: number; cross: number }[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fillItems = line.filter((item) => isFillAxis(item.child, frameEl, mainAxis));
    const nonFillOuterTotal = line
      .filter((item) => !isFillAxis(item.child, frameEl, mainAxis))
      .reduce((acc, item) => acc + outerMain(item), 0);
    const lineGaps = Math.max(0, line.length - 1) * mainGap;
    // Free space is measured against OUTER boxes, so a `fill` child's own margin
    // is subtracted here rather than left inside the share it is about to be
    // given — otherwise a flexible item with a margin overruns the container by
    // exactly that margin.
    const fillMarginTotal = fillItems.reduce((acc, item) => acc + item.mainStart + item.mainEnd, 0);
    const remainingMain = Math.max(0, availableMain - nonFillOuterTotal - fillMarginTotal - lineGaps);

    // Each `fill` child claims the leftover in proportion to its `flexGrow`; an
    // absent grow is 1, so the equal split every existing document was drawn with
    // is exactly what this reduces to. The sub-hundredth remainder is given to the
    // first fill so the line still ends flush.
    const growOf = (item: LineItem): number =>
      item.child["flex-grow"] && item.child["flex-grow"] > 0 ? item.child["flex-grow"] : 1;
    const totalGrow = fillItems.reduce((acc, item) => acc + growOf(item), 0);
    /* A bounded `fill` child takes its share and no more, and what it does not
       take goes back to the ones that can still grow — which is what CSS does
       with a flex base clamped by `max-width`, and why a limited-line-width block
       does not shove its neighbour out of the container. */
    const fillShares = fillItems.map((item) =>
      totalGrow > 0 ? Math.max(0, round2((remainingMain * growOf(item)) / totalGrow)) : 0
    );
    if (fillShares.length > 0) {
      const assigned = fillShares.reduce((a, b) => a + b, 0);
      fillShares[0] = round2(fillShares[0] + (remainingMain - assigned));
    }
    /**
     * ENVELOPE sizes, not box sizes, because the free space they spend was
     * measured in envelopes. A bounded `fill` child is held inside its bound
     * first: a bound is about the size the child is GIVEN, so it has to be made
     * in box units and then turned back into the envelope that size covers.
     */
    const fillSizes = fillShares.map((share, i) => {
      const item = fillItems[i];
      const size = clampAxis(item.child, mainAxis, mainForExtent(item, share, item.baseCrossSize));
      return envelope(item, size, item.baseCrossSize).main;
    });
    const surplus = remainingMain - fillSizes.reduce((a, b) => a + b, 0);
    if (surplus > 0.01) {
      // A child that took its whole share can still take more; one that was held
      // back by a bound cannot, which is the whole difference between them.
      const open = fillSizes.filter((size, i) => size >= fillShares[i] - 0.01).length;
      if (open > 0) {
        const extra = round2(surplus / open);
        for (let i = 0; i < fillSizes.length; i++) {
          if (fillSizes[i] >= fillShares[i] - 0.01) fillSizes[i] = round2(fillSizes[i] + extra);
        }
      }
    }

    // `availableMain` is the frame's current extent, and on a hugging main axis
    // that is the very value this pass is about to replace — distributing against
    // it pins the line to a box that will no longer exist (children ended up past
    // the frame's far edge). A `fill` child already consumed the remainder, so
    // there is nothing left for justify to hand out in either case.
    let freeMain = fillItems.length > 0 || hugMain ? 0 : remainingMain;
    let currentMain = 0;
    let extraGap = 0;

    if (layout.justify === "center") {
      currentMain = freeMain / 2;
    } else if (layout.justify === "end") {
      currentMain = freeMain;
    } else if (layout.justify === "space-between" && line.length > 1) {
      extraGap = freeMain / (line.length - 1);
    } else if (layout.justify === "space-around" && line.length > 0) {
      const perItem = freeMain / line.length;
      extraGap = perItem;
      currentMain = perItem / 2;
    } else if (layout.justify === "space-evenly" && line.length > 0) {
      // n items need n+1 equal gaps, and the outer two are full gaps rather than
      // the half gaps `space-around` leaves at the ends — that difference is the
      // whole reason the mode exists.
      const perGap = freeMain / (line.length + 1);
      extraGap = perGap;
      currentMain = perGap;
    }

    // Sizes were resolved before the loop so `align-content` could distribute the
    // slack between the lines; a hugging cross axis is sized by the line's own
    // content, margins included, not by the stale box.
    const lineCrossSize = lineCrossSizes[lineIndex] + alignContent.growPerLine;

    let lineMainExtent = 0;
    let lineCrossExtent = 0;

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      const { child, baseMainSize, baseCrossSize, mainStart, mainEnd, crossStart, crossEnd } = item;
      const isFillMain = isFillAxis(child, frameEl, mainAxis);
      // A child may override the container's cross-axis alignment for itself.
      // `stretch` is the one value that decides the child's SIZE rather than its
      // offset, so it joins the `fill` test instead of the offset branch — but
      // only for an axis the child left unsaid: a written-down `"fixed"` is the
      // one declaration a stretch cannot override, here as in a grid cell.
      const align = alignSelfOf(child) ?? layout.align ?? DEFAULT_FLEX_ALIGN;
      // Stretch fills what the child left UNSAID — the same test the grid cell
      // applies. A resolved `max-content` (or `fit-content`) is the author
      // saying "measure me from my content", and stretching it would make that
      // statement false: the text was told not to wrap, so it overflows its box
      // and that overflow is reported rather than silently wrapped away.
      const isFillCross =
        isFillAxis(child, frameEl, crossAxis) ||
        (align === "stretch" &&
          resolveAxis(child, frameEl, crossAxis) === "fixed" &&
          !axisIsPinned(child, crossAxis));

      const finalMainSize = isFillMain
        ? mainForExtent(item, fillSizes[fillItems.indexOf(item)], baseCrossSize)
        : baseMainSize;

      // A stretched child fills the line with its ENVELOPE, not with its box, so
      // the size it is given is that solved for the cross — at an unturned child
      // the plain subtraction it always was.
      const stretchTo = (isWrap || hugCross ? lineCrossSize : availableCross) - crossStart - crossEnd;
      const finalCrossSize = isFillCross
        ? Math.max(0, sizeForEnvelope(child, stretchTo, finalMainSize, baseCrossSize))
        : childCrossSize(child, frameEl, isRow, finalMainSize, crossLimit, baseCrossSize, resolveChild);

      const env = envelope(item, finalMainSize, finalCrossSize);
      const extentMain = env.main;
      const outer = crossStart + env.cross + crossEnd;
      let crossOffset = 0;
      if (!isFillCross) {
        if (align === "center") {
          crossOffset = (lineCrossSize - outer) / 2;
        } else if (align === "end") {
          crossOffset = lineCrossSize - outer;
        }
      }

      /**
       * The pass computed a slot for the ENVELOPE, and `env.push` is what turns
       * that into a position for the anchor the document actually stores — the
       * two are not the same point once the element is turned. Without it the
       * envelope hangs off the slot and over the neighbour the pass just moved
       * aside.
       */
      const childX = isRow
        ? contentStartX + currentMain + mainStart + env.mainPush
        : contentStartX + lineCrossStart + crossOffset + crossStart + env.crossPush;
      const childY = isRow
        ? contentStartY + lineCrossStart + crossOffset + crossStart + env.crossPush
        : contentStartY + currentMain + mainStart + env.mainPush;

      const outerNow = mainStart + extentMain + mainEnd;
      currentMain += outerNow + mainGap + extraGap;
      lineMainExtent += outerNow + (i > 0 ? mainGap : 0);
      lineCrossExtent = Math.max(lineCrossExtent, outer);

      laidOutChildren.push(
        placeChildAt(
          child,
          childX,
          childY,
          clampAxis(child, "width", isRow ? finalMainSize : finalCrossSize),
          clampAxis(child, "height", isRow ? finalCrossSize : finalMainSize)
        )
      );
    }

    lineCrossStart += lineCrossSize + crossGap + alignContent.extraGap;
    lineMetrics.push({ main: lineMainExtent, cross: lineCrossExtent });
  }

  let finalWidth = frameEl.width;
  let finalHeight = frameEl.height;

  // Frame self-hug: only the axes that declare `fit-content` tighten. A `fill`
  // axis keeps whatever the parent's pass assigned, which is what the Inspector
  // already shows for it.
  //
  // Extents come from the boxes that were actually placed, not from the
  // pre-distribution estimates — a `fill` child's size only exists afterwards.
  const hugWidth = hugsAxis(frameEl, "width");
  const hugHeight = hugsAxis(frameEl, "height");
  if ((hugWidth || hugHeight) && lineMetrics.length > 0) {
    const totalLineGaps = Math.max(0, lineMetrics.length - 1) * crossGap;
    const maxLineMain = maxFrom(lineMetrics.map((m) => m.main));
    const totalLineCross = lineMetrics.reduce((acc, m) => acc + m.cross, 0) + totalLineGaps;

    if (isRow) {
      if (hugWidth) finalWidth = round2(clampAxis(frameEl, "width", maxLineMain + pl + pr));
      if (hugHeight) finalHeight = round2(clampAxis(frameEl, "height", totalLineCross + pt + pb));
    } else {
      if (hugHeight) finalHeight = round2(clampAxis(frameEl, "height", maxLineMain + pt + pb));
      if (hugWidth) finalWidth = round2(clampAxis(frameEl, "width", totalLineCross + pl + pr));
    }
  }

  return {
    ...frameEl,
    width: finalWidth,
    height: finalHeight,
    children: laidOutChildren
  };
}
