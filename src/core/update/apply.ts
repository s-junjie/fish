import {
  getFileHandle,
  getFileName,
  openedFileName,
  serializeSelf,
  writeFileSafely
} from "../data-bridge";
import { queryWritebackPermission, saveDocAsNewFile } from "../persistence/writeback";
import { timeoutSignal } from "../net/external-fetch";
import type { DesignDocument } from "../dsl/types";
import { rememberJustUpdated } from "./config";
import { UpdateError, verifyDigest, type ReleasePayload } from "./manifest";
import type { FetchLike } from "./check";

/** The id the built shell's runtime payload carries — see `compress-shell.mjs`. */
const RUNTIME_BLOCK_ID = "fish-rt";

export type ApplyOutcome =
  | { ok: true; method: "in-place" | "saved-as" | "downloaded"; version: string }
  | { ok: false; reason: string; message: string };

/**
 * The downloaded shell has to be a shell, not merely the right bytes.
 *
 * The hash proves the file is the one the manifest named; it says nothing about
 * whether that file is an editor. A release that dropped its runtime block would
 * pass every integrity check and produce a document that opens blank, so the
 * runtime block is required before a single byte of the user's design is put
 * into it.
 */
export function assertUsableShell(doc: Document, version: string): void {
  if (!doc.head) {
    throw new UpdateError(`the downloaded shell (v${version}) is not a document — refusing it`);
  }
  if (!doc.getElementById(RUNTIME_BLOCK_ID)) {
    throw new UpdateError(
      `the downloaded shell (v${version}) carries no editor runtime — refusing it`
    );
  }
}

export type ShellFetchLike = (
  input: string,
  init?: { cache?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Fetch a release and prove it, in that order: hash first, parse second. Parsing
 * untrusted bytes before they are known to be the intended ones buys nothing.
 */
export async function downloadShell(
  release: ReleasePayload,
  fetchImpl?: ShellFetchLike
): Promise<string> {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as ShellFetchLike | undefined);
  if (typeof doFetch !== "function") {
    throw new UpdateError("this browser cannot make network requests");
  }
  let bytes: ArrayBuffer;
  try {
    // A release server that accepts the connection and never answers would
    // otherwise leave the update prompt spinning with no way to retry it.
    const response = await doFetch(release.url, {
      cache: "no-store",
      signal: timeoutSignal()
    });
    if (!response.ok) throw new UpdateError(`downloading the update failed (${response.status})`);
    bytes = await response.arrayBuffer();
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError("the update could not be downloaded from this file");
  }
  await verifyDigest(bytes, release.sha256);
  // Walked, never matched: the shell's own payload blocks contain the markup they
  // are describing, and a regex over this text finds the wrong block (see
  // AGENTS.md §7). DOMParser is what makes "is this a shell" answerable at all.
  const parsed = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "text/html");
  assertUsableShell(parsed, release.version);
  // Re-serialised, doctype included, because `outerHTML` of the root element
  // drops it and a document served in quirks mode lays out differently.
  return `<!DOCTYPE html>\n${parsed.documentElement.outerHTML}`;
}

/**
 * The updated file: the new shell with this document poured into it.
 *
 * `serializeSelf` is the whole transplant — it stamps the file id, the document
 * block and the asset block into whatever template it is handed. It is the only
 * splicer: an offline upgrade is this call with a newer shell as the template.
 */
export function buildUpdatedFile(doc: DesignDocument, shellHtml: string): string {
  return serializeSelf(doc, shellHtml);
}

/**
 * Write the update over the open file, or hand the user a place to put it.
 *
 * In place when a granted handle is already there, which is the only case where
 * the file the user is looking at becomes the new shell. Otherwise the picker
 * opens on the current file's name: choosing that same file IS the update, and
 * choosing another one is a copy, which is a legitimate answer rather than a
 * failure. `writeFileSafely` takes the pre-write backup, so the bytes this
 * replaces are recoverable before they are replaced.
 */
export async function applyUpdate(
  doc: DesignDocument,
  release: ReleasePayload,
  opts: { fetchImpl?: ShellFetchLike } = {}
): Promise<ApplyOutcome> {
  let shell: string;
  try {
    shell = await downloadShell(release, opts.fetchImpl);
  } catch (e) {
    return { ok: false, reason: "download", message: describe(e) };
  }
  const handle = getFileHandle();
  if (handle && typeof handle.createWritable === "function") {
    const permission = await queryWritebackPermission();
    if (permission === "granted") {
      try {
        const outcome = await writeFileSafely(doc, handle, shell, { requireBackup: true });
        if (!outcome.ok) {
          const reason = outcome.reason ?? "write-failed";
          return { ok: false, reason, message: reason };
        }
        rememberJustUpdated(release.version);
        return { ok: true, method: "in-place", version: release.version };
      } catch (e) {
        return { ok: false, reason: "write", message: describe(e) };
      }
    }
  }
  const name = getFileName() ?? openedFileName();
  try {
    const saved = await saveDocAsNewFile(doc, name ?? `${doc.name}.fish.html`, shell);
    if (!saved.ok) {
      return { ok: false, reason: saved.reason ?? "save-failed", message: saved.reason ?? "" };
    }
    rememberJustUpdated(release.version);
    return {
      ok: true,
      method: typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function"
        ? "saved-as"
        : "downloaded",
      version: release.version
    };
  } catch (e) {
    return { ok: false, reason: "save", message: describe(e) };
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}