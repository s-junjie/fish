import { getActivePage, type DesignDocument, type DesignElement } from "../dsl/types";
import { findElementById } from "../geometry/tree-ops";
import { applyOps, type ApplyOpsResult, type OpOutcome } from "../ops/apply-ops";
import type { CommentThread, FishCommentsDocument, SuggestedMacroOp } from "./types";
import { AI_AUTHOR } from "./types";

export function normalizeMacroOps(rawOps: SuggestedMacroOp[]): Array<Record<string, unknown>> {
  return rawOps.map((op) => {
    const targetId = (op.targetId as string) || (op.id as string);
    const props = (op.props as Record<string, unknown>) || (op.value as Record<string, unknown>);
    return {
      ...op,
      targetId: targetId ?? op.targetId,
      props: props ?? op.props
    };
  });
}

export function applySuggestionToDocument(
  doc: DesignDocument,
  ops: SuggestedMacroOp[]
): { nextDoc: DesignDocument; changed: boolean; outcomes: ApplyOpsResult["outcomes"] } {
  const normalized = normalizeMacroOps(ops);
  const result = applyOps(doc, normalized);
  return {
    nextDoc: result.doc,
    changed: result.changed,
    outcomes: result.outcomes
  };
}

export function computePreviewElement(
  doc: DesignDocument,
  ops: SuggestedMacroOp[],
  targetElementId: string
): DesignElement | null {
  const normalized = normalizeMacroOps(ops);
  const result = applyOps(doc, normalized);
  const page = getActivePage(result.doc);
  return findElementById(page.children, targetElementId) ?? null;
}

/** One op that did not land, in the words the op runtime gave. */
export interface SuggestionFailure {
  op: string;
  id?: string;
  detail: string;
}

/** What Accept needs in order to say something true. */
export interface SuggestionApplyReport {
  applied: number;
  failures: SuggestionFailure[];
}

export function reportSuggestionApply(outcomes: OpOutcome[]): SuggestionApplyReport {
  const failures = outcomes
    .filter((outcome) => !outcome.ok)
    .map((outcome) => ({ op: outcome.op, id: outcome.id, detail: outcome.detail }));
  return { applied: outcomes.length - failures.length, failures };
}

function replyAsAi(
  commentsDoc: FishCommentsDocument,
  threadId: string,
  patch: Pick<CommentThread, "status"> & Partial<Pick<CommentThread, "suggestion">>,
  replyText: string
): FishCommentsDocument {
  return {
    ...commentsDoc,
    threads: commentsDoc.threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      return {
        ...thread,
        ...patch,
        updatedAt: new Date().toISOString(),
        messages: [
          ...thread.messages,
          {
            id: `msg_${Date.now()}`,
            author: AI_AUTHOR,
            content: replyText,
            createdAt: new Date().toISOString()
          }
        ]
      };
    })
  };
}

export function acceptThreadSuggestion(
  commentsDoc: FishCommentsDocument,
  threadId: string,
  replyText = "Applied suggested changes."
): FishCommentsDocument {
  return {
    ...commentsDoc,
    threads: commentsDoc.threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      return {
        ...thread,
        status: "resolved",
        updatedAt: new Date().toISOString(),
        messages: [
          ...thread.messages,
          {
            id: `msg_${Date.now()}`,
            author: AI_AUTHOR,
            content: replyText,
            createdAt: new Date().toISOString()
          }
        ]
      };
    })
  };
}

/**
 * Some ops did not land, so the thread goes back to `open` instead of claiming
 * to be finished. The suggestion is spent either way, and a next agent run has
 * to read the user's words together with what failed rather than re-apply the
 * same ops blind.
 */
export function partialAcceptThreadSuggestion(
  commentsDoc: FishCommentsDocument,
  threadId: string,
  replyText: string
): FishCommentsDocument {
  return replyAsAi(commentsDoc, threadId, { status: "open", suggestion: undefined }, replyText);
}

export function discardThreadSuggestion(
  commentsDoc: FishCommentsDocument,
  threadId: string
): FishCommentsDocument {
  return {
    ...commentsDoc,
    threads: commentsDoc.threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      return {
        ...thread,
        status: "open",
        suggestion: undefined,
        updatedAt: new Date().toISOString()
      };
    })
  };
}
