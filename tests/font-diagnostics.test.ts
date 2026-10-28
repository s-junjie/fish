import { describe, expect, it } from "vitest";
import { fontDiagnostics } from "../src/core/font-diagnostics";
import type { DesignDocument, DesignElement, FontSpec } from "../src/core/dsl/types";

const doc = (elements: DesignElement[], fonts?: FontSpec[]): DesignDocument =>
  ({
    version: "0.1",
    name: "Fonts",
    canvas: { width: 375, height: 400 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 375, height: 400 }, children: elements }],
    activePageId: "page_1",
    ...(fonts ? { fonts } : {})
  }) as unknown as DesignDocument;

const text = (props: Record<string, unknown> = {}): DesignElement =>
  ({
    id: "label",
    name: "Label",
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 24,
    content: "Hello",
    style: { fontFamily: "Inter", fontSize: 16 },
    ...props
  }) as unknown as DesignElement;

const messages = (elements: DesignElement[], fonts?: FontSpec[]) =>
  fontDiagnostics(doc(elements, fonts)).map((d) => d.message);

describe("fontDiagnostics", () => {
  it("reports a bare family that no fonts[] entry carries", () => {
    const out = fontDiagnostics(doc([text()]));
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe("info");
    expect(out[0].elementId).toBe("label");
    expect(out[0].message).toContain('Font "Inter"');
    expect(out[0].message).toContain("no fonts[] entry carries it");
  });

  it("says nothing when the family is carried with a src", () => {
    expect(fontDiagnostics(doc([text()], [{ family: "Inter", src: "data:font/woff2;base64,AA" }]))).toEqual([]);
  });

  it("reads a carried family list by its names, not its spelling", () => {
    // The demo document's entry is a whole CSS stack; matching it as one string
    // would report every text in the file.
    expect(fontDiagnostics(doc([text()], [{ family: "Inter, sans-serif", src: "data:font/woff2;base64,AA" }]))).toEqual([]);
    expect(fontDiagnostics(doc([text({ style: { fontFamily: "inter", fontSize: 16 } })], [
      { family: "Inter", src: "data:font/woff2;base64,AA" }
    ]))).toEqual([]);
  });

  it("leaves a stack that declares its own fallback alone", () => {
    // "the substitution is the design" — the author said what happens without it.
    expect(messages([text({ style: { fontFamily: "Inter, sans-serif", fontSize: 16 } })])).toEqual([]);
    expect(messages([text({ style: { fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", fontSize: 16 } })])).toEqual([]);
  });

  it("reports each missing family once, with a count", () => {
    const out = fontDiagnostics(
      doc([
        text({ id: "a" }),
        text({ id: "b" }),
        text({ id: "c", style: { fontFamily: "SF Pro Display", fontSize: 16 } })
      ])
    );
    expect(out).toHaveLength(2);
    expect(out[0].message).toContain("used by 2 text(s)");
    expect(out[0].elementId).toBe("a");
    expect(out[1].message).toContain('Font "SF Pro Display"');
  });

  it("counts a span's own family as a use", () => {
    const out = fontDiagnostics(
      doc([text({ spans: [{ text: "Hi", style: { fontFamily: "Playfair Display" } }] })], [
        { family: "Inter", src: "data:font/woff2;base64,AA" }
      ])
    );
    expect(out.map((d) => d.message)).toEqual([expect.stringContaining('Font "Playfair Display"')]);
  });

  it("ignores invisible text", () => {
    expect(fontDiagnostics(doc([text({ visible: false })]))).toEqual([]);
  });

  it("has nothing to report about a text that names nothing, because the default resolves", () => {
    // The default family is `system-ui` (see `font-stack.ts`), so the one text a
    // new layer starts as can never be a claim the file cannot keep.
    expect(messages([text({ style: { fontSize: 16 } })])).toEqual([]);
  });
  it("turns into a warning under --strict-assets", () => {
    expect(fontDiagnostics(doc([text()]), true)[0].level).toBe("warning");
  });
});
