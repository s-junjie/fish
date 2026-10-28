import { describe, it, expect } from "vitest";
import { DOC_BLOCK_RE, injectDocumentBlock } from "../src/core/cli/doc-source";

const shell = `<!doctype html><html><head><script id="design-doc" type="application/json">
{"old":"TEMPLATE_BODY"}
</script></head><body><p>TAIL</p></body></html>`;

describe("injectDocumentBlock", () => {
  it("writes payload text literally, including every replacement pattern", () => {
    const payloads = ["$1,840", "$&", "$`", "$'", "$$", "$100", "$0", "$<x>", "\\$1"];
    for (const content of payloads) {
      const out = injectDocumentBlock(shell, JSON.stringify({ content }));
      const body = DOC_BLOCK_RE.exec(out)?.[1];
      expect(body).toBeDefined();
      expect(JSON.parse(body!)).toEqual({ content });
      expect(out).not.toContain("TEMPLATE_BODY");
      expect(out).toContain("<p>TAIL</p>");
    }
  });
});
