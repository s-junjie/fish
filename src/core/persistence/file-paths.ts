import { getFileHandle } from "./file-handle";

/**
 * Name of the file this page was opened from, taken from the URL. A `file://`
 * page has no way to obtain a handle to its own file, so this is the only
 * ground truth about "which file am I looking at" — and the name that must be
 * offered when we do ask the user to pick a write-back target.
 */
export function openedFileName(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const base = (window.location?.pathname ?? "").split("/").pop();
  if (!base) return undefined;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

export function openedFilePath(): string | undefined {
  if (typeof window === "undefined" || window.location?.protocol !== "file:") return undefined;
  const raw = window.location.pathname ?? "";
  if (!raw) return undefined;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.replace(/^\/([a-zA-Z]:)/, "$1");
  } catch {
    return raw.replace(/^\/([a-zA-Z]:)/, "$1");
  }
}

export function openedFileDirectory(): string | undefined {
  const path = openedFilePath();
  if (!path) return undefined;
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return undefined;
  return path.substring(0, lastSlash) || "/";
}

const WELL_KNOWN_DIRECTORIES = ["desktop", "documents", "downloads", "pictures", "music", "videos"] as const;

/**
 * The well-known directory a path sits *directly* in, if any.
 *
 * Exact, not nearest: `startIn` carries the folder's name and nothing else, so
 * answering `"documents"` for a file three levels below `~/Documents` opens the
 * picker at `~/Documents` — a wrong answer wearing a helpful face, and the one
 * the user reads as "it forgot where my file is". A path that is not directly
 * inside one of these gets `undefined`, which lets the browser fall back to the
 * folder it remembers instead of being dragged somewhere unrelated.
 */
export function wellKnownDirectoryOf(path?: string): string | undefined {
  if (!path) return undefined;
  const parent = path.replace(/[\\/][^\\/]*$/, "");
  const name = parent.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
  if (!name) return undefined;
  if (name === "movies") return "videos";
  return (WELL_KNOWN_DIRECTORIES as readonly string[]).includes(name) ? name : undefined;
}

/** A handle or a well-known directory name — the two things `startIn` takes. */
export type PickerStartIn = string | { readonly name?: string };

/**
 * The `startIn` every picker in the app gets: the folder this document lives
 * in, when the page can prove which one that is.
 *
 * A handle is proof — Chromium opens the picker in the parent directory of a
 * file handle, so Save As lands beside the `.fish.html` being edited. Without
 * one, all a `file://` page knows is its own URL, and `wellKnownDirectoryOf`
 * turns that into a hint only when the hint is exactly right.
 */
export function pickerStartIn(): PickerStartIn | undefined {
  return getFileHandle() ?? wellKnownDirectoryOf(openedFilePath());
}

/** Where a save or auto-save write-back will land: the handle if we have one. */
export function getFileName(): string | undefined {
  return (getFileHandle()?.name as string | undefined) ?? openedFileName();
}

