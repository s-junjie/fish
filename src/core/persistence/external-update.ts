export type DiskUpdateOutcome =
  | { status: "unchanged" }
  | { status: "dismissed"; mtime: number }
  | { status: "updated"; mtime: number }
  | { status: "conflict"; mtime: number };

interface ReadableFileHandle {
  getFile?: () => Promise<{ lastModified?: number }>;
  queryPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<string>;
}

/**
 * Inspect whether the backing file moved on disk since `baselineStamp`.
 *
 * Focus checks must stay silent: read permission alone is checked when the
 * handle provides `queryPermission`, so returning to the tab never opens a
 * browser permission prompt or replaces edits behind the user's back.
 */
export async function inspectExternalUpdate(opts: {
  handle: unknown;
  baselineStamp: number | undefined;
  dismissedMtime: number | null;
  hasLocalEdits: boolean;
}): Promise<DiskUpdateOutcome> {
  const { handle, baselineStamp, dismissedMtime, hasLocalEdits } = opts;
  if (!handle || baselineStamp === undefined) return { status: "unchanged" };
  const fileHandle = handle as ReadableFileHandle;
  if (typeof fileHandle.getFile !== "function") return { status: "unchanged" };
  try {
    if (typeof fileHandle.queryPermission === "function") {
      const perm = await fileHandle.queryPermission({ mode: "read" });
      if (perm !== "granted") return { status: "unchanged" };
    }
    const file = await fileHandle.getFile();
    const mtime = file?.lastModified;
    if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime === baselineStamp) {
      return { status: "unchanged" };
    }
    if (hasLocalEdits) return { status: "conflict", mtime };
    if (dismissedMtime !== null && dismissedMtime === mtime) {
      return { status: "dismissed", mtime };
    }
    return { status: "updated", mtime };
  } catch {
    return { status: "unchanged" };
  }
}
