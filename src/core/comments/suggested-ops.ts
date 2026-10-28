import { getActivePage, type DesignDocument, type DesignElement } from "../dsl/types";
import { findElementById } from "../geometry/tree-ops";
import { applyOps, type ApplyOpsResult } from "../ops/apply-ops";
import type { FishCommentsDocument, SuggestedMacroOp } from "./types";

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
            author: { id: "ai", name: "AI Assistant", role: "ai" },
            content: replyText,
            createdAt: new Date().toISOString()
          }
        ]
      };
    })
  };
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
