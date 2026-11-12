import { describe, it, expect } from "vitest";
import { planPresentWheel, type PresentWheelRequest } from "../src/core/presentation/scroll";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

const canvas = {
  width: 1920,
  height: 1080,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#FFFFFF" }
};

function doc(elements: DesignElement[]): DesignDocument {
  return {
    version: LATEST_DOCUMENT_VERSION,
    id: "test",
    name: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
    activePageId: "page_1",
    elements
  };
}

const rect = (id: string, x: number, y: number, w: number, h: number, extra = {}): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width: w, height: h, ...extra }) as DesignElement;

/** A phone-shaped slide whose content is twice its height. */
const scrollingScreen = (): DesignElement =>
  ({
    id: "screen",
    type: "frame",
    name: "screen",
    x: 0,
    y: 0,
    width: 400,
    height: 800,
    overflowX: "hidden",
    overflowY: "auto",
    children: [rect("row", 0, 0, 400, 1600)]
  }) as DesignElement;

const request = (over: Partial<PresentWheelRequest> = {}): PresentWheelRequest => ({
  elements: [scrollingScreen()],
  doc: doc([scrollingScreen()]),
  point: { x: 200, y: 400 },
  delta: { x: 0, y: 120 },
  offsets: {},
  slideY: 0,
  maxSlideY: 0,
  ...over
});

describe("planPresentWheel", () => {
  it("scrolls the container under the pointer, not the deck", () => {
    const plan = planPresentWheel(request());
    expect(plan).toEqual({ kind: "container", id: "screen", x: 0, y: 120 });
  });

  it("spends the delta on the deck's own offset, not the document's", () => {
    const plan = planPresentWheel(request({ offsets: { screen: { x: 0, y: 300 } }, delta: { x: 0, y: 40 } }));
    expect(plan).toEqual({ kind: "container", id: "screen", x: 0, y: 340 });
  });

  it("stops at the end of a scrollable container instead of turning the slide", () => {
    // 1600 of content in an 800 box: 800 is the whole travel.
    const plan = planPresentWheel(request({ offsets: { screen: { x: 0, y: 800 } }, delta: { x: 0, y: 120 } }));
    expect(plan).toEqual({ kind: "none" });
  });

  it("clamps the last step to the travel rather than overshooting", () => {
    const plan = planPresentWheel(request({ offsets: { screen: { x: 0, y: 760 } }, delta: { x: 0, y: 120 } }));
    expect(plan).toEqual({ kind: "container", id: "screen", x: 0, y: 800 });
  });

  it("scrolls the slide itself when the slide is taller than the screen", () => {
    const plan = planPresentWheel(
      request({ elements: [rect("plain", 0, 0, 400, 800)], maxSlideY: 240, slideY: 0 })
    );
    expect(plan).toEqual({ kind: "slide", y: 120 });
  });

  it("never answers a slide change when nothing can scroll", () => {
    const plan = planPresentWheel(request({ elements: [rect("plain", 0, 0, 400, 800)], maxSlideY: 0 }));
    expect(plan).toEqual({ kind: "none" });
  });

  it("leaves an embedded page its own wheel", () => {
    const embed = { id: "embed", type: "html", name: "embed", x: 0, y: 0, width: 400, height: 800 } as DesignElement;
    const plan = planPresentWheel(
      request({ elements: [embed], doc: doc([embed]), delta: { x: 0, y: 120 } })
    );
    expect(plan).toEqual({ kind: "none" });
  });

  it("reaches the container through a child, including text", () => {
    const screen = scrollingScreen();
    const label = {
      id: "label",
      type: "text",
      name: "label",
      x: 20,
      y: 200,
      width: 300,
      height: 40,
      content: "Row",
      style: {}
    } as unknown as DesignElement;
    const withText = { ...screen, children: [label, rect("row", 0, 0, 400, 1600)] } as DesignElement;
    const plan = planPresentWheel(request({ elements: [withText], doc: doc([withText]), point: { x: 100, y: 210 } }));
    expect(plan).toEqual({ kind: "container", id: "screen", x: 0, y: 120 });
  });
});
