import { describe, it, expect } from "vitest";
import { DesignDocument, DesignElement, FrameElement, RectElement } from "../src/core/dsl/types";
import { exportNames, exportUnits, paintedElements } from "../src/ui/inspector/export-units";

const canvas = { width: 1200, height: 800, unit: "px" as const, background: { type: "solid" as const, color: "#FFFFFF" } };

const makeDoc = (elements: DesignElement[]): DesignDocument => ({
  version: "0.1",
  id: "doc",
  name: "Doc",
  createdAt: "",
  updatedAt: "",
  canvas,
  pages: [{ id: "p1", name: "Page 1", canvas, children: elements }],
  activePageId: "p1"
});

const rect = (id: string, name?: string): RectElement => ({
  id,
  type: "rect",
  name,
  x: 0,
  y: 0,
  width: 100,
  height: 50
});

const frame = (id: string, name?: string, children: DesignElement[] = []): FrameElement => ({
  id,
  type: "frame",
  name,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  children
});

describe("the images one Export press produces", () => {
  it("treats each selected frame as its own picture", () => {
    const hero = frame("hero", "Hero");
    const footer = frame("footer", "Footer");
    const doc = makeDoc([hero, footer]);

    expect(exportUnits(doc, [hero, footer]).map((el) => el.id)).toEqual(["hero", "footer"]);
  });

  it("does not make a picture of a layer that is already inside another one", () => {
    const card = frame("card", "Card", [rect("label")]);
    const doc = makeDoc([card]);
    // Selecting the frame and one of its layers is one picture, not two.
    expect(exportUnits(doc, [card, card.children[0]]).map((el) => el.id)).toEqual(["card"]);
  });

  it("drops a deep descendant selected alongside its root", () => {
    const label = rect("label");
    const card = frame("card", "Card", [label]);
    const page = frame("page", "Page", [card]);
    const doc = makeDoc([page]);

    expect(exportUnits(doc, [page, label]).map((el) => el.id)).toEqual(["page"]);
  });

  it("exports nothing for an empty selection — the caller falls back to the canvas", () => {
    expect(exportUnits(makeDoc([frame("hero")]), [])).toEqual([]);
  });

  it("names each file after its layer", () => {
    const units = [frame("a", "Hero"), frame("b", "Footer"), rect("c", "Badge")];
    expect(exportNames(units)).toEqual(["Hero", "Footer", "Badge"]);
  });

  it("numbers a repeated name, because two files with one name leave the user one file", () => {
    const units = [frame("a", "Frame 1"), frame("b", "Frame 1"), frame("c", "Frame 1")];
    expect(exportNames(units)).toEqual(["Frame 1", "Frame 1-2", "Frame 1-3"]);
  });

  it("treats a name that differs only by case as a repeat", () => {
    expect(exportNames([frame("a", "Hero"), frame("b", "hero")])).toEqual(["Hero", "hero-2"]);
  });

  it("replaces the characters a filename cannot carry", () => {
    expect(exportNames([frame("a", 'a/b:c*d?"e<f>g|h\\i')])).toEqual(["a_b_c_d__e_f_g_h_i"]);
  });

  it("falls back to the layer type when the layer has no name", () => {
    expect(exportNames([frame("a"), rect("b")])).toEqual(["frame", "rect"]);
  });
});

/**
 * What the mirror probe is allowed to ask the live DOM about.
 *
 * A hidden layer is not in the SVG at all, so asking whether it is there answers
 * "no" on every export — and one hidden section anywhere on the page made the
 * probe report a short canvas, which mounts the mirror and rebuilds the whole
 * tree for an export the live canvas could have served.
 */
describe("the layers the canvas can have painted", () => {
  it("drops a hidden layer and everything under it", () => {
    const hidden = { ...frame("hidden", "Hidden", [rect("inside")]), visible: false as const };
    expect(paintedElements([hidden, rect("shown")]).map((el) => el.id)).toEqual(["shown"]);
  });

  it("keeps a visible frame but drops the hidden child inside it", () => {
    const shown = frame("shown", "Shown", [rect("kept"), { ...rect("gone"), visible: false as const }]);
    expect(paintedElements([shown]).map((el) => el.id)).toEqual(["shown", "kept"]);
  });
});
