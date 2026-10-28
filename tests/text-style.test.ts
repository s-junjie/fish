import { flattenLayout } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { relayoutDocumentTree } from "../src/core/compile";
import { convertForeignObjectsToSvg } from "../src/core/export-text";
import type { AutoLayout, TextElement } from "../src/core/dsl/types";

const doc = (elements: unknown[]) => ({
  version: "0.1",
  canvas: { width: 1200, height: 800, unit: "px" },
  elements
});

const laid = (elements: unknown[]) =>
  relayoutDocumentTree(getActivePage(normalizeDesignDocument(doc(elements)).document).children);

const styleOf = (elements: unknown[]) =>
  (getActivePage(normalizeDesignDocument(doc(elements)).document).children[0] as TextElement).style;

describe("italic and tabular figures", () => {
  it("keeps italic as its own axis, beside the weight rather than inside it", () => {
    const style = styleOf([
      { id: "t", type: "text", content: "x", style: { fontSize: 14, fontWeight: 700, fontStyle: "italic" } }
    ]);
    expect(style.fontStyle).toBe("italic");
    // Both survive at once: a 700 italic is not a spelling of the weight.
    expect(style.fontWeight).toBe(700);
  });

  it("accepts the kebab-case spelling and drops a value outside the vocabulary", () => {
    expect(
      styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, "font-style": "italic" } }]).fontStyle
    ).toBe("italic");
    expect(
      styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, fontStyle: "oblique" } }]).fontStyle
    ).toBeUndefined();
  });

  it("keeps tabular-nums, and only that value", () => {
    expect(
      styleOf([{ id: "t", type: "text", content: "1", style: { fontSize: 14, fontVariantNumeric: "tabular-nums" } }])
        .fontVariantNumeric
    ).toBe("tabular-nums");
    expect(
      styleOf([{ id: "t", type: "text", content: "1", style: { fontSize: 14, fontVariantNumeric: "lining-nums" } }])
        .fontVariantNumeric
    ).toBeUndefined();
  });
});

describe("text-align justify", () => {
  it("is preserved, and is no longer a synonym for left", () => {
    // It used to normalize to "left" with no repair: an author asking for flush
    // to both edges got a ragged right and nothing said so.
    expect(styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, align: "justify" } }]).align).toBe(
      "justify"
    );
    expect(styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, align: "start" } }]).align).toBe(
      "left"
    );
  });
});

describe("a line-count clamp", () => {
  const card = (style: Record<string, unknown>) => ({
    id: "card",
    type: "frame",
    width: 360,
    ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
    children: [{ id: "body", type: "text", content: "A ".repeat(29), style: { fontSize: 14, ...style } }]
  });

  it("is stored with the clamp, and refused without one", () => {
    expect(styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, maxLines: 3 } }]).maxLines).toBe(3);
    expect(
      styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, maxLines: 3, textOverflow: "ellipsis" } }])
        .textOverflow
    ).toBe("ellipsis");
    // No line count, nothing to cut: an `ellipsis` alone would round-trip as a
    // capability in use and change no pixel.
    const lonely = styleOf([
      { id: "t", type: "text", content: "x", style: { fontSize: 14, textOverflow: "ellipsis" } }
    ]);
    expect(lonely.textOverflow).toBeUndefined();
  });

  it("floors the count at one line, because zero would paint nothing", () => {
    expect(
      styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, maxLines: 0 } }]).maxLines
    ).toBeUndefined();
    expect(
      styleOf([{ id: "t", type: "text", content: "x", style: { fontSize: 14, maxLines: 2.7 } }]).maxLines
    ).toBe(2);
  });

  it("is a real height, not a paint-only trick", () => {
    // 58 characters of body copy at 14px wrap onto two lines inside the card's
    // 312 content box, and the card hugs that — the numbers are the point.
    const free = laid([card({})])[0] as any;
    expect(Math.round(free.children[0].width)).toBe(312);
    expect(Math.round(free.children[0].height)).toBe(39);
    expect(Math.round(free.height)).toBe(87);

    // Two lines is exactly what it wraps to, so the clamp has nothing to cut.
    const two = laid([card({ maxLines: 2 })])[0] as any;
    expect(Math.round(two.children[0].height)).toBe(39);

    // One line is a real one-line box: the card hugs 19 + 24 + 24.
    const one = laid([card({ maxLines: 1 })])[0] as any;
    expect(Math.round(one.children[0].height)).toBe(19);
    expect(Math.round(one.height)).toBe(67);
  });

  it("leaves the width axis alone", () => {
    // Deriving the width from "one line, never wrap" measured the text at its
    // intrinsic 487 and overflowed the 312 box holding it.
    const one = laid([card({ maxLines: 1 })])[0] as any;
    expect(Math.round(one.children[0].width)).toBe(312);
  });
});

describe("flex justify space-evenly", () => {
  const row = (justify: AutoLayout["justify"]) =>
    laid([
      {
        id: "row",
        type: "frame",
        width: 300,
        height: 40,
        ...flattenLayout({ mode: "flex", direction: "row", justify }),
        children: [
          { id: "a", type: "rect", width: 20, height: 20 },
          { id: "b", type: "rect", width: 20, height: 20 },
          { id: "c", type: "rect", width: 20, height: 20 }
        ]
      }
    ])[0] as any;

  it("gives three items four equal gaps, ends included", () => {
    // 300 - 60 of item and four 60-gaps: the outer two are FULL gaps, which is
    // what tells it apart from space-around's half gaps at the ends.
    expect(row("space-evenly").children.map((c: any) => Math.round(c.x))).toEqual([60, 140, 220]);
    expect(row("space-around").children.map((c: any) => Math.round(c.x))).toEqual([40, 140, 240]);
    expect(row("space-between").children.map((c: any) => Math.round(c.x))).toEqual([0, 140, 280]);
  });

  it("is accepted without a repair", () => {
    const repairs = normalizeDesignDocument(
      doc([
        {
          id: "row",
          type: "frame",
          width: 300,
          height: 40,
          ...flattenLayout({ mode: "flex", direction: "row", justify: "space-evenly" })
        }
      ])
    ).repairs;
    expect(repairs).toEqual([]);
  });
});

/**
 * A minimal DOM, because `convertForeignObjectsToSvg` is the one place that
 * lowers a text run into real SVG elements and there is no browser here.
 */
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
  /** The exporter walks the foreignObject's first child to find the painted box. */
  get firstElementChild(): MockElement | null {
    return this.children[0] ?? null;
  }
  appendChild(child: MockElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  querySelector(tag: string): MockElement | null {
    if (this.tagName === tag) return this;
    for (const child of this.children) {
      const hit = child.querySelector(tag);
      if (hit) return hit;
    }
    return null;
  }
  querySelectorAll(tag: string): MockElement[] {
    const out: MockElement[] = this.tagName === tag ? [this] : [];
    for (const child of this.children) out.push(...child.querySelectorAll(tag));
    return out;
  }
  closest(): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (cur.attrs["data-element-id"]) return cur;
      cur = cur.parent;
    }
    return null;
  }
  remove() {}
  replaceWith(_node?: MockElement) {}
}

function exportText(style: Record<string, unknown>, extra: Record<string, unknown> = {}): MockElement {
  const original = (globalThis as any).document;
  (globalThis as any).document = {
    createElementNS: (_ns: string, tag: string) => new MockElement(tag)
  };
  try {
    const svg = new MockElement("svg");
    const g = new MockElement("g");
    g.setAttribute("data-element-id", "t1");
    const fo = new MockElement("foreignObject");
    let out: any = null;
    fo.replaceWith = (node: any) => {
      out = node;
    };
    g.appendChild(fo);
    svg.appendChild(g);

    convertForeignObjectsToSvg(svg as any, {
      version: "0.1",
      canvas: { width: 500, height: 500, unit: "px" },
      pages: [
        {
          id: "p",
          name: "P",
          children: [
            {
              id: "t1",
              type: "text",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              content: "A ".repeat(40),
              style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF", ...style },
              ...extra
            }
          ]
        }
      ],
      activePageId: "p"
    } as any);
    return out;
  } finally {
    (globalThis as any).document = original;
  }
}

describe("the export paints what the canvas paints", () => {
  it("carries italic and tabular figures onto the SVG text node", () => {
    const node = exportText({ fontStyle: "italic", fontVariantNumeric: "tabular-nums" });
    expect(node.getAttribute("font-style")).toBe("italic");
    expect(node.getAttribute("font-variant-numeric")).toBe("tabular-nums");
  });

  it("justifies every line but the last with textLength", () => {
    // SVG has no `text-align: justify`; `textLength` + `lengthAdjust="spacing"`
    // is the same operation, and only a line that is not the last is stretched —
    // a final line stays ragged in CSS too.
    const node = exportText({ align: "justify" });
    const spans = node.children;

    expect(node.getAttribute("text-anchor")).toBe("start");
    expect(spans[0].getAttribute("textLength")).toBe("200");
    expect(spans[0].getAttribute("lengthAdjust")).toBe("spacing");
    expect(spans[1].getAttribute("textLength")).toBe("200");
    expect(spans[spans.length - 1].getAttribute("textLength")).toBeUndefined();
  });

  it("cuts the run at the clamp and marks the cut", () => {
    const free = exportText({});
    const clamped = exportText({ maxLines: 2, textOverflow: "ellipsis" });
    expect(free.children.length).toBeGreaterThan(2);
    expect(clamped.children.length).toBe(2);
    expect(clamped.children[1].textContent).toMatch(/\u2026$/);
    // The line the clamp did not touch keeps its text.
    expect(clamped.children[0].textContent).toBe(free.children[0].textContent);
  });

  it("does not mark a cut it did not make", () => {
    // Two lines of this run fit in two lines: an ellipsis here would claim
    // something was dropped when nothing was.
    const fits = exportText({ maxLines: 99, textOverflow: "ellipsis" });
    expect(fits.children.every((c) => !/\u2026/.test(c.textContent))).toBe(true);
  });
});

/**
 * A text's ink is its `fills` stack and nothing else.
 *
 * `style.color` is the field an author WRITES a colour in — the normalizer turns
 * one into a layer when the element carries no stack — so reading it again in the
 * exporter painted glyphs the author had emptied, and the `#FFFFFF` behind it
 * painted a text that had no layer at all. Both spellings (`none` here,
 * `transparent` on the canvas) mean "no ink", and neither is white.
 */
describe("text ink comes from the fill stack", () => {
  it("exports no fill for a text with no layer", () => {
    expect(exportText({}).getAttribute("fill")).toBe("none");
  });

  it("exports no fill for an explicitly empty stack, whatever style.color says", () => {
    expect(exportText({ color: "#FF0000" }, { fills: [] }).getAttribute("fill")).toBe("none");
  });

  it("exports the top layer's colour", () => {
    const node = exportText({ color: "#FF0000" }, { fills: [{ type: "solid", color: "#123456" }] });
    expect(node.getAttribute("fill")).toBe("#123456");
  });

  it("exports no fill when the fill is switched off but still in the stack", () => {
    const node = exportText({}, { fills: [{ type: "solid", color: "#123456" }], fillEnabled: false });
    expect(node.getAttribute("fill")).toBe("none");
  });

  it("carries the painter's `none` through the painted-node path", () => {
    // An instance's children are painted under derived ids the page tree never
    // mints, so the exporter falls back to reading the foreignObject — which is
    // where the renderer parks the resolved paint, and where it writes `none`
    // for a text with no ink. Reading the wrapper div instead found nothing and
    // exported the default white.
    const original = (globalThis as any).document;
    (globalThis as any).document = {
      createElementNS: (_ns: string, tag: string) => new MockElement(tag)
    };
    try {
      const svg = new MockElement("svg");
      const g = new MockElement("g");
      g.setAttribute("data-element-id", "ghost");
      const fo = new MockElement("foreignObject");
      fo.setAttribute("x", "0");
      fo.setAttribute("y", "0");
      fo.setAttribute("width", "200");
      fo.setAttribute("height", "40");
      fo.setAttribute("data-text-fill", "none");
      let out: any = null;
      fo.replaceWith = (node: any) => {
        out = node;
      };
      const painted = new MockElement("div");
      painted.setAttribute("style", "font-family: Inter; font-size: 14px; color: transparent");
      painted.textContent = "ghost";
      fo.appendChild(painted);
      g.appendChild(fo);
      svg.appendChild(g);

      // No page holds `ghost`, so the document lookup misses and the painted
      // node is what the exporter has to read.
      convertForeignObjectsToSvg(svg as any, {
        version: "0.1",
        canvas: { width: 500, height: 500, unit: "px" },
        pages: [{ id: "p", name: "P", children: [], activePageId: "p" }],
        activePageId: "p"
      } as any);

      expect(out.getAttribute("fill")).toBe("none");
    } finally {
      (globalThis as any).document = original;
    }
  });
});
