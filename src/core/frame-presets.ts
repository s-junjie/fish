/**
 * The sizes a designer means when they say "a phone" or "a desktop".
 *
 * Figma's list, cut down to one entry per size someone actually picks and to the
 * four boards this tool is asked to make. A preset is only ever a STARTING SIZE:
 * the frame it creates is an ordinary frame with nothing marking it as a preset,
 * so the list can grow without touching the model.
 *
 * `nameKey` rather than a literal because the same string is both the row's
 * label and the layer's name, and both are read by a person.
 */

export type FramePresetGroup = "phone" | "tablet" | "desktop" | "presentation";

export const FRAME_PRESET_GROUPS: readonly FramePresetGroup[] = [
  "phone",
  "tablet",
  "desktop",
  "presentation"
];

export interface FramePreset {
  id: string;
  /** `frame.presets.name.*` — the row label and the created layer's name. */
  nameKey: string;
  width: number;
  height: number;
  group: FramePresetGroup;
}

/**
 * Portrait before landscape inside a group, largest device first — the order the
 * list is read in, not the order the devices came out.
 */
const RAW_PRESETS: readonly [string, string, number, number, number][] = [
  ["iphone-17-pro-max", "iphone17ProMax", 440, 956, 0],
  ["iphone-17-pro", "iphone17Pro", 402, 874, 0],
  ["iphone-air", "iphoneAir", 420, 912, 0],
  ["iphone-se", "iphoneSe", 375, 667, 0],
  ["ipad-pro-13", "ipadPro13", 1024, 1366, 1],
  ["ipad-pro-11", "ipadPro11", 834, 1194, 1],
  ["ipad-mini", "ipadMini", 744, 1133, 1],
  ["desktop", "desktop", 1440, 1024, 2],
  ["macbook-pro-16", "macbookPro16", 1728, 1117, 2],
  ["macbook-pro-14", "macbookPro14", 1512, 982, 2],
  ["slide-16-9", "slide16x9", 1920, 1080, 3],
  ["slide-4-3", "slide4x3", 1024, 768, 3]
];

export const FRAME_PRESETS: readonly FramePreset[] = RAW_PRESETS.map(([id, name, width, height, g]) => ({
  id,
  nameKey: `frame.presets.name.${name}`,
  width,
  height,
  group: FRAME_PRESET_GROUPS[g]
}));

import { DesignElement } from "./dsl/types";
import { elementAABB } from "./geometry/element-bounds";

export const FRAME_PLACEMENT_GAP = 80;

export function placeFrameOutsideSiblings(
  desired: { x: number; y: number },
  size: { width: number; height: number },
  siblings: readonly DesignElement[]
): { x: number; y: number } {
  const boxes = siblings.map(elementAABB);
  let x = Math.round(desired.x), y = Math.round(desired.y);

  for (let step = 0; step < 8; step++) {
    const blocked = boxes.filter(
      (b) => b.x < x + size.width && b.x + b.width > x && b.y < y + size.height && b.y + b.height > y
    );
    if (!blocked.length) break;
    x = Math.round(Math.max(...blocked.map((b) => b.x + b.width)) + FRAME_PLACEMENT_GAP);
  }

  return { x, y };
}
