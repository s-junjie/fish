import { describe, it, expect } from "vitest";
import {
  normalizeMacroOps,
  applySuggestionToDocument,
  computePreviewElement,
  acceptThreadSuggestion,
  partialAcceptThreadSuggestion,
  reportSuggestionApply,
  discardThreadSuggestion
} from "../src/core/comments/suggested-ops";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";
import type { FishCommentsDocument, SuggestedMacroOp } from "../src/core/comments/types";

describe("comments suggested preview and execution", () => {
  const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#101010" } };
  const initialDoc: DesignDocument = {
    version: "0.1",
    id: "doc_1",
    name: "Test Doc",
    createdAt: "2026-10-27T10:00:00Z",
    updatedAt: "2026-10-27T10:00:00Z",
    canvas,
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas,
        children: [
          {
            id: "btn_1",
            type: "rect",
            name: "Button",
            x: 50,
            y: 50,
            width: 120,
            height: 40,
            borderRadius: 4
          } as DesignElement
        ]
      }
    ],
    activePageId: "page_1"
  };

  it("normalizes { id, value } to standard { targetId, props }", () => {
    const rawOps: SuggestedMacroOp[] = [
      { op: "patch", id: "btn_1", value: { cornerRadius: 8 } }
    ];
    const normalized = normalizeMacroOps(rawOps);
    expect(normalized[0]).toMatchObject({
      op: "patch",
      targetId: "btn_1",
      props: { cornerRadius: 8 }
    });
  });

  it("applies suggested ops directly onto design document", () => {
    const ops: SuggestedMacroOp[] = [
      { op: "patch", id: "btn_1", value: { cornerRadius: 12, width: 160 } }
    ];
    const { nextDoc, changed, outcomes } = applySuggestionToDocument(initialDoc, ops);
    expect(changed).toBe(true);
    expect(outcomes[0].ok).toBe(true);
    const patchedBtn = nextDoc.pages[0].children[0] as any;
    expect(patchedBtn.borderRadius).toBe(12);
    expect(patchedBtn.width).toBe(160);
  });

  it("computes virtual preview element without mutating original document", () => {
    const ops: SuggestedMacroOp[] = [
      { op: "patch", id: "btn_1", value: { borderRadius: 16 } }
    ];
    const preview = computePreviewElement(initialDoc, ops, "btn_1");
    expect(preview).not.toBeNull();
    expect((preview as any).borderRadius).toBe(16);
    // Original document is untouched
    expect((initialDoc.pages[0].children[0] as any).borderRadius).toBe(4);
  });

  it("accepts suggestion and marks thread resolved with AI reply", () => {
    const commentsDoc: FishCommentsDocument = {
      version: "0.1",
      threads: [
        {
          id: "cmt_1",
          pageId: "page_1",
          target: { elementId: "btn_1", canvasPoint: { x: 50, y: 50 } },
          status: "suggested",
          createdAt: "2026-10-27T10:00:00Z",
          updatedAt: "2026-10-27T10:00:00Z",
          messages: [{ id: "m1", author: { id: "u1", name: "User", role: "user" }, content: "Make corners rounder", createdAt: "2026-10-27T10:00:00Z" }],
          suggestion: { summary: "Set cornerRadius to 12", ops: [], createdAt: "2026-10-27T10:01:00Z" }
        }
      ]
    };

    const resolved = acceptThreadSuggestion(commentsDoc, "cmt_1", "Corner radius updated to 12px.");
    expect(resolved.threads[0].status).toBe("resolved");
    expect(resolved.threads[0].messages).toHaveLength(2);
    expect(resolved.threads[0].messages[1].author.role).toBe("ai");
    expect(resolved.threads[0].messages[1].content).toBe("Corner radius updated to 12px.");
  });

  it("discards suggestion and resets thread status to open", () => {
    const commentsDoc: FishCommentsDocument = {
      version: "0.1",
      threads: [
        {
          id: "cmt_1",
          pageId: "page_1",
          target: { elementId: "btn_1", canvasPoint: { x: 50, y: 50 } },
          status: "suggested",
          createdAt: "2026-10-27T10:00:00Z",
          updatedAt: "2026-10-27T10:00:00Z",
          messages: [{ id: "m1", author: { id: "u1", name: "User", role: "user" }, content: "Make corners rounder", createdAt: "2026-10-27T10:00:00Z" }],
          suggestion: { summary: "Set cornerRadius to 12", ops: [], createdAt: "2026-10-27T10:01:00Z" }
        }
      ]
    };

    const discarded = discardThreadSuggestion(commentsDoc, "cmt_1");
    expect(discarded.threads[0].status).toBe("open");
    expect(discarded.threads[0].suggestion).toBeUndefined();
  });
});

/**
 * An op that targets another page's tree is evaluated against the ACTIVE page,
 * so its outcome is a failure — nothing else about the run changes. What Accept
 * records has to come from those outcomes, because `changed` cannot see the
 * difference between "all of it landed" and "some of it landed".
 */
describe("comments suggestion apply report", () => {
  const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#101010" } };
  const twoPageDoc: DesignDocument = {
    version: "0.1",
    id: "doc_2",
    name: "Two Pages",
    createdAt: "2026-10-27T10:00:00Z",
    updatedAt: "2026-10-27T10:00:00Z",
    canvas,
    pages: [
      { id: "page_1", name: "Page 1", canvas, children: [{ id: "btn_1", type: "rect", name: "Button", x: 0, y: 0, width: 120, height: 40 } as DesignElement] },
      { id: "page_2", name: "Page 2", canvas, children: [{ id: "hero_1", type: "text", name: "Hero", x: 0, y: 0, width: 200, height: 60 } as DesignElement] }
    ],
    activePageId: "page_1"
  };

  const thread = (): FishCommentsDocument["threads"][number] => ({
    id: "cmt_1",
    pageId: "page_1",
    target: { elementId: "btn_1", canvasPoint: { x: 50, y: 50 } },
    status: "suggested",
    createdAt: "2026-10-27T10:00:00Z",
    updatedAt: "2026-10-27T10:00:00Z",
    messages: [{ id: "m1", author: { id: "u1", name: "User", role: "user" }, content: "Match the hero", createdAt: "2026-10-27T10:00:00Z" }],
    suggestion: { summary: "Match both", ops: [], createdAt: "2026-10-27T10:01:00Z" }
  });

  it("reports nothing failed when every op lands, so the thread can resolve", () => {
    const ops: SuggestedMacroOp[] = [{ op: "patch", id: "btn_1", value: { cornerRadius: 12 } }];
    const report = reportSuggestionApply(applySuggestionToDocument(twoPageDoc, ops).outcomes);
    expect(report.failures).toHaveLength(0);
    expect(report.applied).toBe(1);
    expect(acceptThreadSuggestion({ version: "0.1", threads: [thread()] }, "cmt_1").threads[0].status).toBe("resolved");
  });

  it("keeps the thread open and names the op that could not be applied", () => {
    const ops: SuggestedMacroOp[] = [
      { op: "patch", id: "btn_1", value: { cornerRadius: 12 } },
      { op: "patch", id: "hero_1", value: { fontSize: 32 } }
    ];
    const applied = applySuggestionToDocument(twoPageDoc, ops);
    // The reachable half of the bug: one op landing is enough to call the whole
    // suggestion applied, so `changed` alone cannot gate what the thread records.
    expect(applied.changed).toBe(true);

    const report = reportSuggestionApply(applied.outcomes);
    expect(report.applied).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].id).toBe("hero_1");

    const next = partialAcceptThreadSuggestion(
      { version: "0.1", threads: [thread()] },
      "cmt_1",
      `Applied 1 of 2 ops. Failed: patch hero_1 — ${report.failures[0].detail}`
    );
    expect(next.threads[0].status).toBe("open");
    expect(next.threads[0].suggestion).toBeUndefined();
    expect(next.threads[0].messages[1].content).toContain("hero_1");
  });
});
