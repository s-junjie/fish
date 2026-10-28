/**
 * A Figma plugin's export file → the arguments `importFigmaFile` takes.
 *
 * The plugin writes Figma's own file-response node shape plus the image bytes
 * beside it, because that is the shape the app already maps. This module is
 * the whole of the difference between the two doors: it unwraps the envelope,
 * checks the version, and hands back a document and an `imageFills` map. Nothing
 * downstream knows or cares which one it was — `figma-import.ts` is the single
 * entry both paths go through, and this is what keeps it that way.
 *
 * The envelope is VERSIONED because a file outlives the plugin that wrote it. A
 * designer keeps an export in a folder for months; a plugin that silently changes
 * what it emits would turn an old file into a wrong import rather than a rejected
 * one, which is the failure mode where nothing looks broken and everything is.
 */

import type { FigmaFileResponse, FigmaNode, FigmaStyle, FigmaVariable, FigmaVariableCollection } from "./figma-types";

export const FISH_EXPORT_FORMAT = "fish.figma.export";
export const FISH_EXPORT_VERSION = 1;

export interface FigmaPluginExport {
  format: typeof FISH_EXPORT_FORMAT;
  version: number;
  source?: { plugin?: string; api?: string; scope?: string; exportedAt?: string | null };
  /** Figma's node shape: one `CANVAS` holding what was exported. */
  document: FigmaNode;
  /** `imageRef` → data URI. Absent from an export made without image bytes. */
  images?: Record<string, string>;
  /**
   * The file's variables. Absent from an export whose plugin could not read them
   * — and from every export written before this one — which is a file nobody
   * asked, not a file with no design system.
   */
  variables?: FigmaVariable[];
  /** The collections those variables belong to, with the modes their values use. */
  variableCollections?: FigmaVariableCollection[];
  /**
   * The file's published styles, WITH their values.
   *
   * An array rather than REST's keyed directory, because a directory carries no
   * values and a style rebuilt from a guess is worse than one that did not
   * arrive. Absent from an export written before styles were collected.
   */
  styles?: FigmaStyle[];
  /**
   * Counts of properties this Figma plugin API cannot read at all, e.g. a frame's
   * aspect lock. The plugin reports the count; saying what it means is the app's
   * call, and it happens here because a gap nobody records is a gap nobody closes.
   */
  unreadable?: Record<string, number>;
}

export interface ParsedFigmaExport {
  /** Ready for `importFigmaFile`, as a bare node rather than a file response. */
  document: FigmaNode;
  /**
   * The file's variables, which only this door can carry — REST publishes no
   * member for them. Passed back beside the document because a variable is a
   * file-level thing a layer only points at.
   */
  variables?: FigmaVariable[];
  variableCollections?: FigmaVariableCollection[];
  /** The published styles the document's layers point at, values included. */
  styles?: FigmaStyle[];
  imageFills: Record<string, string>;
  rootName: string;
  unreadable: Array<{ property: string; count: number }>;
}

/** `true` for a plugin export, `false` for a bare node tree or anything else. */
export function isFigmaPluginExport(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && (value as { format?: unknown }).format === FISH_EXPORT_FORMAT;
}

/**
 * Whether clipboard TEXT is one of ours.
 *
 * The plugin's Copy button puts the single-file envelope on the system clipboard,
 * and a paste in FISH has to recognise it without a second importer: the text is
 * wrapped as the file it would have been and handed to the SAME door. The tag
 * test comes first because a paste is a string the OS handed over and most of
 * them are prose — `includes` is the whole cost of finding out. The parse is
 * guarded because the tag being present is not the tag being the whole story:
 * a truncated clipboard is a real thing, and a half envelope is foreign text.
 */
export function isFigmaExportText(text: string): boolean {
  if (!text || !text.includes(FISH_EXPORT_FORMAT)) return false;
  try {
    return isFigmaPluginExport(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * Why one property being unreadable is worth naming in the report.
 *
 * Written here rather than in the plugin because it is a claim about what the
 * IMPORT lost, and the plugin has no idea what the app maps. The plugin's job
 * ended at "I could not read this"; saying "so those layers import without their
 * aspect lock" is this side's sentence to get right.
 */
const UNREADABLE_NOTES: Record<string, string> = {
  preserveRatio:
    "Figma's plugin API cannot read a frame's aspect-ratio lock, so frames that used one import without it. Resizing them will no longer keep their proportions.",
  videoBytes:
    "Figma's plugin API cannot read the bytes behind a video fill — it publishes the clip's hash and nothing that resolves it, where an image has `getImageByHash` — so video layers import as a still of the frame the export captured, not as the clip."
};

export class FigmaExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaExportError";
  }
}

/**
 * Unwrap an export into what `importFigmaFile` expects.
 *
 * A bare node is returned rather than a `{ document }` response because
 * `extractFigmaRoot` already accepts both and wrapping here would put the
 * envelope's shape in front of the one function that decides which is which.
 */
export function parseFigmaExport(value: unknown): ParsedFigmaExport {
  if (!isFigmaPluginExport(value)) {
    throw new FigmaExportError("That file is not a FISH Figma export.");
  }

  const envelope = value as FigmaPluginExport;
  if (envelope.version !== FISH_EXPORT_VERSION) {
    throw new FigmaExportError(
      `That export was written by a different version of the FISH plugin (file version ${String(envelope.version)}, this build reads ${FISH_EXPORT_VERSION}).`
    );
  }

  const document = envelope.document;
  if (!document || document.type !== "DOCUMENT" || !Array.isArray(document.children) || document.children.length === 0) {
    throw new FigmaExportError("That export carries no document — re-export it from the Figma plugin.");
  }

  const images = envelope.images ?? {};
  if (typeof images !== "object") {
    throw new FigmaExportError("That export's image table is not readable.");
  }

  return {
    document,
    variables: Array.isArray(envelope.variables) ? envelope.variables : undefined,
    variableCollections: Array.isArray(envelope.variableCollections) ? envelope.variableCollections : undefined,
    styles: Array.isArray(envelope.styles) ? envelope.styles : undefined,
    imageFills: images,
    rootName: typeof document.name === "string" && document.name ? document.name : "Figma export",
    unreadable: Object.entries(envelope.unreadable ?? {})
      .filter(([, count]) => typeof count === "number" && count > 0)
      .map(([property, count]) => ({ property, count, ...(UNREADABLE_NOTES[property] ? { value: UNREADABLE_NOTES[property] } : {}) }))
  };
}
