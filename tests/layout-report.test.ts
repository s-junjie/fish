import { describe, expect, it } from "vitest";
import { laidOutDocument } from "../src/core/layout-report";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { validateDocument } from "../src/core/validate";

/**
 * The gate grades the document the page holds, not the one the file stores.
 *
 * Every fixture here is a document an author would plausibly write: coordinates
 * that read as intent, and a flow that never sees them.
 */

const doc = (children: unknown[], extra: Record<string, unknown> = {}) => ({
  version: "0.1",
  pages: [{ id: "page", name: "Page", children }],
  ...extra
});

const prepare = (raw: unknown) => laidOutDocument(normalizeDesignDocument(raw).document, raw);

const frame = (children: unknown[], over: Record<string, unknown> = {}) => ({
  id: "capsule",
  type: "frame",
  x: 16,
  y: 16,
  width: 87,
  height: 32,
  display: "flex",
  "align-items": "center",
  children,
  ...over
});

describe("a coordinate the flow ignores", () => {
  it("is one finding for the container, naming the children it discarded", () => {
    const { findings } = prepare(
      doc([
        frame([
          { id: "dot", type: "rect", x: 16, y: 14, width: 3, height: 3 },
          { id: "ring", type: "ellipse", x: 56, y: 8, width: 15, height: 15 }
        ])
      ])
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].elementId).toBe("capsule");
    expect(findings[0].kind).toBe("position-ignored");
    expect(findings[0].level).toBe("warning");
    expect(findings[0].message).toContain('"capsule" (flex) ignores the x/y on 2 in-flow children');
    expect(findings[0].message).toContain("dot (16, 14) → (0, 14.5)");
    expect(findings[0].message).toContain("ring (56, 8) → (3, 8.5)");
    expect(findings[0].message).toContain('Add position "absolute"');
  });

  it("is the box the document is graded on afterwards", () => {
    const { document } = prepare(
      doc([frame([{ id: "dot", type: "rect", x: 16, y: 14, width: 3, height: 3 }])])
    );
    const dot = (document.pages![0].children![0] as any).children[0];
    expect([dot.x, dot.y]).toEqual([0, 14.5]);
  });

  it("is exempt when the child says absolute — that is the spelling that means it", () => {
    const { findings } = prepare(
      doc([frame([{ id: "dot", type: "rect", position: "absolute", x: 16, y: 14, width: 3, height: 3 }])])
    );
    expect(findings).toEqual([]);
  });

  it("is exempt when the child was never placed, because nothing was ignored", () => {
    const { findings } = prepare(doc([frame([{ id: "dot", type: "rect", width: 3, height: 3 }])]));
    expect(findings).toEqual([]);
  });

  it("is exempt when the child is hidden — nothing is laid out", () => {
    const { findings } = prepare(
      doc([frame([{ id: "dot", type: "rect", visible: false, x: 16, y: 14, width: 3, height: 3 }])])
    );
    expect(findings).toEqual([]);
  });

  it("says nothing when the coordinates happen to be where the flow puts them", () => {
    // A document the editor has already laid out stores flow positions, and that
    // is a correct document — the guard must not fire on its own output.
    const { findings } = prepare(
      doc([frame([{ id: "dot", type: "rect", x: 0, y: 14, width: 3, height: 3 }])])
    );
    expect(findings).toEqual([]);
  });

  it("names three children and counts the rest, rather than printing nine", () => {
    const children = Array.from({ length: 9 }, (_, i) => ({
      id: `row_${i}`,
      type: "rect",
      x: 40,
      y: (i + 1) * 10,
      width: 8,
      height: 8
    }));
    const { findings } = prepare(doc([frame(children)]));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("ignores the x/y on 9 in-flow children");
    expect(findings[0].message).toContain("and 6 more child(ren)");
  });

  it("caps the number of containers named, not the number of children", () => {
    const stacks = Array.from({ length: 8 }, (_, i) => ({
      id: `stack_${i}`,
      type: "frame",
      x: 0,
      y: i * 100,
      width: 200,
      height: 60,
      display: "flex",
      children: [{ id: `child_${i}`, type: "rect", x: 40, y: 0, width: 8, height: 8 }]
    }));
    const { findings } = prepare(doc(stacks));
    expect(findings).toHaveLength(7);
    expect(findings[6].message).toContain("2 more container(s)");
  });

  it("says nothing when one id names two elements — ambiguity is not evidence", () => {
    const { findings } = prepare(
      doc([
        frame([{ id: "same", type: "rect", x: 16, y: 14, width: 3, height: 3 }]),
        {
          id: "other",
          type: "frame",
          x: 200,
          y: 0,
          width: 100,
          height: 60,
          display: "flex",
          children: [{ id: "same", type: "rect", x: 40, y: 8, width: 8, height: 8 }]
        }
      ])
    );
    expect(findings).toEqual([]);
  });

  it("leaves a page nobody is looking at as its author wrote it", () => {
    const raw = {
      version: "0.1",
      pages: [
        { id: "a", name: "A", children: [frame([{ id: "dot", type: "rect", x: 16, y: 14, width: 3, height: 3 }])] },
        {
          id: "b",
          name: "B",
          children: [frame([{ id: "dot_b", type: "rect", x: 16, y: 14, width: 3, height: 3 }], { id: "capsule_b" })]
        }
      ]
    };
    const { document, findings } = prepare(raw);
    expect(findings.map((f) => f.elementId)).toEqual(["capsule"]);
    expect((document.pages![1].children![0] as any).children[0].x).toBe(16);
  });
});

describe("what the layout pass does to the document it grades", () => {
  const textPair = (sizing: Record<string, string>) =>
    doc([
      {
        id: "panel",
        type: "frame",
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        children: [
          {
            id: "lead",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 20,
            content: "one two three",
            sizing: { width: "fixed", ...sizing },
            "font-size": "20px",
            "line-height": "20px"
          },
          {
            id: "tail",
            type: "text",
            x: 0,
            y: 32,
            width: 100,
            height: 20,
            content: "tail",
            "font-size": "20px",
            "line-height": "20px"
          }
        ]
      }
    ]);

  it("hands validate the box the renderer will paint", () => {
    const raw = textPair({ height: "fit-content" });
    const { document } = laidOutDocument(normalizeDesignDocument(raw).document, raw);
    const lead = (document.pages![0].children![0] as any).children[0];
    expect(lead.height).toBeGreaterThan(20);
  });

  it("and then refuses to call that derived height a collision", () => {
    // The derived height is the measurer's opinion: on a real cover it read 137px
    // where the browser painted 92, which turned a clean pair into "58% overlap".
    // The height-overflow rule has always skipped a derived box for the same
    // reason; the overlap rule now does too.
    const raw = textPair({ height: "fit-content" });
    const { document } = laidOutDocument(normalizeDesignDocument(raw).document, raw);
    expect(validateDocument(document).some((d) => d.message.includes("visually overlap"))).toBe(false);
  });

  it("still reports the pair when both heights are authored", () => {
    const raw = textPair({});
    const stored = normalizeDesignDocument(raw).document;
    const panel = (stored.pages![0].children![0] as any);
    panel.children[0].height = 40;
    expect(validateDocument(stored).some((d) => d.message.includes("visually overlap"))).toBe(true);
  });
});
