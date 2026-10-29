export type CommentStatus = "open" | "suggested" | "resolved" | "archived";

export interface CommentTarget {
  elementId?: string;
  /** Normalized position [0, 1] relative to the target element's top-left origin. */
  relativeOffset?: { u: number; v: number };
  /** Absolute canvas coordinate as fallback when elementId is missing or deleted. */
  canvasPoint: { x: number; y: number };
  elementSnapshot?: {
    name: string;
    type: string;
  };
}

export interface SuggestedMacroOp {
  op: "patch" | "replace" | "insert" | "remove" | string;
  id?: string;
  value?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SuggestedPreview {
  summary: string;
  ops: SuggestedMacroOp[];
  createdAt: string;
}

export interface CommentAuthor {
  id: string;
  name: string;
  avatar?: string;
  role: "user" | "ai";
}

/**
 * Who writes an agent's own message. There is one author for every AI on every
 * surface — a CLI reply and an accepted suggestion are turns of the same
 * conversation, and two spellings of the name would put two people in one thread.
 */
export const AI_AUTHOR: CommentAuthor = { id: "ai", name: "AI Agent", role: "ai" };

export interface CommentMessage {
  id: string;
  author: CommentAuthor;
  content: string;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  pageId: string;
  target: CommentTarget;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
  messages: CommentMessage[];
  suggestion?: SuggestedPreview;
}

export interface FishCommentsDocument {
  version: "0.1";
  threads: CommentThread[];
}

export function createEmptyCommentsDocument(): FishCommentsDocument {
  return {
    version: "0.1",
    threads: [],
  };
}

/**
 * A comment block read back from anywhere — the file, a recovery snapshot —
 * as a document, or `undefined` when it is not one.
 *
 * Shared by the loader and the recovery path so the two cannot disagree about
 * what counts as a thread list: a snapshot written by a future build with an
 * extra field is still readable, and a truncated one is refused rather than
 * half-adopted.
 */
export function normalizeCommentsDocument(raw: unknown): FishCommentsDocument | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as { version?: unknown; threads?: unknown };
  if (!Array.isArray(candidate.threads)) return undefined;
  const threads = candidate.threads.filter(
    (thread): thread is CommentThread =>
      Boolean(thread) &&
      typeof thread === "object" &&
      Array.isArray((thread as CommentThread).messages) &&
      typeof (thread as CommentThread).id === "string" &&
      Boolean((thread as CommentThread).target)
  );
  return {
    version: "0.1",
    threads,
  };
}
