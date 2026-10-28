import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { h, render, options } from "preact";
import { useState } from "preact/hooks";
import { extractHtmlMetadata, loadHtmlFromFile, loadHtmlFromUrl } from "../src/core/interactions/html-embed-loader";
import { injectSnapshotHelper } from "../src/core/interactions/html-embed-snapshot";
import { useCanvasGestures } from "../src/ui/hooks/useCanvasGestures";
import { DesignDocument, HtmlEmbedElement } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

function makeNode(nodeType: number, nodeName: string) {
  const children: any[] = [];
  return {
    nodeType,
    nodeName,
    childNodes: children,
    children,
    parentNode: null as any,
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
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    style: {}
  };
}

let origDebounce: any;
let origDocument: any;
let origWindow: any;

beforeAll(() => {
  origDebounce = options.debounceRendering;
  options.debounceRendering = (cb) => cb();
  origDocument = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string) => makeNode(1, tag),
    createElementNS: (_: string, tag: string) => makeNode(1, tag),
    createTextNode: (text: string) => {
      const n: any = makeNode(3, "#text");
      n.nodeValue = text;
      return n;
    },
    body: makeNode(1, "BODY")
  };
  origWindow = (globalThis as any).window;
  (globalThis as any).window = new EventTarget();
});

afterAll(() => {
  options.debounceRendering = origDebounce;
  if (origDocument !== undefined) {
    (globalThis as any).document = origDocument;
  } else {
    delete (globalThis as any).document;
  }
  if (origWindow !== undefined) {
    (globalThis as any).window = origWindow;
  } else {
    delete (globalThis as any).window;
  }
});

const fakeHtmlFile = (name: string, text: string): File => {
  const blob = new Blob([text], { type: "text/html" });
  Object.defineProperty(blob, "name", { value: name });
  return blob as File;
};

describe("HTML embed metadata extraction and snapshot injection", () => {
  it("extracts <title> and favicon from html content", () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>Shader Sandbox</title>
          <link rel="icon" href="https://example.com/icon.png">
        </head>
        <body><canvas></canvas></body>
      </html>
    `;
    const meta = extractHtmlMetadata(html);
    expect(meta.title).toBe("Shader Sandbox");
    expect(meta.favicon).toBe("https://example.com/icon.png");
  });

  it("extracts shortcut icon when rel='shortcut icon'", () => {
    const html = `<link rel="shortcut icon" href="/favicon.svg"><title>My Demo</title>`;
    const meta = extractHtmlMetadata(html);
    expect(meta.title).toBe("My Demo");
    expect(meta.favicon).toBe("/favicon.svg");
  });

  it("reads a data: icon whose payload carries the other quote character", () => {
    // This repo's own index.html. `[^"']+` used to cut the href at the first
    // apostrophe and hand the card a truncated URI to paint as a broken image.
    const icon = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3C/svg%3E`;
    const meta = extractHtmlMetadata(`<link rel="icon" type="image/svg+xml" href="${icon}">`);
    expect(meta.favicon).toBe(icon);
  });

  it("finds the icon whichever side of the tag rel sits on", () => {
    const first = extractHtmlMetadata(`<link rel="icon" href="a.png">`);
    const second = extractHtmlMetadata(`<link href="b.png" rel="icon">`);
    expect(first.favicon).toBe("a.png");
    expect(second.favicon).toBe("b.png");
  });

  it("ignores an icon declaration that is not the tab icon", () => {
    const meta = extractHtmlMetadata(`<link rel="apple-touch-icon" href="touch.png">`);
    expect(meta.favicon).toBeUndefined();
  });

  it("keeps a data: icon for an inlined file but drops a relative one", async () => {
    const inlined = await loadHtmlFromFile(
      fakeHtmlFile("a.html", `<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">`)
    );
    expect(inlined.cachedFavicon).toBe("data:image/svg+xml,%3Csvg%3E");

    // A sibling path names a file that does not exist beside the srcdoc, and
    // `data:,` (the "stop asking" idiom) has no payload at all: neither can
    // render, so neither is kept.
    const relative = await loadHtmlFromFile(fakeHtmlFile("b.html", `<link rel="icon" href="./icon.png">`));
    expect(relative.cachedFavicon).toBeUndefined();

    const empty = await loadHtmlFromFile(fakeHtmlFile("c.html", `<link rel="icon" href="data:,">`));
    expect(empty.cachedFavicon).toBeUndefined();
  });

  it("sets cachedTitle and cachedFavicon in loadHtmlFromFile", async () => {
    const file = fakeHtmlFile(
      "demo.html",
      `<!doctype html><html><head><title>Water 3D</title><link rel="icon" href="data:image/png;base64,123"></head></html>`
    );
    const el = await loadHtmlFromFile(file);
    expect(el.name).toBe("Water 3D");
    expect(el.cachedTitle).toBe("Water 3D");
    expect(el.cachedFavicon).toBe("data:image/png;base64,123");
  });

  it("caches the host as the title for a url embed, and fabricates no favicon", () => {
    const el = loadHtmlFromUrl("https://example.org/visuals/fluid");
    expect(el.name).toBe("example.org");
    expect(el.cachedTitle).toBe("example.org");
    expect(el.cachedFavicon).toBeUndefined();
  });

  it("injects runtime snapshot helper before </body> without altering other markup", () => {
    const original = `<!doctype html><html><body><p>Hello</p></body></html>`;
    const injected = injectSnapshotHelper(original);
    expect(injected).toContain('data-fish-helper="snapshot"');
    expect(injected).toContain("<p>Hello</p>");
    expect(injected.endsWith("</body></html>")).toBe(true);
    expect(injectSnapshotHelper(injected)).toBe(injected);
  });

  it("tags the injected helper with the element id so a reply can be bound to a layer", () => {
    const injected = injectSnapshotHelper(`<html><body></body></html>`, "html_42");
    expect(injected).toContain('var EID = "html_42"');
  });
});

describe("HTML embed preview lifecycle in canvas gestures", () => {
  const htmlElement: HtmlEmbedElement = {
    id: "html_target_1",
    type: "html",
    name: "Canvas Sea",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    srcdoc: "<p>test</p>"
  };

  const doc: DesignDocument = normalizeDesignDocument({
    version: "0.1",
    canvas: { width: 1000, height: 1000 },
    elements: [htmlElement]
  } as any).document;

  it("sends a press on an embed down the ordinary selection and drag path", () => {
    const setSelectedIds = vi.fn();
    const startDragGesture = vi.fn();
    let gesturesApi: any;

    function Harness() {
      gesturesApi = useCanvasGestures({
        docRef: { current: doc },
        setDoc: () => {},
        selectedIds: new Set<string>(),
        setSelectedIds,
        primarySelected: null,
        activeTool: "select",
        setActiveTool: () => {},
        zoom: 1,
        pan: { x: 0, y: 0 },
        isPanMode: false,
        isPanModeRef: { current: false },
        startCanvasPan: () => {},
        updateCanvasPan: () => false,
        endCanvasPan: () => {},
        canvasContainerRef: { current: null },
        startDragGesture,
        endDragGesture: () => {},
        commitSnapshot: () => {},
        setHintMessage: () => {},
        startCanvasTextEdit: () => {}
      });
      return null;
    }

    const container = (globalThis as any).document.createElement("div");
    render(h(Harness, null), container);

    gesturesApi.handleElementMouseDown(
      {
        button: 0,
        clientX: 10,
        clientY: 10,
        detail: 1,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        stopPropagation: () => {}
      },
      htmlElement
    );

    // Nothing swallows the press any more. A canvas preview never took the
    // pointer, so the press is an ordinary one: it selects the layer and opens
    // the drag that can move it.
    expect(setSelectedIds).toHaveBeenCalledWith(new Set(["html_target_1"]));
    expect(startDragGesture).toHaveBeenCalled();

    render(null, container);
  });
});
