import { describe, it, expect } from "vitest";
import {
  parseCommentsBlock,
  spliceCommentsBlock,
  serializeSelf,
  createEmptyDocument
} from "../src/core/data-bridge";
import { FishCommentsDocument } from "../src/core/comments/types";

describe("comments data bridge (#fish-comments)", () => {
  const sampleComments: FishCommentsDocument = {
    version: "0.1",
    threads: [
      {
        id: "cmt_test_1",
        pageId: "page_1",
        target: {
          elementId: "btn_submit",
          relativeOffset: { u: 0.5, v: 0.5 },
          canvasPoint: { x: 100, y: 200 },
          elementSnapshot: { name: "Submit Button", type: "frame" }
        },
        status: "open",
        createdAt: "2026-10-27T10:00:00.000Z",
        updatedAt: "2026-10-27T10:00:00.000Z",
        messages: [
          {
            id: "msg_1",
            author: { id: "user_1", name: "Alice", role: "user" },
            content: "Please change the corner radius to 8px",
            createdAt: "2026-10-27T10:00:00.000Z"
          }
        ]
      }
    ]
  };

  it("returns empty document when no comments block is present", () => {
    const html = `<html><head><script id="design-doc" type="application/json">{}</script></head><body></body></html>`;
    const comments = parseCommentsBlock(html);
    expect(comments).toEqual({ version: "0.1", threads: [] });
  });

  it("parses embedded #fish-comments block cleanly", () => {
    const commentsJson = JSON.stringify(sampleComments, null, 2);
    const html = `<html><head>
      <script id="design-doc" type="application/json">{}</script>
      <script id="fish-comments" type="application/json">
${commentsJson}
      </script>
    </head><body></body></html>`;

    const parsed = parseCommentsBlock(html);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].id).toBe("cmt_test_1");
    expect(parsed.threads[0].target.elementId).toBe("btn_submit");
    expect(parsed.threads[0].messages[0].content).toBe("Please change the corner radius to 8px");
  });

  it("splices comments block into HTML without altering design doc", () => {
    const initialHtml = `<html><head>\n  <script id="design-doc" type="application/json">{"id":"doc_1"}</script>\n</head><body></body></html>`;
    const spliced = spliceCommentsBlock(initialHtml, sampleComments);

    expect(spliced).toContain('id="fish-comments"');
    expect(spliced).toContain('id="design-doc"');
    expect(parseCommentsBlock(spliced).threads[0].id).toBe("cmt_test_1");

    // Clear comments
    const emptySpliced = spliceCommentsBlock(spliced, { version: "0.1", threads: [] });
    expect(emptySpliced).not.toContain('id="fish-comments"');
    expect(emptySpliced).toContain('id="design-doc"');
  });

  it("serializeSelf writes and preserves #fish-comments", () => {
    const doc = createEmptyDocument();
    const serialized = serializeSelf(doc, undefined, { comments: sampleComments });

    expect(serialized).toContain('id="fish-comments"');
    expect(serialized).toContain('id="design-doc"');

    const parsed = parseCommentsBlock(serialized);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].target.elementId).toBe("btn_submit");

    // Re-serializing without opts.comments preserves the existing comments block in targetHtml
    const reSerialized = serializeSelf(doc, serialized);
    expect(parseCommentsBlock(reSerialized).threads).toHaveLength(1);
  });
});
