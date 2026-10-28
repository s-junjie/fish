import { describe, it, expect } from "vitest";
import { mergeCommentsDocuments } from "../src/core/comments/merge";
import type { CommentThread, FishCommentsDocument } from "../src/core/comments/types";

function thread(id: string, updatedAt: string, status: CommentThread["status"] = "open"): CommentThread {
  return {
    id,
    pageId: "page_1",
    target: { canvasPoint: { x: 0, y: 0 } },
    status,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt,
    messages: [
      {
        id: `m_${id}`,
        author: { id: "u", name: "You", role: "user" },
        content: id,
        createdAt: updatedAt
      }
    ]
  };
}

function doc(...threads: CommentThread[]): FishCommentsDocument {
  return { version: "0.1", threads };
}

describe("mergeCommentsDocuments", () => {
  it("lets the later write win for a thread both sides have", () => {
    const local = doc(thread("a", "2026-10-27T10:00:00.000Z"));
    const remote = doc({ ...thread("a", "2026-10-27T10:05:00.000Z"), status: "suggested" });
    const { document, changed } = mergeCommentsDocuments(local, remote);
    expect(changed).toBe(true);
    expect(document.threads[0].status).toBe("suggested");
  });

  it("keeps the local edit when it is the newer one", () => {
    const local = doc({ ...thread("a", "2026-10-27T10:09:00.000Z"), status: "resolved" });
    const remote = doc(thread("a", "2026-10-27T10:05:00.000Z"));
    const { document, changed } = mergeCommentsDocuments(local, remote);
    expect(changed).toBe(false);
    expect(document.threads[0].status).toBe("resolved");
  });

  it("adopts a thread only the file has", () => {
    const { document, adoptedIds } = mergeCommentsDocuments(
      doc(thread("a", "2026-10-27T10:00:00.000Z")),
      doc(thread("a", "2026-10-27T10:00:00.000Z"), thread("b", "2026-10-27T10:03:00.000Z"))
    );
    expect(adoptedIds).toEqual(["b"]);
    expect(document.threads.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("keeps a thread only this tab has", () => {
    const { document } = mergeCommentsDocuments(
      doc(thread("a", "2026-10-27T10:00:00.000Z"), thread("local_only", "2026-10-27T10:01:00.000Z")),
      doc(thread("a", "2026-10-27T10:00:00.000Z"))
    );
    expect(document.threads.map((t) => t.id)).toContain("local_only");
  });

  it("never resurrects a thread this session deleted", () => {
    // The file still holds it — a deletion leaves no timestamp behind, which is
    // why the ids are passed in.
    const { document, adoptedIds } = mergeCommentsDocuments(
      doc(),
      doc(thread("gone", "2026-10-27T10:00:00.000Z")),
      ["gone"]
    );
    expect(document.threads).toEqual([]);
    expect(adoptedIds).toEqual([]);
  });

  it("skips archived threads from the file", () => {
    const { document } = mergeCommentsDocuments(doc(), doc(thread("old", "2026-10-27T10:00:00.000Z", "archived")));
    expect(document.threads).toEqual([]);
  });

  it("reports no change for identical blocks", () => {
    const same = doc(thread("a", "2026-10-27T10:00:00.000Z"));
    expect(mergeCommentsDocuments(same, doc(thread("a", "2026-10-27T10:00:00.000Z"))).changed).toBe(false);
  });

  it("survives a missing updatedAt", () => {
    const broken = { ...thread("a", "2026-10-27T10:00:00.000Z"), updatedAt: undefined as unknown as string };
    const { document } = mergeCommentsDocuments(doc(thread("a", "2026-10-27T09:00:00.000Z")), doc(broken));
    expect(document.threads[0].id).toBe("a");
  });
});
