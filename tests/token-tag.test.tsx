import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { h, render, options } from "preact";
import { TokenTag } from "../src/ui/TokenTag";
import { ColorRow } from "../src/ui/inspector/ColorRow";
import { GradientStopBar } from "../src/ui/color-panel/GradientStopBar";
import type { ColorToken, DesignDocument } from "../src/core/dsl/types";

function makeNode(nodeType: number, nodeName: string) {
  const children: any[] = [];
  const attributes: Record<string, string> = {};
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
    addEventListener() {},
    removeEventListener() {}
  };
}

let origDebounce: any;
let origDocument: any;

beforeAll(() => {
  origDebounce = options.debounceRendering;
  options.debounceRendering = (cb) => cb();
  origDocument = (globalThis as any).document;
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
});

function findByAttr(node: any, attr: string): any[] {
  const results: any[] = [];
  function walk(curr: any) {
    if (!curr) return;
    if (curr.attributes && curr.attributes[attr] !== undefined) {
      results.push(curr);
    }
    for (const child of curr.childNodes || []) {
      walk(child);
    }
  }
  walk(node);
  return results;
}

function findByClass(node: any, cls: string): any[] {
  const results: any[] = [];
  function walk(curr: any) {
    if (!curr) return;
    if (curr.className && curr.className.includes(cls)) {
      results.push(curr);
    }
    for (const child of curr.childNodes || []) {
      walk(child);
    }
  }
  walk(node);
  return results;
}

const INK_TOKEN: ColorToken = {
  id: "tok_ink",
  name: "ink/primary",
  type: "color",
  value: "#111827"
};

const DOC: DesignDocument = {
  version: "0.1",
  id: "doc_1",
  name: "Doc",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  canvas: { width: 100, height: 100, background: { type: "solid", color: "#FFFFFF" }, unit: "px" },
  pages: [
    {
      id: "p1",
      name: "P1",
      canvas: { width: 100, height: 100, background: { type: "solid", color: "#FFFFFF" }, unit: "px" },
      children: []
    }
  ],
  activePageId: "p1",
  tokens: [INK_TOKEN]
};

describe("TokenTag", () => {
  it("renders with tag styling and token name", () => {
    const root: any = makeNode(1, "DIV");
    render(h(TokenTag, { name: "radius/2xl", value: "26" }), root);
    const tags = findByClass(root, "group/tag");
    expect(tags.length).toBe(1);
    expect(tags[0].className).toContain("rounded-sm");
    expect(tags[0].className).toContain("bg-raised");
    expect(tags[0].className).toContain("border-rule");
    expect(tags[0].className).toContain("text-meta");
  });

  it("renders detach button when onDetach is passed", () => {
    let detached = false;
    const root: any = makeNode(1, "DIV");
    render(
      h(TokenTag, {
        name: "ink/primary",
        onDetach: () => {
          detached = true;
        },
        detachProps: { "data-paint-token-detach": "tok_ink" }
      }),
      root
    );
    const detachBtns = findByAttr(root, "data-paint-token-detach");
    expect(detachBtns.length).toBe(1);
    expect(detachBtns[0].getAttribute("data-paint-token-detach")).toBe("tok_ink");
  });

  it("omits detach button when onDetach is omitted", () => {
    const root: any = makeNode(1, "DIV");
    render(h(TokenTag, { name: "ink/primary" }), root);
    const detachBtns = findByAttr(root, "data-paint-token-detach");
    expect(detachBtns.length).toBe(0);
  });
});

describe("ColorRow token tag rendering", () => {
  it("renders TokenTag instead of bare text when bound to a color token", () => {
    const root: any = makeNode(1, "DIV");
    render(
      h(ColorRow, {
        paint: { type: "solid", color: "#111827", tokenId: "tok_ink" },
        tokenId: "tok_ink",
        doc: DOC,
        onBindToken: () => {},
        onDetachToken: () => {}
      }),
      root
    );
    const tokenTags = findByClass(root, "group/tag");
    expect(tokenTags.length).toBe(1);
    expect(tokenTags[0].getAttribute("data-paint-token")).toBe("tok_ink");

    const detachBtns = findByAttr(root, "data-paint-token-detach");
    expect(detachBtns.length).toBe(1);
    expect(detachBtns[0].getAttribute("data-paint-token-detach")).toBe("tok_ink");
  });

  it("renders missing token placeholder when bound tokenId is not in document", () => {
    const root: any = makeNode(1, "DIV");
    render(
      h(ColorRow, {
        paint: { type: "solid", color: "#111827", tokenId: "tok_nonexistent" },
        tokenId: "tok_nonexistent",
        doc: DOC,
        onBindToken: () => {},
        onDetachToken: () => {}
      }),
      root
    );
    const missing = findByAttr(root, "data-paint-token-missing");
    expect(missing.length).toBe(1);
    expect(missing[0].getAttribute("data-paint-token-missing")).toBe("tok_nonexistent");
  });
});

describe("GradientStopBar stop token tag rendering", () => {
  it("renders TokenTag when stopToken is present", () => {
    const root: any = makeNode(1, "DIV");
    render(
      h(GradientStopBar, {
        paint: {
          type: "linear-gradient",
          from: "#111827",
          to: "#FFFFFF",
          angle: 90,
          stops: [
            { offset: 0, color: "#111827", tokenId: "tok_ink" },
            { offset: 1, color: "#FFFFFF" }
          ]
        },
        stops: [
          { offset: 0, color: "#111827", tokenId: "tok_ink" },
          { offset: 1, color: "#FFFFFF" }
        ],
        stopIndex: 0,
        onStopsChange: () => {},
        onSelectStop: () => {},
        onAngleChange: () => {},
        stopToken: INK_TOKEN,
        onOpenTokenPicker: () => {},
        onDetachToken: () => {}
      }),
      root
    );
    const tokenTags = findByClass(root, "group/tag");
    expect(tokenTags.length).toBe(1);
    expect(tokenTags[0].getAttribute("data-stop-token-bind")).toBe("0");

    const detachBtns = findByAttr(root, "data-stop-token-detach");
    expect(detachBtns.length).toBe(1);
    expect(detachBtns[0].getAttribute("data-stop-token-detach")).toBe("tok_ink");
  });
});
