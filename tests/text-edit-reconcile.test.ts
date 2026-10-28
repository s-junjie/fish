import { describe, it, expect } from "vitest";
import { reconcileSpansOnTextChange } from "../src/core/interactions/text-spans";
import type { TextSpan } from "../src/core/dsl/types";

/**
 * Run styles survive an edit only if the reconciler knows where the edit was.
 *
 * The old implementation recovered the splice from the two strings — longest
 * common prefix, longest common suffix — and gave the middle the style of the
 * character to the LEFT of the whole change. Replacing a run therefore wrote the
 * style of whatever happened to precede it, and the replaced run's own style was
 * gone with nothing left to say it had ever been there. These are the cases that
 * were wrong, fixed, and pinned.
 */

const blue = { color: "#3B82F6" };
const bold = { fontWeight: 700 as const };
const red = { color: "#EF4444" };

const text = (spans: TextSpan[] | undefined): string =>
  (spans ?? []).map((s) => s.text).join("");

describe("reconcileSpansOnTextChange", () => {
  it("gives replaced characters the run they replaced, not the one to their left", () => {
    const spans: TextSpan[] = [
      { text: "abc", style: blue },
      { text: "d", style: bold },
      { text: "ef", style: red }
    ];
    // Select the bold "d" and type "X" over it.
    const out = reconcileSpansOnTextChange(spans, "abcdef", "abcXef", { start: 3, end: 4 });
    expect(text(out)).toBe("abcXef");
    expect(out).toEqual([
      { text: "abc", style: blue },
      { text: "X", style: bold },
      { text: "ef", style: red }
    ]);
  });

  it("keeps every run when the whole text is re-typed over", () => {
    const spans: TextSpan[] = [
      { text: "Hello ", style: blue },
      { text: "World", style: bold }
    ];
    const out = reconcileSpansOnTextChange(spans, "Hello World", "Fish App", { start: 0, end: 11 });
    // One replacement run, wearing what the first replaced character wore.
    expect(text(out)).toBe("Fish App");
    expect(out).toEqual([{ text: "Fish App", style: blue }]);
  });

  it("resolves the ambiguity a prefix/suffix guess cannot", () => {
    // "aaaa" with four different runs, caret after the FIRST one, typing "a".
    const spans: TextSpan[] = [
      { text: "a", style: blue },
      { text: "a", style: bold },
      { text: "a", style: red },
      { text: "a" }
    ];
    // The strings alone read as "one more a at the end"; only the edit knows.
    const derived = reconcileSpansOnTextChange(spans, "aaaa", "aaaaa");
    const exact = reconcileSpansOnTextChange(spans, "aaaa", "aaaaa", { start: 1, end: 1 });
    // Derived: the extra "a" lands at the end, where the last run declares no
    // style, so it merges into it. That is the best a guess can do.
    expect((derived ?? []).map((s) => s.text)).toEqual(["a", "a", "a", "aa"]);
    expect(text(derived)).toBe("aaaaa");
    // Exact: it lands where the caret was, takes that run's style, and joins it.
    expect((exact ?? []).map((s) => s.text)).toEqual(["aa", "a", "a", "a"]);
    expect((exact ?? [])[0]).toEqual({ text: "aa", style: blue });
  });

  it("leaves the survivors alone when a cross-run range is deleted", () => {
    const spans: TextSpan[] = [
      { text: "keep ", style: blue },
      { text: "cut me", style: bold },
      { text: " tail", style: red }
    ];
    const out = reconcileSpansOnTextChange(spans, "keep cut me tail", "keep  tail", { start: 5, end: 11 });
    expect(text(out)).toBe("keep  tail");
    // The two outer runs still hold their own styles, and they do not merge.
    expect(out).toEqual([
      { text: "keep ", style: blue },
      { text: " tail", style: red }
    ]);
  });

  it("inserts with the character before the caret, and the first run at the start", () => {
    const spans: TextSpan[] = [
      { text: "one ", style: blue },
      { text: "two", style: bold }
    ];
    const end = reconcileSpansOnTextChange(spans, "one two", "one two!", { start: 7, end: 7 });
    expect(end).toEqual([
      { text: "one ", style: blue },
      { text: "two!", style: bold }
    ]);
    const start = reconcileSpansOnTextChange(spans, "one two", "Xone two", { start: 0, end: 0 });
    expect(start).toEqual([
      { text: "Xone ", style: blue },
      { text: "two", style: bold }
    ]);
  });

  it("attributes a paste to the run it was dropped into", () => {
    const spans: TextSpan[] = [
      { text: "one ", style: blue },
      { text: "two", style: bold }
    ];
    const out = reconcileSpansOnTextChange(spans, "one two", "one PASTED two", { start: 4, end: 4 });
    // The caret sat between the space and "two", so it takes "one "'s run.
    expect(out).toEqual([
      { text: "one PASTED ", style: blue },
      { text: "two", style: bold }
    ]);
  });

  it("never lands a run boundary inside a surrogate pair", () => {
    const emoji = "\u{1F600}";
    const spans: TextSpan[] = [
      { text: "a", style: blue },
      { text: emoji, style: bold },
      { text: "b", style: red }
    ];
    const out = reconcileSpansOnTextChange(spans, `a${emoji}b`, "aXb", { start: 1, end: 3 });
    expect(text(out)).toBe("aXb");
    expect(out).toEqual([
      { text: "a", style: blue },
      { text: "X", style: bold },
      { text: "b", style: red }
    ]);
    for (const span of out ?? []) {
      // A lone surrogate is not a character; it renders as tofu.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(span.text)).toBe(false);
    }
  });

  it("drops the runs once nothing styled is left", () => {
    const spans: TextSpan[] = [
      { text: "Hello " },
      { text: "World", style: bold }
    ];
    // Deleting the only styled run leaves nothing to carry: the list goes.
    expect(reconcileSpansOnTextChange(spans, "Hello World", "Hello ")).toBeUndefined();
    expect(reconcileSpansOnTextChange(spans, "Hello World", "")).toBeUndefined();
    expect(reconcileSpansOnTextChange(spans, "Hello World", "Hello World")).toEqual(spans);

    // But a styled SURVIVOR keeps its run, and emptying the text keeps nothing.
    const styledPrefix: TextSpan[] = [
      { text: "Hello ", style: blue },
      { text: "World", style: bold }
    ];
    expect(reconcileSpansOnTextChange(styledPrefix, "Hello World", "Hello ")).toEqual([
      { text: "Hello ", style: blue }
    ]);
    expect(reconcileSpansOnTextChange(styledPrefix, "Hello World", "")).toBeUndefined();
  });

  it("ignores an edit range that cannot describe the two strings", () => {
    const spans: TextSpan[] = [{ text: "Hello", style: blue }];
    // Stale caller: the range runs past the old text. The derived splice answers.
    const out = reconcileSpansOnTextChange(spans, "Hello", "Hello!", { start: 40, end: 41 });
    expect(text(out)).toBe("Hello!");
    expect(out).toEqual([{ text: "Hello!", style: blue }]);
  });

  it("returns nothing to reconcile when the text had no runs", () => {
    expect(reconcileSpansOnTextChange(undefined, "abc", "abcd")).toBeUndefined();
    expect(reconcileSpansOnTextChange([], "abc", "abcd")).toBeUndefined();
  });
});
