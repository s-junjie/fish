import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { matchSlides } from "../src/core/presentation/morph";
import { morphSlide, slidePaint, enterShift, leaveShift } from "../src/core/presentation/animate";
import { createSlideClock, easeAt, resolveSlide, resolveStep, reverseDirection, DEFAULT_SLIDE_MS } from "../src/core/presentation/slide";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignElement } from "../src/core/dsl/types";

const el = (id: string, extra: Partial<DesignElement> = {}): DesignElement =>
  ({
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...extra
  }) as DesignElement;

const frame = (id: string, children: DesignElement[], extra: Partial<DesignElement> = {}): DesignElement =>
  el(id, { type: "frame", children, ...extra } as Partial<DesignElement>);

describe("matchSlides", () => {
  it("pairs layers that share a name", () => {
    const from = frame("a", [el("title"), el("card")]);
    const to = frame("b", [el("title", { x: 100 }), el("card", { y: 50 })]);
    const { pairs, exits, enters } = matchSlides(from, to);
    expect(pairs.map((p) => p.name)).toEqual(["title", "card"]);
    expect(exits).toEqual([]);
    expect(enters).toEqual([]);
  });

  it("keeps the two halves' own boxes, local to their slide", () => {
    // The overlay adds each slide's own x/y; a matcher that baked a world
    // origin in would have to know where a slide sits to be testable at all.
    const from = frame("a", [el("title", { x: 10, y: 20 })]);
    const to = frame("b", [el("title", { x: 30, y: 40 })]);
    const [pair] = matchSlides(from, to).pairs;
    expect(pair.from).toEqual({ x: 10, y: 20, width: 10, height: 10 });
    expect(pair.to).toEqual({ x: 30, y: 40, width: 10, height: 10 });
  });

  it("pairs a name across a type change, which is the reshape the feature is for", () => {
    // A rect that becomes an ellipse is one layer the author re-drew: the box
    // and the alpha travel, so the type may not be part of the identity.
    const from = frame("a", [el("blob", { width: 40, height: 40, opacity: 0.4 })]);
    const to = frame("b", [
      el("blob2", { name: "blob", type: "ellipse", x: 100, y: 60, width: 120, height: 120 } as Partial<DesignElement>)
    ]);
    const { pairs, exits, enters } = matchSlides(from, to);
    expect(exits).toEqual([]);
    expect(enters).toEqual([]);
    const [pair] = pairs;
    expect(pair.name).toBe("blob");
    expect(pair.from).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(pair.to).toEqual({ x: 100, y: 60, width: 120, height: 120 });
    // Both alphas resolved, so the pair can interpolate one it does not share.
    expect([pair.fromOpacity, pair.toOpacity]).toEqual([0.4, 1]);
  });

  it("reads a name with its ends trimmed and otherwise as written", () => {
    const from = frame("a", [el("h", { name: " Hero " })]);
    const to = frame("b", [el("h2", { name: "Hero" }), el("h3", { name: "hero" })]);
    // Trimmed matches; case is the author's, and `hero` is a different layer.
    const { pairs, enters } = matchSlides(from, to);
    expect(pairs.map((p) => p.toId)).toEqual(["h2"]);
    expect(enters.map((e) => e.id)).toEqual(["h3"]);
  });

  it("fades the children of a container whose name became a leaf", () => {
    // The pair's two halves need not be the same kind, so the walk descends into
    // whichever side is a container — a group that becomes a rect has children
    // that can only leave, and dropping them without a trace is a pop.
    const from = frame("a", [frame("box", [el("kid")], { name: "Box" })]);
    const to = frame("b", [el("box2", { name: "Box" })]);
    const { pairs, exits, enters } = matchSlides(from, to);
    expect(pairs.map((p) => p.name)).toEqual(["Box"]);
    expect(exits.map((e) => e.id)).toEqual(["kid"]);
    expect(enters).toEqual([]);
  });

  it("fades the children of a leaf whose name became a container", () => {
    const from = frame("a", [el("box", { name: "Box" })]);
    const to = frame("b", [frame("box2", [el("kid")], { name: "Box" })]);
    const { pairs, exits, enters } = matchSlides(from, to);
    expect(pairs.map((p) => p.name)).toEqual(["Box"]);
    expect(enters.map((e) => e.id)).toEqual(["kid"]);
    expect(exits).toEqual([]);
  });

  it("gives an unnamed layer no identity to carry", () => {
    const from = frame("a", [el("l1", { name: undefined })]);
    const to = frame("b", [el("l2", { name: undefined })]);
    const { pairs, exits, enters } = matchSlides(from, to);
    expect(pairs).toEqual([]);
    expect(exits).toHaveLength(1);
    expect(enters).toHaveLength(1);
  });

  it("pairs duplicate names in document order and leaves the odd one out", () => {
    const from = frame("a", [el("l1", { name: "Card" }), el("l2", { name: "Card" })]);
    const to = frame("b", [el("m1", { name: "Card" })]);
    const { pairs, exits } = matchSlides(from, to);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fromId).toBe("l1");
    expect(exits.map((e) => e.id)).toEqual(["l2"]);
  });

  it("does not pair internal elements of a frame that is already paired", () => {
    // When a container already has a pair between two slides, its internal elements
    // do not pair anymore — the frame transitions as a single unified container.
    const from = frame("a", [frame("panel", [el("dot", { x: 8, y: 6 })], { x: 48, y: 320 })]);
    const to = frame("b", [frame("panel", [el("dot", { x: 40, y: 84 })], { x: 496, y: 130 })]);
    const { pairs } = matchSlides(from, to);
    expect(pairs.map((p) => p.name)).toEqual(["panel"]);
    expect(pairs[0].from).toEqual({ x: 48, y: 320, width: 10, height: 10 });
    expect(pairs[0].to).toEqual({ x: 496, y: 130, width: 10, height: 10 });
  });

  it("does not pair children of an unmatched container, and only pairs the container itself when matched", () => {
    const from = frame("a", [frame("box", [el("dot")])]);
    const to = frame("b", [frame("carton", [el("dot")])]);
    const { pairs } = matchSlides(from, to);
    expect(pairs).toEqual([]);

    const matched = matchSlides(from, frame("b2", [frame("box", [el("dot", { x: 5 })])]));
    expect(matched.pairs.map((p) => p.name)).toEqual(["box"]);
    expect(matched.pairs.map((p) => p.depth)).toEqual([0]);
  });

  it("ignores hidden layers on both sides", () => {
    // A layer that does not paint has nothing to fade and nothing to become.
    const from = frame("a", [el("ghost", { visible: false })]);
    const to = frame("b", [el("ghost", { visible: false })]);
    const { pairs, exits, enters } = matchSlides(from, to);
    expect(pairs).toEqual([]);
    expect(exits).toEqual([]);
    expect(enters).toEqual([]);
  });

  it("has nothing to say about a slide that is not a container", () => {
    const { pairs } = matchSlides(el("r1"), el("r2"));
    expect(pairs).toEqual([]);
  });

  it("reports where a leaving layer sat, so it can be put back there", () => {
    const from = frame("a", [
      el("bg", { name: "Bg" }),
      frame("panel", [el("gone", { name: "Gone" })], { name: "Panel" }),
      el("foot", { name: "Foot" })
    ]);
    const to = frame("b", [frame("panel2", [], { name: "Panel" })]);
    const { exits } = matchSlides(from, to);
    const at = (id: string) => exits.find((e) => e.id === id)!;
    // A top-level exit belongs to the slide, and a nested one to the container
    // that clipped it — not to the slide, which is where lifting it put it.
    expect(at("bg").parentId).toBeNull();
    expect(at("bg").order).toBe(0);
    expect(at("foot").order).toBe(2);
    expect(at("gone").parentId).toBe("panel");
    expect(at("gone").order).toBe(0);
  });
});

describe("resolveSlide", () => {
  it("reads a cut as zero, whatever duration it carries", () => {
    expect(resolveSlide({ transition: "none", durationMs: 900 }).durationMs).toBe(0);
    expect(resolveSlide(undefined).durationMs).toBe(0);
  });

  it("defaults a real transition to the deck's own scale", () => {
    // 600ms, not a workbench `duration` token: that scale exists for feedback
    // someone holds all day, and a deck is watched once.
    expect(resolveSlide({ transition: "morph" }).durationMs).toBe(DEFAULT_SLIDE_MS);
  });

  it("fills every axis so no consumer reads a different default", () => {
    expect(resolveSlide({})).toEqual({
      transition: "none",
      durationMs: 0,
      easing: "ease-in-out",
      direction: "right",
      reversed: false
    });
  });
});

describe("resolveStep", () => {
  it("mirrors the edges of a deck played backwards", () => {
    expect(reverseDirection("right")).toBe("left");
    expect(reverseDirection("left")).toBe("right");
    expect(reverseDirection("up")).toBe("down");
    expect(reverseDirection("down")).toBe("up");
  });

  it("reads the departing slide going forward", () => {
    const departing = { transition: "push" as const, direction: "right" as const };
    expect(resolveStep({ transition: "dissolve" as const }, departing, false)).toEqual({
      transition: "push",
      durationMs: DEFAULT_SLIDE_MS,
      easing: "ease-in-out",
      direction: "right",
      reversed: false
    });
  });

  it("replays the arriving slide's edge, mirrored, when stepping back", () => {
    // The edge 1 -> 2 is declared by slide 1. Returning over it must read that
    // declaration again — not slide 2's outgoing transition — and mirror it.
    const arriving = { transition: "push" as const, direction: "right" as const };
    const departing = { transition: "dissolve" as const };
    expect(resolveStep(arriving, departing, true)).toEqual({
      transition: "push",
      durationMs: DEFAULT_SLIDE_MS,
      easing: "ease-in-out",
      direction: "left",
      reversed: false
    });
  });

  it("moves the departing surface back out when a slide is replayed backwards", () => {
    // Forward holds the departing slide still and slides the next one over it.
    // Returning must keep that composition: the same surface leaves, rather than
    // the previous slide sliding in from the mirrored edge and covering it.
    const arriving = { transition: "slide" as const, direction: "left" as const };
    const resolved = resolveStep(arriving, { transition: "dissolve" as const }, true);
    expect(resolved.transition).toBe("slide");
    expect(resolved.direction).toBe("left");
    expect(resolved.reversed).toBe(true);
  });
});

describe("easeAt", () => {
  it("is pinned at both ends and monotonic between them", () => {
    for (const easing of ["linear", "ease-in", "ease-out", "ease-in-out"] as const) {
      expect(easeAt(easing, 0)).toBe(0);
      expect(easeAt(easing, 1)).toBe(1);
      let last = -1;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = easeAt(easing, t);
        expect(v).toBeGreaterThanOrEqual(last);
        last = v;
      }
    }
  });

  it("clamps rather than overshoots, so nothing lands outside its slide", () => {
    expect(easeAt("ease-in", -1)).toBe(0);
    expect(easeAt("ease-in", 2)).toBe(1);
  });
});

describe("createSlideClock", () => {
  it("runs, reports progress, and stops itself at the end", () => {
    const clock = createSlideClock();
    clock.begin(0, 600, "linear");
    expect(clock.active).toBe(true);
    expect(clock.advance(300)).toBeCloseTo(0.5);
    expect(clock.advance(600)).toBe(1);
    expect(clock.active).toBe(false);
  });

  it("never runs for a zero duration, which is what makes a cut and a finished transition one state", () => {
    const clock = createSlideClock();
    clock.begin(0, 0, "linear");
    expect(clock.active).toBe(false);
    expect(clock.advance(0)).toBe(1);
  });

  it("answers 1 while idle, so a player can ask before it has begun", () => {
    expect(createSlideClock().advance(500)).toBe(1);
  });

  it("lets a cancel land the transition instead of leaving it half-drawn", () => {
    const clock = createSlideClock();
    clock.begin(0, 600, "linear");
    clock.advance(100);
    clock.cancel();
    expect(clock.active).toBe(false);
    expect(clock.advance(200)).toBe(1);
  });
});

describe("morphSlide", () => {
  // Slides sit at different places on the canvas, so a layer's "where it was"
  // has to be re-expressed in the incoming slide's own coordinates.
  // The two slides sit 720px apart on the canvas. That distance is what each
  // slide's own fit cancels, so it must NOT appear in the start box — carrying it
  // over is what puts a travelling layer a slide-width off screen.
  const prev = frame("prev", [el("card", { x: 48, y: 210, width: 240, height: 96 })], { x: 80, y: 120 });
  const next = frame("next", [el("card2", { name: "card", x: 120, y: 130, width: 420, height: 180 })], { x: 800, y: 120 });
  const match = matchSlides(prev, next);

  it("leaves the slide untouched at rest", () => {
    expect(morphSlide(prev, next, match, 1)).toBe(next);
  });

  it("starts a matched layer where it stood WITHIN the outgoing slide", () => {
    const drawn = morphSlide(prev, next, match, 0) as { children: DesignElement[] };
    expect(drawn.children[0]).toMatchObject({ x: 48, y: 210, width: 240, height: 96 });
  });

  it("lands it on its own geometry", () => {
    const drawn = morphSlide(prev, next, match, 1) as { children: DesignElement[] };
    expect(drawn.children[0]).toMatchObject({ x: 120, y: 130, width: 420, height: 180 });
  });

  it("is halfway in between", () => {
    const drawn = morphSlide(prev, next, match, 0.5) as { children: DesignElement[] };
    expect(drawn.children[0].x).toBeCloseTo((48 + 120) / 2);
    expect(drawn.children[0].y).toBeCloseTo((210 + 130) / 2);
    expect(drawn.children[0].width).toBeCloseTo((240 + 420) / 2);
  });

  it("never starts a layer outside the slide it is landing in", () => {
    // The bug this guards: a start box that carried the 720px between the slides
    // put the layer at -672 — on screen only after it had flown in from nowhere.
    const drawn = morphSlide(prev, next, match, 0) as { children: DesignElement[] };
    expect(drawn.children[0].x).toBeGreaterThanOrEqual(0);
    expect(drawn.children[0].y).toBeGreaterThanOrEqual(0);
  });

  it("fades a layer that only arrives, and paints one that only leaves", () => {
    const from = frame("a", [el("gone", { name: "Gone" }), el("shared", { name: "Shared" })]);
    const to = frame("b", [el("shared2", { name: "Shared" }), el("fresh", { name: "Fresh" })]);
    const m = matchSlides(from, to);
    const drawn = morphSlide(from, to, m, 0) as { children: DesignElement[] };
    const gone = drawn.children.find((c) => c.id === "gone");
    const fresh = drawn.children.find((c) => c.id === "fresh");
    // The outgoing layer is INJECTED, because a match that only recorded its id
    // could describe a fade-out it cannot draw.
    expect(gone).toBeDefined();
    expect(gone!.opacity).toBe(1);
    expect(fresh!.opacity).toBe(0);
    const settled = morphSlide(from, to, m, 1) as { children: DesignElement[] };
    expect(settled.children.find((c) => c.id === "fresh")!.opacity).toBeUndefined();
  });

  it("paints a leaving layer where it stood, not on top of the slide", () => {
    // The bug this guards: appending every exit to the end of the list put a
    // full-bleed background over the whole incoming slide for the whole
    // transition, so the new slide arrived through a wash of the old one.
    const from = frame("a", [el("bg", { name: "Bg" }), el("shared", { name: "Shared" })]);
    const to = frame("b", [el("shared2", { name: "Shared" })]);
    const drawn = morphSlide(from, to, matchSlides(from, to), 0) as { children: DesignElement[] };
    expect(drawn.children.map((c) => c.id)).toEqual(["bg", "shared2"]);
  });

  it("keeps a nested exit inside the parent that clipped it", () => {
    const from = frame("a", [
      frame("panel", [el("gone", { name: "Gone", x: 8, y: 6 })], { name: "Panel", x: 100, y: 200 })
    ]);
    const to = frame("b", [frame("panel2", [el("fresh", { name: "Fresh" })], { name: "Panel", x: 20, y: 30 })]);
    const m = matchSlides(from, to);

    const drawn = morphSlide(from, to, m, 0.5) as { children: DesignElement[] };
    const panel = drawn.children.find((c) => c.id === "panel2") as { children: DesignElement[] };
    const gone = panel.children.find((c) => c.id === "gone");
    expect(gone).toBeDefined();
    // Rebased onto the panel's HALFWAY position, so the layer holds still in the
    // slide while the container travels under it: 60 + 48 = 108, the box it left.
    expect(gone!.x).toBeCloseTo(48);
    expect(gone!.y).toBeCloseTo(91);
  });

  it("draws the arriving shape, whatever the half it replaces was", () => {
    // A rect that becomes an ellipse arrives AS an ellipse: the box travels and
    // the layer the author drew on the slide it lands on is what paints.
    const from = frame("a", [el("blob")]);
    const to = frame("b", [el("blob2", { name: "blob", type: "ellipse" } as Partial<DesignElement>)]);
    const drawn = morphSlide(from, to, matchSlides(from, to), 0.5) as { children: DesignElement[] };
    expect(drawn.children[0].type).toBe("ellipse");
  });

  it("interpolates the alpha of a pair that changes it", () => {
    const from = frame("a", [el("blob", { opacity: 0.2 })]);
    const to = frame("b", [el("blob2", { name: "blob", opacity: 0.8 })]);
    const at = (p: number) =>
      (morphSlide(from, to, matchSlides(from, to), p) as { children: DesignElement[] }).children[0];
    expect(at(0).opacity).toBeCloseTo(0.2);
    expect(at(0.5).opacity).toBeCloseTo(0.5);
    expect(at(1).opacity).toBeCloseTo(0.8);
  });

  it("writes no alpha on a pair that agrees about one", () => {
    // The layer has to land as the author drew it, not carrying a redundant
    // `opacity: 1` that a renderer would have to write into its own output.
    const from = frame("a", [el("blob")]);
    const to = frame("b", [el("blob2", { name: "blob" })]);
    const drawn = morphSlide(from, to, matchSlides(from, to), 0.5) as { children: DesignElement[] };
    expect(drawn.children[0].opacity).toBeUndefined();
  });

  it("interpolates blur effects (layer-blur and backdrop-blur)", () => {
    const from = frame("a", [
      el("blob", { effects: [{ type: "layer-blur", blur: 10 }, { type: "backdrop-blur", blur: 4 }] })
    ]);
    const to = frame("b", [
      el("blob2", { name: "blob", effects: [{ type: "layer-blur", blur: 30 }, { type: "backdrop-blur", blur: 12 }] })
    ]);
    const at = (p: number) =>
      (morphSlide(from, to, matchSlides(from, to), p) as { children: DesignElement[] }).children[0];

    const mid = at(0.5);
    const layerBlur = mid.effects?.find((e) => e.type === "layer-blur") as { blur: number };
    const backdropBlur = mid.effects?.find((e) => e.type === "backdrop-blur") as { blur: number };
    expect(layerBlur.blur).toBeCloseTo(20);
    expect(backdropBlur.blur).toBeCloseTo(8);

    const start = at(0);
    expect((start.effects?.find((e) => e.type === "layer-blur") as { blur: number }).blur).toBeCloseTo(10);

    const noBlur = frame("a", [el("blob")]);
    const withBlur = frame("b", [el("blob2", { name: "blob", effects: [{ type: "layer-blur", blur: 20 }] })]);
    const midFromNone = (morphSlide(noBlur, withBlur, matchSlides(noBlur, withBlur), 0.5) as { children: DesignElement[] }).children[0];
    expect((midFromNone.effects?.find((e) => e.type === "layer-blur") as { blur: number }).blur).toBeCloseTo(10);
  });

  it("interpolates tear effect parameters and transitions between untorn and torn", () => {
    const from = frame("a", [
      el("card", {
        effects: [
          {
            type: "tear",
            profile: "torn",
            side: "bottom",
            scale: 100,
            seed: 42,
            at: 0.8,
            roughness: 0.2,
            fiber: 0.1
          }
        ]
      })
    ]);
    const to = frame("b", [
      el("card2", {
        name: "card",
        effects: [
          {
            type: "tear",
            profile: "torn",
            side: "bottom",
            scale: 200,
            seed: 42,
            at: 0.4,
            roughness: 0.8,
            fiber: 0.5
          }
        ]
      })
    ]);
    const at = (p: number) =>
      (morphSlide(from, to, matchSlides(from, to), p) as { children: DesignElement[] }).children[0];

    const mid = at(0.5);
    const tear = mid.effects?.find((e) => e.type === "tear") as any;
    expect(tear.scale).toBeCloseTo(150);
    expect(tear.at).toBeCloseTo(0.6);
    expect(tear.roughness).toBeCloseTo(0.5);
    expect(tear.fiber).toBeCloseTo(0.3);

    // Untorn to torn transition
    const untorn = frame("a", [el("card")]);
    const torn = frame("b", [
      el("card2", {
        name: "card",
        effects: [{ type: "tear", profile: "torn", side: "bottom", scale: 150, seed: 10, at: 0.5, fiber: 0.4, roughness: 0.6 }]
      })
    ]);
    const midTorn = (morphSlide(untorn, torn, matchSlides(untorn, torn), 0.5) as { children: DesignElement[] }).children[0];
    const midTear = midTorn.effects?.find((e) => e.type === "tear") as any;
    expect(midTear.scale).toBeCloseTo(75);
    expect(midTear.at).toBeCloseTo(0.75); // lerp(1, 0.5, 0.5) = 0.75
    expect(midTear.fiber).toBeCloseTo(0.2);
  });

  it("interpolates drop-shadow and cornerRadius/rotation", () => {
    const from = frame("a", [
      el("box", {
        cornerRadius: 4,
        rotation: 0,
        effects: [
          {
            type: "drop-shadow",
            offset: { x: 0, y: 4 },
            blur: 8,
            spread: 0,
            color: "#000000"
          }
        ]
      })
    ]);
    const to = frame("b", [
      el("box2", {
        name: "box",
        cornerRadius: 16,
        rotation: 90,
        effects: [
          {
            type: "drop-shadow",
            offset: { x: 10, y: 20 },
            blur: 24,
            spread: 4,
            color: "#000000"
          }
        ]
      })
    ]);
    const mid = (morphSlide(from, to, matchSlides(from, to), 0.5) as { children: DesignElement[] }).children[0];
    expect((mid as any).cornerRadius).toBeCloseTo(10);
    expect(mid.rotation).toBeCloseTo(45);
    const shadow = mid.effects?.find((e) => e.type === "drop-shadow") as any;
    expect(shadow.offset.x).toBeCloseTo(5);
    expect(shadow.offset.y).toBeCloseTo(12);
    expect(shadow.blur).toBeCloseTo(16);
    expect(shadow.spread).toBeCloseTo(2);
  });

  it("interpolates effects, cornerRadius and rotation on the root slide frame itself", () => {
    const from = {
      ...frame("frameA", []),
      cornerRadius: 0,
      rotation: 0
    };
    const to = {
      ...frame("frameB", []),
      cornerRadius: 32,
      rotation: 90,
      effects: [{ type: "layer-blur", blur: 40 }]
    };

    const mid = morphSlide(from as any, to as any, matchSlides(from as any, to as any), 0.5);
    expect((mid as any).cornerRadius).toBeCloseTo(16);
    expect(mid.rotation).toBeCloseTo(45);
    const blur = (mid.effects?.find((e) => e.type === "layer-blur") as { blur: number });
    expect(blur.blur).toBeCloseTo(20);

    // Reverse direction (B -> A)
    const rev = morphSlide(to as any, from as any, matchSlides(to as any, from as any), 0.5);
    expect((rev as any).cornerRadius).toBeCloseTo(16);
    expect(rev.rotation).toBeCloseTo(45);
    const revBlur = (rev.effects?.find((e) => e.type === "layer-blur") as { blur: number });
    expect(revBlur.blur).toBeCloseTo(20);
  });

  it("interpolates effects on child elements when geometry (x, y, w, h) does not change", () => {
    const cardA = el("cardA", {
      name: "HeroCard",
      x: 100,
      y: 100,
      width: 200,
      height: 200
    });
    const cardB = el("cardB", {
      name: "HeroCard",
      x: 100,
      y: 100,
      width: 200,
      height: 200,
      effects: [{ type: "layer-blur", blur: 30 }]
    });

    const frameA = frame("fa", [cardA]);
    const frameB = frame("fb", [cardB]);

    // Forward (A -> B)
    const forwardMid = (morphSlide(frameA, frameB, matchSlides(frameA, frameB), 0.5) as { children: DesignElement[] }).children[0];
    expect(forwardMid.x).toBe(100);
    expect(forwardMid.y).toBe(100);
    expect((forwardMid.effects?.find((e) => e.type === "layer-blur") as { blur: number }).blur).toBeCloseTo(15);

    // Reverse (B -> A)
    const revMid = (morphSlide(frameB, frameA, matchSlides(frameB, frameA), 0.5) as { children: DesignElement[] }).children[0];
    expect(revMid.x).toBe(100);
    expect(revMid.y).toBe(100);
    expect((revMid.effects?.find((e) => e.type === "layer-blur") as { blur: number }).blur).toBeCloseTo(15);
  });
});

describe("slidePaint", () => {
  it("cross-fades on a dissolve", () => {
    const paint = slidePaint("dissolve", "right", 0.25, 1000, 500);
    expect(paint.drawOutgoing).toBe(true);
    expect(paint.outOpacity).toBeCloseTo(0.75);
    expect(paint.inOpacity).toBeCloseTo(0.25);
  });

  it("walks both surfaces off opposite edges on a push", () => {
    const paint = slidePaint("push", "left", 0.5, 1000, 500);
    expect(paint.drawOutgoing).toBe(true);
    expect(paint.inShift.x).toBeCloseTo(-500);
    expect(paint.outShift.x).toBeCloseTo(500);
  });

  it("holds the outgoing surface still while the incoming one slides over it", () => {
    const paint = slidePaint("slide", "right", 0.5, 1000, 500);
    expect(paint.outShift).toEqual({ x: 0, y: 0 });
    expect(paint.inShift.x).toBeCloseTo(500);
    expect(paint.outAbove).toBe(false);
  });

  it("moves the outgoing surface back out, above a still arriving one, when reversed", () => {
    const paint = slidePaint("slide", "left", 0.5, 1000, 500, true);
    expect(paint.outShift.x).toBeCloseTo(-500);
    expect(paint.inShift).toEqual({ x: 0, y: 0 });
    expect(paint.outAbove).toBe(true);
  });

  it("paints no outgoing surface for a morph", () => {
    // Everything that leaves is inside the incoming tree by then; drawing the
    // outgoing slide too would show each travelling layer twice.
    expect(slidePaint("morph", "right", 0.5, 1000, 500).drawOutgoing).toBe(false);
    expect(slidePaint("none", "right", 0.5, 1000, 500).drawOutgoing).toBe(false);
  });

  it("puts a travelling surface back at 0 when it lands", () => {
    // `toBeCloseTo`, not `toEqual`: multiplying -500 by 0 gives -0, which is 0
    // to every renderer and a failed deep-equal to a test.
    expect(enterShift("up", 1, 1000, 500).x).toBeCloseTo(0);
    expect(enterShift("up", 1, 1000, 500).y).toBeCloseTo(0);
    expect(leaveShift("up", 0, 1000, 500).y).toBeCloseTo(0);
  });
});

describe("slide normalization", () => {
  const canvas = { width: 500, height: 500, unit: "px" as const, background: { type: "solid" as const, color: "#FFFFFF" } };
  const docWith = (elements: unknown[]) =>
    ({
      version: LATEST_DOCUMENT_VERSION,
      id: "t",
      name: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "p", name: "P", canvas, children: elements }],
      activePageId: "p",
      elements
    });

  const frameElement = (extra: Record<string, unknown>) => ({
    id: "f",
    type: "frame",
    name: "f",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    children: [],
    ...extra
  });

  it("keeps a transition written on a frame", () => {
    const { document, repairs } = normalizeDesignDocument(
      docWith([frameElement({ slide: { transition: "morph", durationMs: 800, easing: "ease-out" } })])
    );
    expect(repairs).toEqual([]);
    expect((getActivePage(document).children[0] as { slide?: unknown }).slide).toEqual({
      transition: "morph",
      durationMs: 800,
      easing: "ease-out"
    });
  });

  it("reads the snake_case and shorthand spellings an agent writes", () => {
    const { document } = normalizeDesignDocument(
      docWith([frameElement({ slide: { transition: "MORPH", duration_ms: 400 } })])
    );
    expect((getActivePage(document).children[0] as { slide?: any }).slide).toEqual({ transition: "morph", durationMs: 400 });
  });

  it("clamps an absurd duration instead of dropping it", () => {
    // An author who typed 60000 gets sixty seconds clamped, not a silent cut.
    const { document } = normalizeDesignDocument(docWith([frameElement({ slide: { transition: "push", durationMs: 60000 } })]));
    expect((getActivePage(document).children[0] as { slide?: any }).slide.durationMs).toBe(10000);
  });

  it("drops a word it does not know rather than guessing the nearest transition", () => {
    const { document } = normalizeDesignDocument(docWith([frameElement({ slide: { transition: "morphh" } })]));
    expect((getActivePage(document).children[0] as { slide?: unknown }).slide).toBeUndefined();
  });

  it("reports a slide written on something that cannot present", () => {
    // It looks authored and does nothing, which is worse than an unknown key
    // the author never sees.
    const { document, repairs } = normalizeDesignDocument(
      docWith([{ id: "r", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10, slide: { transition: "morph" } }])
    );
    expect((getActivePage(document).children[0] as { slide?: unknown }).slide).toBeUndefined();
    expect(repairs.some((r) => r.path.includes("slide"))).toBe(true);
  });

  it("leaves a deck that sets nothing byte-for-byte as it was", () => {
    const { document } = normalizeDesignDocument(docWith([frameElement({})]));
    expect("slide" in (getActivePage(document).children[0] as object)).toBe(false);
  });
});
