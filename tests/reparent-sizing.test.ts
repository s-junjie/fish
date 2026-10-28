import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { relayoutDocumentTree } from "../src/core/compile";
import {
  findElementById,
  reconcileSizingAfterReparent,
  reparentOnCanvasDrop
} from "../src/core/geometry/tree-ops";
import { applyLayerDrop } from "../src/ui/layers/layer-reorder";
import { ContainerElement, DesignElement, FrameElement, TextElement } from "../src/core/dsl/types";

// A `sizing` default is stored, not derived, so it is a statement about the
// element's SITUATION — and a drop changes the situation. Measured in the real
// editor before this was fixed, wrong in both directions: text dropped into a
// 312-wide card kept its 1078 character-count width, and text dropped out of one
// came back as a single 604px line instead of the two-line paragraph it had been.
//
// These cases pin the two transitions, and — just as importantly — the three
// situations that must NOT be touched, because a reconcile that fires on every
// drop would pin a hug the author meant.

const LONG =
  "Revenue grew across every region this quarter, led by the northern territory and a strong enterprise pipeline.";

const CARD_CONTENT_WIDTH = 360 - 24 * 2;

// Deliberately WITHOUT width/height, which is the whole fixture: an axis the
// author never wrote is exactly the situation the default is about, and a text
// that arrives with a pixel height keeps it (normalize honours an authored size
// on the height axis). The cast is the cost of saying "no width and no height" in
// a type that requires both — the alternative, filling them in, would delete the
// fixture.
const text = (id: string, overrides: Partial<TextElement> = {}): TextElement =>
  ({
    id,
    type: "text",
    name: id,
    x: 0,
    y: 0,
    content: LONG,
    style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" },
    ...overrides
  }) as TextElement;

const card = (children: DesignElement[] = []): FrameElement => ({
  id: "card",
  type: "frame",
  name: "Card",
  x: 0,
  y: 0,
  width: 360,
  height: 300,
  fills: [{ type: "solid", color: "#222222" }],
  ...flattenLayout({ mode: "flex", direction: "column", gap: 12, padding: 24 }),
  children
});

const plain = (children: DesignElement[] = []): FrameElement => ({
  id: "plain",
  type: "frame",
  name: "Plain",
  x: 600,
  y: 0,
  width: 360,
  height: 300,
  children
});

/** Normalize + lay out, which is where the stored defaults are written. */
const load = (elements: DesignElement[]): DesignElement[] => {
  const doc = {
    version: "0.1",
    canvas: { width: 2000, height: 1200 },
    pages: [{ id: "p1", name: "P1", children: elements }],
    activePageId: "p1"
  };
  const normalized = normalizeDesignDocument(doc as never);
  return relayoutDocumentTree(normalized.document.pages[0].children);
};

const get = (elements: DesignElement[], id: string): TextElement => {
  const found = findElementById(elements, id);
  if (!found) throw new Error(`no ${id}`);
  return found as TextElement;
};

const find = (elements: DesignElement[], id: string): ContainerElement => {
  const found = findElementById(elements, id);
  if (!found) throw new Error(`no ${id}`);
  return found as ContainerElement;
};

describe("a text that enters a layout parent", () => {
  it("gains the hug default on both axes, and wraps to the container", () => {
    // The document as it stands before normalize would ever see it: a text that
    // was authored at canvas level and has just been dropped into the card.
    const elements: DesignElement[] = [
      card([text("t", { width: 1078, height: 19 })])
    ];

    const after = reconcileSizingAfterReparent(elements, "t", null);
    expect(get(after, "t").sizing).toEqual({ width: "fit-content", height: "fit-content" });

    // And the pass that runs next resolves those declarations into a box the width
    // of the card's content, not the character-count width it arrived with.
    const laid = relayoutDocumentTree(after);
    expect(get(laid, "t").width).toBe(CARD_CONTENT_WIDTH);
    expect(get(laid, "t").height).toBeGreaterThan(19);
  });

  it("reaches the same box through the layer panel's drop", () => {
    const elements = load([card(), text("t")]);
    const before = get(elements, "t");
    expect(before.sizing).toBeUndefined();
    expect(before.width).toBeGreaterThan(CARD_CONTENT_WIDTH);

    const result = applyLayerDrop(elements, ["t"], "card", "inside");
    if (!("elements" in result)) throw new Error("drop was refused");

    const dropped = get(result.elements, "t");
    expect(dropped.sizing).toEqual({ width: "fit-content", height: "fit-content" });
    expect(dropped.width).toBe(CARD_CONTENT_WIDTH);
  });

  it("reaches the same box through a canvas drag", () => {
    // Narrow enough that its centre lands inside the card, which is what
    // `reparentOnCanvasDrop` hit-tests.
    const elements: DesignElement[] = [card(), text("t", { x: 40, y: 40, width: 80, height: 19 })];
    const result = reparentOnCanvasDrop(elements, "t");

    expect(result.reparented).toBe(true);
    expect(get(result.elements, "t").sizing).toEqual({
      width: "fit-content",
      height: "fit-content"
    });
  });
});

describe("a text that leaves a layout parent", () => {
  it("keeps the box it was dropped with, instead of re-wrapping unbounded", () => {
    const laid = load([card([text("t")])]);
    const before = get(laid, "t");
    expect(before.sizing).toEqual({ width: "fit-content", height: "fit-content" });
    expect(before.width).toBe(CARD_CONTENT_WIDTH);

    // Out to the canvas: the element is lifted out of the card, then reconciled.
    const without = find(laid, "card").children!.filter((c) => c.id !== "t");
    const lifted: DesignElement[] = [
      { ...find(laid, "card"), children: without },
      { ...before }
    ];

    const after = reconcileSizingAfterReparent(lifted, "t", find(laid, "card"));
    expect(get(after, "t").sizing).toBeUndefined();

    // The numbers are untouched, so the relayout cannot re-measure them.
    const relaid = relayoutDocumentTree(after);
    expect(get(relaid, "t").width).toBe(before.width);
    expect(get(relaid, "t").height).toBe(before.height);
  });

  it("keeps a `fill` width, so dragging it back in fills again", () => {
    const laid = load([card([text("t", { sizing: { width: "fill" } })])]);
    const without = find(laid, "card").children!.filter((c) => c.id !== "t");
    const lifted: DesignElement[] = [
      { ...find(laid, "card"), children: without },
      { ...get(laid, "t") }
    ];

    const after = reconcileSizingAfterReparent(lifted, "t", find(laid, "card"));
    expect(get(after, "t").sizing?.width).toBe("fill");
  });

  it("keeps an authored `max-content`, which has nothing to do with the parent", () => {
    const laid = load([card([text("t", { sizing: { width: "max-content" } })])]);
    const without = find(laid, "card").children!.filter((c) => c.id !== "t");
    const lifted: DesignElement[] = [
      { ...find(laid, "card"), children: without },
      { ...get(laid, "t") }
    ];

    const after = reconcileSizingAfterReparent(lifted, "t", find(laid, "card"));
    expect(get(after, "t").sizing?.width).toBe("max-content");
  });
});

describe("the situations that must not be touched", () => {
  it("a reorder inside the same layout parent", () => {
    const laid = load([card([text("t")])]);
    const after = reconcileSizingAfterReparent(laid, "t", find(laid, "card"));
    expect(after).toBe(laid);
  });

  it("a move between two layout parents, where the declaration still applies", () => {
    const other = { ...card([text("t")]), id: "card2" } as FrameElement;
    const laid = load([card(), other]);
    const moving = get(laid, "t") ?? text("t");
    const elements: DesignElement[] = [
      card(),
      { ...other, children: [moving] }
    ];

    const after = reconcileSizingAfterReparent(elements, "t", find(elements, "card"));
    expect(after).toBe(elements);
  });

  it("a plain frame, which runs no pass that could size anything", () => {
    const elements: DesignElement[] = [plain([text("t")])];
    const after = reconcileSizingAfterReparent(elements, "t", null);
    expect(after).toBe(elements);
  });

  it("anything that is not text — a container's hug is its own pass's business", () => {
    const box: DesignElement = {
      id: "box",
      type: "rect",
      name: "Box",
      x: 0,
      y: 0,
      width: 50,
      height: 40
    };
    const elements: DesignElement[] = [card([box])];
    const after = reconcileSizingAfterReparent(elements, "box", null);
    expect(after).toBe(elements);
  });
});

describe("normalize still stores the same defaults when the file is read", () => {
  it("hugs a text authored inside a layout parent, and leaves canvas-level text alone", () => {
    const laid = load([card([text("inside")]), text("outside")]);
    expect(get(laid, "inside").sizing).toEqual({ width: "fit-content", height: "fit-content" });
    expect(get(laid, "outside").sizing).toBeUndefined();
  });
});
