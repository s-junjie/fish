/**
 * The file's own `lastModified`, as this session last saw it: at the read that
 * proved a handle, or right after a write of our own.
 *
 * This number is the whole external-edit check. Auto-save writes every couple of
 * seconds, so a write that replaces content somebody else put there is not an
 * edge case — it is the default outcome the moment a sync client, a second
 * editor or an agent touches the file. A content hash would be the stronger
 * proof, but the payload carries inline bitmaps: hashing tens of megabytes on
 * the main thread for every pause in typing is not a trade this app can make,
 * and `lastModified` comes free with the read the backup already performs.
 *
 * `undefined` means "no baseline yet", and the check must read it as "let the
 * write through". A session that has neither written nor proved a handle has
 * nothing to compare against, and refusing there would turn one missing fact
 * into a permanently dead auto-save.
 */
let stamp: number | undefined;

/**
 * Why a write was refused, spelled once.
 *
 * Three writers and a UI branch match on it; a second hand-copied string would
 * stop matching without failing anything.
 */
export const FILE_CHANGED_REASON = "file-changed-on-disk";

export function fileStamp(): number | undefined {
  return stamp;
}

export function setFileStamp(value: number | undefined): void {
  stamp = typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Record the stamp of the file behind `handle`, or clear it when the file cannot
 * be stat'ed.
 *
 * Clearing rather than keeping the previous value is the honest answer: every
 * caller here has just read or written that file, so an unreadable handle is the
 * condition that already refuses an auto-save write (`requireBackup`). Keeping a
 * stale number would instead turn "unreadable" into a conflict banner that no
 * button clears.
 */
export async function rememberFileStamp(handle: unknown): Promise<void> {
  const getFile = (handle as { getFile?: () => Promise<{ lastModified?: number }> } | null)?.getFile;
  if (typeof getFile !== "function") {
    setFileStamp(undefined);
    return;
  }
  try {
    setFileStamp((await getFile.call(handle))?.lastModified);
  } catch {
    setFileStamp(undefined);
  }
}
