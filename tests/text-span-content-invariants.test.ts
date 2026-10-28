import { describe, it, expect } from "vitest";
import { reconcileSpansOnTextChange } from "../src/core/interactions/text-spans";
import { normalizeTextSpans } from "../src/core/dsl/normalize/text-sizing";
import type { TextSpan } from "../src/core/dsl/types";

/**
 * The two invariants that make a text's characters survive every path that rewrites
 * them, plus the markup gate they both hang off.
 *
 * Both were found while chasing a report of a text duplicating itself: the span
 * reconciliation is the only place that can turn one text into `content` + `spans`
 * that disagree, and `normalizeTextSpans` is the one that rebuilds `content` out of
 * the spans — so a list that is longer or shorter than the text is not cosmetic, it
 * becomes that text on the next load.
 */
const joined = (spans?: TextSpan[]) => (spans ?? []).map((s) => s.text).join("");

describe("text span content invariants", () => {
  it("reconciles spans that describe exactly the new content, for any edit", () => {
    const contents = ["<fish/>", "<fish/> ", " <fish/>", "<fish/><fish/>", "a<fish/>b", "Hello World", "Hi", "", "aaa"];
    const spansFor = (s: string): TextSpan[] => [
      { text: s.slice(0, Math.ceil(s.length / 2)), style: { color: "#FF0000" } },
      { text: s.slice(Math.ceil(s.length / 2)), style: { fontWeight: 700 } }
    ];
    const failures: string[] = [];
    for (const old of contents) {
      for (const next of contents) {
        for (const spans of [[{ text: old }], spansFor(old)]) {
          const out = reconcileSpansOnTextChange(spans, old, next);
          if (out && joined(out) !== next) {
            failures.push(
              `${JSON.stringify(old)} -> ${JSON.stringify(next)}: ${JSON.stringify(out.map((s) => s.text))}`
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("normalizes to the same thing twice — the loader rebuilds content from spans", () => {
    const failures: string[] = [];
    for (const content of ["<fish/>", "<fish/> ", " <fish/>", "a <b> c", "x<br/>y", "<fish/>\n", "a <b>b</b> c"]) {
      const once = normalizeTextSpans(undefined, content);
      const twice = normalizeTextSpans(once.spans, once.content);
      if (twice.content !== once.content || joined(twice.spans) !== joined(once.spans)) {
        failures.push(`${JSON.stringify(content)} -> ${JSON.stringify(once.content)} -> ${JSON.stringify(twice.content)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("treats tag-shaped text as text, and a real inline tag as markup", () => {
    const kept = ["<fish/>", "<fish/> ", " <fish/>", "a<fish/>b", "2 < 3 > 1", "<div>Hello</div>"];
    for (const content of kept) {
      const out = normalizeTextSpans(undefined, content);
      expect(out.content, content).toBe(content);
    }

    const marked = normalizeTextSpans(undefined, "a <b>bold</b> and <i>italic</i>");
    expect(marked.content).toBe("a bold and italic");
    expect(marked.spans).toEqual([
      { text: "a " },
      { text: "bold", style: { fontWeight: "bold" } },
      { text: " and " },
      { text: "italic", style: { fontStyle: "italic" } }
    ]);
  });

  it("keeps a tag nobody draws inside the surrounding text", () => {
    const out = normalizeTextSpans(undefined, "a <b>x</b> <fish/> tail");
    expect(out.content).toBe("a x <fish/> tail");
    expect(joined(out.spans)).toBe(out.content);
  });
});
