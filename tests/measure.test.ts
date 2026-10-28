import { describe, it, expect } from "vitest";
import { measureDocument, measureElement } from "../src/core/measure";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * Geometry readback for an external agent. Every case here is a way the answer can
 * be quietly wrong: local coordinates reported as canvas ones, an instance's
 * children missing (their ids are derived, so a document walk that stops at the
 * instance reports them as absent), or an inactive page's authored coordinates
 * presented as if something painted them.
 */

const rect = (id: string, x: number, y: number, width: number, height: number): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width, height }) as DesignElement;

const frame = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  children: DesignElement[]
): DesignElement => ({ id, type: "frame", name: id, x, y, width, height, children }) as DesignElement;

const docOf = (elements: DesignElement[]): DesignDocument =>
  normalizeDesignDocument({ version: "0.1", canvas: { width: 1440, height: 4000 }, elements }).document;

describe("measureElement", () => {
  it("reports a top-level element in canvas coordinates", () => {
    const node = measureElement(docOf([rect("a", 120, 252, 496, 136)]), "a");
    expect(node).toMatchObject({ id: "a", type: "rect", x: 120, y: 252, width: 496, height: 136 });
  });

  it("adds the ancestor origin chain, and keeps the stored box as local", () => {
    const doc = docOf([frame("page", 100, 200, 800, 600, [frame("card", 24, 32, 300, 100, [rect("c", 8, 16, 40, 20)])])]);
    expect(measureElement(doc, "c")).toMatchObject({ x: 132, y: 248 });
    expect(measureElement(doc, "c")?.local).toEqual({ x: 8, y: 16, width: 40, height: 20 });
  });

  it("measures a line by its two endpoints, not by (x, y, width, height)", () => {
    const line = { id: "l", type: "line", name: "l", x: 100, y: 100, width: 40, height: 0, dx: -40, dy: 60 } as DesignElement;
    expect(measureElement(docOf([line]), "l")).toMatchObject({ x: 60, y: 100, width: 40, height: 60 });
  });

  it("returns null for an id no node carries", () => {
    expect(measureElement(docOf([rect("a", 0, 0, 10, 10)]), "typo")).toBeNull();
  });
});

describe("measureDocument — instances", () => {
  const instanced = () => {
    const master = {
      id: "cmp/Button",
      type: "component",
      name: "Button",
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      children: [rect("pc-label", 16, 8, 120, 24)]
    } as DesignElement;
    const instance = {
      id: "btn-1",
      type: "instance",
      name: "Book a test ride",
      x: 40,
      y: 600,
      width: 200,
      height: 40,
      componentId: "cmp/Button"
    } as DesignElement;
    return docOf([master, instance]);
  };

  it("measures a resolved instance child under its derived id", () => {
    const node = measureElement(instanced(), "btn-1_pc-label");
    expect(node).toMatchObject({ derived: true, instanceId: "btn-1", x: 56, y: 608 });
  });

  it("reports the instance itself as a real node, not a derived one", () => {
    expect(measureElement(instanced(), "btn-1")).toMatchObject({ derived: false, instanceId: null, x: 40, y: 600 });
  });

  it("leaves an instance measurable when its master is missing", () => {
    const orphan = {
      id: "btn-1",
      type: "instance",
      name: "Book a test ride",
      x: 40,
      y: 600,
      width: 200,
      height: 40,
      componentId: "cmp/Gone"
    } as DesignElement;
    const node = measureElement(docOf([orphan]), "btn-1");
    expect(node).toMatchObject({ x: 40, y: 600, width: 200, height: 40 });
  });
});

describe("measureDocument — pages", () => {
  const twoPages = (): DesignDocument =>
    normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 1440, height: 4000 },
      activePageId: "page-1",
      pages: [
        { id: "page-1", name: "Home", canvas: { width: 1440, height: 4000 }, children: [rect("home", 0, 0, 1440, 4000)] },
        { id: "page-2", name: "Detail", canvas: { width: 1440, height: 1200 }, children: [rect("detail", 0, 0, 1440, 1200)] }
      ]
    }).document;

  it("marks only the active page as rendered", () => {
    const nodes = measureDocument(twoPages());
    expect(nodes.find((n) => n.id === "home")?.rendered).toBe(true);
    expect(nodes.find((n) => n.id === "detail")?.rendered).toBe(false);
  });

  it("still finds an element that lives on an inactive page", () => {
    expect(measureElement(twoPages(), "detail")).toMatchObject({ rendered: false, height: 1200 });
  });
});

describe("measureDocument — viewport culling", () => {
  // The renderer returns null for a top-level element outside the viewport box, so
  // an export taken in that state photographs empty canvas where the element
  // stands. Every other number still reports it as correct, which is why this has to
  // be carried on the node itself.
  const tall = () =>
    docOf([
      rect("in-view", 100, 100, 400, 200),
      rect("below-fold", 100, 3000, 400, 200),
      rect("straddles", 100, 780, 400, 200)
    ]);

  const viewport = { x: 0, y: 0, width: 1440, height: 1000 };

  it("reports an element the viewport covers as rendered", () => {
    expect(measureElement(tall(), "in-view", viewport)?.rendered).toBe(true);
  });

  it("reports an element below the fold as not rendered", () => {
    expect(measureElement(tall(), "below-fold", viewport)?.rendered).toBe(false);
  });

  it("tests the subtree, so a frame whose own box left the viewport can still be painted", () => {
    // A frame scrolled mostly off the top still has a child inside the viewport, and
    // the renderer keeps it — so a frame must not be marked culled for its own box.
    const doc = docOf([frame("f", 100, 900, 600, 800, [rect("deep", 20, 100, 200, 100)])]);
    const nodes = measureDocument(doc, viewport);
    expect(nodes.find((n) => n.id === "f")?.rendered).toBe(true);
    expect(nodes.find((n) => n.id === "deep")?.rendered).toBe(true);
  });

  it("assumes painted when no viewport is known, because core cannot see the canvas", () => {
    expect(measureElement(tall(), "below-fold")?.rendered).toBe(true);
  });

  it("keeps every number correct for a culled element — only the flag changes", () => {
    const node = measureElement(tall(), "below-fold", viewport);
    expect(node).toMatchObject({ x: 100, y: 3000, width: 400, height: 200, rendered: false });
  });
});
