import { describe, expect, it } from "vitest";
import { validateDocument } from "../src/core/validate";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { flattenLayout } from "../src/core/dsl/layout-flat";
import type { DesignDocument } from "../src/core/dsl/types";

/**
 * What a text is measured against, once the picture is taken into account.
 *
 * The check used to see one backdrop: the fill of the container. A white label
 * over a photograph that was a *sibling* rect was therefore measured against the
 * canvas white and reported at 1.0:1, with a recommendation to make the text
 * near-black — on a dark photo.
 */
const doc = (children: unknown[], background = "#FFFFFF"): DesignDocument =>
  normalizeDesignDocument({
    version: "0.1",
    canvas: { width: 375, height: 400, background: { type: "solid", color: background } },
    pages: [{ id: "page_1", name: "Page 1", children }]
  }).document as DesignDocument;

const contrastFindings = (children: unknown[]) =>
  validateDocument(doc(children)).filter((d) => d.message.includes("contrast ratio"));

const photo = (props: Record<string, unknown> = {}) => ({
  id: "photo",
  type: "rect",
  name: "Photo",
  x: 0,
  y: 0,
  width: 375,
  height: 400,
  fills: [{ type: "image", assetId: "asset_hero", fit: "cover" }],
  ...props
});

const label = (props: Record<string, unknown> = {}) => ({
  id: "label",
  type: "text",
  name: "Label",
  x: 24,
  y: 300,
  width: 300,
  height: 40,
  content: "Book the table",
  fills: [{ type: "solid", color: "#FFFFFF" }],
  style: { fontFamily: "Inter, sans-serif", fontSize: 24 },
  ...props
});

describe("contrast backdrop", () => {
  it("says nothing about white text over an image sibling", () => {
    expect(contrastFindings([photo(), label()])).toEqual([]);
  });

  it("says nothing about white text over a dark sibling rect", () => {
    // Reported 1.0:1 against #FFFFFF before: the text was measured against the
    // canvas while a black rect painted right behind it.
    const bg = {
      id: "bg",
      type: "rect",
      name: "Dark",
      x: 0,
      y: 0,
      width: 375,
      height: 400,
      fills: [{ type: "solid", color: "#101010" }]
    };
    expect(contrastFindings([bg, label()])).toEqual([]);
  });

  it("looks through a wrapper that paints nothing", () => {
    const bg = {
      id: "bg",
      type: "rect",
      name: "Dark",
      x: 0,
      y: 0,
      width: 375,
      height: 400,
      fills: [{ type: "solid", color: "#101010" }]
    };
    const content = {
      id: "content",
      type: "frame",
      name: "Content",
      x: 0,
      y: 0,
      width: 375,
      height: 400,
      children: [label()]
    };
    expect(contrastFindings([bg, content])).toEqual([]);
  });

  it("treats a translucent sibling as unknown rather than as its fill", () => {
    const veil = {
      id: "veil",
      type: "rect",
      name: "Veil",
      x: 0,
      y: 0,
      width: 375,
      height: 400,
      opacity: 0.3,
      fills: [{ type: "solid", color: "#101010" }]
    };
    expect(contrastFindings([veil, label()])).toEqual([]);
  });

  it("ignores a sibling that only clips a corner of the text box", () => {
    // A badge over the first characters says nothing about the rest of the line,
    // so the canvas stays the backdrop and the finding stands.
    const badge = {
      id: "badge",
      type: "rect",
      name: "Badge",
      x: 20,
      y: 300,
      width: 40,
      height: 20,
      fills: [{ type: "solid", color: "#101010" }]
    };
    expect(contrastFindings([badge, label()])).toHaveLength(1);
  });

  it("still reports white text on a white canvas with nothing under it", () => {
    const out = contrastFindings([label()]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("1.0:1 against backdrop #FFFFFF");
  });

  it("still reports a real failure against a sibling it can read", () => {
    const bg = {
      id: "bg",
      type: "rect",
      name: "Light",
      x: 0,
      y: 0,
      width: 375,
      height: 400,
      fills: [{ type: "solid", color: "#F7F7F7" }]
    };
    const out = contrastFindings([bg, label()]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("#F7F7F7");
  });

  it("never reads a sibling text's ink as a backdrop", () => {
    // The demo's own headings: a dark line over the page, with another dark line
    // beside it. Reading the sibling's `fills` as a surface reported each heading
    // at 1.0:1 against its own ink.
    const ink = { type: "solid", color: "#131313" };
    const heading = {
      id: "line-1",
      type: "text",
      name: "Line 1",
      x: 0,
      y: 0,
      width: 375,
      height: 400,
      content: "Line 1",
      fills: [ink],
      style: { fontFamily: "Inter, sans-serif", fontSize: 64 }
    };
    const dark = label({ id: "line-2", fills: [ink] });
    expect(contrastFindings([heading, dark])).toEqual([]);
  });

  it("measures a child where the layout puts it, not where the file left it", () => {
    // Both children are stored at 0,0 — what a document authored as JSON looks
    // like. Read that way the band "covers" the label and the finding vanishes;
    // the layout pass puts the label below it, on the white page.
    const section = {
      id: "section",
      type: "frame",
      name: "Section",
      x: 0,
      y: 0,
      width: 375,
      height: 600,
      ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
      children: [
        { id: "band", type: "rect", name: "Band", x: 0, y: 0, width: 327, height: 200, fills: [{ type: "solid", color: "#101010" }] },
        label({ id: "below", x: 0, y: 0, width: 327, height: 40 })
      ]
    };
    expect(contrastFindings([section])).toHaveLength(1);
  });

  it("keeps the image fill of the container itself unknown", () => {
    const card = {
      id: "card",
      type: "frame",
      name: "Card",
      x: 0,
      y: 0,
      width: 375,
      height: 400,
      fills: [{ type: "image", assetId: "asset_hero", fit: "cover" }],
      children: [label()]
    };
    expect(contrastFindings([card])).toEqual([]);
  });
});
