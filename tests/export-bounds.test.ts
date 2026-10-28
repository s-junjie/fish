import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { exportBounds } from "../src/ui/inspector/export-bounds";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * The rectangle the Export button hands the rasterizer. Getting it wrong is the
 * worst kind of export bug: the file is produced, at the right size, with real
 * content in it — just the wrong rectangle of the page.
 */

const docOf = (elements: DesignElement[], canvas = { width: 1440, height: 4000 }): DesignDocument =>
  normalizeDesignDocument({ version: "0.1", canvas, elements }).document;

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

describe("exportBounds", () => {
  it("frames the whole page when nothing is selected", () => {
    expect(exportBounds(docOf([rect("a", 0, 0, 100, 50)]), [])).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 4000
    });
  });

  // The bug: `elementAABB` is parent-local, and a nested element's own x/y is the
  // distance from its parent, so this cropped the top-left corner of the page and
  // called it the selected label.
  it("adds the ancestor origin chain for a single nested element", () => {
    const card = frame("card", 500, 800, 360, 200, [rect("label", 24, 32, 120, 20)]);
    const doc = docOf([card]);
    const label = (card as { children: DesignElement[] }).children[0];
    expect(exportBounds(doc, [label])).toEqual({ x: 524, y: 832, width: 120, height: 20 });
  });

  it("unions a multi-selection in canvas coordinates", () => {
    const doc = docOf([
      frame("card", 500, 800, 360, 200, [rect("a", 24, 32, 120, 20)]),
      rect("far", 1000, 2000, 50, 50)
    ]);
    const card = getActivePage(doc).children[0] as unknown as { children: DesignElement[] };
    const child = card.children[0];
    const far = getActivePage(doc).children[1];
    expect(exportBounds(doc, [child, far])).toEqual({ x: 524, y: 832, width: 526, height: 1218 });
  });

  it("measures a line by its endpoints, not by (x, y, width, height)", () => {
    const line = {
      id: "l",
      type: "line",
      name: "l",
      x: 300,
      y: 300,
      width: 40,
      height: 0,
      dx: -40,
      dy: 60
    } as DesignElement;
    expect(exportBounds(docOf([line]), [line])).toEqual({ x: 260, y: 300, width: 40, height: 60 });
  });

  it("resolves an instance's child, whose id the document tree never mints", () => {
    const doc = docOf([
      {
        id: "cmp/Button",
        type: "component",
        name: "Button",
        x: 0,
        y: 0,
        width: 200,
        height: 40,
        children: [rect("pc-label", 16, 8, 120, 24)]
      } as DesignElement,
      {
        id: "btn-1",
        type: "instance",
        name: "Book a test ride",
        x: 40,
        y: 600,
        width: 200,
        height: 40,
        componentId: "cmp/Button"
      } as DesignElement
    ]);
    const instance = getActivePage(doc).children[1];
    expect(exportBounds(doc, [instance])).toEqual({ x: 40, y: 600, width: 200, height: 40 });
  });

  // The bug: the crop was the element's own box, and a shadow paints PAST
  // that box — the export viewBox is the crop, so every shadowed frame's
  // shadow was cut off at the frame's edge. Figma grows the export to the
  // paint, by the reach the canvas itself decides shadow visibility with.
  it("grows the crop by a drop shadow's reach", () => {
    const card = {
      ...frame("card", 100, 100, 200, 100, []),
      effects: [{ type: "drop-shadow", color: "#000000", offset: { x: 0, y: 8 }, blur: 16 }]
    } as DesignElement;
    const doc = docOf([card]);
    // reach = spread 0 + blur 16 * 3 + offset 8 = 56, on all four sides.
    expect(exportBounds(doc, [getActivePage(doc).children[0]])).toEqual({
      x: 44,
      y: 44,
      width: 312,
      height: 212
    });
  });

  it("takes the widest reach when several shadows stack", () => {
    const card = {
      ...frame("card", 0, 0, 100, 50, []),
      effects: [
        { type: "drop-shadow", color: "#000000", offset: { x: 0, y: 4 }, blur: 4 },
        { type: "drop-shadow", color: "#000000", offset: { x: 0, y: 0 }, blur: 16 }
      ]
    } as DesignElement;
    const doc = docOf([card]);
    // 4 * 3 + 4 = 16 against 16 * 3 = 48.
    expect(exportBounds(doc, [getActivePage(doc).children[0]])).toEqual({
      x: -48,
      y: -48,
      width: 196,
      height: 146
    });
  });

  it("grows nothing for a shadow that is switched off", () => {
    const card = {
      ...frame("card", 10, 10, 100, 50, []),
      effects: [
        { type: "drop-shadow", color: "#000000", offset: { x: 0, y: 8 }, blur: 16, enabled: false }
      ]
    } as DesignElement;
    const doc = docOf([card]);
    expect(exportBounds(doc, [getActivePage(doc).children[0]])).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  // An inner shadow's RESULT is inside the box (only its intermediates are
  // not — see `computeFilterRegion`), and a backdrop effect paints nothing of
  // its own, so neither may grow the crop.
  it("grows nothing for effects whose paint stays inside the box", () => {
    const card = {
      ...frame("card", 10, 10, 100, 50, []),
      effects: [
        { type: "inner-shadow", color: "#000000", offset: { x: 0, y: 10 }, blur: 20 },
        { type: "backdrop-blur", blur: 20 }
      ]
    } as DesignElement;
    const doc = docOf([card]);
    expect(exportBounds(doc, [getActivePage(doc).children[0]])).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  it("grows the crop by a layer blur's reach", () => {
    const card = {
      ...frame("card", 0, 0, 100, 50, []),
      effects: [{ type: "layer-blur", blur: 10 }]
    } as DesignElement;
    const doc = docOf([card]);
    expect(exportBounds(doc, [getActivePage(doc).children[0]])).toEqual({
      x: -30,
      y: -30,
      width: 160,
      height: 110
    });
  });

  it("grows the crop by a text shadow's reach", () => {
    const label = {
      id: "t",
      type: "text",
      name: "t",
      x: 0,
      y: 0,
      width: 120,
      height: 30,
      effects: [{ type: "drop-shadow", color: "#000000", offset: { x: 4, y: 6 }, blur: 12 }]
    } as DesignElement;
    const doc = docOf([label]);
    // blur 12 * 3 + the larger offset 6 = 42; a text's drop shadow has no spread.
    expect(exportBounds(doc, [getActivePage(doc).children[0]])).toEqual({
      x: -42,
      y: -42,
      width: 204,
      height: 114
    });
  });

  // An instance paints the effects its master carries whenever it declares
  // none of its own (`resolveInstanceBox`), so the crop has to resolve the
  // same inheritance the renderer and `CanvasDefs` do.
  it("grows the crop for an instance that inherits its master's shadow", () => {
    const doc = docOf([
      {
        id: "cmp/Card",
        type: "component",
        name: "Card",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        effects: [{ type: "drop-shadow", color: "#000000", offset: { x: 0, y: 8 }, blur: 16 }],
        children: []
      } as DesignElement,
      {
        id: "inst-1",
        type: "instance",
        name: "Card",
        x: 50,
        y: 60,
        width: 200,
        height: 100,
        componentId: "cmp/Card"
      } as DesignElement
    ]);
    expect(exportBounds(doc, [getActivePage(doc).children[1]])).toEqual({
      x: -6,
      y: 4,
      width: 312,
      height: 212
    });
  });
});
