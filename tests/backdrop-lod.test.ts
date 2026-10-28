import { describe, it, expect } from "vitest";
import {
  applyBackdropLod,
  paintsBackdrop,
  clipMaskFits,
  MIN_BACKDROP_SCREEN_PX,
  MAX_DEVICE_TEXTURE_PX,
  MAX_BACKDROP_DEVICE_AREA,
  BACKDROP_CHAIN_ATTR,
  CLIP_CHAIN_ATTR,
  CLIP_SPAN_ATTR
} from "../src/ui/canvas/backdrop-lod";

// There is no DOM in this runner, and the pass only ever asks an element for
// five things: its parent's width/height, its own authored attribute, its inline
// style, and the clipping ancestors above it. A stub with those five is enough
// to test the decision, and the real DOM behaviour is asserted in a browser by
// `tests/e2e/clip-at-zoom.spec.mjs`.
function fakeClipGroup(clipUrl: string, span: string) {
  const attrs: Record<string, string> = {
    "clip-path": clipUrl,
    [CLIP_CHAIN_ATTR]: clipUrl,
    [CLIP_SPAN_ATTR]: span
  };
  return {
    tag: "g",
    parentElement: null as any,
    getAttribute: (n: string) => attrs[n] ?? null,
    setAttribute: (n: string, v: string) => {
      attrs[n] = v;
    }
  };
}

function fakeDiv(chain: string | null, width: string | null, height: string | null, clip: any = null) {
  // Starts in the state the renderer leaves it in: the inline property already
  // carries the authored chain. Starting empty would make every element read as
  // "not painted" and quietly turn the restore path into a no-op.
  const style: Record<string, any> = {};
  if (chain) style.backdropFilter = chain;
  style.setProperty = (k: string, v: string) => { style[k] = v; };
  return {
    tag: "div",
    parentElement: { getAttribute: (n: string) => (n === "width" ? width : n === "height" ? height : null) },
    getAttribute: (n: string) => (n === BACKDROP_CHAIN_ATTR ? chain : null),
    closest: (sel: string) => (sel === `[${CLIP_CHAIN_ATTR}]` ? clip : null),
    style
  };
}

const rootOf = (divs: any[]) => ({ querySelectorAll: () => divs });

describe("a backdrop is painted only when it is big enough to read", () => {
  it("is off below the floor on the SHORT edge", () => {
    // 40 document px at 0.1 is 4 screen px; the floor is 8.
    expect(paintsBackdrop(40, 40, 0.1)).toBe(false);
  });

  it("is on at the floor and above it", () => {
    expect(paintsBackdrop(40, 40, 0.1 * (MIN_BACKDROP_SCREEN_PX / 4))).toBe(true);
    expect(paintsBackdrop(40, 40, 0.5)).toBe(true);
  });

  it("measures the short edge, so a long sliver drops too", () => {
    // 1000 x 3 document px at 1:1 is a 3px-tall bar and has no blur in it.
    expect(paintsBackdrop(1000, 3, 1)).toBe(false);
  });

  it("steps down when the device-pixel area exceeds Chromium's RenderSurface ceiling", () => {
    // 171 x 70 at zoom=18 -> 3078 x 1260 = 3,878,280 > MAX_BACKDROP_DEVICE_AREA (2,000,000),
    // even though neither edge exceeds MAX_DEVICE_TEXTURE_PX (7,680).
    expect(171 * 18).toBeLessThan(MAX_DEVICE_TEXTURE_PX);
    expect(171 * 70 * 18 * 18).toBeGreaterThan(MAX_BACKDROP_DEVICE_AREA);
    expect(paintsBackdrop(171, 70, 18)).toBe(false);
    expect(paintsBackdrop(171, 70, 12)).toBe(true);
  });
});

describe("the pass disables and restores in place", () => {
  it("writes none below the floor, on the element it decides about", () => {
    const d = fakeDiv("blur(12px)", "40", "40");
    applyBackdropLod(rootOf([d]) as any, 0.1);
    expect(d.style.backdropFilter).toBe("none");
    expect(d.style["-webkit-backdrop-filter"]).toBe("none");
  });

  it("puts the authored chain back above it", () => {
    const d = fakeDiv("blur(12px) url(#lg)", "40", "40");
    applyBackdropLod(rootOf([d]) as any, 1);
    expect(d.style.backdropFilter).toBe("blur(12px) url(#lg)");
  });

  it("decides per element, not per viewport", () => {
    const chip = fakeDiv("blur(12px)", "40", "40");
    const panel = fakeDiv("blur(12px)", "160", "160");
    applyBackdropLod(rootOf([chip, panel]) as any, 0.1);
    expect(chip.style.backdropFilter).toBe("none");
    expect(panel.style.backdropFilter).toBe("blur(12px)");
  });

  it("leaves a backdrop alone when its box cannot be read", () => {
    // Painting one blur too many is a cost; dropping one is a bug, so "no
    // opinion" has to mean "keep it".
    const d = fakeDiv("blur(12px)", null, "40");
    applyBackdropLod(rootOf([d]) as any, 0.01);
    expect(d.style.backdropFilter).toBe("blur(12px)");
  });

  it("does not rewrite a value that is already right", () => {
    const d = fakeDiv("blur(12px)", "40", "40");
    applyBackdropLod(rootOf([d]) as any, 0.1);
    d.style.setProperty = () => { throw new Error("touched an unchanged element"); };
    applyBackdropLod(rootOf([d]) as any, 0.1);
    expect(d.style.backdropFilter).toBe("none");
  });
});

describe("clipping is the document's, the blur is the viewport's", () => {
  // The ceiling is in DEVICE px, and this runner has no window, so the scale the
  // browser would supply is stood up explicitly rather than left at 1.
  const withScale = (dpr: number, body: () => void) => {
    const g = globalThis as any;
    const prev = g.window;
    g.window = { devicePixelRatio: dpr };
    try {
      body();
    } finally {
      g.window = prev;
    }
  };

  it("never touches the container's clip-path, however far in it is zoomed", () => {
    withScale(2, () => {
      const g = fakeClipGroup("url(#clip_screen_cover)", "844");
      const d = fakeDiv("blur(12px)", "160", "160", g);
      applyBackdropLod(rootOf([d]) as any, 40);
      expect(g.getAttribute("clip-path")).toBe("url(#clip_screen_cover)");
      applyBackdropLod(rootOf([d]) as any, 0.5);
      expect(g.getAttribute("clip-path")).toBe("url(#clip_screen_cover)");
    });
  });

  it("drops the blur instead, once the mask above it is over the texture ceiling", () => {
    withScale(2, () => {
      // 844 document px at dpr 2 crosses 7,680 at zoom 4.55.
      expect(clipMaskFits(844, 4)).toBe(true);
      expect(clipMaskFits(844, 6)).toBe(false);
      const g = fakeClipGroup("url(#clip_screen_cover)", "844");
      // 40 x 40 at dpr 2 is well inside every per-element ceiling: the only
      // reason this blur can go is the mask above it.
      const d = fakeDiv("blur(12px)", "40", "40", g);
      applyBackdropLod(rootOf([d]) as any, 6);
      expect(d.style.backdropFilter).toBe("none");
      // …and comes back when the mask fits again, because the mark survives.
      applyBackdropLod(rootOf([d]) as any, 4);
      expect(d.style.backdropFilter).toBe("blur(12px)");
    });
  });

  it("leaves a backdrop outside any clip alone at the same zoom", () => {
    withScale(2, () => {
      const d = fakeDiv("blur(12px)", "40", "40", null);
      applyBackdropLod(rootOf([d]) as any, 6);
      expect(d.style.backdropFilter).toBe("blur(12px)");
    });
  });

  it("reads an unreadable span as one that fits", () => {
    withScale(2, () => {
      const g = fakeClipGroup("url(#clip_x)", "not a number");
      const d = fakeDiv("blur(12px)", "40", "40", g);
      applyBackdropLod(rootOf([d]) as any, 14);
      expect(d.style.backdropFilter).toBe("blur(12px)");
    });
  });
});

/**
 * The stub above is built with the attribute `applyBackdropLod` already looks
 * for, so it cannot see whether the renderer ever writes it — and nothing links
 * a JSX attribute to a querySelector string at compile time. That link is
 * asserted in a real browser by `tests/e2e/effect-lod.spec.mjs`, which reads the
 * mark off a rendered node and checks the backdrop comes and goes with the zoom.
 *
 * This file used to grep `data-backdrop-chain={backdropFilterCss}` out of both
 * emitters instead, which pinned a local variable name rather than the
 * behaviour, and passed unchanged if the pass queried an attribute nobody wrote.
 */
