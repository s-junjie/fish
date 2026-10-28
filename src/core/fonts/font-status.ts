/**
 * Whether a family the document NAMES can be painted on this machine.
 *
 * Three states, and the middle one is the whole point of the module:
 *
 *  - `installed` — the machine has the face (or the family is a generic keyword,
 *    or the file carries it in `fonts[].src`);
 *  - `remote` — it is not here, but a web font service can supply it (Phase 5
 *    decides that; this module only records the answer via `noteWebFontFamily`);
 *  - `missing` — neither. The canvas will paint a substitute, so the stored box
 *    dimensions are a lie about text that is not on screen.
 *
 * `missing` is NOT "unknown": it is a claim the file cannot keep, and every
 * consumer — the marker, the geometry freeze, the edit gate, the export warning
 * — asks HERE rather than probing on its own. A second detector is a second
 * answer.
 *
 * How the answer is obtained, in order:
 *  0. a stack that DECLARES a fallback (`"Inter, sans-serif"`) is answered on
 *     every machine, before anything else is asked: the author said what a
 *     substitution should look like. Same predicate as `fontDiagnostics`, so the
 *     CLI and the canvas draw the line in the same place;
 *  1. a generic keyword resolves by definition (CSS says so, no machine needed);
 *  2. a family the document carries with a `src` travels with the file;
 *  3. the platform's own face list, once a user gesture has granted it — exact,
 *     and the reason opening the font picker upgrades every earlier guess;
 *  4. a two-baseline width probe, which needs no permission.
 *
 * `document.fonts.check()` is deliberately not used: it answers `true` for a
 * family that does not exist, so it cannot distinguish anything.
 */

import type { DesignDocument, DesignElement, TextElement, TextStyleDefinition } from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { flattenElements } from "../geometry/tree-ops";
import { clearTextMeasureCache } from "../geometry/text-measure";
import { cssFamilyName, declaresFallback, firstNamedFamily } from "../font-stack";
import { subscribeLocalFonts } from "./local-font-access";

export type FontStatus = "installed" | "remote" | "missing";

/** How much of the document asks for one family. */
export interface FontUsage {
  /** The family as the document spells it; the first spelling seen wins. */
  family: string;
  status: FontStatus;
  /** Text layers whose own style names it. */
  texts: number;
  /** Text runs (spans) that override the layer's family with it. */
  spans: number;
  /** `doc.styles[]` text styles that name it. */
  styles: number;
  /** For a jump-to: the first text layer that uses it. */
  firstTextId?: string;
}

export type FontWidthProbe = (cssFont: string) => number | null;

/**
 * The one string both baselines are measured with. Wide glyphs, ascenders and
 * descenders: a string of `i`s would agree across faces that are nothing alike.
 */
const PROBE_TEXT = "mmmmmmmmmmlliWWQ@#%&";
const PROBE_SIZE = 16;
/** Sub-pixel: the same face asked for twice returns the same number. */
const PROBE_TOLERANCE = 0.01;

let injectedProbe: FontWidthProbe | null = null;
let canvasContext: CanvasRenderingContext2D | null | undefined;

function defaultProbe(cssFont: string): number | null {
  if (typeof document === "undefined") return null;
  if (canvasContext === undefined) {
    canvasContext = null;
    try {
      canvasContext = document.createElement("canvas").getContext("2d");
    } catch {
      canvasContext = null;
    }
  }
  if (!canvasContext) return null;
  canvasContext.font = cssFont;
  const width = canvasContext.measureText(PROBE_TEXT).width;
  return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * A measuring seam, in the shape `setTextMeasurer` established: this module is
 * DOM-free apart from the canvas above, so a test can answer widths it decides
 * instead of the ones the machine happens to have.
 */
export function setFontWidthProbe(probe: FontWidthProbe | null): void {
  injectedProbe = probe;
  decided.clear();
}

const widthOf = (cssFont: string): number | null => (injectedProbe ?? defaultProbe)(cssFont);

/**
 * Does adding `family` to a baseline change what is drawn?
 *
 * Two baselines, because one is not enough: comparing against a single generic
 * cannot tell "not installed" from "installed and metric-identical to it" — and
 * the OS default sans matches `sans-serif` by definition, which is every
 * document's most common family. A face cannot have both monospace's and
 * serif's advances, so agreement with BOTH means the name resolved to nothing.
 */
function probed(family: string): FontStatus | null {
  const token = cssFamilyName(family);
  const prefix = `400 ${PROBE_SIZE}px `;
  const mono = widthOf(`${prefix}monospace`);
  const serif = widthOf(`${prefix}serif`);
  if (mono === null || serif === null) return null;
  const withMono = widthOf(`${prefix}${token}, monospace`);
  const withSerif = widthOf(`${prefix}${token}, serif`);
  if (withMono === null || withSerif === null) return null;
  const sameMono = Math.abs(withMono - mono) <= PROBE_TOLERANCE;
  const sameSerif = Math.abs(withSerif - serif) <= PROBE_TOLERANCE;
  return sameMono && sameSerif ? "missing" : "installed";
}

// ---------------------------------------------------------------------------
// the answer
// ---------------------------------------------------------------------------

/** Families the platform listed, once a gesture granted that list. */
let granted: Set<string> | null = null;
/** Families a web font service is known to have (Phase 5 writes this). */
const webFamilies = new Set<string>();
/** Families the document carries with a `src`; they travel with the file. */
let carried = new Set<string>();

const decided = new Map<string, FontStatus>();
let snapshot: FontUsage[] = [];
const listeners = new Set<() => void>();

const keyOf = (family: string): string => family.trim().toLowerCase();

function decide(family: string): FontStatus {
  const key = keyOf(family);
  if (!key) return "installed";
  // A stack that declares its own fallback is answered before anything else,
  // because the answer does not depend on this machine: the author said what a
  // substitution should look like. Checked FIRST and not after the face list,
  // or a granted list would turn a deliberate fallback into `missing` the moment
  // the picker was opened.
  if (declaresFallback(family)) return "installed";
  const named = firstNamedFamily(family);
  const namedKey = keyOf(named);
  if (!namedKey) return "installed";
  if (carried.has(namedKey)) return "installed";
  if (granted) return granted.has(namedKey) ? "installed" : webFamilies.has(namedKey) ? "remote" : "missing";
  if (webFamilies.has(namedKey)) return "remote";
  const memo = decided.get(namedKey);
  if (memo) return memo;
  // No probe means no way to tell (Node, a test, a browser without a canvas).
  // Answering `installed` there is deliberate: a false `missing` locks the text
  // out of being edited, while a false `installed` costs a substitute nobody
  // promised to replace.
  const answer = probed(named) ?? "installed";
  decided.set(namedKey, answer);
  return answer;
}

/** The status of one family, whether or not the document names it. */
export function fontStatusOf(family: string | undefined | null): FontStatus {
  return decide(family ?? "");
}

export function fontStatusSnapshot(): readonly FontUsage[] {
  return snapshot;
}

export function subscribeFontStatus(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * The first family `el` paints with that this machine cannot supply, or null.
 *
 * The layer's OWN family is asked first. A span stacks on top of it, so when the
 * element's family is unavailable the whole run is a substitute and reporting a
 * span's family would name the smaller of two problems. The returned family is
 * the one to SHOW — the first named entry, since a pre-split document spells its
 * fallback inline (`"Inter, sans-serif"`) and `sans-serif` is not a font anyone
 * can install.
 */
export function textFontStatus(el: DesignElement): { family: string; status: FontStatus } | null {
  if (el.type !== "text") return null;
  const text = el as TextElement;
  const own = text.style?.fontFamily;
  if (own) {
    const status = decide(own);
    if (status !== "installed") return { family: firstNamedFamily(own) || own, status };
  }
  for (const span of text.spans ?? []) {
    const family = span.style?.fontFamily;
    if (!family) continue;
    const status = decide(family);
    if (status !== "installed") return { family: firstNamedFamily(family) || family, status };
  }
  return null;
}

/**
 * A web font service answered for this family (Phase 5). `absent` takes it back
 * out: a family the service does not have is not `remote`, it is `missing`.
 */
export function noteWebFontFamily(family: string, state: "remote" | "absent"): void {
  const key = keyOf(family);
  if (!key) return;
  const had = webFamilies.has(key);
  if (state === "remote") webFamilies.add(key);
  else webFamilies.delete(key);
  if (had !== (state === "remote")) publish();
}

/** Forget every answer, as a page that just loaded would. */
export function resetFontStatus(): void {
  decided.clear();
  carried = new Set();
  webFamilies.clear();
  granted = null;
  snapshot = [];
}
// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

interface Scan {
  usage: Map<string, FontUsage>;
  /** The stack each family was found in, keyed like `usage` — a family's status
   *  is decided from what the DOCUMENT wrote, not from the name alone. */
  stacks: Map<string, string>;
  carried: Set<string>;
}

function scanDocument(doc: DesignDocument): Scan {
  const usage = new Map<string, FontUsage>();
  const stacks = new Map<string, string>();
  const carry = new Set<string>();

  for (const font of doc.fonts ?? []) {
    // Only a `src` makes the family travel with the file. Without one it is a
    // name this machine is expected to have, which is exactly what is decided
    // below — claiming it installed would hide the very state this reports.
    if (font?.src && font.family) carry.add(keyOf(firstNamedFamily(font.family) || font.family));
  }

  const record = (stack: string | undefined, kind: "texts" | "spans" | "styles", textId?: string) => {
    // A stack is asked for its first NAMED entry: `"Inter, sans-serif"` (how
    // pre-split documents spell it) names Inter and falls back by design, so the
    // family to report on is Inter, not `sans-serif`.
    const family = firstNamedFamily(stack);
    if (!family) return;
    const key = keyOf(family);
    let entry = usage.get(key);
    if (!entry) {
      entry = { family, status: "installed", texts: 0, spans: 0, styles: 0 };
      usage.set(key, entry);
      if (stack) stacks.set(key, stack);
    }
    entry[kind]++;
    if (kind === "texts" && textId && !entry.firstTextId) entry.firstTextId = textId;
  };

  const roots: DesignElement[] = doc.pages?.length
    ? doc.pages.flatMap((page) => page.children ?? [])
    : getActivePage(doc).children ?? [];

  for (const el of flattenElements(roots)) {
    if (el.type !== "text") continue;
    const text = el as TextElement;
    record(text.style?.fontFamily, "texts", text.id);
    for (const span of text.spans ?? []) record(span.style?.fontFamily, "spans");
  }

  for (const style of doc.styles ?? []) {
    if (style.styleType !== "text") continue;
    record((style as TextStyleDefinition).style?.fontFamily, "styles");
  }

  return { usage, stacks, carried: carry };
}

/**
 * Re-decide every family the document names, and tell the UI only when an
 * answer MOVED.
 *
 * A status change invalidates every measurement taken with the old one, so the
 * measure cache is dropped here rather than by each caller — a caller that
 * forgot would keep boxes sized for a face that is no longer being painted.
 */
export function refreshFontStatus(doc: DesignDocument | null): void {
  registerDocumentFonts(doc);
  const scan = doc
    ? scanDocument(doc)
    : { usage: new Map<string, FontUsage>(), stacks: new Map<string, string>(), carried: new Set<string>() };
  carried = scan.carried;
  const previous = new Map(snapshot.map((entry) => [keyOf(entry.family), entry.status]));
  const beforeSignature = signatureOf(snapshot);

  let moved = false;
  const next: FontUsage[] = [];
  for (const entry of scan.usage.values()) {
    const status = decide(scan.stacks.get(keyOf(entry.family)) ?? entry.family);
    if (previous.get(keyOf(entry.family)) !== status) moved = true;
    next.push({ ...entry, status });
  }
  snapshot = next.sort((a, b) => a.family.localeCompare(b.family));
  if (moved) clearTextMeasureCache();
  // A status MOVE is what invalidates the measure cache. A family leaving, or the
  // counts behind one changing, is what invalidates a LIST — and a row that says
  // "2 text layers" about a family the file now names once is the same kind of
  // wrong as a mark on a layer that no longer uses it.
  if (moved || signatureOf(snapshot) !== beforeSignature) {
    for (const listener of [...listeners]) listener();
  }
}

/** What a reader of the list would SEE, so a rebuild with the same content stays quiet. */
function signatureOf(list: readonly FontUsage[]): string {
  return list.map((e) => `${e.family}\u0000${e.status}\u0000${e.texts}\u0000${e.spans}\u0000${e.styles}`).join("\n");
}

/**
 * Re-decide what is already known, without a document: an answer that arrived
 * from outside the file (the platform's font list) changes what the same
 * document means.
 */
function publish(): void {
  let moved = false;
  snapshot = snapshot.map((entry) => {
    const status = decide(entry.family);
    if (status !== entry.status) moved = true;
    return status === entry.status ? entry : { ...entry, status };
  });
  if (moved) clearTextMeasureCache();
  if (moved) for (const listener of [...listeners]) listener();
}

/**
 * Families whose faces arrive from somewhere other than the document — the
 * platform's list after a grant — must re-open the question for every family
 * already decided, so the answer stays with the one module that gave it.
 */
subscribeLocalFonts((result) => {
  if (!result.ok || result.families.length === 0) return;
  granted = new Set(result.families.map(keyOf));
  decided.clear();
  publish();
});

/**
 * Make a carried face real.
 *
 * The UI never writes `fonts[].src` (a CJK family is 5–20 MB before base64), but
 * a document authored elsewhere can carry one — and then the file's own claim
 * has to be honoured, or the resolver says `installed` about a face nothing ever
 * loaded and the canvas measures the substitute under that name. Registrations
 * are keyed by identity, so the pass over `doc.fonts` on every refresh costs
 * nothing after the first — and the set tracks what the DOM holds, not the
 * answers, so `resetFontStatus` leaves it alone.
 */
const registeredFaces = new Set<string>();

export function registerDocumentFonts(doc: DesignDocument | null): void {
  if (typeof document === "undefined" || typeof FontFace === "undefined" || !document.fonts) return;
  for (const font of doc?.fonts ?? []) {
    if (!font?.src || !font.family) continue;
    const key = `${keyOf(font.family)}|${font.weight ?? ""}|${font.style ?? ""}|${font.src}`;
    if (registeredFaces.has(key)) continue;
    registeredFaces.add(key);
    try {
      const face = new FontFace(font.family, `url(${JSON.stringify(font.src)})`, {
        ...(font.weight !== undefined ? { weight: String(font.weight) } : {}),
        ...(font.style ? { style: font.style } : {})
      });
      document.fonts.add(face);
      face.load().then(
        () => clearTextMeasureCache(),
        // An unreadable `src` is the file's problem, not this module's: the
        // family stays `installed` (the file carries it) and the canvas paints
        // the substitute under its name, which no marker reports today.
        () => {}
      );
    } catch {
      /* a `src` the browser refuses to parse is reported by nobody today */
    }
  }
}
