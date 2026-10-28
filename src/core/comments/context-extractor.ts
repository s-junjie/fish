import type { DesignDocument, DesignElement, ContainerElement } from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { findElementById, findParentById } from "../geometry/tree-ops";
import type { FishCommentsDocument, CommentThread } from "./types";

export interface CommentAIContext {
  threadId: string;
  pageId: string;
  instruction: string;
  conversationHistory: Array<{ role: "user" | "ai"; content: string }>;
  target: DesignElement | null;
  parent: {
    id: string;
    type: string;
    layout?: unknown;
    width: number;
    height: number;
  } | null;
  children: Array<{
    id: string;
    type: string;
    name?: string;
    characters?: string;
  }>;
  siblings: Array<{
    id: string;
    type: string;
    name?: string;
  }>;
  tokens: {
    colors: string[];
    radii: string[];
  };
}

export function extractCommentContext(
  doc: DesignDocument,
  commentsDoc: FishCommentsDocument,
  threadId: string
): CommentAIContext | null {
  const thread = commentsDoc.threads.find((t) => t.id === threadId);
  if (!thread) return null;

  const page = doc.pages.find((p) => p.id === thread.pageId) ?? getActivePage(doc);
  const elements = page.children;

  const targetEl = thread.target.elementId ? findElementById(elements, thread.target.elementId) : null;
  const parentEl = thread.target.elementId ? findParentById(elements, thread.target.elementId) : null;

  // Extract direct children if target is a container
  const children: CommentAIContext["children"] = [];
  if (targetEl && "children" in targetEl && Array.isArray((targetEl as ContainerElement).children)) {
    for (const child of (targetEl as ContainerElement).children) {
      children.push({
        id: child.id,
        type: child.type,
        name: child.name,
        characters: "characters" in child ? (child as any).characters : undefined
      });
    }
  }

  // Extract siblings in the parent container (or page root if top-level)
  const siblingList = parentEl ? parentEl.children : elements;
  const siblings: CommentAIContext["siblings"] = [];
  if (targetEl) {
    for (const sib of siblingList) {
      if (sib.id !== targetEl.id) {
        siblings.push({
          id: sib.id,
          type: sib.type,
          name: sib.name
        });
      }
    }
  }

  // Extract tokens
  const colors: string[] = [];
  if (doc.tokens) {
    for (const token of doc.tokens) {
      if (token.type === "color") colors.push(token.name);
    }
  }

  const radii = ["4px", "8px", "12px", "16px", "24px", "9999px"];

  const instruction = thread.messages[thread.messages.length - 1]?.content ?? "";
  const conversationHistory = thread.messages.map((m) => ({
    role: m.author.role,
    content: m.content
  }));

  return {
    threadId: thread.id,
    pageId: thread.pageId,
    instruction,
    conversationHistory,
    target: targetEl,
    parent: parentEl
      ? {
          id: parentEl.id,
          type: parentEl.type,
          layout: "layout" in parentEl ? (parentEl as any).layout : undefined,
          width: parentEl.width,
          height: parentEl.height
        }
      : null,
    children,
    siblings,
    tokens: {
      colors,
      radii
    }
  };
}
