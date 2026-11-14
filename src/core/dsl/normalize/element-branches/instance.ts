import { OVERRIDABLE_PROPERTIES } from "../../constants";
import { asBoolean, asNumber, isPlainObject, normalizeOverflow, normalizeScrollOffset } from "../shared";
import { normalizeFillStack } from "../paint";
import { applyNormalizedBorderRadius, normalizeStrokes } from "../stroke";
import type { ElementBranch } from "./shared";

export const normalizeInstance: ElementBranch = ({ el, base, sizing, path, repairs, box }) => {
  base.componentId = typeof el.componentId === "string" ? el.componentId : "";
  if (Array.isArray(el.overrides)) {
    // The shared list, not a copy: this filter is the only thing standing
    // between a stored override and the bin, so a list that lags behind the
    // union deletes the difference on every load. A deletion the author cannot
    // see is the same defect the filter exists to prevent, so every one of them
    // is named — a dropped value is a repair, not a cleanup.
    base.overrides = el.overrides.filter((ov: any, index: number) => {
      const target = typeof ov?.targetId === "string" ? ov.targetId : null;
      const property = String(ov?.property);
      if (!isPlainObject(ov) || target === null) {
        repairs.push({
          kind: "dropped-property",
          path: `${path}/overrides/${index}`,
          message: `override ${JSON.stringify(ov)} has no targetId; dropped`
        });
        return false;
      }
      if (!(OVERRIDABLE_PROPERTIES as readonly string[]).includes(property)) {
        repairs.push({
          kind: "dropped-property",
          path: `${path}/overrides/${index}/property`,
          message: `override property ${JSON.stringify(ov.property)} on "${target}" is not one of ${OVERRIDABLE_PROPERTIES.length} overridable properties; dropped`
        });
        return false;
      }
      return true;
    });
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
  applyNormalizedBorderRadius(el, base, sizing, path, repairs, box);
  // Nothing at all when the master's is inherited — an instance stores only what
  // it OWNS, so an `overflow` here always means the instance overrides it.
  Object.assign(base, normalizeOverflow(el, path, repairs));
  const instSx = normalizeScrollOffset(el.scrollX ?? el.scrollLeft ?? el["scroll-x"] ?? el["scroll-left"]);
  if (instSx !== undefined && instSx > 0) base.scrollX = instSx;
  const instSy = normalizeScrollOffset(el.scrollY ?? el.scrollTop ?? el["scroll-y"] ?? el["scroll-top"]);
  if (instSy !== undefined && instSy > 0) base.scrollY = instSy;
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

  // A guide is geometry, and an instance's geometry belongs to its master — the
  // same reason it stores no auto-layout of its own. Reported rather than kept:
  // a stored array would draw bands the instance cannot honour, and a silently
  // ignored one is a ruler the author thinks they placed.
  if (el.layoutGuides !== undefined || el["layout-guides"] !== undefined) {
    repairs.push({
      kind: "layout",
      path: `${path}/layoutGuides`,
      message:
        "instance cannot carry layout guides: they belong to the master. Drawn on the master; not projected into instances yet."
    });
  }
};
