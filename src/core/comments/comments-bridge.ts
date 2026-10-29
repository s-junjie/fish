import { FishCommentsDocument, createEmptyCommentsDocument } from "./types";
import { mergeCommentsDocuments } from "./merge";
import { fileIdFromHtml, readFileIdFromShell } from "../persistence/file-identity";

export const COMMENTS_BLOCK_RE = /<script\s+id=["']fish-comments["'][^>]*>([\s\S]*?)<\/script>/i;
const DOC_BLOCK_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;

let activeCommentsDoc: FishCommentsDocument | null = null;

/**
 * Thread ids this session deleted.
 *
 * A merge cannot read a deletion out of a timestamp: the file still has the
 * thread, with no marker saying it went away here. Remembering the ids is what
 * stops a write from resurrecting a comment the user just removed.
 */
const deletedCommentIds = new Set<string>();

const commentsReplacedListeners = new Set<(comments: FishCommentsDocument) => void>();

export function setActiveComments(comments: FishCommentsDocument | null): void {
  activeCommentsDoc = comments;
}

export function getActiveComments(): FishCommentsDocument | null {
  return activeCommentsDoc;
}

export function noteCommentDeleted(threadId: string): void {
  deletedCommentIds.add(threadId);
}

export function noteCommentRestored(threadId: string): void {
  deletedCommentIds.delete(threadId);
}

export function clearDeletedCommentIds(): void {
  deletedCommentIds.clear();
}

/**
 * Told when a write pulled a newer comment block out of the file.
 *
 * The writer is not a React component, so this is how the adopted threads reach
 * the UI: without it the merge would be correct on disk and invisible on
 * screen until the next reload.
 */
export function onCommentsReplaced(listener: (comments: FishCommentsDocument) => void): () => void {
  commentsReplacedListeners.add(listener);
  return () => commentsReplacedListeners.delete(listener);
}

export function parseCommentsBlock(html: string): FishCommentsDocument {
  const body = COMMENTS_BLOCK_RE.exec(html)?.[1]?.trim();
  if (!body) return createEmptyCommentsDocument();
  try {
    const parsed = JSON.parse(body.replace(/\\u003c/g, "<"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.threads)) {
      return {
        version: parsed.version || "0.1",
        threads: parsed.threads
      };
    }
    return createEmptyCommentsDocument();
  } catch {
    return createEmptyCommentsDocument();
  }
}

export function loadInitialComments(): FishCommentsDocument {
  if (typeof document === "undefined") {
    return createEmptyCommentsDocument();
  }
  const scriptEl = document.getElementById("fish-comments");
  if (!scriptEl || !scriptEl.textContent || !scriptEl.textContent.trim()) {
    return createEmptyCommentsDocument();
  }
  try {
    const parsed = JSON.parse(scriptEl.textContent.replace(/\\u003c/g, "<"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.threads)) {
      return {
        version: parsed.version || "0.1",
        threads: parsed.threads
      };
    }
  } catch (err) {
    console.warn("FISH: Failed to parse embedded #fish-comments JSON:", err);
  }
  return createEmptyCommentsDocument();
}

export function spliceCommentsBlock(html: string, comments: FishCommentsDocument): string {
  const hasComments = comments.threads.length > 0;
  const commentsJson = hasComments
    ? JSON.stringify(comments, null, 2).replace(/<\//g, "\\u003c/")
    : "";
  const commentsScriptBlock = hasComments
    ? `\n  <script id="fish-comments" type="application/json">\n${commentsJson}\n  </script>`
    : "";

  if (COMMENTS_BLOCK_RE.test(html)) {
    if (hasComments) {
      return html.replace(COMMENTS_BLOCK_RE, () => commentsScriptBlock.trim());
    }
    return html.replace(new RegExp(`\\s*${COMMENTS_BLOCK_RE.source}`, "i"), "");
  }

  if (DOC_BLOCK_RE.test(html)) {
    if (!hasComments) return html;
    return html.replace(DOC_BLOCK_RE, (match) => `${match}${commentsScriptBlock}`);
  }

  return html;
}

/**
 * Reconcile the live comment block with the one the file holds, just before it
 * is overwritten.
 *
 * `writeFileSafely` replaces the whole container, including `#fish-comments`.
 * An agent running `fish comments suggest` has meanwhile written that block by
 * itself — and the document's identity check cannot see it, because the comment
 * block is deliberately outside `#design-doc`. This is the one place that knows
 * both sides, so it is where the two are merged (`mergeCommentsDocuments`).
 *
 * Only the file this tab opened is reconciled: a save-as target is a different
 * document, and adopting its threads would import a stranger's conversation.
 */
export function reconcileCommentsWithFile(text: string | undefined): FishCommentsDocument | undefined {
  if (!text) return undefined;
  const targetId = fileIdFromHtml(text);
  const ownId = readFileIdFromShell();
  if (!targetId || !ownId || targetId !== ownId) return undefined;

  const remote = parseCommentsBlock(text);
  const local = activeCommentsDoc;
  if (!local) {
    if (remote.threads.length === 0) return undefined;
    setActiveComments(remote);
    return remote;
  }

  const { document, changed } = mergeCommentsDocuments(local, remote, deletedCommentIds);
  if (!changed) return local;
  // The file's answer to a comment is a state the user asked for: adopt it here
  // so the card and the rail show it, instead of holding it on disk only.
  setActiveComments(document);
  for (const listener of commentsReplacedListeners) listener(document);
  return document;
}

