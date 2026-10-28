import { describe, expect, it } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import {
  DEFAULT_HTML_HEIGHT,
  DEFAULT_HTML_WIDTH,
  MAX_HTML_FILE_BYTES,
  computeHtmlTargetSize,
  createHtmlElement,
  htmlNameFromUrl,
  loadHtmlFromEmbedCode,
  loadHtmlFromFile,
  loadHtmlFromUrl,
  parseEmbedCode
} from "../src/core/interactions/html-embed-loader";
import { isFrameableUrl } from "../src/core/dsl/html-source";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { documentFromHtml, serializeSelf } from "../src/core/data-bridge";
import { presentationFrames } from "../src/core/presentation/frames";
import { HtmlEmbedElement } from "../src/core/dsl/types";
import { HTML_EMBED_SANDBOX } from "../src/ui/canvas/SvgHtmlEmbedNode";

const docOf = (elements: unknown[]) =>
  normalizeDesignDocument({
    version: "0.1",
    canvas: { width: 1920, height: 1080, unit: "px" },
    elements
  } as never).document;

const fakeHtmlFile = (name: string, text: string, size?: number): File => {
  const blob = new Blob([text], { type: "text/html" });
  Object.defineProperty(blob, "name", { value: name });
  if (size !== undefined) Object.defineProperty(blob, "size", { value: size });
  return blob as File;
};

describe("what can be framed", () => {
  it("accepts only http(s) pages", () => {
    expect(isFrameableUrl("https://example.com")).toBe(true);
    expect(isFrameableUrl("http://example.com/a?b=c")).toBe(true);
    expect(isFrameableUrl("  https://example.com  ")).toBe(true);
  });

  it("refuses the schemes a browser would not fetch for us", () => {
    // `file:` is unreachable from an already-loaded page, and `data:` is a
    // document rather than a location — that case is what `srcdoc` is for.
    expect(isFrameableUrl("file:///Users/x/page.html")).toBe(false);
    expect(isFrameableUrl("data:text/html,<p>hi</p>")).toBe(false);
    expect(isFrameableUrl("javascript:alert(1)")).toBe(false);
    expect(isFrameableUrl("example.com")).toBe(false);
    expect(isFrameableUrl("")).toBe(false);
  });

  it("names an embed after its host, and falls back when there is none", () => {
    expect(htmlNameFromUrl("https://www.example.com/deep/path")).toBe("example.com");
    expect(htmlNameFromUrl("not a url")).toBe("Web Page");
  });
});

describe("placing an html embed", () => {
  it("opens at a viewport-sized box, since a page has no intrinsic size", () => {
    expect(createHtmlElement({ x: 0, y: 0 })).toMatchObject({
      type: "html",
      width: DEFAULT_HTML_WIDTH,
      height: DEFAULT_HTML_HEIGHT
    });
  });

  it("scales a box past the cap without distorting it", () => {
    const { width, height } = computeHtmlTargetSize(4000, 2000);
    expect(width).toBe(1280);
    expect(height).toBe(640);
  });

  it("opens the default at exactly 1280 × 800, uncapped", () => {
    // The default IS the cap: a cap below it would silently shrink every embed
    // the author places without asking for a size.
    const { width, height } = computeHtmlTargetSize(DEFAULT_HTML_WIDTH, DEFAULT_HTML_HEIGHT);
    expect([width, height]).toEqual([1280, 800]);
  });

  it("stores a URL as `src`", () => {
    const el = loadHtmlFromUrl("https://example.com/page");
    expect(el.src).toBe("https://example.com/page");
    expect(el.srcdoc).toBeUndefined();
    expect(el.name).toBe("example.com");
  });

  it("refuses a URL it cannot frame, rather than making an empty embed", () => {
    expect(() => loadHtmlFromUrl("file:///tmp/page.html")).toThrow(/http/i);
    expect(() => loadHtmlFromUrl("   ")).toThrow();
  });

  it("inlines a local file as `srcdoc`, so the document stays one file", async () => {
    const el = await loadHtmlFromFile(fakeHtmlFile("landing.html", "<!doctype html><p>hi</p>"));
    expect(el.srcdoc).toBe("<!doctype html><p>hi</p>");
    expect(el.src).toBeUndefined();
    expect(el.name).toBe("landing");
  });

  it("refuses a file too large to live inside the document", async () => {
    await expect(
      loadHtmlFromFile(fakeHtmlFile("huge.html", "<p>x</p>", MAX_HTML_FILE_BYTES + 1))
    ).rejects.toThrow(/limit/i);
  });

  it("refuses an empty file", async () => {
    await expect(loadHtmlFromFile(fakeHtmlFile("empty.html", "   "))).rejects.toThrow();
  });
});

describe("an embed snippet is reduced to the page it frames", () => {
  const YOUTUBE = `<iframe width="560" height="315" src="https://www.youtube.com/embed/xyz"
    title="YouTube video player" frameborder="0"
    allow="accelerometer; autoplay; encrypted-media" allowfullscreen></iframe>`;

  it("takes the src and the size the snippet asks for", () => {
    expect(parseEmbedCode(YOUTUBE)).toEqual({
      src: "https://www.youtube.com/embed/xyz",
      width: 560,
      height: 315
    });
  });

  it("opens the placed embed at that size, not at the default box", () => {
    expect(loadHtmlFromEmbedCode(YOUTUBE)).toMatchObject({
      type: "html",
      width: 560,
      height: 315,
      src: "https://www.youtube.com/embed/xyz",
      name: "youtube.com"
    });
  });

  it("resolves a protocol-relative src, which is how a share dialog writes one", () => {
    expect(parseEmbedCode('<iframe src="//player.example.com/p.html?b=1"></iframe>')).toMatchObject({
      src: "https://player.example.com/p.html?b=1"
    });
  });

  it("falls back to the default box when a size has no pixel answer", () => {
    const parsed = parseEmbedCode('<iframe src="https://example.com" width="100%" height="480"></iframe>');
    expect(parsed).toMatchObject({ width: undefined, height: 480 });
    expect(loadHtmlFromEmbedCode('<iframe src="https://example.com" width="100%"></iframe>')).toMatchObject({
      width: DEFAULT_HTML_WIDTH,
      height: DEFAULT_HTML_HEIGHT
    });
  });

  it("reads attributes whichever quote they use, and survives a `>` inside a value", () => {
    const parsed = parseEmbedCode(`<iframe src='https://example.com/a?b=1' title='a > b' width='640'></iframe>`);
    expect(parsed).toMatchObject({ src: "https://example.com/a?b=1", width: 640 });
  });

  it("ignores a commented-out frame, so a whole page pasted in still finds the live one", () => {
    const page = `<!-- <iframe src="https://old.example.com"></iframe> -->\n${YOUTUBE}`;
    expect(parseEmbedCode(page)).toMatchObject({ src: "https://www.youtube.com/embed/xyz" });
  });

  it("refuses what it cannot frame rather than placing an empty one", () => {
    expect(parseEmbedCode("https://example.com")).toBeNull();
    expect(parseEmbedCode('<iframe src="file:///tmp/page.html"></iframe>')).toBeNull();
    expect(parseEmbedCode('<iframe src="javascript:alert(1)"></iframe>')).toBeNull();
    expect(parseEmbedCode("<iframe></iframe>")).toBeNull();
    // A `<script>` widget is not an iframe and is not a URL either; it has no
    // frame to point at, which is the whole reason this entry refuses it.
    expect(parseEmbedCode('<script src="https://platform.example.com/widget.js"></script>')).toBeNull();
    expect(() => loadHtmlFromEmbedCode("<p>hello</p>")).toThrow(/iframe/i);
  });

  it("drops the permissions a snippet carries, since no field can hold them", () => {
    const el = loadHtmlFromEmbedCode(YOUTUBE);
    expect(Object.keys(el).sort()).toEqual(
      ["height", "id", "name", "src", "type", "width", "x", "y"].sort()
    );
  });
});

describe("an html embed survives a save and a load", () => {
  const normalize = (el: Record<string, unknown>) =>
    normalizeDesignDocument(
      {
        version: "0.1",
        canvas: { width: 800, height: 600, unit: "px" },
        elements: [{ id: "h1", type: "html", x: 0, y: 0, width: 400, height: 300, ...el }]
      } as never,
      { preserveUnknown: true }
    );

  it("keeps `src` and drops no key", () => {
    const { document, repairs } = normalize({ src: "https://example.com" });
    const el = getActivePage(document).children[0] as HtmlEmbedElement;
    expect(el.type).toBe("html");
    expect(el.src).toBe("https://example.com");
    expect(repairs.filter((r) => r.kind === "type")).toEqual([]);
    expect(repairs.filter((r) => r.kind === "dropped-property")).toEqual([]);
  });

  it("keeps `srcdoc` verbatim, whitespace and all", () => {
    const doc = "<!doctype html>\n<html>\n  <body>\n    <p>hi</p>\n  </body>\n</html>";
    const { document } = normalize({ srcdoc: doc });
    expect(getActivePage(document).children[0] as HtmlEmbedElement).toMatchObject({ srcdoc: doc });
  });

  /**
   * The flag is a layer's standing request, so it has to come back out of the
   * file — and it has to come back absent, not `false`, on the embeds that
   * never made it. A written `false` on every embed in the document is noise
   * on the wire and a diff on every save.
   */
  it("keeps `alwaysLive`, and leaves it off an embed that never set it", () => {
    const armed = normalize({ src: "https://example.com", alwaysLive: true });
    expect(getActivePage(armed.document).children[0] as HtmlEmbedElement).toMatchObject({ alwaysLive: true });
    expect(armed.repairs.filter((r) => r.kind === "dropped-property")).toEqual([]);

    const resting = normalize({ src: "https://example.com" });
    expect(getActivePage(resting.document).children[0] as HtmlEmbedElement).not.toHaveProperty("alwaysLive");
  });

  it("reports an embed with neither source instead of rendering a silent blank", () => {
    const { repairs } = normalize({});
    const reported = repairs.filter((r) => r.kind === "element");
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toMatch(/neither "src" nor "srcdoc"/);
  });

  /**
   * The document block is a `<script>` in the saved file, so a `</script>` inside
   * an inlined page would end the block early and truncate the document — the
   * one way an embed can corrupt the file it lives in.
   */
  it("round-trips an inlined document that contains `</script>`", () => {
    const srcdoc = '<!doctype html><body><script>var a = 1;</script></body>';
    const { document } = normalize({ srcdoc });
    const html = serializeSelf(document, "<!doctype html><html><head></head><body></body></html>");

    // Only the writer's own close tag is literal. The page's one is escaped to
    // `\u003c/script>`, which is what keeps the block from ending early.
    expect(html.match(/<\/script>/g)?.length).toBe(1);
    expect(html).toContain("\\u003c/script>");

    const back = documentFromHtml(html);
    expect(getActivePage(back!).children[0] as HtmlEmbedElement).toMatchObject({ srcdoc });
  });
});

describe("an html embed is a slide", () => {
  it("presents on its own, rather than needing a frame wrapped around it", () => {
    const frames = presentationFrames(
      docOf([{ id: "h1", type: "html", x: 0, y: 0, width: 1280, height: 800, src: "https://example.com" }])
    );
    expect(frames.map((f) => f.id)).toEqual(["h1"]);
    expect(frames[0].bounds).toMatchObject({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it("takes its place in reading order among artboards", () => {
    const frames = presentationFrames(
      docOf([
        { id: "page2", type: "frame", x: 2000, y: 0, width: 100, height: 100 },
        { id: "h1", type: "html", x: 0, y: 0, width: 1280, height: 800, srcdoc: "<p>hi</p>" }
      ])
    );
    expect(frames.map((f) => f.id)).toEqual(["h1", "page2"]);
  });

  it("is not a slide when it is hidden, by the same rule the containers follow", () => {
    const frames = presentationFrames(
      docOf([
        { id: "h1", type: "html", x: 0, y: 0, width: 100, height: 100, srcdoc: "<p>hi</p>", visible: false }
      ])
    );
    expect(frames.map((f) => f.id)).not.toContain("h1");
  });

  it("carries a slide transition, which only a slide can have", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 800, height: 600, unit: "px" },
      elements: [
        {
          id: "h1",
          type: "html",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          srcdoc: "<p>hi</p>",
          slide: { transition: "dissolve" }
        }
      ]
    } as never);
    expect(getActivePage(document).children[0]).toMatchObject({ slide: { transition: "dissolve" } });
    expect(repairs.filter((r) => r.path.endsWith("/slide"))).toEqual([]);
  });

  /**
   * The other half of the change: `slide` was loosened for `html` and for
   * nothing else, so a shape that has no slide still says so.
   */
  it("still drops `slide` from a type that has no slide", () => {
    const { repairs } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 800, height: 600, unit: "px" },
      elements: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10, slide: { transition: "dissolve" } }]
    } as never);
    expect(
      repairs.some((r) => r.kind === "dropped-property" && r.path.endsWith("/slide"))
    ).toBe(true);
  });
});

/**
 * The sandbox and the scheme check are the two halves of one boundary, and both
 * are a single token away from being wrong in a way nothing else notices.
 *
 * `allow-same-origin` on the frame would hand a picked `.html` — which inherits
 * this page's origin through `srcdoc` — the app's DOM, its `localStorage`, and
 * the IndexedDB holding every autosave backup. Every other test here passes
 * unchanged if that token appears, so it is asserted directly.
 */
describe("the trust boundary an embedded document crosses", () => {
  it("denies the frame same-origin, which is what keeps a srcdoc out of the app", () => {
    expect(HTML_EMBED_SANDBOX).not.toMatch(/allow-same-origin/);
    // An opaque origin is the whole point, so nothing may re-add the token
    // through a spelling this assertion would miss.
    for (const token of HTML_EMBED_SANDBOX.split(/\s+/)) {
      expect(token.toLowerCase()).not.toContain("same-origin");
    }
  });

  it("drops a src that is not a page the browser may fetch", () => {
    const bad = [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "  JavaScript:alert(1)  "
    ];
    for (const src of bad) {
      const { document, repairs } = normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 800, height: 600, unit: "px" },
        elements: [{ id: "h", type: "html", x: 0, y: 0, width: 100, height: 100, src }]
      } as never);
      expect((getActivePage(document).children[0] as HtmlEmbedElement).src).toBeUndefined();
      expect(repairs.some((r) => r.path.endsWith("/src") && r.message.includes("http(s)"))).toBe(true);
    }
  });

  it("keeps an http(s) src, and says nothing about it", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 800, height: 600, unit: "px" },
      elements: [{ id: "h", type: "html", x: 0, y: 0, width: 100, height: 100, src: "https://example.com/a" }]
    } as never);
    expect((getActivePage(document).children[0] as HtmlEmbedElement).src).toBe("https://example.com/a");
    expect(repairs.filter((r) => r.path.endsWith("/src"))).toEqual([]);
  });

  it("falls back to the inline document when the src is dropped", () => {
    const { document } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 800, height: 600, unit: "px" },
      elements: [
        { id: "h", type: "html", x: 0, y: 0, width: 100, height: 100, src: "javascript:alert(1)", srcdoc: "<p>hi</p>" }
      ]
    } as never);
    const el = getActivePage(document).children[0] as HtmlEmbedElement;
    expect(el.src).toBeUndefined();
    expect(el.srcdoc).toBe("<p>hi</p>");
  });

  it("survives sandboxed environments where accessing window.localStorage throws SecurityError", () => {
    const sandboxedWindow = {} as Window;
    Object.defineProperty(sandboxedWindow, "localStorage", {
      get() {
        throw new Error("SecurityError: Failed to read 'localStorage' from 'Window'");
      }
    });

    let readVal: string | null = null;
    expect(() => {
      try {
        readVal = sandboxedWindow.localStorage?.getItem("test") ?? null;
      } catch {
        readVal = null;
      }
    }).not.toThrow();
    expect(readVal).toBeNull();
  });
});

