import type { CommentThread, FishCommentsDocument } from "./types";

export interface MergeResult {
  document: FishCommentsDocument;
  /** False when the file said nothing new — the caller can skip the write-back of state. */
  changed: boolean;
  /** Thread ids that came from the file and were not in the live document. */
  adoptedIds: string[];
}

function stampOf(thread: CommentThread): number {
  const at = Date.parse(thread.updatedAt ?? "");
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Reconcile the live comment block with the one a file now holds.
 *
 * Two writers reach the same file without knowing about each other: this tab
 * (auto-save writes the whole container) and `fish comments` (an agent writing
 * only the `#fish-comments` block). Neither can see the other's edit, and the
 * document's own identity check is blind to it by design — the comment block is
 * deliberately outside `#design-doc`, so its hash never moves. Without this
 * step the next auto-save replaces whatever the agent wrote, and the user's
 * answer silently never arrives.
 *
 * The rule is per thread, not per file: a thread exists on both sides and the
 * one whose `updatedAt` is later wins, because every writer stamps it. A thread
 * only the file has is adopted (it is the agent's answer to something this tab
 * never saw), and a thread only this tab has is kept. Deletions are the one
 * thing a timestamp cannot express, so they are passed in explicitly: an id this
 * session deleted is never resurrected from the file.
 */
export function mergeCommentsDocuments(
  local: FishCommentsDocument,
  remote: FishCommentsDocument,
  deletedIds: Iterable<string> = []
): MergeResult {
  const deleted = deletedIds instanceof Set ? deletedIds : new Set(deletedIds);
  const remoteById = new Map<string, CommentThread>();
  for (const thread of remote.threads) remoteById.set(thread.id, thread);

  const adoptedIds: string[] = [];
  const threads = local.threads.map((thread) => {
    const fromFile = remoteById.get(thread.id);
    if (!fromFile) return thread;
    remoteById.delete(thread.id);
    if (stampOf(fromFile) > stampOf(thread)) return fromFile;
    return thread;
  });

  for (const thread of remote.threads) {
    if (!remoteById.has(thread.id)) continue;
    remoteById.delete(thread.id);
    if (deleted.has(thread.id)) continue;
    if (thread.status === "archived") continue;
    adoptedIds.push(thread.id);
    threads.push(thread);
  }

  const document: FishCommentsDocument = { version: "0.1", threads };
  const changed = adoptedIds.length > 0 || JSON.stringify(document) !== JSON.stringify(local);
  return { document, changed, adoptedIds };
}
