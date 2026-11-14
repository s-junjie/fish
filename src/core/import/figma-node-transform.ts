import { readAffine } from "../geometry/affine";
import type { FigmaGap, FigmaNode, Rect } from "./figma-types";

export const deg = (radians: number): number => (radians * 180) / Math.PI;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function normalizeDeg(value: number): number {
  return ((value % 360) + 360) % 360;
}

export interface FigmaTransformFields {
  rotation: number;
  skewX?: number;
  skewY?: number;
}

export interface NodeTransform {
  flipY: boolean;
  fields: FigmaTransformFields | undefined;
  rotation: number | undefined;
  rotated: boolean;
  matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number } | null;
}

/** Figma's `rotation` is CCW while the DSL/SVG `rotate()` is CW on a y-down canvas. */
export function declaredRotationDeg(node: FigmaNode): number | undefined {
  return typeof node.rotation === "number" ? -node.rotation : undefined;
}

/**
 * Decomposes `node.relativeTransform` once per node for flip, shear, rotation,
 * and placement.
 */
export function analyzeNodeTransform(node: FigmaNode): NodeTransform {
  const m = node.relativeTransform;
  if (Array.isArray(m) && Array.isArray(m[0]) && Array.isArray(m[1])) {
    const [a, b, tx] = m[0];
    const [c, d, ty] = m[1];
    if ([a, b, c, d].every((v) => typeof v === "number" && Number.isFinite(v))) {
      const flipY = a * d - b * c < 0;
      // Figma writes rows, SVG columns: transpose `[a,b;c,d]` before decomposing.
      const raw = readAffine({ a, b: c, c: b, d, e: 0, f: 0 });
      const fields: FigmaTransformFields | undefined = raw
        ? {
            rotation: normalizeDeg(raw.rotation),
            ...(Math.abs(raw.skewX) > 0.01 ? { skewX: raw.skewX } : {}),
            ...(Math.abs(raw.skewY) > 0.01 ? { skewY: raw.skewY } : {})
          }
        : undefined;
      const rotation = fields ? fields.rotation : deg(Math.atan2(c, a));
      const hasShear = fields !== undefined && (fields.skewX !== undefined || fields.skewY !== undefined);
      const rotated = hasShear || Math.abs(((rotation % 360) + 360) % 360) > 0.01;
      const matrix =
        typeof tx === "number" && Number.isFinite(tx) && typeof ty === "number" && Number.isFinite(ty)
          ? { a, b, c, d, tx, ty }
          : null;
      return { flipY, fields, rotation, rotated, matrix };
    }
  }
  const rotation = declaredRotationDeg(node);
  const rotated = typeof rotation === "number" && Math.abs(((rotation % 360) + 360) % 360) > 0.01;
  return { flipY: false, fields: undefined, rotation, rotated, matrix: null };
}

/** Line flips cannot use `flipY` on a level segment; absorb mirror into angle. */
export function figmaLineRotation(node: FigmaNode, xform: NodeTransform): number | undefined {
  const size = node.size;
  const m = node.relativeTransform;
  if (!size || size.x <= 0 || !Array.isArray(m) || !Array.isArray(m[0]) || !Array.isArray(m[1])) {
    return declaredRotationDeg(node);
  }
  const [a, b] = m[0];
  const [c, d] = m[1];
  if (![a, b, c, d].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return xform.rotation ?? declaredRotationDeg(node);
  }
  const worldX = a * size.x + b * size.y;
  const worldY = c * size.x + d * size.y;
  if (worldX === 0 && worldY === 0) return declaredRotationDeg(node);
  return deg(Math.atan2(worldY, worldX) - Math.atan2(size.y, size.x));
}

function ownSize(node: FigmaNode): { x: number; y: number } | null {
  const size = node.size;
  if (!size || typeof size.x !== "number" || typeof size.y !== "number") return null;
  if (size.x <= 0) return null;
  if (size.y <= 0 && node.type !== "LINE") return null;
  return size;
}

function hasGeometry(node: FigmaNode): boolean {
  const fill = node.fillGeometry?.[0]?.path;
  const stroke = node.strokeGeometry?.[0]?.path;
  return Boolean((fill && fill.length > 1) || (stroke && stroke.length > 1));
}

export interface ParentContext {
  rotated?: boolean;
  layoutMode?: string;
}

export interface Placement {
  rect: Rect;
  local?: boolean;
  ownSpace: boolean;
  rotation?: number;
}

function localPlacement(
  node: FigmaNode,
  size: { x: number; y: number } | null,
  xform: NodeTransform
): Placement | null {
  const m = xform.matrix;
  if (!m) return null;
  const aabb = node.absoluteBoundingBox;
  const width = size?.x ?? aabb?.width ?? 0;
  const height = size?.y ?? aabb?.height ?? 0;
  if (!(width > 0) && !(height > 0)) return null;

  const centreX = m.tx + (m.a * width) / 2 + (m.b * height) / 2;
  const centreY = m.ty + (m.c * width) / 2 + (m.d * height) / 2;
  return {
    rect: {
      x: round2(centreX - width / 2),
      y: round2(centreY - height / 2),
      width: round2(width),
      height: round2(height)
    },
    local: true,
    ownSpace: true,
    rotation: round2(normalizeDeg(xform.rotation ?? deg(Math.atan2(m.c, m.a))))
  };
}

export function placeNode(
  node: FigmaNode,
  parent: ParentContext | undefined,
  xform: NodeTransform,
  onGap: (node: FigmaNode, property: string, value?: string) => void
): Placement | null {
  const aabb = node.absoluteBoundingBox;
  const size = ownSize(node);

  if (parent?.rotated) {
    const local = localPlacement(node, size, xform);
    if (local) return local;
    onGap(
      node,
      "rotation:relativeTransform",
      "the response carries no `relativeTransform`, so a layer inside a rotated frame is placed from its canvas bounds"
    );
  }

  if (!aabb) return null;
  const bound = { x: aabb.x || 0, y: aabb.y || 0, width: aabb.width || 0, height: aabb.height || 0 };
  const own = size !== null && xform.rotated;
  const rect: Rect = own
    ? {
        x: round2(bound.x + (bound.width - size.x) / 2),
        y: round2(bound.y + (bound.height - size.y) / 2),
        width: size.x,
        height: size.y
      }
    : bound;

  if (rect.width === 0 && rect.height === 0 && !hasGeometry(node)) return null;

  if (own) return { rect, ownSpace: true, rotation: round2(normalizeDeg(xform.rotation ?? 0)) };

  if (xform.rotated && node.type !== "LINE") {
    onGap(
      node,
      "node:rotation",
      "the response carries no `size` for this node, so there is no unrotated box to turn: the rotation is not drawn and the box stays the bound of it"
    );
  }
  return { rect, ownSpace: false };
}

export function carryRotation(out: Record<string, unknown>, rotation: number | undefined): void {
  if (out.rotation !== undefined || rotation === undefined) return;
  const angle = normalizeDeg(rotation);
  if (Math.abs(angle) > 0.01) out.rotation = round2(angle);
}

export type GapReporter = FigmaGap;

