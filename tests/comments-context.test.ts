import { describe, it, expect } from "vitest";
import { extractCommentContext } from "../src/core/comments/context-extractor";
import type { DesignDocument, DesignElement, FrameElement } from "../src/core/dsl/types";
import type { FishCommentsDocument } from "../src/core/comments/types";

describe("comments AI context extractor", () => {
  const canvas = { width: 1440, height: 900, unit: "px" as const, background: { type: "solid" as const, color: "#101010" } };

  const testDoc: DesignDocument = {
    version: "0.1",
    id: "doc_1",
    name: "Dashboard",
    createdAt: "2026-10-27T10:00:00Z",
    updatedAt: "2026-10-27T10:00:00Z",
    canvas,
    tokens: [
      { id: "tok_1", name: "--fish-brand-primary", type: "color", value: "#3b82f6" }
    ],
    pages: [
      {
        id: "page_main",
        name: "Main",
        canvas,
        children: [
          {
            id: "card_login",
            type: "frame",
            name: "Login Card",
            x: 100,
            y: 100,
            width: 400,
            height: 300,
            layout: { mode: "flex", dir: "vertical", gap: 16 },
            children: [
              {
                id: "input_email",
                type: "rect",
                name: "Email Input",
                x: 0,
                y: 0,
                width: 360,
                height: 40
              } as DesignElement,
              {
                id: "btn_submit",
                type: "frame",
                name: "Submit Button",
                x: 0,
                y: 56,
                width: 360,
                height: 48,
                borderRadius: 4,
                children: [
                  {
                    id: "btn_label",
                    type: "text",
                    name: "Button Label",
                    characters: "Submit",
                    x: 10,
                    y: 10,
                    width: 50,
                    height: 20
                  } as unknown as DesignElement
                ]
              } as FrameElement
            ]
          } as FrameElement
        ]
      }
    ],
    activePageId: "page_main"
  };

  const commentsDoc: FishCommentsDocument = {
    version: "0.1",
    threads: [
      {
        id: "cmt_101",
        pageId: "page_main",
        target: {
          elementId: "btn_submit",
          relativeOffset: { u: 0.5, v: 0.5 },
          canvasPoint: { x: 280, y: 180 },
          elementSnapshot: { name: "Submit Button", type: "frame" }
        },
        status: "open",
        createdAt: "2026-10-27T10:05:00Z",
        updatedAt: "2026-10-27T10:05:00Z",
        messages: [
          {
            id: "msg_1",
            author: { id: "u1", name: "Bob", role: "user" },
            content: "Change button text to Sign In and make corner radius 8px",
            createdAt: "2026-10-27T10:05:00Z"
          }
        ]
      }
    ]
  };

  it("extracts focused target, parent, children, siblings, and tokens", () => {
    const context = extractCommentContext(testDoc, commentsDoc, "cmt_101");
    expect(context).not.toBeNull();
    expect(context!.threadId).toBe("cmt_101");
    expect(context!.instruction).toBe("Change button text to Sign In and make corner radius 8px");

    // Target element
    expect(context!.target?.id).toBe("btn_submit");

    // Parent layout constraints
    expect(context!.parent).toEqual({
      id: "card_login",
      type: "frame",
      layout: { mode: "flex", dir: "vertical", gap: 16 },
      width: 400,
      height: 300
    });

    // Children (inner text/icons)
    expect(context!.children).toHaveLength(1);
    expect(context!.children[0]).toEqual({
      id: "btn_label",
      type: "text",
      name: "Button Label",
      characters: "Submit"
    });

    // Siblings
    expect(context!.siblings).toEqual([
      { id: "input_email", type: "rect", name: "Email Input" }
    ]);

    // Tokens
    expect(context!.tokens.colors).toContain("--fish-brand-primary");
  });

  it("returns null when threadId does not exist", () => {
    const context = extractCommentContext(testDoc, commentsDoc, "non_existent_thread");
    expect(context).toBeNull();
  });
});
