import { useState, useCallback, useEffect } from "preact/hooks";
import {
  loadInitialComments,
  setActiveComments,
  noteCommentDeleted,
  onCommentsReplaced
} from "../../core/data-bridge";
import type {
  FishCommentsDocument,
  CommentThread,
  CommentTarget,
  CommentMessage
} from "../../core/comments/types";
import { createEmptyCommentsDocument, normalizeCommentsDocument } from "../../core/comments/types";
import { computeRelativeOffset } from "../../core/comments/anchor";
import { computeParentOrigin } from "../../core/geometry/tree-coords";
import { elementWorldAABB } from "../../core/geometry/tree-hit";
import {
  applySuggestionToDocument,
  acceptThreadSuggestion,
  partialAcceptThreadSuggestion,
  reportSuggestionApply,
  discardThreadSuggestion
} from "../../core/comments/suggested-ops";
import { t } from "../../i18n";
import type { DesignDocument, DesignElement } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";

const USER_AUTHOR = { id: "user", name: "User", role: "user" as const };

function makeMessage(content: string): CommentMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    author: USER_AUTHOR,
    content,
    createdAt: new Date().toISOString()
  };
}

export function useComments(
  docRef: { current: DesignDocument },
  commitSnapshot: (doc: DesignDocument) => void,
  /** Told after every comment mutation, so the file writer runs. */
  onPersist?: () => void
) {
  const [comments, setComments] = useState<FishCommentsDocument>(() => {
    const initial = loadInitialComments();
    setActiveComments(initial);
    return initial;
  });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [draftTarget, setDraftTarget] = useState<CommentTarget | null>(null);

  const updateComments = useCallback(
    (next: FishCommentsDocument) => {
      setComments(next);
      setActiveComments(next);
      onPersist?.();
    },
    [onPersist]
  );

  /* A write can pull a newer comment block out of the file — an agent's answer
     to a thread, written while this tab was open. The writer owns that merge, so
     it announces the result rather than this hook polling for it. */
  useEffect(() => {
    return onCommentsReplaced((next) => setComments(next));
  }, []);

  const handleCommentAtElement = useCallback(
    (el: DesignElement, worldPoint: { x: number; y: number }) => {
      const page = getActivePage(docRef.current);
      const parentOrigin = computeParentOrigin(page.children, el.id);
      const worldBox = elementWorldAABB(el, parentOrigin.x, parentOrigin.y);
      const offset = computeRelativeOffset(worldPoint, worldBox);
      setDraftTarget({
        elementId: el.id,
        relativeOffset: offset,
        canvasPoint: worldPoint,
        elementSnapshot: {
          name: el.name || el.type,
          type: el.type
        }
      });
      setActiveThreadId(null);
    },
    [docRef]
  );

  const handleCommentAtCanvas = useCallback((worldPoint: { x: number; y: number }) => {
    setDraftTarget({
      canvasPoint: worldPoint
    });
    setActiveThreadId(null);
  }, []);

  const handleAddComment = useCallback(
    (target: CommentTarget, content: string) => {
      const now = new Date().toISOString();
      const newThread: CommentThread = {
        id: `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        pageId: getActivePage(docRef.current).id,
        target,
        status: "open",
        createdAt: now,
        updatedAt: now,
        messages: [makeMessage(content)]
      };
      updateComments({
        ...comments,
        threads: [...comments.threads, newThread]
      });
      // Posting closes the window: the pin is the receipt.
      setDraftTarget(null);
      setActiveThreadId(null);
    },
    [comments, docRef, updateComments]
  );

  const handleReplyComment = useCallback(
    (threadId: string, content: string) => {
      updateComments({
        ...comments,
        threads: comments.threads.map((t) =>
          t.id === threadId
            ? { ...t, updatedAt: new Date().toISOString(), messages: [...t.messages, makeMessage(content)] }
            : t
        )
      });
      setActiveThreadId((curr) => (curr === threadId ? null : curr));
    },
    [comments, updateComments]
  );

  const setStatus = useCallback(
    (threadId: string, status: CommentThread["status"]) => {
      updateComments({
        ...comments,
        threads: comments.threads.map((t) =>
          t.id === threadId ? { ...t, status, updatedAt: new Date().toISOString() } : t
        )
      });
    },
    [comments, updateComments]
  );

  const handleResolveComment = useCallback(
    (threadId: string) => {
      setStatus(threadId, "resolved");
      setActiveThreadId((curr) => (curr === threadId ? null : curr));
    },
    [setStatus]
  );

  const handleReopenComment = useCallback(
    (threadId: string) => setStatus(threadId, "open"),
    [setStatus]
  );

  const handleMoveComment = useCallback(
    (threadId: string, target: CommentTarget) => {
      updateComments({
        ...comments,
        threads: comments.threads.map((t) =>
          t.id === threadId ? { ...t, target, updatedAt: new Date().toISOString() } : t
        )
      });
    },
    [comments, updateComments]
  );

  const handleDeleteComment = useCallback(
    (threadId: string) => {
      // Remembered so the next write does not merge the thread back in from the
      // file, which still has it and cannot know it was deleted here.
      noteCommentDeleted(threadId);
      updateComments({
        ...comments,
        threads: comments.threads.filter((t) => t.id !== threadId)
      });
      if (activeThreadId === threadId) setActiveThreadId(null);
    },
    [comments, activeThreadId, updateComments]
  );

  const handleApplySuggestion = useCallback(
    (threadId: string) => {
      const thread = comments.threads.find((t) => t.id === threadId);
      if (!thread?.suggestion?.ops) return;

      const { nextDoc, changed, outcomes } = applySuggestionToDocument(
        docRef.current,
        thread.suggestion.ops
      );
      // One undoable step, exactly like an inspector edit — the ops go through
      // the same runtime, so ⌘Z returns the canvas to what the user was reading
      // when they pressed Accept.
      if (changed) commitSnapshot(nextDoc);

      const report = reportSuggestionApply(outcomes);
      if (report.failures.length === 0) {
        updateComments(acceptThreadSuggestion(comments, threadId, t("comments.appliedSuccess")));
        return;
      }
      /* `changed` cannot tell these apart from a clean accept: one op landing is
         enough. Resolving anyway would record "applied" over a canvas that is
         missing part of what the card promised, so the failure is written into
         the thread and the thread stays open. */
      updateComments(
        partialAcceptThreadSuggestion(
          comments,
          threadId,
          t("comments.appliedPartial", {
            n: report.applied,
            total: outcomes.length,
            detail: report.failures
              .map((failure) => `${failure.op}${failure.id ? ` ${failure.id}` : ""} — ${failure.detail}`)
              .join("; ")
          })
        )
      );
    },
    [comments, docRef, commitSnapshot, updateComments]
  );

  const handleDiscardSuggestion = useCallback(
    (threadId: string) => {
      updateComments(discardThreadSuggestion(comments, threadId));
    },
    [comments, updateComments]
  );

  /**
   * Adopt a whole comment block — what a recovered snapshot carries.
   *
   * A recovered document without its conversation would be a file whose comments
   * silently reverted to whatever the last write held, which is worse than the
   * crash that lost them: the user has no way to tell it happened.
   */
  const replaceComments = useCallback(
    (raw: unknown) => {
      const next = normalizeCommentsDocument(raw) ?? createEmptyCommentsDocument();
      updateComments(next);
      setActiveThreadId(null);
      setDraftTarget(null);
    },
    [updateComments]
  );

  return {
    comments,
    activeThreadId,
    setActiveThreadId,
    draftTarget,
    setDraftTarget,
    handleCommentAtElement,
    handleCommentAtCanvas,
    handleAddComment,
    handleReplyComment,
    handleResolveComment,
    handleReopenComment,
    handleMoveComment,
    handleDeleteComment,
    handleApplySuggestion,
    handleDiscardSuggestion,
    replaceComments
  };
}
