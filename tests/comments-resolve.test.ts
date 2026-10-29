import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { h, render, options } from "preact";
import { CommentPopover } from "../src/ui/canvas/CommentPopover";
import { CommentsOverlay } from "../src/ui/canvas/CommentsOverlay";
import { BottomToolbar } from "../src/ui/toolbar/BottomToolbar";
import type { CommentThread } from "../src/core/comments/types";

function makeNode(nodeType: number, nodeName: string) {
  const children: any[] = [];
  const attributes: Record<string, string> = {};
  const listeners: Record<string, any> = {};
  return {
    nodeType,
    nodeName,
    childNodes: children,
    children,
    parentNode: null as any,
    attributes,
    className: "",
    title: "",
    style: {},
    onclick: null,
    focus() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0 };
    },
    appendChild(c: any) {
      c.parentNode = this;
      children.push(c);
      return c;
    },
    removeChild(c: any) {
      const i = children.indexOf(c);
      if (i !== -1) children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    insertBefore(c: any, ref: any) {
      c.parentNode = this;
      const i = children.indexOf(ref);
      if (i !== -1) children.splice(i, 0, c);
      else children.push(c);
      return c;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute(name: string, value: any) {
      attributes[name] = String(value);
      if (name === "class" || name === "className") this.className = String(value);
      if (name === "title") this.title = String(value);
    },
    removeAttribute(name: string) {
      delete attributes[name];
    },
    getAttribute(name: string) {
      return attributes[name];
    },
    addEventListener(event: string, handler: any) {
      listeners[event] = handler;
    },
    removeEventListener(event: string) {
      delete listeners[event];
    },
    click() {
      const self = this as any;
      const listeners = self._listeners || self.l;
      if (listeners) {
        for (const [key, fn] of Object.entries(listeners)) {
          if (key.toLowerCase().startsWith("click") && typeof fn === "function") {
            fn({ stopPropagation: () => {}, preventDefault: () => {} });
          }
        }
      }
    },
    input(val: string) {
      const self = this as any;
      const listeners = self._listeners || self.l;
      if (listeners) {
        for (const [key, fn] of Object.entries(listeners)) {
          if (key.toLowerCase().startsWith("input") && typeof fn === "function") {
            fn({ currentTarget: { value: val }, target: { value: val } });
          }
        }
      }
    }
  };
}

let origDebounce: any;
let origDocument: any;
let origWindow: any;

beforeAll(() => {
  origDebounce = options.debounceRendering;
  options.debounceRendering = (cb) => cb();
  origDocument = (globalThis as any).document;
  origWindow = (globalThis as any).window;
  (globalThis as any).window = {
    innerWidth: 1000,
    innerHeight: 1000,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  (globalThis as any).document = {
    createElement: (tag: string) => makeNode(1, tag.toUpperCase()),
    createElementNS: (_: string, tag: string) => makeNode(1, tag.toUpperCase()),
    createTextNode: (text: string) => {
      const n: any = makeNode(3, "#text");
      n.nodeValue = text;
      n.textContent = text;
      return n;
    },
    body: makeNode(1, "BODY")
  };
});

afterAll(() => {
  options.debounceRendering = origDebounce;
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
});

function findByAttr(node: any, attr: string, val?: string): any[] {
  const results: any[] = [];
  function walk(curr: any) {
    if (!curr) return;
    if (curr.attributes && curr.attributes[attr] !== undefined) {
      if (val === undefined || curr.attributes[attr] === val) {
        results.push(curr);
      }
    }
    for (const child of curr.childNodes || []) {
      walk(child);
    }
  }
  walk(node);
  return results;
}

function findByText(node: any, text: string): any[] {
  const results: any[] = [];
  function walk(curr: any) {
    if (!curr) return;
    if (curr.nodeType === 3 && curr.nodeValue === text) {
      results.push(curr.parentNode);
    }
    for (const child of curr.childNodes || []) {
      walk(child);
    }
  }
  walk(node);
  return results;
}

describe("comments resolve behaviour", () => {
  const dummyThread: CommentThread = {
    id: "thread_1",
    pageId: "page_1",
    target: { canvasPoint: { x: 100, y: 100 } },
    status: "open",
    createdAt: "2026-10-28T12:00:00Z",
    updatedAt: "2026-10-28T12:00:00Z",
    messages: [
      {
        id: "msg_1",
        author: { id: "user_1", name: "User", role: "user" },
        content: "Fix this color",
        createdAt: "2026-10-28T12:00:00Z"
      }
    ]
  };

  it("calls both onResolve and onClose when resolve button is clicked in CommentPopover", () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    const onReply = vi.fn();
    const onReopen = vi.fn();
    const onDelete = vi.fn();

    const root: any = makeNode(1, "DIV");
    render(
      h(CommentPopover, {
        thread: dummyThread,
        onReply,
        onResolve,
        onReopen,
        onDelete,
        onClose
      }),
      root
    );

    const resolveButtons = findByAttr(root, "aria-label", "Resolve");
    expect(resolveButtons.length).toBe(1);

    resolveButtons[0].click();

    expect(onResolve).toHaveBeenCalledWith("thread_1");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call onClose when reopen is clicked on an already-resolved thread", () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    const onReply = vi.fn();
    const onReopen = vi.fn();
    const onDelete = vi.fn();

    const resolvedThread: CommentThread = {
      ...dummyThread,
      status: "resolved"
    };

    const root: any = makeNode(1, "DIV");
    render(
      h(CommentPopover, {
        thread: resolvedThread,
        onReply,
        onResolve,
        onReopen,
        onDelete,
        onClose
      }),
      root
    );

    const reopenButtons = findByAttr(root, "aria-label", "Reopen");
    expect(reopenButtons.length).toBe(1);

    reopenButtons[0].click();

    expect(onReopen).toHaveBeenCalledWith("thread_1");
    expect(onClose).not.toHaveBeenCalled();
    render(null, root);
  });

  it("calls onReply and onClose when send button is clicked in CommentPopover", () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    const onReply = vi.fn();
    const onReopen = vi.fn();
    const onDelete = vi.fn();

    const root: any = makeNode(1, "DIV");
    render(
      h(CommentPopover, {
        thread: dummyThread,
        onReply,
        onResolve,
        onReopen,
        onDelete,
        onClose
      }),
      root
    );

    const replyInput = findByAttr(root, "aria-label", "Reply...")[0];
    expect(replyInput).toBeDefined();
    replyInput.input("Great change!");

    const sendBtn = findByAttr(root, "aria-label", "Send")[0];
    expect(sendBtn).toBeDefined();
    sendBtn.click();

    expect(onReply).toHaveBeenCalledWith("thread_1", "Great change!");
    expect(onClose).toHaveBeenCalled();
    render(null, root);
  });

  it("highlights the currently active/editing comment pin with amber bg-brand", () => {
    const root: any = makeNode(1, "DIV");
    render(
      h(CommentsOverlay, {
        comments: { version: "0.1", threads: [dummyThread] },
        pageId: "page_1",
        viewport: { panX: 0, panY: 0, zoom: 1 },
        findElement: () => undefined,
        onAddComment: () => {},
        onReplyComment: () => {},
        onResolveComment: () => {},
        onReopenComment: () => {},
        onDeleteComment: () => {},
        activeThreadId: "thread_1"
      }),
      root
    );

    const pins = findByAttr(root, "data-comment-pin", "thread_1");
    expect(pins.length).toBe(1);

    const pill = pins[0].childNodes[0];
    expect(pill.className).toContain("bg-brand");
    expect(pill.className).toContain("text-brand-ink");
    expect(pill.className).toContain("ring-brand");
    render(null, root);
  });

  it("renders a divider between comment and plugin/resources in BottomToolbar", () => {
    const root: any = makeNode(1, "DIV");
    render(
      h(BottomToolbar, {
        activeTool: "select",
        setActiveTool: () => {},
        currentNavTool: "select",
        setCurrentNavTool: () => {},
        currentShapeTool: "rect",
        setCurrentShapeTool: () => {},
        isCanvasPanning: false,
        setHintMessage: () => {}
      }),
      root
    );

    const commentBtn = findByAttr(root, "data-tool", "comment")[0];
    expect(commentBtn).toBeDefined();

    // The divider is a sibling between comment and resources
    const parent = commentBtn.parentNode;
    const commentIndex = parent.childNodes.indexOf(commentBtn);
    const divider = parent.childNodes[commentIndex + 1];

    expect(divider.className).toContain("w-px");
    expect(divider.className).toContain("bg-rule-strong");

    const resourcesBtn = parent.childNodes[commentIndex + 2];
    expect(findByAttr(resourcesBtn, "data-tool", "resources").length).toBe(1);
    render(null, root);
  });
});
