import { DesignElement, Stroke } from "../../core/dsl/types";
import { InstanceBox } from "../../core/interactions/instance-inherit";

/**
 * An element's paint box in its own units: the resolved instance box when it
 * has one, else the element's stored width/height, floored at 1 so a def never
 * divides by zero or emits a NaN attribute.
 */
export function boxSize(el: DesignElement, box: InstanceBox | null): { w: number; h: number } {
  return {
    w: Math.max(1, box ? box.width : el.width || 1),
    h: Math.max(1, box ? box.height : el.height || 1)
  };
}

/**
 * An element's stroke layers as a def should read them: the resolved box's when
 * it has one (an instance inherits its master's), else the element's own list.
 */
export function elementStrokes(el: DesignElement, box: InstanceBox | null): Stroke[] {
  return box ? box.strokes : ((el as any).strokes || []) as Stroke[];
}
