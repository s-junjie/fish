import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { serializeSelf, createEmptyDocument } from "../src/core/data-bridge";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { DesignDocument } from "../src/core/dsl/types";

describe("FISH M0 Round-Trip & Pristine Shell Serialization", () => {
  it("creates a well-formed empty document with a docId and a blank page", () => {
    const doc = createEmptyDocument();
    // Deliberately no `$schema`: it used to point at a URL that does not
    // resolve, and a dead link is worse than no link — it implies a contract
    // that nobody can read.
    expect(doc.$schema).toBeUndefined();
    expect(doc.docId).toMatch(/^fish_/);
    expect(doc.version).toBe("0.1");
    expect(getActivePage(doc).children).toEqual([]);
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages![0].children).toEqual([]);
  });

  it("escapes '<' in the doc block so a literal '</script>' can never terminate it", () => {
    const shell = `<!DOCTYPE html>
<html>
<head>
  <title>Shell</title>
  <script id="design-doc" type="application/json">
  { "version": "0.1" }
  </script>
</head>
<body>
  <div id="app"></div>
</body>
</html>`;

    const doc = createEmptyDocument();
    doc.name = "</script><script>alert(1)</script>";

    const serialized = serializeSelf(doc, shell);
    const match = serialized.match(/<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script>");

    const parsedBack = JSON.parse(match![1]);
    expect(parsedBack.name).toBe("</script><script>alert(1)</script>");
    expect(parsedBack.docId).toBe(doc.docId);
  });

  it("keeps `$1` / `$&` in the document out of the replacement pattern", () => {
    // A string replacement is a pattern: splicing the JSON into the shell with a
    // template literal made every `$1`-shaped run in the document expand to this
    // regex's first capture. A `$196.4K` label was written back as the shell's
    // own `<meta name="fish:fileId" …>` tag, which no longer parses as JSON.
    const shell = `<!DOCTYPE html>
<html>
<head>
  <title>Shell</title>
  <script id="design-doc" type="application/json">
  { "version": "0.1" }
  </script>
</head>
<body>
  <div id="app"></div>
</body>
</html>`;

    const doc = createEmptyDocument();
    const price = "$196.4K — $& — $` — $' — $1,000";
    doc.name = price;

    const serialized = serializeSelf(doc, shell);
    const match = serialized.match(/<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]).name).toBe(price);
  });

  it("normalizes non-destructively preserving element-level unknown properties", () => {
    const rawDoc = {
      docId: "fish_custom_doc",
      version: "0.1",
      name: "Doc With Element Additions",
      canvas: { width: 800, height: 600 },
      customRootField: "preserve_me",
      elements: [
        {
          id: "r1",
          type: "rect",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          customElementTag: "analytics_banner"
        }
      ]
    };

    const firstPass = normalizeDesignDocument(rawDoc, { preserveUnknown: true });
    expect(firstPass.document.docId).toBe("fish_custom_doc");
    expect((firstPass.document as any).customRootField).toBe("preserve_me");
    expect((getActivePage(firstPass.document).children[0] as any).customElementTag).toBe("analytics_banner");

    // Idempotency: second pass yields 0 repairs and identical structure
    const secondPass = normalizeDesignDocument(firstPass.document, { preserveUnknown: true });
    expect(secondPass.repairs.length).toBe(0);
    expect(secondPass.document).toEqual(firstPass.document);
  });
});
