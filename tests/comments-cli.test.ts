import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCommentsBlock } from "../src/core/data-bridge";
import { commentsCommand } from "../src/core/cli/fish-comments";

/**
 * `fish comments` runs in-process here rather than through `node scripts/…`:
 * the command is a function over a file's text, and a child process would only
 * add an interpreter to the thing under test. The kit's `./fish` reaches the
 * same function (see `src/core/cli/fish.ts`).
 */
function run(args: string[], opts: Parameters<typeof commentsCommand>[1] = {}): string {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    commentsCommand(args, opts);
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("comments CLI workflow", () => {
  const tmpFile = join(process.cwd(), "test_comments_cli.fish.html");

  const initialHtml = `<!DOCTYPE html>
<html>
<head>
  <script id="design-doc" type="application/json">
  {
    "version": "0.1",
    "id": "doc_cli",
    "name": "CLI Test Doc",
    "pages": [
      {
        "id": "page_1",
        "name": "Page 1",
        "children": [
          { "id": "btn_target", "type": "rect", "name": "Target Button", "x": 10, "y": 10, "width": 100, "height": 40 }
        ]
      }
    ],
    "tokens": [
      { "id": "t1", "name": "--fish-brand", "type": "color", "value": "#3B82F6" },
      { "id": "t2", "name": "radius/card", "type": "number", "value": 12, "category": "radius" }
    ]
  }
  </script>
  <script id="fish-comments" type="application/json">
  {
    "version": "0.1",
    "threads": [
      {
        "id": "cmt_cli_1",
        "pageId": "page_1",
        "target": { "elementId": "btn_target", "canvasPoint": { "x": 10, "y": 10 } },
        "status": "open",
        "createdAt": "2026-10-27T10:00:00Z",
        "updatedAt": "2026-10-27T10:00:00Z",
        "messages": [
          {
            "id": "m1",
            "author": { "id": "u1", "name": "User", "role": "user" },
            "content": "Make button width 200px",
            "createdAt": "2026-10-27T10:00:00Z"
          }
        ]
      }
    ]
  }
  </script>
</head>
<body></body>
</html>`;

  afterEach(() => {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  });

  it("lists comments from file", () => {
    writeFileSync(tmpFile, initialHtml, "utf-8");
    const list = JSON.parse(run(["list", tmpFile]));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("cmt_cli_1");
    expect(list[0].status).toBe("open");
    expect(list[0].targetElementId).toBe("btn_target");
    expect(list[0].instruction).toBe("Make button width 200px");
  });

  it("pending returns only the threads an agent still has to act on", () => {
    writeFileSync(tmpFile, initialHtml, "utf-8");
    expect(JSON.parse(run(["pending", tmpFile]))).toHaveLength(1);
    run(["resolve", tmpFile, "cmt_cli_1"]);
    expect(JSON.parse(run(["pending", tmpFile]))).toHaveLength(0);
  });

  it("extracts AI context for a comment thread", () => {
    writeFileSync(tmpFile, initialHtml, "utf-8");
    const context = JSON.parse(run(["context", tmpFile, "cmt_cli_1"]));
    expect(context.threadId).toBe("cmt_cli_1");
    expect(context.instruction).toBe("Make button width 200px");
    expect(context.target.id).toBe("btn_target");
    expect(context.tokens.colors).toContain("--fish-brand");
    expect(context.tokens.radii).toEqual(["radius/card"]);
  });

  it("returns laid-out coordinates and derived instance targets in context", () => {
    const html = `<!DOCTYPE html>
<html><head>
  <script id="design-doc" type="application/json">
  {
    "version": "0.1",
    "id": "doc_layout_inst",
    "name": "Layout & Instance",
    "pages": [
      {
        "id": "page_1",
        "name": "Page 1",
        "children": [
          {
            "id": "flex_row",
            "type": "frame",
            "x": 20,
            "y": 30,
            "width": 200,
            "height": 80,
            "display": "flex",
            "padding": 16,
            "children": [
              { "id": "child_box", "type": "rect", "x": 0, "y": 0, "width": 80, "height": 24 }
            ]
          },
          {
            "id": "comp_btn",
            "type": "component",
            "x": 0,
            "y": 200,
            "width": 120,
            "height": 40,
            "children": [
              { "id": "lbl", "type": "text", "content": "Go", "x": 12, "y": 8, "width": 60, "height": 20 }
            ]
          },
          {
            "id": "inst_cta",
            "type": "instance",
            "componentId": "comp_btn",
            "x": 20,
            "y": 140
          }
        ]
      }
    ],
    "tokens": []
  }
  </script>
  <script id="fish-comments" type="application/json">
  {
    "version": "0.1",
    "threads": [
      {
        "id": "cmt_flex",
        "pageId": "page_1",
        "target": { "elementId": "child_box", "canvasPoint": { "x": 36, "y": 46 } },
        "status": "open",
        "createdAt": "2026-10-27T10:00:00Z",
        "updatedAt": "2026-10-27T10:00:00Z",
        "messages": [{ "id": "m1", "author": { "id": "u1", "name": "U", "role": "user" }, "content": "Nudge", "createdAt": "2026-10-27T10:00:00Z" }]
      },
      {
        "id": "cmt_inst",
        "pageId": "page_1",
        "target": { "elementId": "inst_cta_lbl", "canvasPoint": { "x": 32, "y": 148 } },
        "status": "open",
        "createdAt": "2026-10-27T10:00:00Z",
        "updatedAt": "2026-10-27T10:00:00Z",
        "messages": [{ "id": "m2", "author": { "id": "u1", "name": "U", "role": "user" }, "content": "Rename", "createdAt": "2026-10-27T10:00:00Z" }]
      }
    ]
  }
  </script>
</head><body></body></html>`;
    writeFileSync(tmpFile, html, "utf-8");

    const flexCtx = JSON.parse(run(["context", tmpFile, "cmt_flex"]));
    expect(flexCtx.target.x).toBe(16);
    expect(flexCtx.target.y).toBe(16);
    expect(flexCtx.tokens.radii).toEqual([]);

    const instCtx = JSON.parse(run(["context", tmpFile, "cmt_inst"]));
    expect(instCtx.target.id).toBe("inst_cta_lbl");
    expect(instCtx.instanceTarget).toEqual({
      instanceId: "inst_cta",
      masterNodeId: "lbl",
      overridable: true
    });
    expect(instCtx.parent.id).toBe("inst_cta");
  });

  it("refuses to read the design document of another dialect", () => {
    const foreign = initialHtml.replace('"version": "0.1",\n    "id": "doc_cli"', '"version": "9.9",\n    "id": "doc_cli"');
    writeFileSync(tmpFile, foreign, "utf-8");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = commentsCommand(["context", tmpFile, "cmt_cli_1"]);
    const message = error.mock.calls.map((call) => call.join(" ")).join("\n");
    const printed = log.mock.calls.length;
    error.mockRestore();
    log.mockRestore();
    expect(code).toBe(2);
    expect(printed).toBe(0);
    expect(message).toContain("document dialect 9.9");
    expect(message).toContain("does not migrate");
  });

  it("still lists the conversation of a file whose document it will not read", () => {
    const foreign = initialHtml.replace('"version": "0.1",\n    "id": "doc_cli"', '"version": "9.9",\n    "id": "doc_cli"');
    writeFileSync(tmpFile, foreign, "utf-8");
    expect(JSON.parse(run(["list", tmpFile]))).toHaveLength(1);
  });

  it("writes an AI suggestion without mutating #design-doc", () => {
    writeFileSync(tmpFile, initialHtml, "utf-8");
    const docBlockBefore = /<script id="design-doc"[\s\S]*?<\/script>/.exec(initialHtml)![0];
    const ops = JSON.stringify([{ op: "patch", id: "btn_target", value: { width: 200 } }]);
    run(["suggest", tmpFile, "cmt_cli_1"], { summary: "Adjust width to 200px", ops });

    const written = readFileSync(tmpFile, "utf-8");
    expect(/<script id="design-doc"[\s\S]*?<\/script>/.exec(written)![0]).toBe(docBlockBefore);

    const comments = parseCommentsBlock(written);
    expect(comments.threads[0].status).toBe("suggested");
    expect(comments.threads[0].suggestion?.summary).toBe("Adjust width to 200px");
    expect(comments.threads[0].suggestion?.ops).toHaveLength(1);
    // The suggestion is also a message: a reloaded thread must read as a
    // conversation, and the panel shows the last message as its snippet.
    expect(comments.threads[0].messages.at(-1)?.content).toBe("Adjust width to 200px");
  });

  it("resolves a thread and appends an AI reply", () => {
    writeFileSync(tmpFile, initialHtml, "utf-8");
    run(["resolve", tmpFile, "cmt_cli_1"], { reply: "Width set to 200px." });

    const comments = parseCommentsBlock(readFileSync(tmpFile, "utf-8"));
    expect(comments.threads[0].status).toBe("resolved");
    expect(comments.threads[0].messages).toHaveLength(2);
    expect(comments.threads[0].messages[1].content).toBe("Width set to 200px.");
  });

  it("replies without changing the status", () => {
    writeFileSync(tmpFile, initialHtml, "utf-8");
    run(["reply", tmpFile, "cmt_cli_1"], { text: "Which width do you mean?" });
    const comments = parseCommentsBlock(readFileSync(tmpFile, "utf-8"));
    expect(comments.threads[0].status).toBe("open");
    expect(comments.threads[0].messages.at(-1)?.content).toBe("Which width do you mean?");
    expect(comments.threads[0].messages.at(-1)?.author.role).toBe("ai");
  });

  it("reports a missing thread instead of writing", () => {
    writeFileSync(tmpFile, initialHtml, "utf-8");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = commentsCommand(["resolve", tmpFile, "cmt_missing"]);
    error.mockRestore();
    expect(code).toBe(1);
    expect(readFileSync(tmpFile, "utf-8")).toBe(initialHtml);
  });
});
