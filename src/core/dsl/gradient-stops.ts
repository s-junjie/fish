import type { GradientStop } from "./types";

export type { GradientStop };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function stopOffset(stop: unknown, index: number, count: number): number {
  if (isPlainObject(stop)) {
    const raw = typeof stop.offset === "number" && Number.isFinite(stop.offset)
      ? stop.offset
      : typeof stop.position === "number" && Number.isFinite(stop.position)
        ? stop.position
        : undefined;
    if (raw !== undefined) {
      return clamp01(raw);
    }
  }
  return count <= 1 ? 0 : Math.round((index / (count - 1)) * 1e4) / 1e4;
}

/** Canonical `stops`, or undefined when there is no array to read. */
export function canonicalGradientStops(raw: unknown): GradientStop[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((stop, index) => {
    const tokenId = isPlainObject(stop) && typeof stop.tokenId === "string" ? stop.tokenId.trim() : "";
    return {
      color:
        typeof stop === "string"
          ? stop
          : isPlainObject(stop) && typeof stop.color === "string" && stop.color
            ? stop.color
            : "#FFFFFF",
      offset: stopOffset(stop, index, raw.length),
      ...(tokenId ? { tokenId } : {})
    };
  });
}

/**
 * What makes two stops the same colour. A bound stop is compared by its TOKEN,
 * not by the value the token happens to resolve to: two different tokens that
 * share a hex today (the usual case across light and dark) are still a ramp,
 * and judging them flat would collapse it and drop both bindings.
 */
const stopIdentity = (stop: GradientStop): string =>
  stop.tokenId ? `token:${stop.tokenId}` : `color:${stop.color}`;

/**
 * A ramp with no interior variation really is a solid. Checked against the
 * canonical stops rather than against `from === to`, because a three-stop ramp
 * whose endpoints match (red → green → red) has equal endpoints and is not flat.
 */
export function gradientIsFlat(stops: GradientStop[] | undefined): boolean {
  if (!stops || stops.length === 0) return true;
  return stops.every((s) => stopIdentity(s) === stopIdentity(stops[0]));
}

/**
 * Writes each bound stop's token value into its `color`. Returns undefined when
 * nothing moved, so callers keep referential identity for untouched paints.
 */
export function materializeStopTokens(
  stops: readonly GradientStop[],
  resolve: (tokenId: string) => string | undefined
): GradientStop[] | undefined {
  let changed = false;
  const next = stops.map((stop) => {
    if (!stop.tokenId) return stop;
    const color = resolve(stop.tokenId);
    if (!color || color === stop.color) return stop;
    changed = true;
    return { ...stop, color };
  });
  return changed ? next : undefined;
}

/**
 * Keeps `from` / `to` in step with the ramp. They are the endpoints' mirror, and
 * a reader that reconstructs stops from them (normalize, an old document) would
 * otherwise see the colours from before the token moved.
 */
export function withGradientEndpoints<T extends { from?: string; to?: string }>(
  paint: T,
  stops: readonly GradientStop[]
): T {
  if (stops.length === 0) return paint;
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  return { ...paint, from: sorted[0].color, to: sorted[sorted.length - 1].color };
}

/** The token a ramp's stops follow, if any — the one a collapse must carry over. */
export function firstStopTokenId(stops: GradientStop[] | undefined): string | undefined {
  return stops?.find((s) => s.tokenId)?.tokenId;
}
