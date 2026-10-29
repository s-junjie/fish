import { DesignDocument } from "../dsl/types";
import { writeBytesAtomically } from "./atomic-write";
import { IdbBackend, MemoryBackend, hasIndexedDb } from "./backend";
import { getFileHandle, setFileHandle, clearFileHandle } from "./file-handle";
import { openedFileName, pickerStartIn, getFileName } from "./file-paths";
import { getFileId, adoptFileId, FILE_ID_META_RE } from "./file-identity";
import { reconcileCommentsWithFile, clearDeletedCommentIds } from "../comments/comments-bridge";
import { serializeSelf, payloadHashFromHtml } from "./container";
import { documentTitleFor } from "../document-title";

export interface WriteOutcome {
  /** The file was rewritten. */
  ok: boolean;
  /** Why it was not, when `ok` is false. */
  reason?: string;
  /** The write landed but there is no pre-write copy to fall back on. */
  backupFailed?: boolean;
  /**
   * `computePayloadHash` of the bytes that landed. This is what the fork anchor
   * re-anchors to, so it must describe the file, not the doc we meant to write.
   */
  payloadHash?: string;
}

const backupBackend = hasIndexedDb() ? new IdbBackend() : new MemoryBackend();

/**
 * The text this session last stored as the file's backup.
 *
 * Auto-save runs every couple of seconds and the file it is protecting is
 * unchanged between most of those — so the store was rewritten with 42.6 MB it
 * already held, on the main thread, for every pause in typing. Comparing the
 * fresh read against this is a length-and-memcmp; storing it again is not.
 */
let lastBackup: { fileId: string; text: string } | null = null;

/**
 * Keep the file's current contents before we overwrite it.
 *
 * Not a `.bak` file: writing a sibling file needs `showSaveFilePicker` and
 * therefore a user gesture, so it cannot happen inside an auto-save flush. The
 * copy goes to IndexedDB instead, keyed by file identity, and is what makes a
 * corrupt file recoverable — the state right before our own last write.
 *
 * Reports failure instead of swallowing it. The caller decides what an absent
 * safety net means, because it does not mean the same thing everywhere: an
 * explicit ⌘S is the user's own call, but an unprompted auto-save write that
 * cannot be undone should not proceed on top of no copy.
 */
async function backupBeforeWrite(
  handle: unknown
): Promise<{ ok: true; text?: string } | { ok: false; reason: string }> {
  try {
    const getFile = (handle as { getFile?: () => Promise<{ text: () => Promise<string> }> } | null)?.getFile;
    if (typeof getFile !== "function") return { ok: false, reason: "no-getFile" };
    const text = await (await getFile.call(handle)).text();
    // An empty file has no work to lose, so there is nothing to back up. Refusing
    // here made the first write into a freshly created file impossible.
    if (!text) return { ok: true, text };
    const fileId = getFileId();
    if (lastBackup && lastBackup.fileId === fileId && lastBackup.text === text) {
      return { ok: true, text };
    }
    await backupBackend.put("backups", {
      key: fileId,
      text,
      at: new Date().toISOString()
    });
    lastBackup = { fileId, text };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Contents of the file as of just before our last write to it. */
export async function readFileBackup(fileId: string): Promise<string | undefined> {
  try {
    const row = (await backupBackend.get("backups", fileId)) as { text?: string } | undefined;
    return row?.text;
  } catch {
    return undefined;
  }
}

/**
 * `computePayloadHash` of the design-document block exactly as the file held it,
 * captured once at boot. Letting the user pick a write-back target is only safe
 * if we can prove the file they picked is the one open in this tab, and this is
 * the baseline that proof compares against.
 *
 * Hashed from the file's own text rather than from the parsed document: a
 * comparison that went through normalize would refuse the user's own file the
 * moment the normalizer changed.
 */
let openedFileHash: string | undefined;

export function getOpenedFileHash(): string | undefined {
  return openedFileHash;
}

/** Re-anchor the identity check after the tab adopts a different file. */
export function setOpenedFileHash(payloadHash: string | undefined): void {
  openedFileHash = payloadHash;
}

/**
 * The single write path for a `.fish.html`. Both the explicit save and the
 * silent auto-save write-back go through here, so the pre-write backup can
 * never be skipped by one of them — an auto-save that overwrote the file every
 * two seconds without a backup would be the most dangerous writer in the app.
 *
 * The bytes land through `writeBytesAtomically`, the one place that knows how
 * to replace a file without a window in which it is empty.
 */
export async function writeFileSafely(
  doc: DesignDocument,
  handle: unknown,
  templateHtml?: string,
  opts: { requireBackup?: boolean } = {}
): Promise<WriteOutcome> {
  const backup = await backupBeforeWrite(handle);
  if (!backup.ok && opts.requireBackup) {
    return { ok: false, reason: `backup-unavailable:${backup.reason}` };
  }
  // A fresh timestamp on a copy: `doc` is referenced by undo snapshots, so
  // writing it in place would silently rewrite history entries.
  // The handle's own name, because this write lands in *that* file — which is
  // not necessarily the one this tab was opened from.
  const targetName = (handle as { name?: string } | null)?.name;
  const mergedComments = reconcileCommentsWithFile(backup.ok ? backup.text : undefined);
  const fileContent = serializeSelf({ ...doc, updatedAt: new Date().toISOString() }, templateHtml, {
    title: documentTitleFor(targetName, doc.name),
    ...(mergedComments ? { comments: mergedComments } : {})
  });
  await writeBytesAtomically(handle, fileContent);
  // The deletions are on disk now, so remembering them can only do harm: a
  // thread an agent legitimately re-adds under the same id would be dropped.
  clearDeletedCommentIds();
  // The file on disk now carries a fileId stamp. Mirror it into this page so the
  // id stays stable for the rest of the session: `getFileId` reads the DOM, and
  // the handle is persisted under that id. Without this the handle would be
  // filed under the name-derived fallback id, which the next load — now reading
  // the stamp out of the file — would never look up, so the user would be asked
  // to pick the file again on every single open.
  const writtenId = FILE_ID_META_RE.exec(fileContent)?.[1];
  if (writtenId) adoptFileId(writtenId);
  const payloadHash = payloadHashFromHtml(fileContent);
  // The file on disk now holds these bytes, and the identity check proves a
  // picked handle against the file as it was OPENED — a baseline left at boot
  // refuses the user's own file as soon as that file has moved on, which it has
  // after an explicit save or after auto-save has been writing for a while.
  // Not moved when the write landed in a differently named file: a ⌘S save-as
  // is not the file this tab is showing, and adopting it would make the next
  // relink accept that copy.
  // `getFileName` (handle first) rather than the URL: once a save-as has adopted
  // the new handle this tab is editing that file, and every later auto-save of
  // it must move the baseline too. Before adoption the handle is still the old
  // one, so a save-as write leaves the original file's baseline alone.
  const opened = getFileName();
  if (!targetName || !opened || targetName === opened) openedFileHash = payloadHash;
  return {
    ok: true,
    payloadHash,
    ...(backup.ok ? {} : { backupFailed: true })
  };
}

export async function saveInPlace(doc: DesignDocument): Promise<{
  success: boolean;
  method: "fsa" | "download";
  filename: string;
  error?: string;
  payloadHash?: string;
}> {
  let templateHtml: string | undefined;
  // Serialize a copy with a fresh timestamp instead of mutating the live
  // document: `doc` is referenced by undo snapshots, so an in-place write here
  // would silently rewrite history entries and break the immutable invariant.
  const docToWrite: DesignDocument = { ...doc, updatedAt: new Date().toISOString() };

  // In Vite dev mode, document.documentElement.outerHTML contains unbundled Vite dev script tags
  // which causes the exported HTML to be blank when opened standalone via file://.
  // We fetch the standalone single-file bundle from the dev server if running under dev mode.
  const isDev =
    typeof process !== "undefined" && process.env?.NODE_ENV === "development"
      ? true
      : typeof window !== "undefined" && (window.location?.port === "5173" || window.location?.port === "3000");
  if (typeof window !== "undefined" && isDev) {
    try {
      const res = await fetch("/__fish_bundle__");
      if (res.ok) {
        templateHtml = await res.text();
      } else {
        const distRes = await fetch("/dist/index.html");
        if (distRes.ok) {
          templateHtml = await distRes.text();
        }
      }
    } catch {
      // Fallback to pristineHtml
    }
  }

  // Default to the name of the file being edited. Falling back to the document
  // name here made "save" look like "save as": the picker offered an unrelated
  // name, users accepted it, and auto-save then wrote to a file that was not
  // the one open in the tab — with the URL still pointing at the original.
  const filename =
    openedFileName() || `${(doc.name || "untitled").toLowerCase().replace(/\s+/g, "-")}.fish.html`;

  let currentFileHandle = getFileHandle();

  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      if (currentFileHandle) {
        let perm = "granted";
        if (typeof currentFileHandle.queryPermission === "function") {
          try {
            perm = await currentFileHandle.queryPermission({ mode: "readwrite" });
          } catch {
            perm = "prompt";
          }
        }
        if (perm === "prompt" && typeof currentFileHandle.requestPermission === "function") {
          try {
            perm = await currentFileHandle.requestPermission({ mode: "readwrite" });
          } catch {
            perm = "denied";
          }
        }
        if (perm !== "granted") {
          currentFileHandle = null;
          setFileHandle(null);
        }
      }

      if (!currentFileHandle) {
        const startIn = pickerStartIn();
        currentFileHandle = await (window as any).showSaveFilePicker({
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
        setFileHandle(currentFileHandle);
      }

      // Routed through the shared writer so the pre-write backup is taken here
      // too — this is the one path the auto-save layer does not control. The
      // user asked for this save, so a missing backup is reported rather than
      // treated as a reason to refuse.
      const outcome = await writeFileSafely(doc, currentFileHandle, templateHtml);
      if (!outcome.ok) {
        return { success: false, method: "fsa", filename, error: outcome.reason };
      }

      return {
        success: true,
        method: "fsa",
        filename: currentFileHandle.name || filename,
        payloadHash: outcome.payloadHash
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { success: false, method: "fsa", filename };
      }
      clearFileHandle();
      // A failed in-place write is not a save. This used to fall through to the
      // download branch and return `success: true`, which made the UI claim the
      // file was written and re-anchored the fork to content the file did not
      // hold. It also does not silently download: an unexpected download is the
      // "save became save-as" trap the filename default above exists to avoid.
      // The recovery snapshot still holds the work, and the status tells the user.
      return {
        success: false,
        method: "fsa",
        filename,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // No File System Access API at all — a download is the only way to save.
  // The title is named from `filename`, which on this path is the file being
  // written: the tab may be looking at a `file://` page this download replaces.
  const fileContent = serializeSelf(docToWrite, templateHtml, {
    title: documentTitleFor(filename, docToWrite.name)
  });
  const blob = new Blob([fileContent], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { success: true, method: "download", filename };
}

