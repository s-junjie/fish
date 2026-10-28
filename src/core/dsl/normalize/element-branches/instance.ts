import { OVERRIDABLE_PROPERTIES } from "../../types";
import { asBoolean, asNumber, isPlainObject, normalizeClipContent } from "../shared";
import { normalizeFillStack } from "../paint";
import { cornerRadiusInput, normalizeCornerRadius, normalizeStrokes } from "../stroke";
import type { ElementBranch } from "./shared";

export const normalizeInstance: ElementBranch = ({ el, base, path, repairs, box }) => {
  base.componentId = typeof el.componentId === "string" ? el.componentId : "";
  if (Array.isArray(el.overrides)) {
    // The shared list, not a copy: this filter is the only thing standing
    // between a stored override and the bin, so a list that lags behind the
    // union deletes the difference on every load.
    base.overrides = el.overrides.filter((ov: any) =>
      isPlainObject(ov) &&
      typeof ov.targetId === "string" &&
      (OVERRIDABLE_PROPERTIES as readonly string[]).includes(String(ov.property))
    );
  }

  // An instance's own paint stack is an OVERRIDE, not a definition: an
  // explicit empty array means "paint nothing" and must survive, while an
  // ABSENT key is what inherits from the master. Frames drop an empty stack
  // (a fill-less rect/frame is an authoring mistake); an instance must not,
  // or removing the last fill comes back on the next load.
  if (el.fills !== undefined) {
    base.fills = normalizeFillStack(el, path, repairs) || [];
  }
  if (el.strokes !== undefined) {
    // An instance's stack is an OVERRIDE, not a definition: an explicit empty
    // array means "no stroke" and must survive, while an ABSENT key is what
    // inherits from the master.
    base.strokes = normalizeStrokes(el, path, repairs) || [];
  }
  // Same presence rule for effects: `effects: []` on an instance means "no
  // effects" and suppresses the master's. The shared pass above drops an
  // empty array (harmless on a frame, which inherits nothing), so an instance
  // that came back from a reload would silently re-gain the master's shadow.
  if (Array.isArray(el.effects) && base.effects === undefined) base.effects = [];
  const instRadius = normalizeCornerRadius(cornerRadiusInput(el), path, repairs, box);
  if (instRadius !== undefined) base.borderRadius = instRadius;
  const instClip = normalizeClipContent(el, path, repairs);
  if (instClip !== undefined) base.clipContent = instClip;
  // A hand-set box: without this the flag is lost on save, and the instance
  // would snap back to its master's size on the next master resize.
  if (asBoolean(el.sizeOverride) === true) base.sizeOverride = true;
  // A proportional scale has to survive the load, or a saved document paints its
  // instance 1x inside a box the master never had. 1:1 is stored as ABSENT — the
  // field means "scaled", and a pair of ones says nothing a missing key does not.
  const scale = el.instanceScale;
  if (isPlainObject(scale)) {
    const x = asNumber((scale as Record<string, unknown>).x);
    const y = asNumber((scale as Record<string, unknown>).y);
    if (x !== undefined && y !== undefined && x > 0 && y > 0 && (x !== 1 || y !== 1)) {
      base.instanceScale = { x, y };
    }
  }
};
