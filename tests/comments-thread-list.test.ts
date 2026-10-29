import { describe, it, expect } from "vitest";
import { spansPages, visibleThreads } from "../src/ui/comments/CommentsPanel";
import type { CommentThread } from "../src/core/comments/types";

/**
 * The rail is the queue of things waiting for an answer, so it cannot be a
 * viewer of one canvas: a thread on another page is listed, and opening it is a
 * jump (the panel's `onFocusThread` switches page first). These cases grade that
 * against every thread the document holds, never against a copy of the list.
 */
describe("the comment rail lists every page's threads", () => {
  const thread = (id: string, pageId: string, status: CommentThread["status"], updatedAt: string): CommentThread => ({
    id,
    pageId,
    target: { canvasPoint: { x: 0, y: 0 } },
    status,
    createdAt: updatedAt,
    updatedAt,
    messages: [{ id: "m1", author: { id: "u1", name: "User", role: "user" }, content: "Hello", createdAt: updatedAt }]
  });

  const threads = [
    thread("cmt_1", "page_1", "open", "2026-10-27T10:00:00Z"),
    thread("cmt_2", "page_2", "suggested", "2026-10-27T11:00:00Z"),
    thread("cmt_3", "page_1", "resolved", "2026-10-27T12:00:00Z")
  ];

  it("shows a thread whose page is not the open one", () => {
    const ids = visibleThreads(threads, "all").map((item) => item.id);
    expect(ids).toEqual(["cmt_2", "cmt_1", "cmt_3"]);
  });

  it("asks for a page label only once threads span pages", () => {
    expect(spansPages(threads)).toBe(true);
    expect(spansPages(threads.filter((item) => item.pageId === "page_1"))).toBe(false);
  });

  it("keeps open work above resolved work whatever page it is on", () => {
    const openFilter = visibleThreads(threads, "open").map((item) => item.status);
    expect(openFilter.every((status) => status !== "resolved")).toBe(true);
    expect(visibleThreads(threads, "resolved").map((item) => item.id)).toEqual(["cmt_3"]);
  });
});
