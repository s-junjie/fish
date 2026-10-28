import { getActivePage, type DesignDocument, type DesignElement, type Effect, type InstanceElement } from "../../core/dsl/types";
import { elementAABB } from "../../core/geometry/element-bounds";
import { transformBoundsToAABB, type Rect } from "../../core/geometry/bounds";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { resolveInstanceBox } from "../../core/interactions/instance-inherit";
import { worldMatrixOf } from "../../core/interactions/component-swap";
import { measureElement } from "../../core/measure";
import { dropShadowReach } from "../canvas/shadow-lod";
import type { ExportBounds } from "../../core/export";

/**
 * What the Export button crops to.
 *
 * Every box has to be in canvas coordinates. `elementAABB` alone is
 * parent-LOCAL, and an element's own `x`/`y` is the distance from its parent —
 * so exporting one nested layer without the ancestor origin chain cropped a
 * region at the top-left of the page instead of the layer the user selected. The
 * multi-selection path had the origin; the single-selection path did not.
 *
 * And the origin alone is not enough either: the chain has to be the one the
 * renderer draws, rotations included, or a layer inside a turned frame exports
 * from the place the frame was before it was turned.
 *
 * Nor is the geometry box the whole painted extent: an effect reaches past it,
 * and the crop IS the export viewBox — so the box grows by the effect's reach,
 * the way it already grows by a tilt's projected quad.
 */
export function exportBounds(
  doc: DesignDocument,
  selected: readonly DesignElement[]
): ExportBounds {
  if (selected.length === 0) {
    const canvas = getActivePage(doc).canvas || doc.canvas;
    return {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(canvas.width ?? 1080)),
      height: Math.max(1, Math.round(canvas.height ?? 1080))
    };
  }

  const boxes = selected
    .map((el) => measureElement(doc, el.id) ?? localBoxOf(doc, el))
    .map((b) => ({
      minX: b.x,
      minY: b.y,
      maxX: b.x + b.width,
      maxY: b.y + b.height
    }));

  // A perspective tilt paints OUTSIDE the flat box — the near edge projects
  // wider than the stored geometry, which is the whole point of the effect —
  // so a tilted layer's crop grows to the projected quad. The projection is
  // in the element's own box space and the measured box above is in canvas
  // space; the flat box's centre is the same point in both (the tilt pivots
  // there and no ancestor turns the PIVOT's offset), so the projected excess
  // applies around the measured centre.
  for (const [i, el] of selected.entries()) {
    const b = boxes[i];
    // An effect paints OUTSIDE the flat box too, and the crop is the flat box:
    // a drop shadow's blur and offset reach past the silhouette it is cast
    // from, so the export viewBox cut every shadowed frame's shadow off at
    // the frame's own edge. Figma grows the export to the paint; the growth
    // is the reach the canvas already decides shadow visibility with, so a
    // shadow worth painting on screen is worth cropping to on export.
    const reach = effectsReach(doc, el);
    if (reach > 0) {
      b.minX -= reach;
      b.maxX += reach;
      b.minY -= reach;
      b.maxY += reach;
    }
    if (!el.rotateX && !el.rotateY) continue;
    const tilt = tiltProjectedSize(el);
    if (!tilt) continue;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    b.minX = Math.min(b.minX, cx - tilt.w / 2);
    b.maxX = Math.max(b.maxX, cx + tilt.w / 2);
    b.minY = Math.min(b.minY, cy - tilt.h / 2);
    b.maxY = Math.max(b.maxY, cy + tilt.h / 2);
  }

  const minX = Math.min(...boxes.map((b) => b.minX));
  const minY = Math.min(...boxes.map((b) => b.minY));
  const maxX = Math.max(...boxes.map((b) => b.maxX));
  const maxY = Math.max(...boxes.map((b) => b.maxY));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.round(maxX - minX)),
    height: Math.max(1, Math.round(maxY - minY))
  };
}

/**
 * The effects an element PAINTS with — which for an instance is not the list
 * on the node. `resolveInstanceBox` folds the master's effects in, and the
 * export keeps that resolution: an instance that declares no effects of its
 * own exports its master's shadow, so the crop has to see it too.
 */
function paintedEffects(doc: DesignDocument, el: DesignElement): Effect[] {
  if (el.type !== "instance") return el.effects ?? [];
  const master = el.componentId ? findMasterComponent(doc, el.componentId) : null;
  return master ? resolveInstanceBox(el as InstanceElement, master).effects : el.effects ?? [];
}

/**
 * How far past its own box the element's own paint reaches, in the element's
 * units.
 *
 * `dropShadowReach` is the canvas's own number for a shadow's reach — the one
 * `applyShadowLod` decides visibility with — and `blur * 3` is the pad
 * `computeFilterRegion` gives a layer blur, so the crop and the paint agree
 * by construction instead of by two spellings of the same blur. An inner
 * shadow's RESULT is inside the box (only its intermediates are not), and a
 * backdrop effect paints nothing of its own, so neither grows the crop.
 */
function effectsReach(doc: DesignDocument, el: DesignElement): number {
  let reach = 0;
  for (const ef of paintedEffects(doc, el)) {
    if (!ef || ef.enabled === false) continue;
    if (ef.type === "drop-shadow") {
      reach = Math.max(reach, dropShadowReach(ef));
    } else if (ef.type === "layer-blur") {
      reach = Math.max(reach, Math.max(0, ef.blur ?? 0) * 3);
    }
  }
  return reach;
}

/**
 * The projected quad's canvas size for one tilted element, in its own box
 * space — the same math the tilt wrapper paints and `export-tilt` bakes.
 * Null when the tilt projects to nothing usable (view distance hit).
 */
function tiltProjectedSize(el: DesignElement): { w: number; h: number } | null {
  const rx = ((el.rotateX || 0) * Math.PI) / 180;
  const ry = ((el.rotateY || 0) * Math.PI) / 180;
  if (!el.rotateX && !el.rotateY) return null;
  const d = el.perspective && el.perspective > 0 ? el.perspective : 800;
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const project = (lx: number, ly: number): [number, number] | null => {
    const x1 = lx * cosY;
    const z1 = -lx * sinY;
    const y1 = ly * cosX - z1 * sinX;
    const z2 = ly * sinX + z1 * cosX;
    const denom = d - z2;
    if (denom < 1) return null;
    const s = d / denom;
    return [x1 * s, y1 * s];
  };
  const hw = Math.max(1, el.width) / 2;
  const hh = Math.max(1, el.height) / 2;
  const corners = [
    project(-hw, -hh), project(hw, -hh), project(hw, hh), project(-hw, hh)
  ];
  if (corners.some((p) => p === null || !isFinite(p[0]) || !isFinite(p[1]))) return null;
  const xs = corners.map((p) => p![0]);
  const ys = corners.map((p) => p![1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * An id the measure walk cannot reach (a detached, mid-edit node) still has a box.
 *
 * The four corners go through the world matrix rather than having an origin
 * added, so this agrees with `measureDocument` on where a turned node paints
 * instead of disagreeing with it.
 */
function localBoxOf(doc: DesignDocument, el: DesignElement): Rect {
  return transformBoundsToAABB(elementAABB(el), worldMatrixOf(doc, el))!;
}
