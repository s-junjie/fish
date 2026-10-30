import type { DesignDocument } from "../dsl/types";
import {
  serializeSelf,
  getFileHandle,
  setFileHandle,
  openedFileName,
  pickerStartIn,
  type PickerStartIn,
  payloadHashFromHtml,
  fileIdFromHtml,
  writeFileSafely
} from "../data-bridge";
import { documentTitleFor } from "../document-title";
import { writeBytesAtomically } from "./atomic-write";
import { IdbBackend, MemoryBackend, hasIndexedDb } from "./backend";
import { createHandleStore, type HandleStore, type FileSystemFileHandleLike } from "./handles";

const backend = hasIndexedDb() ? new IdbBackend() : new MemoryBackend();
const handleStore: HandleStore = createHandleStore(backend);

/** Persist the active handle under `docId` so it survives a page reload. */
export async function persistHandle(docId: string): Promise<void> {
  const h = getFileHandle();
  if (h) await handleStore.save(docId, h as FileSystemFileHandleLike);
}

/** Restore a persisted handle for `fileId` into the active session. */
export async function loadHandle(fileId: string): Promise<void> {
  const h = await handleStore.load(fileId);
  if (h) setFileHandle(h);
}

/** Forget a persisted handle that turned out not to be this file. */
export async function forgetHandle(fileId: string): Promise<void> {
  await handleStore.clear(fileId);
}

/**
 * Name of the file auto-save will write to. With no handle yet this is the file
 * the page was opened from, which is a promise we cannot keep — FSA can only
 * reach a file the user has explicitly picked. The UI shows this so the user
 * can tell whether the tab and the write-back target are still the same file.
 */
export function writebackTargetName(): string | undefined {
  const handle = getFileHandle();
  return (handle as { name?: string } | null)?.name ?? openedFileName();
}

type OpenFilePickerFn = (opts: {
  multiple?: boolean;
  types?: { description?: string; accept?: Record<string, string[]> }[];
  startIn?: PickerStartIn;
  id?: string;
}) => Promise<FileSystemFileHandleLike[]>;

/**
 * Ask the user to point at the file auto-save should write back to.
 *
 * Deliberately NOT `showSaveFilePicker`: that creates a file, and a tab opened
 * from `file://` cannot navigate to it — the URL would keep showing the
 * original while every auto-save rewrote the copy, with no on-screen clue that
 * the two had separated. Opening only ever grants a handle to a file that
 * already exists, which is exactly "the file I am looking at".
 */
export async function pickWritebackFile(): Promise<{
  ok: boolean;
  reason?: string;
  name?: string;
  handle?: FileSystemFileHandleLike;
}> {
  const picker = (typeof window !== "undefined" ? (window as any).showOpenFilePicker : undefined) ?? (globalThis as any).showOpenFilePicker;
  if (typeof picker !== "function") return { ok: false, reason: "no-open-picker" };
  const startIn = pickerStartIn();
  let handles: FileSystemFileHandleLike[];
  try {
    // No `types` filter here on purpose: `verifyPickedFile` already refuses
    // every file except the exact one open in this tab, and passing `types`
    // makes Chromium set `_dialog.allowedFileTypes` on macOS `NSOpenPanel` —
    // where `openAndSavePanelService` intermittently greys out the very
    // `.fish.html` just launched from Finder on the first open while leaving
    // sibling `.html` files enabled. Without `types`, `_dialog.allowedFileTypes`
    // is `nil` and every file in the folder stays selectable.
    handles = await picker({
      multiple: false,
      id: "fish-document",
      ...(startIn ? { startIn } : {})
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return { ok: false, reason: "aborted" };
    return { ok: false, reason: e instanceof Error ? e.message : "picker-failed" };
  }
  const handle = handles?.[0];
  if (!handle) return { ok: false, reason: "no-file" };
  // Deliberately not installed as the active handle yet: it only becomes the
  // write-back target once `verifyPickedFile` has proven it is the file open in
  // this tab. Adopting it first would let one wrong click silently redirect
  // every future auto-save at an unrelated file.
  return { ok: true, name: handle.name, handle };
}

/**
 * Prove that a freshly picked handle points at the file this tab was opened
 * from, on two axes: the document inside it, and its name.
 *
 * Reading needs only the read permission the open picker already granted, so
 * this costs nothing and turns "trust the user picked correctly" into a check.
 * A mismatch is refused outright: auto-saving into a file the user is not
 * looking at is precisely the failure this whole flow exists to prevent — and
 * for an empty shell the baseline *is* the empty document, so picking a file
 * that already has work in it is refused rather than silently overwritten.
 *
 * Content alone is not enough: it proves "the same document", not "the same
 * file". Every empty shell hashes alike, so a content-only check let the shell
 * adopt *any* empty `.fish.html` on disk — while a content-bearing file could
 * only ever adopt itself. The name is the only other identity a `file://` page
 * can hold (it cannot read its own path beyond `openedFileName`), so the two
 * together are the strongest proof available. `expectedName` is omitted when
 * the tab is not a real file — the dev bundle route, for instance — because a
 * name that is not a file name proves nothing.
 */
export async function verifyPickedFile(
  handle: FileSystemFileHandleLike,
  expectedHash: string | undefined,
  expectedName?: string,
  expectedFileId?: string
): Promise<{ ok: boolean; reason?: string }> {
  // Only reachable outside a browser (tests); a real page always has a baseline.
  if (!expectedHash) return { ok: true };
  const getFile = (handle as { getFile?: () => Promise<{ text: () => Promise<string> }> }).getFile;
  if (typeof getFile !== "function") return { ok: false, reason: "cannot-read" };
  let text: string;
  try {
    text = await (await getFile.call(handle)).text();
  } catch {
    return { ok: false, reason: "cannot-read" };
  }
  const hash = payloadHashFromHtml(text);
  if (hash === undefined) return { ok: false, reason: "not-a-fish-file" };
  // Content alone refuses the user's own file after anything outside this app
  // rewrote it (a CLI `fish apply`, an external editor). The `fish:fileId` stamp
  // survives that rewrite and names *this* file, so it is the second proof —
  // still paired with the name check below, which stops a copy being adopted.
  if (hash !== expectedHash && (!expectedFileId || fileIdFromHtml(text) !== expectedFileId)) {
    return { ok: false, reason: "content-mismatch" };
  }
  // Strict on purpose: a handle with no name at all cannot be shown to be this
  // file, and a real File System Access handle always carries one.
  if (expectedName && handle.name !== expectedName) return { ok: false, reason: "name-mismatch" };
  return { ok: true };
}

/**
 * Prove a handle restored from IndexedDB still points at the file open in this
 * tab, and drop it when it does not.
 *
 * Handles are filed under the `fileId` the shell carries, and a byte-level copy
 * carries that stamp too — so a copy, renamed or not, loads the *original's*
 * handle, and re-arming write-back on it rewrites the original on the next
 * auto-save. `verifyPickedFile` is the only proof available; see it for why the
 * name is required and for the one case it cannot separate — a copy under the
 * same name in another directory.
 *
 * Forgetting the handle on failure is the point: leaving it in place would
 * re-arm the same wrong target on every single reload.
 */
export async function verifyRestoredHandle(
  fileId: string,
  expectedHash: string | undefined,
  expectedName?: string
): Promise<{ ok: boolean; reason?: string }> {
  const handle = getFileHandle();
  if (!handle) return { ok: false, reason: "no-handle" };
  const check = await verifyPickedFile(handle, expectedHash, expectedName, fileId);
  if (check.ok) return { ok: true };
  setFileHandle(null);
  await forgetHandle(fileId).catch(() => undefined);
  return check;
}

export type WritebackPermission = "granted" | "prompt" | "denied" | "unsupported";

export async function queryWritebackPermission(): Promise<WritebackPermission> {
  const h = getFileHandle();
  if (!h || typeof h.queryPermission !== "function") return "unsupported";
  const state = await h.queryPermission({ mode: "readwrite" });
  return state === "granted" || state === "denied" ? state : "prompt";
}

export async function requestWritebackPermission(): Promise<WritebackPermission> {
  const h = getFileHandle();
  if (!h || typeof h.requestPermission !== "function") return "unsupported";
  const state = await h.requestPermission({ mode: "readwrite" });
  return state === "granted" ? "granted" : state === "denied" ? "denied" : "prompt";
}

export interface WritebackResult {
  ok: boolean;
  reason?: string;
  /** `computePayloadHash` of the bytes that landed — the fork's new anchor. */
  payloadHash?: string;
  handle?: FileSystemFileHandleLike;
  name?: string;
  fileId?: string;
}

/**
 * Silently rewrite the open `.fish.html` in place via FSA. Requires an already
 * granted handle — unlike `saveInPlace` this never prompts, so it is safe to
 * call from the auto-save flush path.
 */
export async function writeBackFile(doc: DesignDocument): Promise<WritebackResult> {
  const h = getFileHandle();
  if (!h || typeof h.createWritable !== "function") return { ok: false, reason: "no-handle" };
  const perm = await queryWritebackPermission();
  if (perm !== "granted") return { ok: false, reason: `permission:${perm}` };
  try {
    // `requireBackup`: nobody asked for this write, so overwriting the file on
    // top of no recoverable copy is the one combination that can lose work
    // without the user ever pressing anything. The explicit ⌘S path does not
    // require it — that save is the user's own call, and it reports the missing
    // net instead of refusing.
    const outcome = await writeFileSafely(doc, h, undefined, { requireBackup: true });
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    return { ok: true, payloadHash: outcome.payloadHash };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "write-failed" };
  }
}

/** The name offered by Save As, keeping `.htm` a `.fish.html` copy. */
export function saveAsCopyName(currentName: string): string {
  return currentName.replace(/(\.fish)?\.html?$/i, "-copy.fish.html");
}

/**
 * Save a document as a *new* standalone `.fish.html` — used to export a named
 * version as a sidecar. Prompts the user for a location via
 * `showSaveFilePicker` (requires a user gesture). Does NOT touch the active
 * handle, so the current file is never overwritten.
 *
 * `templateHtml` replaces the shell the document is poured into, which is how
 * the update path writes a document into a NEWER shell (see `core/update`). It
 * defaults to this session's own shell, so every existing caller keeps the
 * version it is running.
 */
export async function saveDocAsNewFile(
  doc: DesignDocument,
  filename: string,
  templateHtml?: string,
  opts?: { freshFileId?: boolean }
): Promise<WritebackResult> {
  const picker = (typeof window !== "undefined" ? (window as any).showSaveFilePicker : undefined) ?? (globalThis as any).showSaveFilePicker;
  if (typeof picker !== "function") {
    if (typeof document !== "undefined") {
      const fileContent = serializeSelf(doc, templateHtml, {
        ...opts,
        title: documentTitleFor(filename, doc.name)
      });
      const blob = new Blob([fileContent], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.endsWith(".html") ? filename : `${filename}.fish.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return { ok: true };
    }
    return { ok: false, reason: "no-save-picker" };
  }
  let handle: FileSystemFileHandleLike;
  const startIn = pickerStartIn();
  try {
    handle = await picker({
      suggestedName: filename,
      id: "fish-document",
      ...(startIn ? { startIn } : {}),
      types: [
        {
          description: "FISH Single-File Design Document (*.fish.html)",
          accept: { "text/html": [".html", ".htm"] }
        }
      ]
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return { ok: false, reason: "aborted" };
    return { ok: false, reason: e instanceof Error ? e.message : "picker-failed" };
  }
  const fileContent = serializeSelf(doc, templateHtml, {
    ...opts,
    // The name the user just chose, not this tab's: a save-as writes a copy, and
    // the copy's own title is the one it will be opened under.
    title: documentTitleFor(handle.name ?? filename, doc.name)
  });
  try {
    if (typeof handle.createWritable !== "function") {
      return { ok: false, reason: "no-writable" };
    }
    // A save-as may land on a file that already exists — the picker offers the
    // current name, and choosing it is a legitimate "replace this". A bare
    // `createWritable()` would truncate that file to zero bytes before the
    // first byte is written, so a failure here had nothing to fall back on.
    await writeBytesAtomically(handle, fileContent);
    const writtenId = (/<meta\s+name=["']fish:fileId["']\s+content=["']([^"']+)["']/i).exec(fileContent)?.[1];
    const payloadHash = payloadHashFromHtml(fileContent);
    return {
      ok: true,
      handle,
      name: handle.name ?? filename,
      fileId: writtenId,
      payloadHash
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "write-failed" };
  }
}

type SaveFilePickerFn = (opts: {
  suggestedName: string;
  types?: { description?: string; accept?: Record<string, string[]> }[];
  startIn?: PickerStartIn;
  id?: string;
}) => Promise<FileSystemFileHandleLike>;
