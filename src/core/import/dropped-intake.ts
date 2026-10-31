import { pickedJsonFromRaw, type PickedJson } from "../persistence/json-file";
import { readDocumentFromHtml } from "../persistence/container";
import { describeImportRefusal, refuseFile } from "./import-limits";
import { FigmaExportError, isFigmaPluginExport } from "./figma-export";
import { figmaImportErrorMessage, readFigmaImportFile, type FigmaReadProgress } from "./figma-file-read";
import { standaloneFigmaDocument } from "./figma-landing";
import { withImportedDesignSystem } from "./imported-tokens";
import { looksLikeZip } from "./figma-bundle";
import { t } from "../../i18n";

/**
 * A file dropped on the app, read as a document.
 *
 * THE THREE-BOX RULE. What can arrive is one of three things the app itself
 * writes or exports: a `.fish.json` sidecar, a `.fish.html` file, and the zip the
 * Figma plugin packs. They are told apart by content rather than by extension,
 * because extension is the thing a user is most likely to have renamed, and each
 * is handed to the reader that already owned that format — inventing a fourth
 * normalisation would let the same bytes land differently depending on whether
 * they were dropped or picked.
 *
 * WHY THIS EXISTS AS ONE MODULE. Three separate drop handlers would each grow
 * their own idea of "supported file", and the dragover reply has to agree with
 * the drop. One intake is what makes the cursor honest: every file the pointer
 * promises to take is one this module can answer for.
 */

const MEDIA_EXTENSIONS = /\.(png|jpe?g|webp|svg|gif|mp4|webm|ogg|mov|m4v)$/i;

/**
 * The MIME types a drop of ours can arrive as.
 *
 * `octet-stream` is in here because it is what several filesystems report for a
 * `.zip`, and leaving it out would refuse the plugin's own export on the desktop
 * that produced it. `""` is not a type in this list but the answer to the same
 * question — see `dragCarriesDocument`.
 */
const DOCUMENT_MIME = new Set([
  "application/json",
  "text/json",
  "text/html",
  "application/xhtml+xml",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream"
]);

export function isDroppedMedia(file: File): boolean {
  return file.type.startsWith("image/") || file.type.startsWith("video/") || MEDIA_EXTENSIONS.test(file.name || "");
}

/**
 * Whether anything in this drag is something the intake can read.
 *
 * A DRAG IS ANSWERED WITHOUT ITS FILES. The browser publishes types and nothing
 * else before the drop — no name, no bytes — so this is a guess made from MIME
 * alone, and it is deliberately generous about it: an empty type is what macOS
 * reports for any extension it has no UTI for, which includes every one of ours,
 * so refusing it would refuse our own files. The promise is therefore kept by
 * `readDroppedDocument` rather than by the cursor: anything that gets past here
 * and turns out to be foreign gets a sentence saying so instead of silence.
 */
export function dragCarriesDocument(dt: DataTransfer | null): boolean {
  const mimes = publishedMimes(dt);
  if (!mimes) return false;
  // ONLY "Files": every OS that publishes a bare file drag with no type does it
  // to our own extensions as often as to anything else, so there is nothing here
  // to say no on. Letting it through is what makes the known-MIME answer below
  // able to be a refusal.
  if (mimes.length === 0) return true;
  // `text/` is in rather than out because a `.json` or `.html` renamed to `.txt`
  // still has our document inside it, and the drop answers that file with a
  // sentence rather than with a guess.
  return mimes.some((mime) => mime === "" || DOCUMENT_MIME.has(mime) || mime.startsWith("text/"));
}

export function dragCarriesMedia(dt: DataTransfer | null): boolean {
  const mimes = publishedMimes(dt);
  if (!mimes) return false;
  if (mimes.length === 0) return true;
  return mimes.some((mime) => mime.startsWith("image/") || mime.startsWith("video/"));
}

/** The MIME types a drag offered, `null` when there is no file drag at all. */
function publishedMimes(dt: DataTransfer | null): string[] | null {
  if (!dt) return null;
  const types = Array.from(dt.types || []).map((type) => type.toLowerCase());
  if (!types.includes("files")) return null;
  return types.filter((type) => type !== "files");
}

/** Whether this drag could be ours at all, media included: the dragover gate. */
export function acceptsDroppedFiles(dt: DataTransfer | null): boolean {
  return dragCarriesDocument(dt) || dragCarriesMedia(dt);
}

export function partitionDroppedFiles(files: readonly File[]): { media: File[]; documents: File[] } {
  const media: File[] = [];
  const documents: File[] = [];
  for (const file of files) (isDroppedMedia(file) ? media : documents).push(file);
  return { media, documents };
}

export type DroppedDocumentRead = { ok: true; picked: PickedJson } | { ok: false; message: string };

export interface DroppedDocumentOptions {
  onProgress?: FigmaReadProgress;
}

/**
 * Read one dropped file as one document, or say why it is not one.
 *
 * A refusal is always a sentence. The canvas used to take every drag and then
 * keep only the pictures out of it, so a `.fish.html` was promised a landing and
 * given none — worse than saying no, because nothing appeared to have happened.
 */
export async function readDroppedDocument(file: File, options?: DroppedDocumentOptions): Promise<DroppedDocumentRead> {
  const oversize = refuseFile(file.size);
  if (oversize) return { ok: false, message: describeImportRefusal(oversize) };

  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (looksLikeZip(head)) return await readAsFigma(file, undefined, options);

    const text = await file.text();
    if (text.trimStart().startsWith("<")) return readAsHtml(file, text);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, message: t("documentJson.dropUnsupported") };
    }
    if (isFigmaPluginExport(raw) || isForeignFigmaShape(raw)) return await readAsFigma(file, raw, options);
    // EVERY JSON IS NOT A DOCUMENT, and the dialog this lands in offers to throw
    // away what is open. A stray `.json` normalises into a page-less ghost rather
    // than failing, so offering it would put "replace everything with nothing"
    // one click behind a drag. `pages` is what every exported document carries.
    if (!looksLikeFishDocument(raw)) return { ok: false, message: t("documentJson.dropUnsupported") };
    return { ok: true, picked: pickedJsonFromRaw(raw, file.name) };
  } catch (err) {
    return { ok: false, message: figmaImportErrorMessage(err) };
  }
}

/**
 * A Figma payload that is not one of the plugin's envelopes.
 *
 * REST's `/v1/files` answer lands here too, and handing it to the document reader
 * would normalise it into an empty document rather than refuse it — a successful
 * import of nothing. `parseFigmaExport` says why instead.
 */
function isForeignFigmaShape(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as { document?: unknown; pages?: unknown };
  return Boolean(value.document) && !Array.isArray(value.pages);
}

function looksLikeFishDocument(raw: unknown): boolean {
  return Boolean(raw) && typeof raw === "object" && Array.isArray((raw as { pages?: unknown }).pages);
}

function readAsHtml(file: File, text: string): DroppedDocumentRead {
  const read = readDocumentFromHtml(text);
  if (!read) return { ok: false, message: t("documentJson.dropUnsupported") };
  return { ok: true, picked: { fileName: file.name, doc: read.document, repairs: read.repairs } };
}

/**
 * The Figma door, aimed at a document rather than at the one already open.
 *
 * No `styles`/`tokens` are passed in: the design system this produces belongs to
 * the file being read, so that a replace carries its own tokens with it instead
 * of leaving a document whose layers point at a value nobody imported.
 */
async function readAsFigma(
  file: File,
  envelope: unknown,
  options?: DroppedDocumentOptions
): Promise<DroppedDocumentRead> {
  try {
    const { result } = await readFigmaImportFile(
      file,
      { styles: [], tokens: [] },
      { envelope, onProgress: options?.onProgress }
    );
    const doc = standaloneFigmaDocument(result);
    const picked: PickedJson = {
      fileName: file.name,
      doc: { ...doc, ...withImportedDesignSystem(doc, result.tokens) },
      repairs: []
    };
    return { ok: true, picked };
  } catch (err) {
    if (err instanceof FigmaExportError) return { ok: false, message: err.message };
    throw err;
  }
}
