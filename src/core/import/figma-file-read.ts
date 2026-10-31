import { importFigmaFile as importFigmaJson, type ImportFigmaFileOutcome } from "./figma-import";
import type { FigmaImportOptions } from "./figma-types";
import { FigmaExportError, parseFigmaExport } from "./figma-export";
import { looksLikeZip, readFigmaBundle, FigmaBundleError } from "./figma-bundle";
import { blobsFromImageFills } from "./figma-assets";
import { t } from "../../i18n";

/**
 * File bytes to a converted design, whichever box the plugin packed it in.
 *
 * Shared rather than private to `useFigmaImport` because a drop now arrives here
 * too, and two pickups would drift: the bundle detection is four bytes of magic
 * and a manifest lookup, and the second reader would be the one a user finds.
 */

/** Same noun-based shape the hint used from inside the hook. */
export type FigmaReadProgress = (stage: "images", done: number, total: number) => void;

export interface FigmaFileRead {
  result: ImportFigmaFileOutcome;
  /** Swallowed content the report does not already count, said out loud. */
  notes: string[];
}

export async function readFigmaImportFile(
  file: File,
  existing: FigmaImportOptions,
  options?: { onProgress?: FigmaReadProgress; envelope?: unknown }
): Promise<FigmaFileRead> {
  const bundle = options?.envelope ? null : await readBundle(file);
  const envelope = options?.envelope ?? bundle?.manifest ?? undefined;
  const parsed = parseFigmaExport(envelope ?? (await readManifestText(file)));

  // TWO PACKAGINGS, ONE POLICY. The folder hands its images over as bytes; the
  // single-file form — and the clipboard copy, which can only be text — inlines
  // them as data URIs. The difference used to end there: a data URI was
  // registered verbatim, so the same photograph imported at 2.6MB as a `.json`
  // and re-encoded as a folder. So the inline form is unpacked into bytes HERE
  // and both take the blob path, which is where the app's image policy lives.
  const imageBlobs = bundle ? bundle.images : blobsFromImageFills(parsed.imageFills);

  const result = await importFigmaJson(
    // A bare node carries neither, and wrapping it in a response only to hold
    // `undefined` would make `extractFigmaRoot` decide between two spellings of
    // the same thing.
    parsed.variables || parsed.styles
      ? {
          document: parsed.document,
          variables: parsed.variables,
          variableCollections: parsed.variableCollections,
          styles: parsed.styles
        }
      : parsed.document,
    { ...existing, onProgress: options?.onProgress, imageBlobs }
  );

  // Counted in LAYERS, not in kinds: "1 property could not be read" tells a
  // designer nothing about whether their file is intact. A ref the manifest
  // named but the archive does not carry counts here too — a gap said out loud,
  // rather than a blank rectangle nobody can account for.
  const lostLayers = parsed.unreadable.reduce((sum, gap) => sum + gap.count, 0) + (bundle?.missing.length ?? 0);
  return {
    result,
    notes: lostLayers > 0 ? [t("figmaImport.exportPartialNote", { n: lostLayers })] : []
  };
}

/** The four bytes that tell the zip apart from the JSON the plugin wrote first. */
async function readBundle(file: File) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return looksLikeZip(head) ? readFigmaBundle(file) : null;
}

async function readManifestText(file: File): Promise<unknown> {
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new FigmaExportError(t("figmaImport.errNotExport"));
  }
}

/**
 * Turn a read failure into the sentence the notice shows.
 *
 * Both file-level failures are named explicitly because being handed the wrong
 * file is the expected mistake — a designer has a folder of zips — and each
 * already comes with a sentence that says what to do about it. The fall-through
 * is for an unexpected failure, and it still says something rather than nothing.
 */
export function figmaImportErrorMessage(err: unknown): string {
  if (err instanceof FigmaExportError || err instanceof FigmaBundleError) return err.message;
  if (err instanceof SyntaxError) return t("figmaImport.errNotExport");
  return err instanceof Error && err.message ? err.message : t("figmaImport.failed");
}
