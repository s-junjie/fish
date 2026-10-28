/**
 * A Figma Slides transition, staying on the slide that carries it.
 *
 * Two things are worth testing separately, and they fail apart: the STYLE mapping
 * (five FISH transitions against twenty-three Figma ones, and the directions are
 * spelled into Figma's names), and the HAND-OFF — both Figma and the DSL hang the
 * animation on the slide it leaves, so the spec must not be shifted by one.
 */

import { describe, expect, it } from "vitest";
import { mapFigmaSlideTransition } from "../src/core/import/figma-slide";
import { importFigmaFile } from "../src/core/import/figma-import";
import type { DesignElement, SlideSpec } from "../src/core/dsl/types";

const map = (transition: Record<string, unknown> | undefined) => mapFigmaSlideTransition(transition);
const specOf = (transition: Record<string, unknown> | undefined): SlideSpec | undefined => map(transition).spec;
const gapsOf = (transition: Record<string, unknown> | undefined): string[] => map(transition).gaps.map((g) => g.property);

/** `slide` lives on the container types, and `Page.children` is the broad union. */
const slideOf = (el: DesignElement) => (el as unknown as { slide?: SlideSpec }).slide;

describe("a Figma style lands on one of FISH's five", () => {
  it("maps the three that are exact, and keeps the curve and the duration", () => {
    expect(specOf({ style: "DISSOLVE", duration: 0.6, curve: "EASE_IN_AND_OUT" })).toEqual({
      transition: "dissolve",
      durationMs: 600,
      easing: "ease-in-out"
    });
    expect(specOf({ style: "SMART_ANIMATE", duration: 1.2 })).toEqual({ transition: "morph", durationMs: 1200 });
    expect(specOf({ style: "PUSH_FROM_LEFT", duration: 0.3 })).toEqual({
      transition: "push",
      durationMs: 300,
      direction: "left"
    });
    for (const style of ["DISSOLVE", "SMART_ANIMATE", "PUSH_FROM_LEFT"]) {
      expect(gapsOf({ style })).toEqual([]);
    }
  });

  it("reads Figma's move-in as FISH's slide, which is the same movement", () => {
    // "moves the next slide into view, above the previous slide" — the arriving
    // frame moves and the one it replaces stays, which is `slide` to the letter.
    expect(specOf({ style: "MOVE_FROM_BOTTOM" })).toEqual({ transition: "slide", direction: "down" });
    expect(gapsOf({ style: "MOVE_FROM_BOTTOM" })).toEqual([]);
  });

  it("names the two families FISH cannot say exactly", () => {
    // Figma's slide-in also FADES the slide it replaces; FISH's leaves it standing.
    expect(specOf({ style: "SLIDE_FROM_TOP" })).toEqual({ transition: "slide", direction: "up" });
    expect(gapsOf({ style: "SLIDE_FROM_TOP" })).toEqual(["slide:style:SLIDE_FROM_TOP"]);

    // The out families move the DEPARTING frame and leave the arriving one still.
    // FISH has no such mode, so it arrives as a push and both move — and because
    // `direction` names where the arriving frame comes from, the edge mirrors:
    // a slide leaving to the left means the next one comes from the right.
    expect(specOf({ style: "SLIDE_OUT_TO_LEFT" })).toEqual({ transition: "push", direction: "right" });
    expect(specOf({ style: "MOVE_OUT_TO_TOP" })).toEqual({ transition: "push", direction: "down" });
    expect(gapsOf({ style: "SLIDE_OUT_TO_LEFT" })).toEqual(["slide:style:SLIDE_OUT_TO_LEFT"]);
  });

  it("reads every direction Figma spells into the name", () => {
    const directions = { LEFT: "left", RIGHT: "right", TOP: "up", BOTTOM: "down" } as const;
    for (const [edge, direction] of Object.entries(directions)) {
      expect(specOf({ style: `PUSH_FROM_${edge}` })?.direction).toBe(direction);
      expect(specOf({ style: `MOVE_FROM_${edge}` })?.direction).toBe(direction);
    }
  });

  it("takes the four curves it has and names the other four it does not", () => {
    for (const [curve, easing] of [
      ["LINEAR", "linear"],
      ["EASE_IN", "ease-in"],
      ["EASE_OUT", "ease-out"],
      ["EASE_IN_AND_OUT", "ease-in-out"]
    ] as const) {
      expect(specOf({ style: "DISSOLVE", curve })).toEqual({ transition: "dissolve", easing });
      expect(gapsOf({ style: "DISSOLVE", curve })).toEqual([]);
    }
    expect(specOf({ style: "DISSOLVE", curve: "BOUNCY" })?.easing).toBe("ease-out");
    expect(gapsOf({ style: "DISSOLVE", curve: "BOUNCY" })).toEqual(["slide:curve:BOUNCY"]);
  });

  it("leaves a deck that sets nothing alone, and names what has nowhere to go", () => {
    expect(specOf({ style: "NONE", duration: 0.3, curve: "EASE_IN", timing: { type: "ON_CLICK" } })).toBeUndefined();
    expect(specOf(undefined)).toBeUndefined();
    expect(gapsOf(undefined)).toEqual([]);

    expect(gapsOf({ style: "NONE", timing: { type: "AFTER_DELAY", delay: 5 } })).toEqual(["slide:timing:AFTER_DELAY"]);
    expect(gapsOf({ style: "SOME_FUTURE_STYLE" })).toEqual(["slide:style:SOME_FUTURE_STYLE"]);
  });

  it("clamps a duration past what FISH will play, rather than refusing the slide", () => {
    // Figma's own ceiling is ten seconds and so is FISH's, so this is only reachable
    // through an out-of-range value from the API — and a number out of range is
    // content, not a reason to lose the transition.
    expect(specOf({ style: "DISSOLVE", duration: 12 })?.durationMs).toBe(10000);
    expect(specOf({ style: "DISSOLVE", duration: 0 })?.durationMs).toBeUndefined();
    expect(specOf({ style: "DISSOLVE", duration: Number.NaN })?.durationMs).toBeUndefined();
  });
});

/** A deck as the plugin exports one: SLIDE nodes, in presentation order. */
const slide = (id: string, name: string, transition?: Record<string, unknown>) => ({
  id,
  name,
  type: "SLIDE",
  absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
  size: { x: 1920, y: 1080 },
  fills: [],
  children: [],
  ...(transition ? { slideTransition: transition } : {})
});

const importDeck = (slides: unknown[]) =>
  importFigmaFile({
    document: {
      id: "0:0",
      name: "Deck",
      type: "DOCUMENT",
      children: [{ id: "0:1", name: "Page", type: "CANVAS", children: slides }]
    }
  } as never);

describe("a transition stays on the slide that leaves", () => {
  it("keeps each slide's spec on that same slide", async () => {
    // Figma: "the transition between the current slide and the next slide". FISH
    // now uses the same attachment, so slide 1's spec stays on frame 1.
    const result = await importDeck([
      slide("1:1", "One", { style: "DISSOLVE", duration: 0.4 }),
      slide("1:2", "Two", { style: "MOVE_FROM_LEFT" }),
      slide("1:3", "Three")
    ]);
    const frames = result.pages[0].children;

    expect(slideOf(frames[0])).toEqual({ transition: "dissolve", durationMs: 400 });
    expect(slideOf(frames[1])).toEqual({ transition: "slide", direction: "left" });
    expect(slideOf(frames[2])).toBeUndefined();
  });

  it("keeps the last slide's transition too, for a slide that may follow later", async () => {
    const result = await importDeck([
      slide("1:1", "One"),
      slide("1:2", "Two", { style: "PUSH_FROM_TOP" })
    ]);
    const frames = result.pages[0].children;
    expect(slideOf(frames[1])).toEqual({ transition: "push", direction: "up" });
    expect(result.report.unmapped.filter((g) => g.property.startsWith("slide:transition"))).toEqual([]);
  });

  it("carries the approximations into the report, against the slide that asked", async () => {
    const result = await importDeck([
      slide("1:1", "One", { style: "SLIDE_FROM_LEFT", curve: "QUICK", timing: { type: "AFTER_DELAY", delay: 3 } }),
      slide("1:2", "Two")
    ]);
    const properties = result.report.unmapped.map((g) => g.property);
    expect(properties).toContain("slide:style:SLIDE_FROM_LEFT");
    expect(properties).toContain("slide:curve:QUICK");
    expect(properties).toContain("slide:timing:AFTER_DELAY");
    expect(slideOf(result.pages[0].children[0])).toEqual({ transition: "slide", direction: "left", easing: "ease-out" });
  });

  it("says nothing about a deck whose slides set no transitions", async () => {
    const result = await importDeck([slide("1:1", "One"), slide("1:2", "Two")]);
    expect(result.pages[0].children.map(slideOf)).toEqual([undefined, undefined]);
    expect(result.report.unmapped.filter((g) => g.property.startsWith("slide:"))).toEqual([]);
  });
});
