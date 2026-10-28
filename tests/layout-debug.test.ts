import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { layoutDebug, layoutDefects } from "../src/core/layout-debug";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { relayoutDocumentTree } from "../src/core/layout/auto-layout";
import { instanceSizeResolver } from "../src/core/interactions/instance-size";
import { getActivePage, updateActivePageElements, type DesignDocument, type DesignElement } from "../src/core/dsl/types";

/**
 * The container's box beside the space its children occupy. The two are equal in
 * every healthy document, which is what makes a non-zero delta a defect rather than
 * a judgement call — and it is the failure a screenshot cannot show, because the
 * container is the right size and what is inside it is not.
 */

const rect = (id: string, x: number, y: number, width: number, height: number): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width, height, fills: [{ type: "solid", color: "#fff" }] }) as DesignElement;

const text = (id: string, content: string): DesignElement =>
  ({
    id,
    type: "text",
    name: id,
    content,
    sizing: { width: "fill", height: "fit-content" },
    style: { fontFamily: "Inter, sans-serif", fontSize: 14, lineHeight: 1.5, color: "#fff" }
  }) as DesignElement;

function laidOut(raw: unknown): DesignDocument {
  const n = normalizeDesignDocument(raw);
  return updateActivePageElements(
    n.document,
    relayoutDocumentTree(getActivePage(n.document).children, instanceSizeResolver(n.document))
  );
}

const LONG =
  "Edit designs directly on local disk with zero cloud latency, and keep every measurement the engine made instead of guessing at it from a character count.";

describe("layoutDebug", () => {
  it("reports a healthy hugging container as exactly zero delta", () => {
    const doc = laidOut({
      version: "0.1",
      canvas: { width: 900, height: 700 },
      elements: [
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 40,
          y: 40,
          width: 360,
          sizing: { height: "fit-content" },
          ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
          children: [text("body", LONG)]
        }
      ]
    });
    const [card] = layoutDebug(doc);
    expect(card.overflow).toBe(false);
    expect(card.delta).toBeCloseTo(0, 1);
    // The text has to have actually wrapped for this to mean anything: a single
    // line would make the assertion pass for the wrong reason.
    expect(card.content.height).toBeGreaterThan(40);
  });

  it("does not report a container that is merely taller than its content", () => {
    // A fixed, generous height is a design decision, not a measurement that failed.
    const doc = laidOut({
      version: "0.1",
      canvas: { width: 900, height: 700 },
      elements: [
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 0,
          y: 0,
          width: 360,
          height: 300,
          ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 16 }),
          children: [rect("a", 0, 0, 40, 40)]
        }
      ]
    });
    expect(layoutDefects(doc)).toHaveLength(0);
    expect(layoutDebug(doc)[0].delta).toBeLessThan(0);
  });

  it("ignores a child taken out of the flow", () => {
    // An absolute child is pinned where the author put it; counting it would report
    // every deliberate overlay as an overflow.
    const doc = laidOut({
      version: "0.1",
      canvas: { width: 900, height: 700 },
      elements: [
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 0,
          y: 0,
          width: 360,
          height: 100,
          ...flattenLayout({ mode: "flex", direction: "column", gap: 8, padding: 16 }),
          children: [
            rect("a", 0, 0, 40, 40),
            { ...rect("badge", 0, 0, 40, 40), position: "absolute" } as DesignElement
          ]
        }
      ]
    });
    const card = layoutDebug(doc)[0];
    expect(card.childCount).toBe(1);
    expect(card.overflow).toBe(false);
  });

  it("reports a container whose content is taller than the box it was given", () => {
    // A fixed 100px frame with 200px of children: the box is what the engine
    // produced, the content is what is painted, and they disagree.
    const doc = laidOut({
      version: "0.1",
      canvas: { width: 900, height: 700 },
      elements: [
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 0,
          y: 0,
          width: 360,
          height: 100,
          ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 0 }),
          children: [rect("a", 0, 0, 40, 120), rect("b", 0, 120, 40, 120)]
        }
      ]
    });
    const [card] = layoutDefects(doc);
    expect(card.id).toBe("card");
    expect(card.delta).toBeGreaterThan(100);
    expect(card.overflow).toBe(true);
  });

  it("skips a frame with no layout — there is no pass that could have got it wrong", () => {
    const doc = laidOut({
      version: "0.1",
      canvas: { width: 900, height: 700 },
      elements: [
        { id: "plain", type: "frame", name: "Plain", x: 0, y: 0, width: 360, height: 100, children: [rect("a", 0, 0, 40, 40)] }
      ]
    });
    expect(layoutDebug(doc)).toHaveLength(0);
  });
});
