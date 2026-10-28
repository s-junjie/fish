import { SlideDirection, SlideEasing, SlideSpec, SlideTransition } from "./types";
import { SLIDE_DIRECTIONS, SLIDE_EASINGS, SLIDE_TRANSITIONS } from "./schema-enums";
import { asNumber, canonicalKey, isPlainObject } from "./normalize/shared";

/**
 * `duration_ms` / `durationMs` / `Duration` all land on `durationMs`.
 *
 * Stripped rather than canonicalised: `canonicalKey` turns `_` into `-`, which
 * makes `duration_ms` and `durationMs` two different keys — exactly the pair an
 * agent and the schema are most likely to disagree on.
 */
const FIELDS: Record<string, keyof SlideSpec> = {
  transition: "transition",
  durationms: "durationMs",
  duration: "durationMs",
  easing: "easing",
  direction: "direction"
};

const fieldKey = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const MAX_DURATION_MS = 10000;

function inList<T extends string>(list: readonly T[], value: unknown): T | undefined {
  const key = canonicalKey(String(value));
  return (list as readonly string[]).includes(key) ? (key as T) : undefined;
}

/**
 * A transition's numbers are content, so an out-of-range duration is CLAMPED
 * rather than dropped: an author who typed `6000` gets six seconds, not a cut
 * they have to debug. An unrecognised word is dropped instead, because there is
 * no nearest value to fall back on and guessing `morph` for `morphh` would put
 * motion where the author asked for none.
 *
 * Returns `undefined` for anything that carries no usable field so the key stays
 * off the element entirely: a deck that sets no transitions must serialize
 * byte-for-byte as it did before this existed.
 */
export function normalizeSlide(raw: unknown): SlideSpec | undefined {
  if (!isPlainObject(raw)) return undefined;

  const out: SlideSpec = {};
  for (const key of Object.keys(raw)) {
    const field = FIELDS[fieldKey(key)];
    const value = raw[key];
    if (!field || value === undefined || value === null) continue;

    switch (field) {
      case "transition": {
        const t = inList(SLIDE_TRANSITIONS, value);
        if (t) out.transition = t as SlideTransition;
        break;
      }
      case "durationMs": {
        const ms = asNumber(value);
        if (ms !== undefined) out.durationMs = Math.min(MAX_DURATION_MS, Math.max(0, ms));
        break;
      }
      case "easing": {
        const e = inList(SLIDE_EASINGS, value);
        if (e) out.easing = e as SlideEasing;
        break;
      }
      case "direction": {
        const d = inList(SLIDE_DIRECTIONS, value);
        if (d) out.direction = d as SlideDirection;
        break;
      }
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
