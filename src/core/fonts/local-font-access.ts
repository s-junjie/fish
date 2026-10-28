/**
 * The one place the app asks the platform for its font list.
 *
 * `queryLocalFonts()` is permission-gated: the browser asks the user to let the
 * page see every installed font, and the prompt surfaces wherever the first call
 * happens — which is nothing to do with what the user was doing. Two callers
 * each caching their own answer meant two prompts for one decision, so the grant
 * a user gave on creating a text layer did not answer the call that changing
 * that layer's font made.
 *
 * Hence three rules, all enforced here rather than by each caller: one call, one
 * memo, and no call at all until a user gesture asks for the list. Both callers
 * (the font picker, and outlining text) read this module, and `fontStatus` is a
 * third — it needs the answer broadcast when it arrives, not only from its own
 * call (`subscribeLocalFonts`).
 */

export interface LocalFontFace {
  family: string;
  style: string;
  fullName?: string;
  postscriptName?: string;
  blob: () => Promise<Blob>;
}

export type LocalFontsResult =
  | { ok: true; faces: LocalFontFace[]; families: string[] }
  | { ok: false; reason: "no-api" | "denied" };

/**
 * Several hundred faces, one family per weight and style, plus entries long
 * enough to be a path. Names are what a font menu shows, so the list is built
 * here once rather than per consumer.
 */
function familyNames(faces: LocalFontFace[]): string[] {
  const seen = new Set<string>();
  for (const face of faces) {
    const family = (face.family || "").trim();
    if (!family || family.length > 80) continue;
    seen.add(family);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const NO_API: LocalFontsResult = { ok: false, reason: "no-api" };
const DENIED: LocalFontsResult = { ok: false, reason: "denied" };

let cache: LocalFontsResult | null = null;
let inflight: Promise<LocalFontsResult> | null = null;

/**
 * Who wants to know when the answer arrives.
 *
 * The grant cannot be asked for on load (`readLocalFonts` is what raises the
 * prompt), so anything deciding a font's state before the user opens the picker
 * works from a measurement instead. The moment the list DOES arrive it is exact,
 * and every consumer that decided earlier has to be told or it keeps reporting
 * a guess as fact.
 */
const listeners = new Set<(result: LocalFontsResult) => void>();

export function subscribeLocalFonts(onResult: (result: LocalFontsResult) => void): () => void {
  listeners.add(onResult);
  if (cache) onResult(cache);
  return () => {
    listeners.delete(onResult);
  };
}

function query(): (() => Promise<LocalFontFace[]>) | null {
  if (typeof window === "undefined") return null;
  const qlf = (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
  return typeof qlf === "function" ? (qlf as () => Promise<LocalFontFace[]>).bind(window) : null;
}

export function supportsLocalFonts(): boolean {
  return query() !== null;
}

/**
 * Whether the answer is already in hand. A caller that would otherwise announce
 * a wait asks this first; it never asks on the user's behalf, because asking is
 * what raises the prompt.
 */
export function hasLocalFonts(): boolean {
  return cache !== null;
}

export function readLocalFonts(): Promise<LocalFontsResult> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  const qlf = query();
  if (!qlf) {
    cache = NO_API;
    for (const listener of [...listeners]) listener(cache);
    return Promise.resolve(cache);
  }
  inflight = qlf()
    .then((faces) => {
      cache = { ok: true, faces, families: familyNames(faces) };
      return cache;
    })
    .catch(() => {
      cache = DENIED;
      return cache;
    })
    .finally(() => {
      inflight = null;
      if (cache) for (const listener of [...listeners]) listener(cache);
    });
  return inflight;
}