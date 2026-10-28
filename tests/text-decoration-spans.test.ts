import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { convertForeignObjectsToSvg } from "../src/core/export-text";
import { normalizeTextDecoration, textDecorationCss, toggledDecoration } from "../src/core/dsl/text-decoration";
import type { TextElement } from "../src/core/dsl/types";

describe("text decoration and rich text spans", () => {
  it("normalizes the decoration lines and structured spans", () => {
    const raw = {
      version: "0.1",
      canvas: { width: 800, height: 600, unit: "px" },
      elements: [
        {
          id: "t1",
          type: "text",
          x: 10,
          y: 20,
          width: 200,
          height: 40,
          content: "Hello World",
          style: {
            fontSize: 18,
            color: "#FFFFFF",
            textDecoration: ["underline"]
          },
          spans: [
            { text: "Hello " },
            { text: "World", style: { color: "#3B82F6", fontWeight: "bold", textDecoration: ["line-through"] } }
          ]
        }
      ]
    };

    const { document, repairs } = normalizeDesignDocument(raw as any, { preserveUnknown: true });
    const el = getActivePage(document).children[0] as TextElement;

    expect(el.style.textDecoration).toEqual(["underline"]);
    expect(el.spans).toBeDefined();
    expect(el.spans!.length).toBe(2);
    expect(el.spans![0].text).toBe("Hello ");
    expect(el.spans![1].text).toBe("World");
    expect(el.spans![1].style?.color).toBe("#3B82F6");
    expect(el.spans![1].style?.fontWeight).toBe("bold");
    expect(el.spans![1].style?.textDecoration).toEqual(["line-through"]);
    expect(el.content).toBe("Hello World");
  });

  /**
   * A run colour has one spelling. A top-level `color`, a CSS declaration
   * string and a span-level token reference all used to be dropped with
   * `repairs: []`, so `fish check` passed a document whose colour had vanished.
   */
  it("reports malformed span colour declarations instead of dropping them silently", () => {
    const normalize = (spans: unknown) =>
      normalizeDesignDocument(
        {
          version: "0.1",
          canvas: { width: 200, height: 100, unit: "px" },
          elements: [
            {
              id: "t",
              type: "text",
              x: 0,
              y: 0,
              width: 200,
              height: 40,
              content: "Hello",
              style: { fontSize: 16, color: "#000000" },
              spans
            }
          ]
        } as never,
        { preserveUnknown: true }
      );
    const drops = (spans: unknown) =>
      normalize(spans).repairs.filter((repair) => repair.kind === "dropped-property");

    const topLevel = normalize([{ text: "Hello", color: "#FF0000" }]);
    expect((getActivePage(topLevel.document).children[0] as TextElement).spans?.[0].style).toBeUndefined();
    expect(drops([{ text: "Hello", color: "#FF0000" }])).toEqual([
      expect.objectContaining({ message: expect.stringContaining("style.color") })
    ]);

    expect(drops([{ text: "Hello", style: "color:#FF0000" }])).toEqual([
      expect.objectContaining({ message: expect.stringContaining("CSS declaration string") })
    ]);

    expect(drops([{ text: "Hello", style: { tokenId: "tok" } }])).toEqual([
      expect.objectContaining({ message: expect.stringContaining("fills[].tokenId") })
    ]);
  });

  /**
   * The lines are not alternatives, which is the whole reason the property is a
   * list. A struck-through link is the ordinary case, and the single-value enum
   * this replaced could not have written it down at all.
   */
  it("keeps both lines on one element, whatever order they were written in", () => {
    const doc = (decoration: unknown) =>
      getActivePage(normalizeDesignDocument(
        {
          version: "0.1",
          canvas: { width: 100, height: 100, unit: "px" },
          elements: [
            {
              id: "t",
              type: "text",
              x: 0,
              y: 0,
              width: 100,
              height: 20,
              content: "x",
              style: { fontSize: 16, color: "#000000", textDecoration: decoration }
            }
          ]
        } as never,
        { preserveUnknown: true }
      ).document).children[0] as TextElement;

    expect(doc(["underline", "line-through"]).style.textDecoration).toEqual(["underline", "line-through"]);
    // Canonical order, so the two spellings are ONE value: list equality is
    // positional, and a run that came back in the other order would compare
    // unequal to its neighbour and split the text for nothing.
    expect(doc(["line-through", "underline"]).style.textDecoration).toEqual(["underline", "line-through"]);
    // The CSS spelling, which is what a pasted `text-decoration` declaration is.
    expect(doc("underline line-through").style.textDecoration).toEqual(["underline", "line-through"]);
    // The single-line spelling every document written before this existed uses.
    expect(doc("underline").style.textDecoration).toEqual(["underline"]);
    // `none` is not a member: no lines IS the absent key.
    expect(doc("none").style.textDecoration).toBeUndefined();
    expect(doc([]).style.textDecoration).toBeUndefined();
  });

  it("reads the empty list as a value on a run and as an absence on an element", () => {
    // The distinction the whole span model turns on, asserted at the reader that
    // decides it: a run saying `[]` must not be confused with a run saying nothing.
    expect(normalizeTextDecoration(undefined)).toBeUndefined();
    expect(normalizeTextDecoration([])).toBeUndefined();
    expect(normalizeTextDecoration([], { keepEmpty: true })).toEqual([]);
    expect(normalizeTextDecoration("none", { keepEmpty: true })).toEqual([]);
    expect(normalizeTextDecoration("none")).toBeUndefined();
  });

  it("toggles one line without disturbing the other", () => {
    expect(toggledDecoration(undefined, "underline", true)).toEqual(["underline"]);
    expect(toggledDecoration(["underline"], "line-through", true)).toEqual(["underline", "line-through"]);
    // Removing one leaves the other: this is what a partial style could not say.
    expect(toggledDecoration(["underline", "line-through"], "underline", false)).toEqual(["line-through"]);
    // Removing the last one is an EMPTY list, not undefined — on a run that is the
    // only way to say "no lines here" against a paragraph that draws one.
    expect(toggledDecoration(["underline"], "underline", false)).toEqual([]);
  });

  it("automatically extracts spans from inline HTML tags in content for external AI", () => {
    const raw = {
      version: "0.1",
      canvas: { width: 800, height: 600, unit: "px" },
      elements: [
        {
          id: "t2",
          type: "text",
          x: 0,
          y: 0,
          width: 300,
          height: 50,
          content: 'Hello <b>Bold</b> and <span style="color: #ff0000; text-decoration: underline;">Red Underline</span>!',
          style: { fontSize: 16, color: "#FFFFFF" }
        }
      ]
    };

    const { document } = normalizeDesignDocument(raw as any, { preserveUnknown: true });
    const el = getActivePage(document).children[0] as TextElement;

    expect(el.content).toBe("Hello Bold and Red Underline!");
    expect(el.spans).toBeDefined();
    expect(el.spans!.length).toBe(5);
    expect(el.spans![0]).toEqual({ text: "Hello " });
    expect(el.spans![1]).toEqual({ text: "Bold", style: { fontWeight: "bold" } });
    expect(el.spans![2]).toEqual({ text: " and " });
    expect(el.spans![3]).toEqual({
      text: "Red Underline",
      style: { color: "#ff0000", textDecoration: ["underline"] }
    });
    expect(el.spans![4]).toEqual({ text: "!" });
  });

  /**
   * Nested markup ADDS lines. The stack used to be merged with `Object.assign`, so
   * `<u><s>x</s></u>` kept whichever tag was merged last and silently lost the
   * other — a two-line run written the only way the string form can write it.
   */
  it("unions the decoration lines of nested tags instead of keeping the last", () => {
    const raw = {
      version: "0.1",
      canvas: { width: 100, height: 100, unit: "px" },
      elements: [
        {
          id: "t3",
          type: "text",
          x: 0,
          y: 0,
          width: 200,
          height: 20,
          content: "a <u><s>both</s></u> b",
          style: { fontSize: 16, color: "#FFFFFF" }
        }
      ]
    };

    const { document } = normalizeDesignDocument(raw as any, { preserveUnknown: true });
    const el = getActivePage(document).children[0] as TextElement;
    expect(el.content).toBe("a both b");
    expect(el.spans!.find((s) => s.text === "both")!.style!.textDecoration).toEqual([
      "underline",
      "line-through"
    ]);
  });

  it("exports the decoration lines and rich text spans to SVG tspans", () => {
    class MockElement {
      tagName: string;
      attrs: Record<string, string> = {};
      children: MockElement[] = [];
      parent: MockElement | null = null;
      textContent = "";
      constructor(tagName: string) {
        this.tagName = tagName;
      }
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      }
      getAttribute(k: string) {
        return this.attrs[k];
      }
      appendChild(child: MockElement) {
        child.parent = this;
        this.children.push(child);
        return child;
      }
      querySelector(tag: string): MockElement | null {
        if (this.tagName === tag) return this;
        for (const child of this.children) {
          const res = child.querySelector(tag);
          if (res) return res;
        }
        return null;
      }
      querySelectorAll(tag: string): MockElement[] {
        const out: MockElement[] = [];
        if (this.tagName === tag) out.push(this);
        for (const child of this.children) {
          out.push(...child.querySelectorAll(tag));
        }
        return out;
      }
      closest(sel: string): MockElement | null {
        let cur: MockElement | null = this;
        while (cur) {
          if (cur.attrs["data-element-id"]) return cur;
          cur = cur.parent;
        }
        return null;
      }
      remove() {
        // mock remove
      }
      replaceWith(newNode: MockElement) {
        // mock replace
      }
    }

    const origDoc = (globalThis as any).document;
    (globalThis as any).document = {
      createElementNS: (_ns: string, tag: string) => new MockElement(tag)
    };

    try {
      const doc = {
        version: "0.1",
        canvas: { width: 500, height: 500, unit: "px" },
        pages: [
          {
            id: "page_1",
            name: "Page 1",
            children: [
              {
                id: "t_export",
                type: "text",
                x: 10,
                y: 20,
                width: 200,
                height: 50,
                content: "Hello World",
                style: {
                  fontFamily: "Inter",
                  fontSize: 16,
                  color: "#FFFFFF",
                  textDecoration: ["underline"],
                  letterSpacing: 2
                },
                spans: [
                  { text: "Hello " },
                  { text: "World", style: { color: "#3B82F6", fontWeight: "bold", textDecoration: ["line-through"], letterSpacing: 0 } }
                ]
              }
            ]
          }
        ],
        activePageId: "page_1"
      };

      const svg = (globalThis as any).document.createElementNS("", "svg");
      const g = (globalThis as any).document.createElementNS("", "g");
      g.setAttribute("data-element-id", "t_export");
      const fo = (globalThis as any).document.createElementNS("", "foreignObject");
      let replacedWith: any = null;
      fo.replaceWith = (node: any) => {
        replacedWith = node;
      };
      g.appendChild(fo);
      svg.appendChild(g);

      convertForeignObjectsToSvg(svg as any, doc as any);

      expect(replacedWith).toBeTruthy();
      expect(replacedWith.tagName).toBe("text");
      // NOT on the `<text>`: the attribute propagates to the `tspan` children and
      // cannot be taken back off one of them, so a run that turned a line off would
      // still be painted through. Each run carries its own instead — see below.
      expect(replacedWith.getAttribute("text-decoration")).toBeUndefined();

      const lineTspan = replacedWith.children[0];
      expect(lineTspan.tagName).toBe("tspan");
      expect(lineTspan.children.length).toBe(2);

      const chunk1 = lineTspan.children[0];
      const chunk2 = lineTspan.children[1];
      // A run that says nothing draws what the element draws, resolved here rather
      // than left to inheritance.
      expect(chunk1.textContent).toBe("Hello ");
      expect(chunk1.getAttribute("text-decoration")).toBe("underline");
      expect(chunk2.textContent).toBe("World");
      expect(chunk2.getAttribute("fill")).toBe("#3B82F6");
      expect(chunk2.getAttribute("font-weight")).toBe("bold");
      expect(chunk2.getAttribute("text-decoration")).toBe("line-through");
      // Tracking is an inherited attribute, so the element's goes on the `<text>`
      // and a run that wants none has to say so itself — an empty attribute would
      // leave it tracking with the paragraph.
      expect(replacedWith.getAttribute("letter-spacing")).toBe("2px");
      expect(chunk1.getAttribute("letter-spacing")).toBeUndefined();
      expect(chunk2.getAttribute("letter-spacing")).toBe("0px");
    } finally {
      (globalThis as any).document = origDoc;
    }
  });

  it("joins both lines into the one attribute value CSS expects", () => {
    // The boundary both painters share: the document stores lines, CSS takes a
    // space-separated list, and one function is what keeps them from disagreeing.
    expect(textDecorationCss(["underline", "line-through"])).toBe("underline line-through");
    expect(textDecorationCss(["underline"])).toBe("underline");
    // "nothing to draw" — which is also what an explicit `[]` means to a painter.
    // The difference between the two is WHERE the line is drawn, not what value is
    // written, and that decision belongs to the element/run split, not here.
    expect(textDecorationCss(undefined)).toBeUndefined();
    expect(textDecorationCss([])).toBeUndefined();
  });

  it("applies span style to character ranges cleanly via applySpanStyleToRange", async () => {
    const { applySpanStyleToRange } = await import("../src/core/interactions/text-spans");
    const el: TextElement = {
      id: "t_range",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hello World",
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
    };

    // Style "World" (indices 6 to 11) with bold and underline
    const updated = applySpanStyleToRange(el, { start: 6, end: 11 }, {
      fontWeight: 700,
      textDecoration: ["underline"]
    });

    expect(updated.spans).toBeDefined();
    expect(updated.spans!.length).toBe(2);
    expect(updated.spans![0].text).toBe("Hello ");
    expect(updated.spans![0].style).toBeUndefined();
    expect(updated.spans![1].text).toBe("World");
    expect(updated.spans![1].style?.fontWeight).toBe(700);
    expect(updated.spans![1].style?.textDecoration).toEqual(["underline"]);

    // Overlap styling: style "lo Wo" (indices 3 to 8) with color
    const overlapping = applySpanStyleToRange(updated, { start: 3, end: 8 }, {
      color: "#FF0000"
    });

    // Should create slices: "Hel" (0-3), "lo " (3-6 with color), "Wo" (6-8 with color + bold + underline), "rld" (8-11 with bold + underline)
    expect(overlapping.spans!.length).toBe(4);
    expect(overlapping.spans![0].text).toBe("Hel");
    expect(overlapping.spans![1].text).toBe("lo ");
    expect(overlapping.spans![1].style?.color).toBe("#FF0000");
    expect(overlapping.spans![2].text).toBe("Wo");
    expect(overlapping.spans![2].style?.color).toBe("#FF0000");
    expect(overlapping.spans![2].style?.fontWeight).toBe(700);
    expect(overlapping.spans![2].style?.textDecoration).toEqual(["underline"]);
    expect(overlapping.spans![3].text).toBe("rld");
    expect(overlapping.spans![3].style?.color).toBeUndefined();
    expect(overlapping.spans![3].style?.fontWeight).toBe(700);
    expect(overlapping.spans![3].style?.textDecoration).toEqual(["underline"]);
  });

  /**
   * `fontStyle` was the key this function dropped on the floor: the type, the
   * normalizer, both painters and the export all carried it, but the whitelist that
   * rebuilds a run left it out — so marking a selection italic in the inspector
   * wrote the key and this function threw it away. The button did nothing, and
   * nothing reported it, because the element-level path was fine.
   */
  it("keeps a run's italic through a range edit", async () => {
    const { applySpanStyleToRange } = await import("../src/core/interactions/text-spans");
    const el: TextElement = {
      id: "t_italic",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hello World",
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
    };

    const italic = applySpanStyleToRange(el, { start: 6, end: 11 }, { fontStyle: "italic" });
    expect(italic.spans!.length).toBe(2);
    expect(italic.spans![0].style).toBeUndefined();
    expect(italic.spans![1].style?.fontStyle).toBe("italic");

    // Upright is a VALUE on a run, not the absence of one: it is how a run inside
    // an italic paragraph says it is upright.
    const upright = applySpanStyleToRange(
      { ...el, style: { ...el.style, fontStyle: "italic" } },
      { start: 6, end: 11 },
      { fontStyle: "normal" }
    );
    expect(upright.spans![1].style?.fontStyle).toBe("normal");
  });

  /**
   * The compactor must not merge two runs that differ only by italic, or the edit
   * above survives exactly until the next one: `isSameSpanStyle` did not compare
   * `fontStyle`, so italicising a selection between two identical runs collapsed
   * all three and the italic vanished on the way out.
   */
  it("does not merge runs that differ only by italic or by decoration", async () => {
    const { applySpanStyleToRange } = await import("../src/core/interactions/text-spans");
    const el: TextElement = {
      id: "t_merge",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "aa bb aa",
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
    };

    const italicMiddle = applySpanStyleToRange(el, { start: 3, end: 5 }, { fontStyle: "italic" });
    expect(italicMiddle.spans!.map((s) => s.text)).toEqual(["aa ", "bb", " aa"]);

    const struckMiddle = applySpanStyleToRange(el, { start: 3, end: 5 }, {
      textDecoration: ["line-through"]
    });
    expect(struckMiddle.spans!.map((s) => s.text)).toEqual(["aa ", "bb", " aa"]);

    // And the two spellings of the same pair of lines are one style, not two: the
    // order is canonical, so a run written the other way round still merges.
    const one = applySpanStyleToRange(el, { start: 3, end: 5 }, {
      textDecoration: ["line-through", "underline"]
    });
    const two = applySpanStyleToRange(one, { start: 3, end: 5 }, { fontWeight: 700 });
    expect(two.spans![1].style?.textDecoration).toEqual(["underline", "line-through"]);
  });

  it("toggles one decoration line over a range, and reports the range's state", async () => {
    const { toggleSpanDecoration, spanRangeHasDecoration } = await import(
      "../src/core/interactions/text-spans"
    );
    const el: TextElement = {
      id: "t_toggle",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hello World",
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
    };

    const underlined = toggleSpanDecoration(el, { start: 6, end: 11 }, "underline");
    expect(underlined.spans![1].style?.textDecoration).toEqual(["underline"]);
    expect(spanRangeHasDecoration(underlined, { start: 6, end: 11 }, "underline")).toBe(true);
    expect(spanRangeHasDecoration(underlined, { start: 0, end: 5 }, "underline")).toBe(false);

    // Second press takes it off, and the run keeps an EMPTY list — that is the
    // value, and it is what stops the element's line being drawn through it.
    const off = toggleSpanDecoration(underlined, { start: 6, end: 11 }, "underline");
    expect(off.spans![1].style?.textDecoration).toEqual([]);

    // One line on, the other already there: the first must not disturb the second,
    // which a wholesale partial style could not promise.
    const both = toggleSpanDecoration(
      toggleSpanDecoration(el, { start: 6, end: 11 }, "line-through"),
      { start: 6, end: 11 },
      "underline"
    );
    expect(both.spans![1].style?.textDecoration).toEqual(["underline", "line-through"]);
    const onlyStrike = toggleSpanDecoration(both, { start: 6, end: 11 }, "underline");
    expect(onlyStrike.spans![1].style?.textDecoration).toEqual(["line-through"]);
  });

  /**
   * The element's own line has to be readable as the range's state, because the
   * inspector shows the toggle from the range and writes to it. Reading "no runs,
   * so nothing holds" would offer to turn italic ON for a paragraph that is
   * entirely italic.
   */
  it("reads a range's state through the element's own style when there are no runs", async () => {
    const { spanRangeIsItalic, spanRangeHasDecoration } = await import(
      "../src/core/interactions/text-spans"
    );
    const el: TextElement = {
      id: "t_inherit",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hello World",
      style: {
        fontFamily: "Inter",
        fontSize: 16,
        color: "#FFFFFF",
        fontStyle: "italic",
        textDecoration: ["underline"]
      }
    };

    expect(spanRangeIsItalic(el, { start: 2, end: 9 })).toBe(true);
    expect(spanRangeHasDecoration(el, { start: 2, end: 9 }, "underline")).toBe(true);
    expect(spanRangeHasDecoration(el, { start: 2, end: 9 }, "line-through")).toBe(false);

    // A run that overrides the element answers for itself.
    const withRun: TextElement = { ...el, spans: [{ text: "Hello " }, { text: "World" }] };
    expect(spanRangeIsItalic(withRun, { start: 0, end: 5 })).toBe(true);
  });

  it("adjusts text bbox size when spans contain larger fontSize", async () => {
    const { resolveTextSizing } = await import("../src/core/layout/text-sizing");
    const baseText: TextElement = {
      id: "t_base",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      sizing: { width: "fit-content", height: "fit-content" },
      content: "Hello World",
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
    };

    const baseMeasured = resolveTextSizing(baseText, null);

    const largeSpanText: TextElement = {
      ...baseText,
      spans: [
        { text: "Hello " },
        { text: "World", style: { fontSize: 48 } }
      ]
    };

    const spanMeasured = resolveTextSizing(largeSpanText, null);

    // With 48px span, both width and height must expand
    expect(spanMeasured.width).toBeGreaterThan(baseMeasured.width);
    expect(spanMeasured.height).toBeGreaterThan(baseMeasured.height);
  });

  it("reconciles spans on text change correctly when typing or editing", async () => {
    const { reconcileSpansOnTextChange } = await import("../src/core/interactions/text-spans");
    const spans = [
      { text: "Hello " },
      { text: "World", style: { color: "#3B82F6", fontWeight: 700 } }
    ];

    // Typing at end: "Hello World!"
    const typedAtEnd = reconcileSpansOnTextChange(spans, "Hello World", "Hello World!");
    expect(typedAtEnd).toBeDefined();
    expect(typedAtEnd!.map((s) => s.text).join("")).toBe("Hello World!");
    expect(typedAtEnd![1].text).toBe("World!");
    expect(typedAtEnd![1].style?.color).toBe("#3B82F6");

    // Deleting "World": "Hello "
    const deletedWord = reconcileSpansOnTextChange(spans, "Hello World", "Hello ");
    // Only unstyled "Hello " remains -> no custom style -> undefined
    expect(deletedWord).toBeUndefined();

    // Editing middle: "Hello Brave World"
    const insertedMiddle = reconcileSpansOnTextChange(spans, "Hello World", "Hello Brave World");
    expect(insertedMiddle).toBeDefined();
    expect(insertedMiddle!.map((s) => s.text).join("")).toBe("Hello Brave World");
    expect(insertedMiddle!.length).toBe(2);

    // Completely replacing text when prefix was unstyled -> unstyled text (undefined spans)
    const replaced = reconcileSpansOnTextChange(spans, "Hello World", "FISH App");
    expect(replaced).toBeUndefined();

    // Completely replacing text when prefix had style -> inherits style
    const styledSpans = [{ text: "Hello", style: { color: "#3B82F6" } }];
    const replacedStyled = reconcileSpansOnTextChange(styledSpans, "Hello", "FISH App");
    expect(replacedStyled).toBeDefined();
    expect(replacedStyled![0].text).toBe("FISH App");
    expect(replacedStyled![0].style?.color).toBe("#3B82F6");
  });

  /**
   * `letterSpacing` is a run property now, and the load path, the edit path and
   * the measurer all have to agree on it. It was dead once — the type carried it
   * while nothing stored or read one — so the three are asserted together.
   */
  it("carries letterSpacing on a run, and reads 0 as a value rather than an absence", async () => {
    const { applySpanStyleToRange, spanStyleAt } = await import("../src/core/interactions/text-spans");

    const authored = normalizeDesignDocument(
      {
        version: "0.1",
        canvas: { width: 400, height: 200, unit: "px" },
        elements: [
          {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 40,
            content: "Tight Loose",
            style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF", letterSpacing: 4 },
            spans: [{ text: "Tight ", style: { letterSpacing: 0 } }, { text: "Loose" }]
          }
        ]
      } as any,
      { preserveUnknown: true }
    );
    const loaded = getActivePage(authored.document).children[0] as TextElement;
    expect(loaded.spans![0].style?.letterSpacing).toBe(0);
    expect(loaded.spans![1].style?.letterSpacing).toBeUndefined();

    // A kebab-case key and a px suffix are both spellings the model reaches for.
    const loose = normalizeDesignDocument(
      {
        version: "0.1",
        canvas: { width: 400, height: 200, unit: "px" },
        elements: [
          {
            id: "t2",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 40,
            content: "Wide",
            style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" },
            spans: [{ text: "Wide", style: { "letter-spacing": "2px" } }]
          }
        ]
      } as any,
      { preserveUnknown: true }
    );
    expect((getActivePage(loose.document).children[0] as TextElement).spans![0].style?.letterSpacing).toBe(2);

    const el: TextElement = {
      id: "t",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 200,
      height: 20,
      content: "Hello World",
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF", letterSpacing: 4 }
    };
    const ranged = applySpanStyleToRange(el, { start: 6, end: 11 }, { letterSpacing: 0 });
    // Uncovered characters declare nothing; the covered run keeps its 0 — the
    // only way it can refuse the paragraph's tracking — so the two do not merge.
    expect(ranged.spans!.map((s) => s.text)).toEqual(["Hello ", "World"]);
    expect(ranged.spans![1].style?.letterSpacing).toBe(0);
    expect(spanStyleAt(ranged, 8)?.letterSpacing).toBe(0);
    expect(spanStyleAt(ranged, 0)).toBeUndefined();
    expect(spanStyleAt(ranged, 99)).toBeUndefined();
  });

  it("measures a run's own tracking, so the box grows with it", async () => {
    const { textSpec } = await import("../src/core/layout/text-sizing");
    const { measureText } = await import("../src/core/geometry/text-measure");

    const el: TextElement = {
      id: "t",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 200,
      height: 20,
      content: "Hello World",
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
    };
    const plain = measureText(el.content, textSpec(el.style, el.spans));
    const tracked: TextElement = {
      ...el,
      spans: [{ text: "Hello " }, { text: "World", style: { letterSpacing: 8 } }]
    };
    const loose = measureText(tracked.content, textSpec(tracked.style, tracked.spans));

    expect(loose.width).toBeGreaterThan(plain.width);
    expect(loose.height).toBe(plain.height);
  });

  it("extracts letter-spacing from the inline HTML shorthand too", () => {
    const { document } = normalizeDesignDocument(
      {
        version: "0.1",
        canvas: { width: 400, height: 200, unit: "px" },
        elements: [
          {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 40,
            content: 'Wide <span style="letter-spacing: 3px">tracking</span> here',
            style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
          }
        ]
      } as any,
      { preserveUnknown: true }
    );
    const el = getActivePage(document).children[0] as TextElement;
    expect(el.content).toBe("Wide tracking here");
    expect(el.spans!.map((s) => s.text)).toEqual(["Wide ", "tracking", " here"]);
    expect(el.spans![1].style?.letterSpacing).toBe(3);
  });

  it("normalizes letter-spacing units: px collapses to the bare number, em and % tag as em", async () => {
    const { normalizeLetterSpacing } = await import("../src/core/dsl/normalize/text-sizing");
    expect(normalizeLetterSpacing(2)).toBe(2);
    expect(normalizeLetterSpacing(-1.5)).toBe(-1.5);
    // Bare and `px` are one value, not two.
    expect(normalizeLetterSpacing("2px")).toBe(2);
    expect(normalizeLetterSpacing("0.05em")).toBe("0.05em");
    // A percentage is an em ratio layout-identically — `5%` = `0.05em`.
    expect(normalizeLetterSpacing("5%")).toBe("0.05em");
    expect(normalizeLetterSpacing("normal")).toBeUndefined();
  });

  it("resolves a run's em tracking against the run's own size", async () => {
    const { textSpec } = await import("../src/core/layout/text-sizing");
    const el: TextElement = {
      id: "t",
      type: "text",
      name: "Text",
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      content: "Hello World",
      style: { fontFamily: "Inter", fontSize: 20, color: "#FFFFFF" },
      spans: [{ text: "Hello " }, { text: "World", style: { fontSize: 40, letterSpacing: "0.05em" } }]
    };
    const spec = textSpec(el.style, el.spans);
    // The run's own 40px size, not the element's 20, resolves the em.
    expect(spec.spans![1].style?.letterSpacing).toBe(2);
    expect(spec.letterSpacing).toBe(0);
  });
});
