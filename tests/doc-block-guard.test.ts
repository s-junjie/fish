import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// The build template (index.html) carries the demo `#design-doc` block authored
// by hand. A literal `</script>` inside any of its string values would terminate
// the script tag at HTML-parse time and corrupt every artifact built from it —
// and, unlike runtime saves, nothing re-serializes this block on the way out, so
// the escaping in serializeSelf cannot save it. This guard exists so a
// future edit to the template fails `npm test` instead of shipping a broken file.
const DOC_RE = /<script id="design-doc" type="application\/json">\n([\s\S]*?)\n\s*<\/script>/;

function readDocBlock(): string {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(DOC_RE);
  expect(match).not.toBeNull();
  return match![1];
}

describe("index.html design-doc block hygiene", () => {
  it("contains no literal </script> that could terminate the block", () => {
    const body = readDocBlock();
    expect(body.toLowerCase()).not.toContain("</script");
  });

  it("parses as JSON even with a '</script>' inside any value", () => {
    const body = readDocBlock();
    expect(() => JSON.parse(body)).not.toThrow();
  });
});