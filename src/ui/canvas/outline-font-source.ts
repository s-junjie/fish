import { FontParseError, OutlineFont, parseOutlineFont } from "../../core/fonts";
import { LocalFontFace, readLocalFonts } from "../../core/fonts/local-font-access";

/**
 * Finds the actual font file behind a CSS `font-family` stack.
 *
 * The stack is walked the way CSS walks it — the first family that exists wins —
 * because the browser already picked one face and the outline has to be drawn
 * with that same face. This matters more than it sounds: documents authored
 * before the font-stack split store `"Inter, sans-serif"`, Inter is not
 * installed on a stock macOS, and a resolver that only tried the first family
 * would report those layers as unreadable while the screen showed Helvetica.
 *
 * Generic families name no file, so they are expanded to the faces a platform is
 * likely to substitute and the right one is chosen by measuring: render one
 * string in the generic and in each candidate and keep the width that matches.
 * A candidate that matches nothing is rejected rather than used — `system-ui` on
 * macOS resolves to a font `queryLocalFonts` does not list, and its nearest
 * listed neighbour is off by 27px, which is a different typeface, not a rounding
 * difference.
 *
 * The enumeration itself is `readLocalFonts`, shared with the font picker: one
 * permission-gated call, cached once. Outlining is a user command, so it is also
 * a user gesture, and the first call is the only one that can raise the prompt.
 *
 * Failure carries a reason, because "could not read the font" covers four
 * different problems with four different fixes, and a user staring at that one
 * sentence cannot tell a refused permission from a font that is simply not
 * installed.
 */

/**
 * What a generic family is likely to resolve to, per platform.
 *
 * The CJK entries are not padding: on a Chinese-locale Chrome `sans-serif`
 * resolves to the CJK system font, whose Latin glyphs are its own — measured on
 * one such machine, `"Inter, sans-serif"` matched `PingFang HK` to 0.0px while
 * every Western candidate was off. A list of Latin-only faces therefore fails
 * on exactly the machines whose users are most likely to hit it.
 */
const GENERIC_CANDIDATES: Record<string, string[]> = {
  "sans-serif": [
    "Helvetica",
    "Helvetica Neue",
    "Arial",
    "Verdana",
    "Geneva",
    "PingFang SC",
    "PingFang HK",
    "PingFang TC",
    "Hiragino Sans",
    "Hiragino Sans GB",
    "Heiti SC",
    "Microsoft YaHei",
    "Noto Sans",
    "Segoe UI"
  ],
  serif: [
    "Times New Roman",
    "Times",
    "Georgia",
    "Palatino",
    "Songti SC",
    "SimSun",
    "Hiragino Mincho ProN",
    "Noto Serif"
  ],
  monospace: ["Menlo", "Monaco", "Courier New", "Courier", "Consolas", "Noto Sans Mono"],
  "system-ui": [
    "Helvetica Neue",
    "Helvetica",
    "Arial",
    "PingFang SC",
    "PingFang HK",
    "Segoe UI"
  ],
  "-apple-system": ["Helvetica Neue", "Helvetica", "PingFang SC", "PingFang HK"],
  blinkmacsystemfont: ["Helvetica Neue", "Helvetica", "PingFang SC", "PingFang HK"],
  cursive: ["Apple Chancery", "Comic Sans MS"],
  fantasy: ["Papyrus", "Impact"]
};

/**
 * Latin separates the Western faces; the CJK tail separates the CJK ones.
 * PingFang SC and HK share their Latin glyphs exactly, so a Latin-only probe
 * cannot choose between them and a simplified-Chinese document would come back
 * with traditional shapes.
 */
const PROBE_TEXT = "Hamburgefonstiv 0123456789 AVTo \u6c49\u5b57\u6d4b\u8bd5";
const PROBE_SIZE = 100;
/** How far a candidate may sit from the generic's own width, in probe px. */
const PROBE_TOLERANCE = 4;

export type OutlineFontFailure = "no-api" | "denied" | "empty" | "no-face" | "unreadable";

export type OutlineFontOutcome =
  | { ok: true; font: OutlineFont; face: string }
  | { ok: false; failure: OutlineFontFailure; detail: string };

const fontCache = new Map<string, OutlineFontOutcome>();
let measureCanvas: HTMLCanvasElement | null = null;

function splitStack(fontFamily: string): string[] {
  return fontFamily
    .split(",")
    .map((part) => part.trim().replace(/^["'](.*)["']$/, "$1"))
    .filter(Boolean);
}

/**
 * `FontData` carries no numeric weight — only a `style` string like `"Demi Bold
 * Italic"` — so the closest face is chosen by reading words, not numbers.
 */
function styleScore(style: string, weight: number, italic: boolean): number {
  const lower = style.toLowerCase();
  const faceItalic = lower.includes("italic") || lower.includes("oblique");
  const faceBold = /bold|heavy|black/.test(lower);
  const faceLight = /light|thin/.test(lower);
  const wantBold = weight >= 600;
  const wantLight = weight <= 300;

  let score = 0;
  if (faceItalic === italic) score += 4;
  if (faceBold === wantBold) score += 3;
  if (wantLight && faceLight) score += 1;
  if (!wantBold && !wantLight && !faceBold && !faceLight) score += 1;
  return score;
}

function facesNamed(list: LocalFontFace[], name: string): LocalFontFace[] {
  const wanted = name.toLowerCase();
  return list.filter((face) => face.family.toLowerCase() === wanted);
}

function bestFace(
  candidates: LocalFontFace[],
  weight: number,
  italic: boolean
): LocalFontFace | null {
  let best: LocalFontFace | null = null;
  let bestScore = -1;
  for (const face of candidates) {
    const score = styleScore(face.style, weight, italic);
    if (score > bestScore) {
      bestScore = score;
      best = face;
    }
  }
  return best;
}

function measureWidth(font: string): number {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) return 0;
  context.font = font;
  return context.measureText(PROBE_TEXT).width;
}

/** Which listed face the platform substituted for a generic family, if any. */
function matchGeneric(
  available: string[],
  generic: string,
  weight: number,
  italic: boolean
): string | null {
  const style = `${italic ? "italic " : ""}${weight} ${PROBE_SIZE}px `;
  const target = measureWidth(`${style}${generic}`);
  if (!(target > 0)) return available[0] ?? null;

  let best: string | null = null;
  let bestDelta = Infinity;
  for (const name of available) {
    const delta = Math.abs(measureWidth(`${style}"${name}"`) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = name;
    }
  }
  return bestDelta <= PROBE_TOLERANCE ? best : null;
}

/**
 * What the platform substituted when nothing in the stack exists.
 *
 * `font-family: Inter` with no Inter installed still draws — the platform picks
 * a default. Which one it picked is measurable: render the stack and every
 * generic at the same size and keep the generic whose width matches. Without
 * this, a single-name stack reports "no font" while the screen is showing that
 * text in something perfectly outlineable.
 */
function substituteGeneric(stack: string[], weight: number, italic: boolean): string | null {
  const style = `${italic ? "italic " : ""}${weight} ${PROBE_SIZE}px `;
  const target = measureWidth(`${style}${stack.join(", ")}`);
  if (!(target > 0)) return null;

  let best: string | null = null;
  let bestDelta = Infinity;
  for (const generic of Object.keys(GENERIC_CANDIDATES)) {
    const delta = Math.abs(measureWidth(`${style}${generic}`) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = generic;
    }
  }
  return bestDelta <= PROBE_TOLERANCE ? best : null;
}

/**
 * The nearest face in the whole list, for the failure message only.
 *
 * Deliberately NOT used to pick a font: width is necessary but not sufficient to
 * identify one, and a sweep of every family happily returns an Arabic face whose
 * Latin glyphs fall back to the same default as the stack did. Reported, so a
 * failure can say how far off the best candidate was.
 */
function closestByMeasurement(
  list: LocalFontFace[],
  stack: string[],
  weight: number,
  italic: boolean
): { family: string; delta: number } | null {
  const style = `${italic ? "italic " : ""}${weight} ${PROBE_SIZE}px `;
  const target = measureWidth(`${style}${stack.join(", ")}`);
  if (!(target > 0)) return null;

  const seen = new Set<string>();
  let best: string | null = null;
  let bestDelta = Infinity;
  for (const face of list) {
    if (seen.has(face.family)) continue;
    seen.add(face.family);
    const delta = Math.abs(measureWidth(`${style}"${face.family}"`) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = face.family;
    }
  }
  return best ? { family: best, delta: bestDelta } : null;
}

function chooseFace(
  list: LocalFontFace[],
  stack: string[],
  weight: number,
  italic: boolean
): LocalFontFace | null {
  for (const name of stack) {
    const generic = GENERIC_CANDIDATES[name.toLowerCase()];
    if (!generic) {
      const face = bestFace(facesNamed(list, name), weight, italic);
      if (face) return face;
      continue;
    }
    const available = generic.filter((candidate) => facesNamed(list, candidate).length > 0);
    if (available.length === 0) continue;
    const picked = matchGeneric(available, name, weight, italic);
    if (!picked) continue;
    const face = bestFace(facesNamed(list, picked), weight, italic);
    if (face) return face;
  }

  const substitute = substituteGeneric(stack, weight, italic);
  if (substitute) {
    const generic = GENERIC_CANDIDATES[substitute];
    const available = generic.filter((candidate) => facesNamed(list, candidate).length > 0);
    const picked = available.length > 0 ? matchGeneric(available, substitute, weight, italic) : null;
    if (picked) return bestFace(facesNamed(list, picked), weight, italic);
  }
  return null;
}

export async function resolveOutlineFont(
  fontFamily: string,
  weight: number,
  italic: boolean
): Promise<OutlineFontOutcome> {
  const stack = splitStack(fontFamily);
  if (stack.length === 0) {
    return { ok: false, failure: "no-face", detail: "(empty font stack)" };
  }

  const key = `${stack.join(",")}|${weight}|${italic}`;
  const cached = fontCache.get(key);
  if (cached) return cached;

  const outcome = await resolveUncached(stack, weight, italic);
  fontCache.set(key, outcome);
  return outcome;
}

async function resolveUncached(
  stack: string[],
  weight: number,
  italic: boolean
): Promise<OutlineFontOutcome> {
  const granted = await readLocalFonts();
  if (!granted.ok) {
    return { ok: false, failure: granted.reason, detail: stack[0] };
  }
  const list = granted.faces;
  if (list.length === 0) {
    // An empty list is not "no match" — it means the platform gave us nothing to
    // match against, which is a different problem with a different answer.
    return { ok: false, failure: "empty", detail: stack[0] };
  }

  const face = chooseFace(list, stack, weight, italic);
  if (!face) {
    const closest = closestByMeasurement(list, stack, weight, italic);
    const near = closest
      ? `closest "${closest.family}" off by ${closest.delta.toFixed(1)}px`
      : "nothing measurable";
    return {
      ok: false,
      failure: "no-face",
      detail: `${stack.join(", ")} \u2014 ${list.length} faces, ${near}`
    };
  }

  try {
    const bytes = new Uint8Array(await (await face.blob()).arrayBuffer());
    return { ok: true, font: parseOutlineFont(bytes), face: face.family };
  } catch (error) {
    const why = error instanceof FontParseError ? error.code : "parse error";
    return { ok: false, failure: "unreadable", detail: `${face.family} (${why})` };
  }
}
