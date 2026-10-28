import type { ContainerElement, DesignElement, FrameElement } from "../dsl/types";
import { resizeContainerWithConstraints } from "../geometry/constraints";
import { applyAutoLayout } from "./auto-layout";

/**
 * Resize a stack, which is two passes rather than one.
 *
 * `applyAutoLayout` places the in-flow children and re-interleaves them into their
 * authored array slots, which leaves every other child exactly where it was —
 * including the ones that left the flow, whose whole job is to follow the box.
 * `resizeContainerWithConstraints` is the pass that moves them.
 *
 * A resize gesture therefore has to run both, or an absolute child pinned to the
 * right edge will follow a width typed into the inspector and stand still while
 * the handle is dragged. The two passes are independent: the layout pass
 * preserves what it does not place, so the pinned children survive either order.
 * Constraints run first because that is the order the free-frame path reads in.
 *
 * Both passes are measured from `from` / `dragStart`, never from the box the
 * previous animation frame left behind: re-measuring an already-adjusted child
 * against the live tree accumulates drift on every frame of the drag.
 */
export function resizeStackWithPins(
  updated: DesignElement,
  dragStart: ContainerElement,
  from: { width: number; height: number },
  to: { width: number; height: number }
): DesignElement {
  const pinned = resizeContainerWithConstraints(dragStart, from, to);
  const withPins = pinned.children ? { ...updated, children: pinned.children } : updated;
  return applyAutoLayout(withPins as FrameElement);
}
