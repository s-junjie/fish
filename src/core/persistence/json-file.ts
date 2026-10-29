import type { DesignDocument } from "../dsl/types";
import { normalizeDesignDocument } from "../dsl/normalize/document";
import type { NormalizationRepair } from "../dsl/normalize/shared";
import { documentJson } from "../document-json";
import { documentJsonFileName } from "../document-import";
import { getFileName, pickerStartIn, type PickerStartIn } from "../data-bridge";
import { writeBytesAtomically } from "./atomic-write";

/**
 * The `.fish.json` sidecar — a document with no shell around it.
 *
 * Not a new persistence path. The `.fish.html` file remains the only thing
 * auto-save writes and the only thing `Open in this tab` reads; this is the
 * transport an author hands to an agent or a diff, and the file the import side
 * reads back. Both forms come from `core/document-json.ts`, so what is exported
 * is byte-for-byte what an import will accept.
 */

export type JsonExportResult = { ok: true } | { ok: false; reason: string };

const JSON_MIME = { "application/json": [".json"] };

/**
 * Write the document out as a `.fish.json` file the user chooses.
 *
 * Pretty-printed, because the export's two readers are a human reading a diff
 * and the agent form — which has its own row, on the clipboard, and is the one
 * that is meant to be pasted. `showSaveFilePicker` where the browser has it, an
 * anchor download where it does not, so the export is not Chromium-only.
 *
 * The picker opens in the folder the document came from, so the sidecar lands
 * beside its `.fish.html` rather than wherever the last save happened to be.
 */
export async function saveDocumentJson(doc: DesignDocument): Promise<JsonExportResult> {
  const text = documentJson(doc);
  const picker = (globalThis as { showSaveFilePicker?: SavePickerFn }).showSaveFilePicker;
  const suggestedName = documentJsonFileName(doc, getFileName());
  const startIn = pickerStartIn();

  if (typeof picker !== "function") {
    downloadBlob(new Blob([text], { type: "application/json;charset=utf-8" }), suggestedName);
    return { ok: true };
  }

  let handle: FileSystemFileHandleLike;
  try {
    handle = await picker({
      suggestedName,
      id: "fish-document-json",
      ...(startIn ? { startIn } : {}),
      types: [{ description: "FISH JSON Document (*.fish.json)", accept: JSON_MIME }]
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return { ok: false, reason: "aborted" };
    return { ok: false, reason: e instanceof Error ? e.message : "picker-failed" };
  }

  try {
    // Same atomic path as a `.fish.html` write: overwriting an existing sidecar
    // is a normal answer to the picker, and both failure modes are real here —
    // a bare `createWritable()` empties the file first, and a shorter export
    // over a longer one leaves the previous document's tail behind.
    await writeBytesAtomically(handle, text);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "write-failed" };
  }
}

export interface PickedJson {
  fileName: string;
  doc: DesignDocument;
  /** Normalisation repairs, so the dialog can show rather than swallow them. */
  repairs: NormalizationRepair[];
}

/**
 * Read a `.fish.json` off disk and run it through the same reader a stored
 * document went through, so what the dialog reports is what will land.
 *
 * The raw parse happens here rather than in the dialog because the file may not
 * be JSON at all, and "that file is not a FISH document" is the answer the user
 * needs before any choice about replacing is on screen.
 */
export async function pickDocumentJson(): Promise<
  | { ok: true; picked: PickedJson }
  | { ok: false; reason: string }
> {
  const picker = (globalThis as { showOpenFilePicker?: OpenPickerFn }).showOpenFilePicker;
  if (typeof picker !== "function") return { ok: false, reason: "no-open-picker" };
  const startIn = pickerStartIn();

  let handles: FileSystemFileHandleLike[];
  try {
    handles = await picker({
      multiple: false,
      id: "fish-document-json",
      ...(startIn ? { startIn } : {}),
      types: [{ description: "FISH JSON Document (*.fish.json)", accept: JSON_MIME }]
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return { ok: false, reason: "aborted" };
    return { ok: false, reason: e instanceof Error ? e.message : "picker-failed" };
  }

  const handle = handles?.[0];
  if (!handle?.getFile) return { ok: false, reason: "no-file" };

  let raw: unknown;
  try {
    raw = JSON.parse(await (await handle.getFile()).text());
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "not-json" };
  }

  const { document, repairs } = normalizeDesignDocument(raw);
  return { ok: true, picked: { fileName: handle.name, doc: document as DesignDocument, repairs } };
}

/** The `<input type="file">` door, for the browsers with no `showOpenFilePicker`. */
export async function readDocumentJsonFile(file: File): Promise<
  | { ok: true; picked: PickedJson }
  | { ok: false; reason: string }
> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "not-json" };
  }
  const { document, repairs } = normalizeDesignDocument(raw);
  return { ok: true, picked: { fileName: file.name, doc: document as DesignDocument, repairs } };
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface FileSystemFileHandleLike {
  name: string;
  getFile?: () => Promise<{ text: () => Promise<string> }>;
  createWritable?: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
}

type SavePickerFn = (opts: {
  suggestedName: string;
  types?: { description?: string; accept?: Record<string, string[]> }[];
  startIn?: PickerStartIn;
  id?: string;
}) => Promise<FileSystemFileHandleLike>;

type OpenPickerFn = (opts: {
  multiple?: boolean;
  types?: { description?: string; accept?: Record<string, string[]> }[];
  startIn?: PickerStartIn;
  id?: string;
}) => Promise<FileSystemFileHandleLike[]>;