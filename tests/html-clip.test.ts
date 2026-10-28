import { describe, expect, it } from "vitest";
import {
  FISH_HTML_CLIP_FORMAT,
  FISH_HTML_CLIP_SIGNATURE,
  createHtmlClipPayload,
  isHtmlClipText,
  parseHtmlClip
} from "../src/core/import/html-clip";
import { importHtmlDocument } from "../src/core/import/html-import";

describe("html-clip transport format", () => {
  it("recognizes a valid JSON clip payload", () => {
    const raw = JSON.stringify({
      format: FISH_HTML_CLIP_FORMAT,
      version: "0.1",
      html: "<div style='width: 100px; height: 50px; background: red;'>Button</div>",
      title: "Red Button",
      mode: "element"
    });
    expect(isHtmlClipText(raw)).toBe(true);
  });

  it("recognizes an HTML signature clip payload", () => {
    const raw = `${FISH_HTML_CLIP_SIGNATURE}\n<div class="card">Card</div>`;
    expect(isHtmlClipText(raw)).toBe(true);
  });

  it("refuses plain text, code, or malformed JSON", () => {
    expect(isHtmlClipText("")).toBe(false);
    expect(isHtmlClipText("Hello world")).toBe(false);
    expect(isHtmlClipText("const x = 123;")).toBe(false);
    expect(isHtmlClipText('{"format": "other-app"}')).toBe(false);
    expect(isHtmlClipText('{"format": "fish-html-clip", "html": ""}')).toBe(false);
  });

  it("round-trips payload creation and parsing", () => {
    const html = "<header><h1>Header</h1></header>";
    const json = createHtmlClipPayload(html, {
      title: "Hero Header",
      url: "https://example.com",
      mode: "element"
    });

    expect(isHtmlClipText(json)).toBe(true);
    const parsed = parseHtmlClip(json);
    expect(parsed.html).toBe(html);
    expect(parsed.title).toBe("Hero Header");
    expect(parsed.mode).toBe("element");
    expect(parsed.url).toBe("https://example.com");
  });

  it("parses HTML signature payload", () => {
    const html = "<section><p>Text</p></section>";
    const raw = `${FISH_HTML_CLIP_SIGNATURE}\n${html}`;
    const parsed = parseHtmlClip(raw);
    expect(parsed.html).toBe(html);
    expect(parsed.title).toBe("Imported Element");
    expect(parsed.mode).toBe("element");
  });

  it("handles whitespace, title fallback, and url extraction", () => {
    const raw = JSON.stringify({
      format: FISH_HTML_CLIP_FORMAT,
      html: "<div>Content</div>",
      url: "https://example.com"
    });
    const parsed = parseHtmlClip(raw);
    expect(parsed.title).toBe("Imported HTML");
    expect(parsed.mode).toBe("element");
    expect(parsed.url).toBe("https://example.com");
  });

  it("recognizes and parses raw HTML documents and container snippets", () => {
    const docHtml = "<!DOCTYPE html><html><head><title>My Page</title></head><body><h1>Hello</h1></body></html>";
    expect(isHtmlClipText(docHtml)).toBe(true);
    const docParsed = parseHtmlClip(docHtml);
    expect(docParsed.title).toBe("My Page");
    expect(docParsed.mode).toBe("page");

    const blockHtml = "<div class='container'><p>Hello World</p></div>";
    expect(isHtmlClipText(blockHtml)).toBe(true);
    const blockParsed = parseHtmlClip(blockHtml);
    expect(blockParsed.mode).toBe("element");
  });

  it("handles browser fragments with StartFragment comments and meta tags", () => {
    const browserClip = "<meta charset='utf-8'><!--StartFragment--><div class='card'>Card</div><!--EndFragment-->";
    expect(isHtmlClipText(browserClip)).toBe(true);
    const parsed = parseHtmlClip(browserClip);
    expect(parsed.html).toContain("<div class='card'>Card</div>");
    expect(parsed.mode).toBe("element");
  });

  it("recognizes SVG vector markup as HTML element clip", () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
    expect(isHtmlClipText(svg)).toBe(true);
    const parsed = parseHtmlClip(svg);
    expect(parsed.title).toBe("Imported SVG");
    expect(parsed.mode).toBe("element");
  });

  it("defers iframe embed snippets so they can be handled by the embed loader", () => {
    const iframeSnippet = '<iframe src="https://example.com/embed" width="800" height="600"></iframe>';
    expect(isHtmlClipText(iframeSnippet)).toBe(false);
  });

  it("aborts HTML import when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      importHtmlDocument("<div>Hello</div>", { signal: controller.signal })
    ).rejects.toThrow();
  });
});
