import type { GradientStop } from "./types";
import { isColorValue } from "./color-value";

export type { GradientStop };

/**
 * A repair sink, structurally typed so this module does not have to import the
 * normalizer's own type back — `normalize/paint` imports THIS file, and the
 * dependency only needs to run one way. `kind` is `string` rather than the
 * normalizer's union for the same reason a structural type exists at all: a
 * literal here would make `NormalizationRepair[]` (whose `kind` is the wider
 * union) unassignable to it.
 */
export interface StopRepair {
  kind: string;
  path: string;
  message: string;
  severity?: "info";
}

type Repairs = StopRepair[];

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

/**
 * Canonical `stops`, or undefined when there is no array to read.
 *
 * A stop this cannot read is DROPPED and reported, never defaulted. It used to
 * default to `#FFFFFF`, which is how a `[color, offset]` pair or a `{ colour,
 * at }` typo became a white solid with no repair: every unreadable stop landed
 * on the same colour, the ramp judged itself flat, and the paint collapsed to
 * that colour. Refusing the entry leaves the author's own `from` / `to` (or
 * nothing at all) in charge, and `check` says which stop was refused and why.
 *
 * A stop carrying only `tokenId` is the one exception: its colour is
 * materialised from the token table after normalization, so dropping it here
 * would delete a binding that resolves one pass later.
 */
export function canonicalGradientStops(
  raw: unknown,
  path?: string,
  repairs?: Repairs
): GradientStop[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const at = (index: number): string => (path ? `${path}/${index}` : `stops[${index}]`);
  const refuse = (index: number, message: string): void => {
    repairs?.push({ kind: "paint", path: at(index), message });
  };
  if (!Array.isArray(raw)) {
    repairs?.push({
      kind: "paint",
      path: path ?? "stops",
      message: `stops must be an array of { "color": "#RRGGBB", "offset": 0..1 }; this ${typeof raw} was ignored`
    });
    return undefined;
  }
  if (raw.length === 0) return undefined;
  const out: GradientStop[] = [];
  raw.forEach((stop, index) => {
    const tokenId = isPlainObject(stop) && typeof stop.tokenId === "string" ? stop.tokenId.trim() : "";
    const colour =
      typeof stop === "string"
        ? stop
        : isPlainObject(stop) && typeof stop.color === "string"
          ? stop.color
          : "";
    if (!colour) {
      if (tokenId) {
        out.push({ color: "#FFFFFF", offset: stopOffset(stop, index, raw.length), tokenId });
        return;
      }
      refuse(
        index,
        Array.isArray(stop)
          ? "a stop is an object, not a [color, offset] pair — write { \"color\": \"#RRGGBB\", \"offset\": 0..1 }; this stop was dropped"
          : 'stop has no "color" — write { "color": "#RRGGBB", "offset": 0..1 }; this stop was dropped'
      );
      return;
    }
    if (!isColorValue(colour)) {
      refuse(index, `colour ${JSON.stringify(colour)} is not a CSS colour; this stop was dropped`);
      return;
    }
    out.push({
      color: colour,
      offset: stopOffset(stop, index, raw.length),
      ...(tokenId ? { tokenId } : {})
    });
  });
  return out.length > 0 ? out : undefined;
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
