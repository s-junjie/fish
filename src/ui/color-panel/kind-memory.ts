import type { AssetRef, GradientStop, ImagePaint, Paint, PatternPaint } from "../../core/dsl/types";
import { isGradientKind, type GradientKind } from "../paint-kind";

export type GradientPaint = Extract<Paint, { type: GradientKind }>;

export interface GradientGeometry {
  angle?: number;
  center?: { x: number; y: number };
  radius?: number;
}

/**
 * What each kind last painted.
 *
 * A kind switch rebuilds the paint from scratch, so without this the framing
 * chosen on an image layer, or the angle aimed on a linear one, was thrown away
 * every time the user stepped through another kind and came back.
 */
export interface KindMemory {
  image: ImagePaint | null;
  pattern: PatternPaint | null;
  gradientKind: GradientKind | null;
  geometry: Partial<Record<GradientKind, GradientGeometry>>;
}

export const emptyKindMemory = (): KindMemory => ({
  image: null,
  pattern: null,
  gradientKind: null,
  geometry: {}
});

/**
 * Records the geometry a kind switch must not lose.
 *
 * The recorded fields ARE the carry-over set, per kind: a re-entered radial keeps
 * its centre and radius but is drawn at its default rotation, so it records no
 * angle.
 */
export function rememberPaint(memory: KindMemory, paint: Paint): void {
  switch (paint.type) {
    case "image":
      memory.image = paint;
      return;
    case "pattern":
      memory.pattern = paint;
      return;
    case "linear-gradient":
      memory.gradientKind = paint.type;
      memory.geometry[paint.type] = { angle: paint.angle };
      return;
    case "radial-gradient":
      memory.gradientKind = paint.type;
      memory.geometry[paint.type] = { center: paint.center, radius: paint.radius };
      return;
    case "angular-gradient":
      memory.gradientKind = paint.type;
      memory.geometry[paint.type] = { center: paint.center, angle: paint.angle };
      return;
    case "diamond-gradient":
      memory.gradientKind = paint.type;
      memory.geometry[paint.type] = { center: paint.center, radius: paint.radius, angle: paint.angle };
      return;
  }
}

/** The image paint to re-point at, or `null` when the document has no bitmap. */
export function imageSwitchPaint(memory: KindMemory, assets: AssetRef[]): ImagePaint | null {
  const remembered = memory.image;
  const reusable = !!remembered && assets.some((a) => a.id === remembered.assetId && !!a.uri);
  const assetId = reusable ? remembered!.assetId : assets.find((a) => !!a.uri)?.id;
  if (!assetId) return null;
  if (!reusable) return { type: "image", assetId, fit: "cover" };
  return {
    type: "image",
    assetId,
    fit: remembered!.fit ?? "cover",
    ...(remembered!.focalPoint ? { focalPoint: remembered!.focalPoint } : {}),
    ...(remembered!.adjust ? { adjust: remembered!.adjust } : {})
  };
}

/** A motif with no colour would be a layer that paints nothing. */
export function patternSwitchPaint(memory: KindMemory, color: string): PatternPaint {
  if (memory.pattern) return { ...memory.pattern };
  return { type: "pattern", motif: "dots", tile: { width: 16, height: 16 }, foreground: color };
}

/** The gradient paint a switch to `kind` produces, carrying the geometry remembered for it. */
export function gradientSwitchPaint(
  kind: GradientKind,
  current: Paint,
  stops: GradientStop[],
  color: string,
  memory: KindMemory
): GradientPaint {
  const active = isGradientKind(current.type);
  const from = active ? stops[0]?.color ?? color : color;
  const fallbackTo = kind === "linear-gradient" ? "#8B5CF6" : "#1E1E1E";
  const to = active ? stops[stops.length - 1]?.color ?? fallbackTo : fallbackTo;
  const nextStops = active ? stops : [{ color: from, offset: 0 }, { color: to, offset: 100 }];
  const base = {
    from,
    to,
    stops: nextStops,
    fromOffset: nextStops[0].offset,
    toOffset: nextStops[nextStops.length - 1].offset
  };
  const geometry = memory.geometry[kind];
  // A live gradient's own angle wins over the remembered linear one: only a
  // non-gradient paint falls back to memory.
  const linearAngle = active
    ? (current as { angle?: number }).angle ?? 90
    : geometry?.angle ?? 90;

  switch (kind) {
    case "linear-gradient":
      return { ...base, type: kind, angle: linearAngle };
    case "radial-gradient":
      return {
        ...base,
        type: kind,
        ...(geometry?.center ? { center: geometry.center } : {}),
        ...(typeof geometry?.radius === "number" ? { radius: geometry.radius } : {})
      };
    case "angular-gradient":
      return {
        ...base,
        type: kind,
        ...(geometry?.center ? { center: geometry.center } : {}),
        ...(typeof geometry?.angle === "number" ? { angle: geometry.angle } : {})
      };
    case "diamond-gradient":
      return {
        ...base,
        type: kind,
        ...(geometry?.center ? { center: geometry.center } : {}),
        ...(typeof geometry?.radius === "number" ? { radius: geometry.radius } : {}),
        ...(typeof geometry?.angle === "number" ? { angle: geometry.angle } : {})
      };
  }
}
