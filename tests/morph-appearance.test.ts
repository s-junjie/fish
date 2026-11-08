import { describe, it, expect } from "vitest";
import { matchSlides } from "../src/core/presentation/morph";
import { morphSlide } from "../src/core/presentation/animate";
import type { DesignElement, Paint, TextStyle } from "../src/core/dsl/types";

/**
 * The half of a morph that is not geometry: what the layer is filled with, what
 * is drawn around it, the type it is set in, the filter over it. All of it used
 * to jump to the incoming slide's value on frame one while the box travelled.
 */

const el = (id: string, extra: Partial<DesignElement> = {}): DesignElement =>
  ({
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...extra
  }) as DesignElement;

const frame = (id: string, children: DesignElement[]): DesignElement =>
  el(id, { type: "frame", children } as Partial<DesignElement>);

/** The one paired child, drawn at `p`. Untyped: the point is what came out. */
const at = (from: DesignElement, to: DesignElement, p: number): any =>
  (morphSlide(from, to, matchSlides(from, to), p) as { children: DesignElement[] }).children[0];

const solid = (color: string): Paint => ({ type: "solid", color });

describe("a morph carries the paint", () => {
  it("melts one colour into the other", () => {
    const from = frame("a", [el("card", { fills: [solid("#000000")] })]);
    const to = frame("b", [el("card2", { name: "card", fills: [solid("#FFFFFF")] })]);
    expect(at(from, to, 0).fills?.[0]).toMatchObject({ color: "rgba(0, 0, 0, 1)" });
    expect(at(from, to, 0.5).fills?.[0]).toMatchObject({ color: "rgba(128, 128, 128, 1)" });
    expect(at(from, to, 1).fills?.[0]).toMatchObject({ color: "#FFFFFF" });
  });

  it("walks a gradient's stops and its angle together", () => {
    const ramp = (from: string, to: string, angle: number, end: number): Paint => ({
      type: "linear-gradient",
      from,
      to,
      angle,
      stops: [
        { color: from, offset: 0 },
        { color: to, offset: end }
      ]
    });
    const a = frame("a", [el("bg", { fills: [ramp("#000000", "#FF0000", 0, 1)] })]);
    const b = frame("b", [el("bg2", { name: "bg", fills: [ramp("#FFFFFF", "#0000FF", 90, 0.5)] })]);

    const mid = at(a, b, 0.5).fills?.[0] as Extract<Paint, { type: "linear-gradient" }>;
    expect(mid.angle).toBe(45);
    expect(mid.stops?.[0]).toMatchObject({ color: "rgba(128, 128, 128, 1)", offset: 0 });
    expect(mid.stops?.[1]).toMatchObject({ color: "rgba(128, 0, 128, 1)", offset: 0.75 });
  });

  it("fades a layer only one slide carries instead of switching it on", () => {
    const from = frame("a", [el("card", { fills: [solid("#000000")] })]);
    const to = frame("b", [el("card2", { name: "card", fills: [solid("#000000"), solid("#FF0000")] })]);

    // At the start the second fill is present but invisible; by the end it is
    // the layer the author drew.
    expect(at(from, to, 0).fills?.[1]).toMatchObject({ color: "#FF0000", opacity: 0 });
    expect(at(from, to, 0.5).fills?.[1]).toMatchObject({ opacity: 0.5 });
    expect(at(from, to, 1).fills?.[1]).toMatchObject({ color: "#FF0000" });
  });

  it("dissolves a fill it cannot merge, under the one replacing it", () => {
    // A solid and a gradient have no field in common, so the pair cross-fades:
    // two layers at the same slot, the outgoing fading out below.
    const from = frame("a", [el("card", { fills: [solid("#FF0000")] })]);
    const to = frame("b", [
      el("card2", {
        name: "card",
        fills: [{ type: "linear-gradient", from: "#000000", to: "#FFFFFF", angle: 0 }]
      })
    ]);
    const mid = at(from, to, 0.5).fills!;
    expect(mid).toHaveLength(2);
    expect(mid[0]).toMatchObject({ type: "solid", opacity: 0.5 });
    expect(mid[1]).toMatchObject({ type: "linear-gradient", opacity: 0.5 });
  });

  it("cross-fades two different bitmaps and interpolates one that stays", () => {
    const photo = (assetId: string, scale: number): Paint => ({
      type: "image",
      assetId,
      fit: "crop",
      crop: { x: 0, y: 0, scale, rotation: 0 }
    });
    const same = [el("pic", { fills: [photo("asset_1", 1)] })];
    const zoomed = [el("pic2", { name: "pic", fills: [photo("asset_1", 2)] })];
    const mid = at(frame("a", same), frame("b", zoomed), 0.5).fills?.[0] as Extract<Paint, { type: "image" }>;
    expect(mid.crop?.scale).toBeCloseTo(1.5);
    expect(mid.assetId).toBe("asset_1");

    const other = [el("pic3", { name: "pic", fills: [photo("asset_2", 1)] })];
    expect(at(frame("c", same), frame("d", other), 0.5).fills).toHaveLength(2);
  });
});

describe("a morph carries the stroke", () => {
  it("grows an edge in from nothing rather than drawing it at full weight", () => {
    const from = frame("a", [el("card")]);
    const to = frame("b", [el("card2", { name: "card", strokes: [{ width: 4, color: "#000000" }] })]);
    expect(at(from, to, 0).strokes?.[0].width).toBe(0);
    expect(at(from, to, 0.5).strokes?.[0].width).toBe(2);
  });

  it("melts the colour and the weight of an edge both slides draw", () => {
    const from = frame("a", [el("card", { strokes: [{ width: 1, color: "#000000" }] })]);
    const to = frame("b", [el("card2", { name: "card", strokes: [{ width: 5, color: "#FFFFFF" }] })]);
    const mid = at(from, to, 0.5).strokes?.[0];
    expect(mid?.width).toBe(3);
    expect(mid?.color).toBe("rgba(128, 128, 128, 1)");
  });
});

describe("a morph carries the type", () => {
  const text = (id: string, name: string, style: Partial<TextStyle>): DesignElement =>
    el(id, {
      type: "text",
      name,
      content: "Hello",
      style: { fontFamily: "Inter", fontSize: 16, ...style }
    } as Partial<DesignElement>);

  it("grows the glyphs with the box", () => {
    const from = frame("a", [text("t", "title", { fontSize: 16, lineHeight: 1.2 })]);
    const to = frame("b", [text("t2", "title", { fontSize: 32, lineHeight: 1.6 })]);
    const mid = at(from, to, 0.5);
    expect(mid.style?.fontSize).toBe(24);
    expect(mid.style?.lineHeight).toBeCloseTo(1.4);
  });

  it("interpolates tracking in its own unit, and leaves a unit change alone", () => {
    const from = frame("a", [text("t", "label", { fontSize: 12, letterSpacing: "0.05em" })]);
    const to = frame("b", [text("t2", "label", { fontSize: 12, letterSpacing: "0.15em" })]);
    expect(at(from, to, 0.5).style?.letterSpacing).toBe("0.1em");

    // px and em are two units: there is no halfway, so the target's stands.
    const px = frame("c", [text("t3", "label", { letterSpacing: "2px" })]);
    expect(at(from, px, 0.5).style?.letterSpacing).toBe("2px");
  });

  it("keeps the family and the weight, which have no halfway", () => {
    const from = frame("a", [text("t", "title", { fontFamily: "Inter", fontWeight: 400 })]);
    const to = frame("b", [text("t2", "title", { fontFamily: "Lora", fontWeight: 700 })]);
    const mid = at(from, to, 0.5);
    expect(mid.style?.fontFamily).toBe("Lora");
    expect(mid.style?.fontWeight).toBe(700);
  });

  /**
   * A run's size is ABSOLUTE px written over the paragraph's, so a size that
   * stood still while the box travelled put the incoming run into the outgoing
   * box at its final size: a one-line headline wrapped into three and unwrapped
   * again on the way out.
   */
  describe("the runs that override the paragraph", () => {
    const rich = (id: string, name: string, size: number | undefined, track?: string, color?: string): DesignElement =>
      el(id, {
        type: "text",
        name,
        content: "Hello world",
        width: 400,
        // The paragraph's own size is what a run inherits; the run's override is
        // the absolute px the animation used to leave standing.
        style: { fontFamily: "Inter", fontSize: size ?? 16 },
        spans: [
          { text: "Hello ", style: { fontSize: size, letterSpacing: track as any, color } },
          { text: "world", style: { fontSize: size, letterSpacing: track as any, color } }
        ]
      } as Partial<DesignElement>);

    it("grows a run's own size with the box", () => {
      const mid = at(frame("a", [rich("t", "title", 16)]), frame("b", [rich("t2", "title", 32)]), 0.5);
      expect(mid.spans?.map((s: any) => s.style?.fontSize)).toEqual([24, 24]);
      expect(mid.spans?.map((s: any) => s.text)).toEqual(["Hello ", "world"]);
    });

    it("counts an inherited size as the size the run was set in", () => {
      // The run says nothing, so it was painted at the paragraph's — that is the
      // number it has to travel from, not the target's own size.
      const mid = at(frame("a", [rich("t", "title", undefined)]), frame("b", [rich("t2", "title", 32)]), 0.5);
      expect(mid.spans?.map((s: any) => s.style?.fontSize)).toEqual([24, 24]);
    });

    it("carries the run's tracking and colour, and leaves a unit change alone", () => {
      const wide = at(
        frame("a", [rich("t", "title", 16, "0.05em", "#000000")]),
        frame("b", [rich("t2", "title", 16, "0.15em", "#FFFFFF")]),
        0.5
      );
      expect(wide.spans?.[0].style?.letterSpacing).toBe("0.1em");
      expect(wide.spans?.[0].style?.color).toBe("rgba(128, 128, 128, 1)");

      const px = at(frame("c", [rich("t", "title", 16, "2px")]), frame("d", [rich("t2", "title", 16, "0.15em")]), 0.5);
      expect(px.spans?.[0].style?.letterSpacing).toBe("0.15em");
    });

    it("leaves a plain text without spans alone", () => {
      const total = at(frame("a", [text("t", "title", {})]), frame("b", [text("t2", "title", {})]), 0.5);
      expect(total.spans).toBeUndefined();
    });
  });

  it("slides a run along its path", () => {
    const run = (id: string, name: string, startOffset: number): DesignElement =>
      el(id, {
        type: "text",
        name,
        content: "Around",
        style: { fontFamily: "Inter", fontSize: 16 },
        onPath: { pathId: "curve", startOffset }
      } as Partial<DesignElement>);
    expect(at(frame("a", [run("t", "cap", 0)]), frame("b", [run("t2", "cap", 100)]), 0.5).onPath?.startOffset).toBe(50);
  });
});

describe("a morph carries the colour filter", () => {
  it("fades a filter in from neutral, not from zero", () => {
    // `brightness` neutral is 1. Reading an absent axis as 0 would pass the
    // layer through a black frame on its way in.
    const from = frame("a", [el("pic")]);
    const to = frame("b", [el("pic2", { name: "pic", adjust: { brightness: 2, saturation: 0.5 } })]);
    const mid = at(from, to, 0.5).adjust;
    expect(mid?.brightness).toBeCloseTo(1.5);
    expect(mid?.saturation).toBeCloseTo(0.75);
  });
});
