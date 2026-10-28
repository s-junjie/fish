import { afterAll, describe, expect, it, vi } from "vitest";
import { Fragment } from "preact";

// `isolate: false` means this registry outlives the file: without the unmock
// below, every later test sees `useMemo` run eagerly — which is fine for the
// defs these two files grade and wrong for the renderer everyone else mounts.
vi.mock("preact/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("preact/hooks")>();
  return {
    ...actual,
    useMemo: (fn: () => unknown) => fn()
  };
});

afterAll(() => {
  vi.unmock("preact/hooks");
});

import { CanvasDefs, ElementDefs, renderElementDefs } from "../src/ui/canvas/CanvasDefs";
import { shadowSilhouette } from "../src/ui/canvas/shadow-silhouette";
import { resolveSolidPaintBlend } from "../src/ui/canvas/SvgShapeNode";
import { Effect, DesignElement, Paint, RectElement } from "../src/core/dsl/types";


/**
 * A spread is drawn from the element's OUTLINE, not from `feMorphology`: the
 * primitive is capped in device pixels and costs O(radius) per pixel, and its
 * square kernel rounds nothing. The geometry is delivered as an `feImage` whose
 * rectangle IS the filter's — Chromium scales the image to fit the region — and
 * these assertions are the arithmetic of that contract.
 */
/**
 * The def markup, with the memo boundary taken out.
 *
 * `CanvasDefs` emits one `<ElementDefs>` per element so a drag re-renders only
 * the layer that moved; a test that wants to read the markup has to step
 * through that boundary itself.
 */
const defsMarkup = (node: any): any[] => {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(defsMarkup);
  if (node.type === ElementDefs) return defsMarkup(renderElementDefs(node.props));
  if (node.type === Fragment) return defsMarkup(node.props?.children);
  // A DOM element: keep it, and keep what it contains (a `<filter>` nests its
  // primitives as children).
  if (typeof node.type === "string") return [node, ...defsMarkup(node.props?.children)];
  return [node];
};

const svgOf = (uri: string) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));

function rect(extra: Partial<DesignElement>): DesignElement {
  return { id: "r1", type: "rect", x: 40, y: 30, width: 200, height: 60, ...extra } as DesignElement;
}

function primitivesOf(el: DesignElement) {
  const defs = CanvasDefs({ allElements: [el], selectedIds: new Set(), pixelScale: 8 }) as any;
  const filter = defsMarkup(defs).find((c: any) => c && c.type === "filter" && c.props?.id === "filter_r1");
  expect(filter).toBeTruthy();
  return { filter, children: (filter.props.children as any[]).flat(Infinity).filter(Boolean) };
}

const drop = (spread: number, extra: Partial<Effect> = {}): Effect =>
  ({ type: "drop-shadow", color: "#000000", offset: { x: 0, y: 10 }, blur: 10, spread, enabled: true, ...extra }) as Effect;

const inner = (spread: number): Effect =>
  ({ type: "inner-shadow", color: "#000000", offset: { x: 0, y: 10 }, blur: 10, spread, enabled: true }) as Effect;

describe("spread drawn from the element's outline", () => {
  it("emits an feImage instead of feMorphology, sized and placed like the filter", () => {
    const el = rect({ fills: [{ type: "solid", color: "#ffffff" }], effects: [drop(20)] });
    const { filter, children } = primitivesOf(el);
    const image = children.find((c: any) => c.type === "feImage");
    expect(image).toBeTruthy();
    expect(children.some((c: any) => c.type === "feMorphology")).toBe(false);

    // Chromium draws the image scaled to FIT the region, so the two rectangles
    // have to be the same one — region in the space the element's x/y live in.
    expect(filter.props.filterUnits).toBe("userSpaceOnUse");
    expect(image.props.x).toBe(filter.props.x);
    expect(image.props.y).toBe(filter.props.y);
    expect(image.props.width).toBe(filter.props.width);
    expect(image.props.height).toBe(filter.props.height);
    expect(filter.props.x).toBeLessThan(el.x as number);
    expect(filter.props.x + filter.props.width).toBeGreaterThan((el.x as number) + 200);
  });

  it("dilates with round joins, so the spread is the rounded offset CSS draws", () => {
    const el = rect({ fills: [{ type: "solid", color: "#ffffff" }], effects: [drop(20)] });
    const { children } = primitivesOf(el);
    const svg = svgOf(children.find((c: any) => c.type === "feImage").props.href);
    // 20 of spread on an unstroked rect: the outline stroked by 40, filled.
    expect(svg).toContain('stroke-width="40"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('fill="#000000"');
  });

  it("grows the dilation by the element's own outside stroke", () => {
    const el = rect({
      fills: [{ type: "solid", color: "#ffffff" }],
      strokes: [{ color: "#000000", width: 4, align: "outside", enabled: true }],
      effects: [drop(20)]
    });
    const { children } = primitivesOf(el);
    const svg = svgOf(children.find((c: any) => c.type === "feImage").props.href);
    // The painted region already reaches 4 past the outline; the spread adds 20.
    expect(svg).toContain('stroke-width="48"');
  });

  it("inflates the outline itself for an erosion, and empties when nothing is left", () => {
    const el = rect({ borderRadius: 10, fills: [{ type: "solid", color: "#ffffff" }], effects: [drop(-8)] });
    const { children } = primitivesOf(el);
    const svg = svgOf(children.find((c: any) => c.type === "feImage").props.href);
    // A shrunk rect: no stroke trick exists for erosion, so the path is exact.
    expect(svg).not.toContain("stroke-width");
    expect(svg).toContain("<path");
    // 200x60 shrunk by 8 a side, radius 10 -> 2.
    expect(svg).toMatch(/M 2 0 H 182 A 2 2/);

    const gone = rect({ fills: [{ type: "solid", color: "#ffffff" }], effects: [drop(-40)] });
    const goneSvg = svgOf(primitivesOf(gone).children.find((c: any) => c.type === "feImage").props.href);
    expect(goneSvg).not.toContain("<path");
  });

  it("dilates the hole for a negative inner shadow, and shrinks it for a positive one", () => {
    const hole = (spread: number) =>
      svgOf(
        primitivesOf(rect({ fills: [{ type: "solid", color: "#ffffff" }], effects: [inner(spread)] })).children.find(
          (c: any) => c.type === "feImage"
        ).props.href
      );
    // spread -40 pulls the hole OUT by 40 — the reported case.
    expect(hole(-40)).toContain('stroke-width="80"');
    // spread +40 pulls it IN, which is an erosion: an exact, unstroked path.
    expect(hole(40)).not.toContain("stroke-width");
  });

  it("keeps the alpha-based chain for a translucent fill, and for anything without an outline", () => {
    const translucent = rect({
      fills: [{ type: "solid", color: "#ffffff", opacity: 0.09 } as any],
      effects: [drop(20)]
    });
    expect(primitivesOf(translucent).children.some((c: any) => c.type === "feMorphology")).toBe(true);

    const text: DesignElement = {
      id: "r1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      content: "hi",
      effects: [inner(-20)],
      style: { fontSize: 16 }
    } as DesignElement;
    expect(primitivesOf(text).children.some((c: any) => c.type === "feMorphology")).toBe(true);

    // A container's silhouette is its children's, which geometry cannot carry
    // unless it is clipped to a box it also fills.
    const frame: DesignElement = {
      id: "r1",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      clipContent: false,
      children: [],
      fills: [{ type: "solid", color: "#ffffff" }],
      effects: [drop(20)]
    } as DesignElement;
    expect(primitivesOf(frame).children.some((c: any) => c.type === "feMorphology")).toBe(true);
  });

  it("returns null rather than a wrong silhouette", () => {
    const region = { x: -20, y: -20, width: 240, height: 100 };
    const origin = { x: 40, y: 30 };
    expect(shadowSilhouette(rect({ fills: [] }), 20, true, region, origin)).toBeNull();
    expect(shadowSilhouette(rect({ fills: [{ type: "solid", color: "#ffffff" }] }), 20, false, region, origin)).toBeTruthy();
  });
});
/**
 * Chromium clamps one `feMorphology`'s radius at 256 DEVICE pixels, so a spread
 * larger than `256 / (zoom * devicePixelRatio)` has to be spelled as several
 * chained primitives or it comes up short — which is what made a negative spread
 * change size between zooms. These assertions are the arithmetic of that split;
 * the cap itself was measured in a browser (see the note in `CanvasDefs`).
 */
const MAX_DEVICE_PX = 256;

function shadow(kind: "inner-shadow" | "drop-shadow", spread: number): Effect {
  return { type: kind, color: "#000000", offset: { x: 0, y: 40 }, blur: 10, spread, enabled: true } as Effect;
}

function morphsOf(kind: "inner-shadow" | "drop-shadow", spread: number, pixelScale: number) {
  const el: RectElement = {
    id: "rect1",
    type: "rect",
    x: 0,
    y: 0,
    width: 200,
    height: 60,
    effects: [shadow(kind, spread)]
  };
  const defs = CanvasDefs({ allElements: [el], selectedIds: new Set(), pixelScale }) as any;
  const filter = defsMarkup(defs).find((c: any) => c && c.type === "filter" && c.props?.id === "filter_rect1");
  expect(filter).toBeTruthy();
  return (filter.props.children as any[]).flat(Infinity).filter((p: any) => p && p.type === "feMorphology");
}

describe("feMorphology spread against Chromium's device-pixel cap", () => {
  it("emits one primitive at 1:1, with the spread as authored", () => {
    for (const kind of ["inner-shadow", "drop-shadow"] as const) {
      const morphs = morphsOf(kind, -40, 1);
      expect(morphs).toHaveLength(1);
      expect(morphs[0].props.radius).toBe(40);
      // Inner dilates its hole, drop erodes its silhouette: the sign picks the
      // operator, and the two are not interchangeable.
      expect(morphs[0].props.operator).toBe(kind === "inner-shadow" ? "dilate" : "erode");
    }
  });

  it("splits the spread once the radius would pass the cap", () => {
    const morphs = morphsOf("inner-shadow", -40, 8);
    expect(morphs).toHaveLength(2);
    expect(morphs.map((m: any) => m.props.radius)).toEqual([20, 20]);
    // Chained, not parallel: each primitive reads the previous one's result.
    expect(morphs[1].props.in).toBe(morphs[0].props.result);
    // The inner chain saturates the silhouette first; the drop chain reads the
    // source directly. Neither is the other's input.
    expect(morphs[0].props.in).toBe("fx-0-in-alpha");
    expect(morphsOf("drop-shadow", -40, 8)[0].props.in).toBe("SourceAlpha");
  });

  it("keeps every chunk under the cap and their sum equal to the spread", () => {
    for (const kind of ["inner-shadow", "drop-shadow"] as const) {
      for (const pixelScale of [1, 2, 4, 8, 16, 32]) {
        for (const spread of [-40, -7, 12, 96]) {
          const morphs = morphsOf(kind, spread, pixelScale);
          const radii = morphs.map((m: any) => m.props.radius);
          expect(Math.abs(radii.reduce((a: number, b: number) => a + b, 0))).toBeCloseTo(Math.abs(spread), 6);
          for (const r of radii) expect(r * pixelScale).toBeLessThanOrEqual(MAX_DEVICE_PX);
          expect(morphs.every((m: any) => m.props.operator === (spread > 0 ? (kind === "inner-shadow" ? "erode" : "dilate") : kind === "inner-shadow" ? "dilate" : "erode"))).toBe(true);
        }
      }
    }
  });

  it("emits no morphology at all when there is no spread", () => {
    expect(morphsOf("inner-shadow", 0, 8)).toHaveLength(0);
    expect(morphsOf("drop-shadow", 0, 8)).toBeDefined();
  });

  it("renders iOS 27 Glass + blend-mode shadow and fill stacks as translucent highlights and hairlines rather than opaque black/gray", () => {
    const glassFrame: DesignElement = {
      id: "r1",
      type: "frame",
      x: 0,
      y: 0,
      width: 155,
      height: 155,
      clipContent: true,
      borderRadius: 30,
      cornerSmoothing: 0.6,
      children: [],
      effects: [
        {
          type: "liquid-glass",
          frost: 6,
          refraction: 70,
          depth: 30,
          dispersion: 20,
          splay: 20,
          lightAngle: 0,
          lightIntensity: 40,
          enabled: true
        },
        {
          type: "inner-shadow",
          color: "#e6e6e6",
          offset: { x: 0, y: 40 },
          blur: 30,
          spread: -40,
          blendMode: "color-burn",
          enabled: true
        },
        {
          type: "inner-shadow",
          color: "#282828",
          offset: { x: 0, y: -40 },
          blur: 10,
          spread: -40,
          blendMode: "plus-lighter",
          enabled: true
        }
      ]
    } as DesignElement;

    const { children } = primitivesOf(glassFrame);
    // Uses exact feImage silhouettes for both base alpha and dilated hole even when fills are absent
    expect(children.some((c: any) => c.type === "feMorphology")).toBe(false);
    const floods = children.filter((c: any) => c.type === "feFlood");
    expect(floods).toHaveLength(2);
    // #282828 plus-lighter -> #ffffff @ ~0.157, #e6e6e6 color-burn -> #000000 @ ~0.098
    const opacities = floods.map((f: any) => f.props.floodOpacity).sort((a: number, b: number) => a - b);
    expect(opacities[0]).toBeCloseTo(0.098, 2);
    expect(opacities[1]).toBeCloseTo(0.157, 2);

    // Base-less button blend stack (LUMINOSITY #111 @ 0.6 + COLOR_DODGE #777 @ 1 + LINEAR_DODGE #222 @ 1)
    const buttonFills: Paint[] = [
      { type: "solid", color: "#111111", opacity: 0.6, blendMode: "luminosity" },
      { type: "solid", color: "#777777", opacity: 1, blendMode: "color-dodge" },
      { type: "solid", color: "#222222", opacity: 1, blendMode: "plus-lighter" }
    ];
    const resolved = buttonFills.map((f) => resolveSolidPaintBlend(f, buttonFills, false, false));
    expect(resolved[0].opacity).toBeCloseTo(0.25, 2);
    expect(resolved[1].opacity).toBeLessThan(0.15);
    expect(resolved[2]).toMatchObject({ fillVal: "#ffffff" });
    expect(resolved[2].opacity).toBeCloseTo(34 / 255, 2);

    // Standalone COLOR_DODGE fill (like the vertical Bar in iOS 27 Lock Screen widgets)
    // keeps its full authored opacity rather than being attenuated as a luminosity stack.
    const singleDodge: Paint = { type: "solid", color: "#ffffff", opacity: 1, blendMode: "color-dodge" };
    expect(resolveSolidPaintBlend(singleDodge, [singleDodge], false, false)).toEqual({
      fillVal: "#ffffff",
      opacity: 1,
      blendMode: "color-dodge"
    });
  });
});
