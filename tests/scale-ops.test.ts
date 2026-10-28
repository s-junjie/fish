import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { updateActivePageElements } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import {
  scaleSelectionInDocument,
  scaleSelectionToSizeInDocument,
  scaleElements,
  normalizeScaleFactor,
  selectionWorldBounds,
  SCALE_ANCHORS,
  SCALE_REFUSALS,
  DEFAULT_SCALE_ANCHOR,
  type ScaleRefusal
} from "../src/core/interactions/scale-ops";
import { t } from "../src/i18n";
import { DesignDocument, DesignElement, LineElement, PathElement, RectElement, TextElement, FrameElement } from "../src/core/dsl/types";
import { childrenOf } from "../src/core/geometry/tree-ops";
import { parsePathData } from "../src/core/geometry/path-data";
import { relayoutDocumentTree } from "../src/core/compile";

const rect = (props: Partial<RectElement>): RectElement => ({
  id: "r",
  type: "rect",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...props
});

const frame = (props: Partial<FrameElement>): FrameElement => ({
  id: "F",
  type: "frame",
  x: 0,
  y: 0,
  width: 400,
  height: 200,
  children: [],
  ...props
});

const doc = (elements: DesignElement[]): DesignDocument =>
  ({ version: "0.1", elements, pages: [{ id: "p1", name: "Page 1", children: elements }] }) as unknown as DesignDocument;

/** `undefined` on a miss — the recursion descends into every leaf's (empty) child
 *  list, so a helper that throws on the empty list never finishes a search. */
const find = (list: DesignElement[], id: string): DesignElement | undefined => {
  for (const el of list) {
    if (el.id === id) return el;
    const hit = find(childrenOf(el), id);
    if (hit) return hit;
  }
  return undefined;
};

const read = (d: DesignDocument, id: string): DesignElement => {
  const el = find(getActivePage(d).children, id);
  if (!el) throw new Error(`not found: ${id}`);
  return el;
};

describe("normalizeScaleFactor", () => {
  it("clamps to the range where a layer stays visible", () => {
    expect(normalizeScaleFactor(0)).toBe(1);
    expect(normalizeScaleFactor(-2)).toBe(1);
    expect(normalizeScaleFactor(NaN)).toBe(1);
    expect(normalizeScaleFactor(1e9)).toBe(100);
    expect(normalizeScaleFactor(1e-9)).toBe(0.01);
    expect(normalizeScaleFactor(2)).toBe(2);
  });
});

/**
 * The property of a scale that distinguishes it from a resize: everything
 * measured in pixels of the box moves with it. A resize leaves 24px padding and
 * 16px type on a card that is suddenly twice as wide, which is the bug this
 * exists to prevent — so the tests assert the properties, not just the box.
 */
describe("scale takes the properties with the geometry", () => {
  it("multiplies the box", () => {
    const out = scaleSelectionInDocument(doc([rect({ fills: [{ type: "solid", color: "#000" }] })]), new Set(["r"]), 2);
    const r = read(out.doc, "r");
    expect([r.width, r.height], "box").toEqual([200, 100]);
  });

  it("scales corner radii, stroke width and effect blur", () => {
    const out = scaleSelectionInDocument(
      doc([
        rect({
          borderRadius: 12,
          strokes: [{ color: "#000", width: 3 }],
          effects: [{ type: "drop-shadow", color: "#000", offset: { x: 4, y: 8 }, blur: 10, spread: 2 }]
        })
      ]),
      new Set(["r"]),
      2
    );
    const r = read(out.doc, "r") as RectElement;
    expect(r.borderRadius).toBe(24);
    expect(r.strokes?.[0]?.width).toBe(6);
    const shadow = r.effects![0] as Extract<NonNullable<RectElement["effects"]>[number], { type: "drop-shadow" }>;
    expect([shadow.blur, shadow.offset.x, shadow.offset.y, shadow.spread]).toEqual([20, 8, 16, 4]);
  });

  it("scales type size and an absolute leading, leaving a multiplier alone", () => {
    const text: TextElement = {
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      width: 200,
      height: 20,
      content: "hi",
      style: { fontFamily: "Inter", fontSize: 16, color: "#000", lineHeight: "24px", letterSpacing: 0.5 }
    };
    const r = read(scaleSelectionInDocument(doc([text]), new Set(["t"]), 2).doc, "t") as TextElement;
    expect(r.style.fontSize).toBe(32);
    expect(r.style.lineHeight).toBe("48px");
    expect(r.style.letterSpacing).toBe(1);

    // A unitless line height is a RATIO: `fontSize` scales, so the leading tracks
    // it on its own and the number must not be multiplied as if it were a length.
    const ratio = { ...text, style: { ...text.style, lineHeight: 1.5 } } as TextElement;
    const scaled = read(scaleSelectionInDocument(doc([ratio]), new Set(["t"]), 2).doc, "t") as TextElement;
    expect(scaled.style.fontSize).toBe(32);
    expect(scaled.style.lineHeight).toBe(1.5);

    // An `em` tracking is relative to the size, which scales on its own, so it
    // must not be multiplied — scaling it would compound the growth.
    const tracked = { ...text, style: { ...text.style, letterSpacing: "0.05em" } } as TextElement;
    const scaledTrack = read(scaleSelectionInDocument(doc([tracked]), new Set(["t"]), 2).doc, "t") as TextElement;
    expect(scaledTrack.style.fontSize).toBe(32);
    expect(scaledTrack.style.letterSpacing).toBe("0.05em");
  });

  it("scales auto-layout gap and padding", () => {
    const out = scaleSelectionInDocument(
      doc([frame({ ...flattenLayout({ mode: "flex", direction: "column", gap: 10, padding: 8 }) })]),
      new Set(["F"]),
      3
    );
    const f = read(out.doc, "F") as FrameElement;
    expect(layoutOf(f)?.gap).toBe(30);
    expect(layoutOf(f)?.padding).toBe(24);
  });

  it("scales the px tracks and leaves the fr ratios alone", () => {
    // The tracks are measurements of this geometry, so they scale with it; an
    // `fr` is a ratio and scaling it would change the layout rather than the
    // size. Leaving the list out entirely is what made the tracks stop fitting
    // their own frame after a scale.
    const out = scaleSelectionInDocument(
      doc([
        frame({
          width: 1264,
          height: 300,
          ...flattenLayout({
            mode: "grid",
            columns: 3,
            columnSizes: [280, { fr: 1 }, 288],
            rowSizes: [48, { fr: 1 }, 26],
            columnGap: 8
          })
        })
      ]),
      new Set(["F"]),
      2
    );
    const layout = layoutOf(read(out.doc, "F") as FrameElement)!;
    expect(layout.columnSizes).toEqual([560, { fr: 1 }, 576]);
    expect(layout.rowSizes).toEqual([96, { fr: 1 }, 52]);
    expect(layout.columnGap).toBe(16);
    // The fixed tracks and the gaps now fill exactly what is left of the frame,
    // which is the statement a scale has to leave true.
    const fixed = (layout.columnSizes as number[]).filter((t) => typeof t === "number") as number[];
    const total = fixed.reduce((a, b) => a + b, 0) + layout.columnGap! * 2;
    expect(total).toBeLessThanOrEqual(read(out.doc, "F").width);
  });

  it("scales path data with the box", () => {
    const path: PathElement = {
      id: "p",
      type: "path",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      d: "M 0 0 L 100 0 L 100 100 Z"
    };
    const r = read(scaleSelectionInDocument(doc([path]), new Set(["p"]), 2).doc, "p") as PathElement;
    const parsed = parsePathData(r.d)!;
    const xs = parsed.anchors.map((a) => a.x);
    const ys = parsed.anchors.map((a) => a.y);
    expect(Math.max(...xs)).toBe(200);
    expect(Math.max(...ys)).toBe(200);
  });

  it("scales a line's endpoint deltas", () => {
    const line = { id: "l", type: "line", x: 0, y: 0, width: 100, height: 50, dx: 100, dy: 50, strokes: [{ width: 2 }] } as DesignElement;
    const r = read(scaleSelectionInDocument(doc([line]), new Set(["l"]), 2).doc, "l") as DesignElement & { dx: number; dy: number };
    expect([r.dx, r.dy]).toEqual([200, 100]);
  });

  it("leaves non-pixel properties alone", () => {
    const out = scaleSelectionInDocument(
      doc([rect({ opacity: 0.5, rotation: 30, name: "keep" })]),
      new Set(["r"]),
      2
    );
    const r = read(out.doc, "r");
    expect(r.opacity).toBe(0.5);
    expect(r.rotation).toBe(30);
    expect(r.name).toBe("keep");
  });
});

/**
 * Shrinking a card and growing it again has to land back on the design it
 * started from.
 *
 * This is the property that decides whether the whole tool is usable, and it is
 * not free: the scale BAKES its factor into geometry, so every clamp on the way
 * down is a permanent edit to the document. The floor used to be 1px, chosen so
 * a layer stayed clickable, and that made the round trip lossy for good — a 3x5
 * bar landed on 1x1.67 and came back as 10x16.7, a 110x4 home indicator as
 * 275x10 — because the extent the design started with was no longer stored
 * anywhere. `MIN_DIMENSION` is sub-pixel now, so the worst case the legal factor
 * range allows shrinks to 1% and grows back to 100%, and it is EXACT.
 */
describe("a scale is reversible", () => {
  const roundTrip = (start: FrameElement, down: number, up: number): FrameElement =>
    read(
      scaleSelectionInDocument(
        scaleSelectionInDocument(doc([start]), new Set(["F"]), down).doc,
        new Set(["F"]),
        up
      ).doc,
      "F"
    ) as FrameElement;

  it("restores the radius exactly when the box never reaches the floor", () => {
    const back = roundTrip(frame({ borderRadius: 20 }), 0.5, 2);
    expect([back.width, back.height, back.borderRadius]).toEqual([400, 200, 20]);
  });

  it("keeps a corner at the floor instead of writing a square one", () => {
    // The smallest factor the tool allows, on a box short enough that the floor is
    // close behind it.
    const start = frame({ width: 20, height: 10, borderRadius: 2 });
    const down = read(scaleSelectionInDocument(doc([start]), new Set(["F"]), 0.01).doc, "F") as FrameElement;
    // 20x10 keeps its 2:1. Flooring the axes separately would have given a square that
    // had never been one, and the reason a text layer's type stops matching its own box.
    expect([down.width, down.height], "aspect intact").toEqual([0.2, 0.1]);
    expect(down.borderRadius as number, "still a corner, not 0").toBe(0.02);

    // Both axes moved by the same factor, so the corner follows it and comes back whole
    // rather than merely in proportion.
    const up = read(scaleSelectionInDocument(doc([down]), new Set(["F"]), 100).doc, "F") as FrameElement;
    expect([up.width, up.height, up.borderRadius], "restored exactly").toEqual([20, 10, 2]);
  });

  it("restores the design exactly after the widest round trip an absolute size allows", () => {
    // The W/H fields are absolute, so a typed 0.1 of a 20x10 frame is 0.1 — the 1%
    // a factor input would floor it to never enters, and the 100x back to 20x10 is
    // the same request the other way: the corner and the stroke come with it.
    let f = frame({ width: 20, height: 10, borderRadius: 2, strokes: [{ color: "#000", width: 2 }] });
    const shrink = scaleSelectionToSizeInDocument(doc([f]), new Set(["F"]), { width: 0.1, height: 0.05 }, DEFAULT_SCALE_ANCHOR);
    f = read(shrink.doc, "F") as FrameElement;
    expect([f.width, f.height], "the request, not a floor of it").toEqual([0.1, 0.05]);
    const grow = scaleSelectionToSizeInDocument(doc([f]), new Set(["F"]), { width: 20, height: 10 }, DEFAULT_SCALE_ANCHOR);
    const back = read(grow.doc, "F") as FrameElement;
    expect([back.width, back.height], "the box is whole again").toEqual([20, 10]);
    expect(back.borderRadius, "and so is the corner").toBe(2);
    expect(back.strokes?.[0]?.width, "and the stroke").toBe(2);
  });

  it("keeps a per-corner radius list proportional", () => {
    const r = roundTrip(frame({ borderRadius: [8, 16, 4, 0] }), 0.01, 100);
    const radii = r.borderRadius as number[];
    expect(radii[1] / Math.min(r.width, r.height)).toBeCloseTo(16 / 200, 3);
    expect(radii[0] / Math.min(r.width, r.height)).toBeCloseTo(8 / 200, 3);
    expect(radii[3], "a square corner stays square").toBe(0);
  });

  it("keeps stroke width and padding in ratio with the box", () => {
    // The `frame` helper is 400x200, so the shorter side is 200 and every pixel
    // property's ratio is taken against that.
    const r = roundTrip(
      frame({ borderRadius: 0, strokes: [{ color: "#000", width: 4 }], ...flattenLayout({ mode: "flex", direction: "row", padding: 16, gap: 8 }) }),
      0.01,
      100
    );
    const shorter = Math.min(r.width, r.height);
    expect((r.strokes?.[0] as { width: number }).width / shorter, "stroke").toBeCloseTo(4 / 200, 3);
    expect((layoutOf(r) as { padding: number }).padding / shorter, "padding").toBeCloseTo(16 / 200, 3);
    expect((layoutOf(r) as { gap: number }).gap / shorter, "gap").toBeCloseTo(8 / 200, 3);
  });

  it("scales the whole subtree by the factor the frame really took", () => {
    const out = scaleSelectionInDocument(
      doc([frame({ width: 8, height: 400, children: [rect({ id: "c", x: 2, width: 4, height: 200 })] })]),
      new Set(["F"]),
      0.01
    );
    const f = read(out.doc, "F") as FrameElement;
    const c = read(out.doc, "c") as DesignElement;
    // 0.01 is the smallest factor the tool accepts, so the frame lands on 0.08x4 with
    // its 1:50 intact. The child has to scale by THAT factor rather than by whatever its
    // own floor would allow on its own, or it keeps its old size inside a frame a
    // hundredth of its own. Its offset is in the frame's space, so it follows the
    // request rather than the box.
    expect([f.width, f.height]).toEqual([0.08, 4]);
    // The child is 4x200 — the same 1:50 — so it keeps that ratio and fills the frame
    // it was just scaled into.
    expect([c.x, c.width, c.height], "the child followed the frame's real factor").toEqual([0.02, 0.04, 2]);
  });
});

/**
 * A scale is only reversible if nothing between the two halves rounds.
 *
 * The scale itself is the easy half — it bakes a factor into geometry and every writer
 * in `core/` rounds to two decimals, which the undo can undo. The relayout that a
 * scale triggers is the hard half, because the engine RE-DERIVES every box it measures:
 * a `fit-content` frame's width, a text block's height, where a `fill` child lands. Any
 * of those snapped to a whole pixel is a permanent edit, and the second half of the round
 * trip reads it back and multiplies the error.
 *
 * So a 27.6px frame measured as 28 came back 280, wider than the parent holding it, and
 * the design drifted on every repeat. This is the shape that actually broke: a real
 * layout rather than a single box, and every class of element the floor used to eat.
 */
describe("a scale survives the layout pass it triggers", () => {
  /** One round trip through the whole pipeline, relayout included on both halves. */
  const roundTrip = (elements: DesignElement[], factor: number): DesignElement[] => {
    const start = doc(elements);
    const ids = new Set(["F"]);
    const bounds = selectionWorldBounds(getActivePage(start).children, ids)!;
    const scaleTo = (width: number, height: number, from: DesignElement[]) =>
      relayoutDocumentTree(
        getActivePage(scaleSelectionToSizeInDocument(updateActivePageElements(start, from), ids, { width, height }).doc).children
      );
    const down = scaleTo(bounds.width * factor, bounds.height * factor, getActivePage(start).children);
    return scaleTo(bounds.width, bounds.height, down);
  };

  /**
   * The document as the app would hold it: a relayout pass has already run, so every
   * box the engine derives is settled. Comparing against the raw input instead would
   * charge the round trip for the first layout's work — a row's `align: center` moves
   * a label off the y it was authored at, which has nothing to do with scaling.
   */
  const settled = (): DesignElement[] => relayoutDocumentTree(getActivePage(doc(design())).children);

  /**
   * Drawn geometry and stroke weights, kept apart from the boxes below.
   *
   * A scale rewrites `d` and multiplies stroke widths, and both are stored at the
   * document's own two decimals — so a value like 9.17 has nowhere to put 4.585 on the
   * way down and comes back as 9.18. That is a limit of the precision, not a defect:
   * the error is bounded by it and, more importantly, it CONVERGES, which is what
   * separates it from the floor's behaviour of multiplying the error on every pass.
   */
  const DRAWN_KEYS = ["d", "stroke", "strokes"];

  const fields = (list: DesignElement[], keys?: (key: string) => boolean, out: string[] = []): string[] => {
    for (const el of list) {
      for (const [key, value] of Object.entries(el)) {
        if (key === "children") continue;
        if (keys && !keys(key)) continue;
        out.push(`${el.id}.${key}: ${JSON.stringify(value)}`);
      }
      fields(childrenOf(el), keys, out);
    }
    return out;
  };
  const isBox = (key: string) => !DRAWN_KEYS.includes(key);

  const design = (): DesignElement[] => [
    frame({
      id: "F",
      width: 336,
      height: 668,
      children: [
        // A `fit-content` frame with a row layout: the engine re-measures its width
        // from its children, so its box is derived rather than stored.
        frame({
          id: "search",
          width: 300,
          height: 42,
          borderRadius: 14,
          ...flattenLayout({ mode: "flex", direction: "row", gap: 12, padding: [0, 14, 0, 14], align: "center" }),
          children: [
            // Authored the way the serializer emits it — absolute cubics, two decimals,
            // closed with a trailing Z — because a scale re-serializes `d` and anything
            // else converts on the first pass: arcs become cubics and relative commands
            // become absolute.
            {
              id: "icon",
              type: "path",
              x: 14,
              y: 11,
              width: 20,
              height: 20,
              d: "M 9.17 3.34 C 5.96 3.34 3.34 5.96 3.34 9.17 C 3.34 12.38 5.96 15 9.17 15 C 12.38 15 15 12.38 15 9.17 C 15 5.96 12.38 3.34 9.17 3.34 Z",
              strokes: [{ color: "#8B8B90", width: 1.68 }]
            } as PathElement,
            {
              id: "label",
              type: "text",
              x: 46,
              y: 13,
              width: 184,
              height: 17,
              sizing: { height: "fit-content" },
              content: "M5 2026",
              style: { fontFamily: "Inter", fontSize: 12.5, color: "#000" }
            } as TextElement
          ]
        }),
        // Small enough that 10% lands under a pixel — the case the old 1px floor ate.
        rect({ id: "bars", x: 0, y: 100, width: 3, height: 11, borderRadius: 1 }),
        // A divider with no extent at all. The floor must not invent a box for it: a
        // non-zero box is something every later factor reads a ratio off, so a
        // zero-height rule came back with a stroke multiplied by ten.
        { id: "rule", type: "line", x: 0, y: 200, width: 0, height: 0, dx: 0, dy: 0, strokes: [{ color: "#E3E3E5", width: 2 }] } as LineElement,
        // Wide and thin: the shortest side is what a corner is measured against, so
        // this is the box that lost the most from an aspect-destroying floor.
        frame({ id: "home", x: 0, y: 300, width: 110, height: 4, borderRadius: 4, children: [] })
      ]
    })
  ];

  for (const factor of [0.5, 0.1]) {
    it(`restores every box after shrinking to ${factor * 100}% and back`, () => {
      const before = fields(settled(), isBox);
      const after = fields(roundTrip(settled(), factor), isBox);
      const drift = after.filter((line, i) => line !== before[i]);
      expect(drift, `drifted:\n  ${drift.join("\n  ")}`).toEqual([]);
    });

    it(`restores the drawn geometry to within the document's precision at ${factor * 100}%`, () => {
      const drawn = (list: DesignElement[]) =>
        fields(list, (key) => DRAWN_KEYS.includes(key)).flatMap((line) => (line.match(/-?\d+(\.\d+)?/g) ?? []).map(Number));
      const [want, got] = [drawn(settled()), drawn(roundTrip(settled(), factor))];
      expect(got, "same shape").toHaveLength(want.length);
      // The bound the precision implies, not a chosen tolerance: the intermediate is
      // stored to two decimals, so it carries half a hundredth of the document's unit,
      // and scaling back up multiplies that by the reciprocal. A `Z` doubled by the
      // serializer, or a stroke scaled twice, is orders of magnitude outside this.
      const tolerance = 0.005 / factor;
      got.forEach((value, i) =>
        expect(Math.abs(value - want[i]), `value ${i}: ${want[i]} -> ${value}`).toBeLessThanOrEqual(tolerance)
      );
    });
  }

  it("does not drift further the more often it is repeated", () => {
    // Snapping once is tolerable: a 2dp document cannot carry every value through the
    // bottom of the factor range. Drifting on every repeat is not, and it is what a
    // floor or a whole-pixel rounding does. So the second trip has to land where the
    // first left off, at the very bottom of the range.
    const once = roundTrip(settled(), 0.01);
    const twice = roundTrip(once, 0.01);
    const drift = fields(twice).filter((line, i) => line !== fields(once)[i]);
    expect(drift, `drifted:\n  ${drift.join("\n  ")}`).toEqual([]);
  });
});

describe("scale walks the whole subtree", () => {
  it("scales descendants and their own local positions", () => {
    const out = scaleSelectionInDocument(
      doc([
        frame({
          children: [
            rect({ id: "a", x: 10, y: 20, width: 100, height: 50 }),
            rect({ id: "b", x: 150, y: 100, width: 100, height: 50 })
          ]
        })
      ]),
      new Set(["F"]),
      2
    );
    const a = read(out.doc, "a");
    const b = read(out.doc, "b");
    expect([a.x, a.y, a.width, a.height]).toEqual([20, 40, 200, 100]);
    expect([b.x, b.y]).toEqual([300, 200]);
  });

  it("scales a nested frame's own box as well as its position", () => {
    const out = scaleSelectionInDocument(
      doc([
        frame({
          children: [frame({ id: "inner", x: 0, y: 0, width: 100, height: 100, children: [] })]
        })
      ]),
      new Set(["F"]),
      2
    );
    const inner = read(out.doc, "inner") as FrameElement;
    expect([inner.width, inner.height]).toEqual([200, 200]);
  });

  it("scales a selected layer once, not once per selected ancestor", () => {
    // Selecting both a frame and a layer inside it is ordinary; the outer one is
    // what the user meant. `mapElements` visits the inner node too, so without the
    // ancestor rule this would be 2x on 2x.
    const out = scaleSelectionInDocument(
      doc([frame({ children: [rect({ id: "a", x: 0, y: 0, width: 100, height: 50 })] })]),
      new Set(["F", "a"]),
      2
    );
    expect(read(out.doc, "F").width).toBe(800);
    expect(read(out.doc, "a").width).toBe(200);
  });
});

describe("scale leaves the rest of the document alone", () => {
  it("does not move an unselected sibling", () => {
    const out = scaleSelectionInDocument(
      doc([rect({ id: "a", x: 0, y: 0, width: 100, height: 50 }), rect({ id: "b", x: 0, y: 200, width: 100, height: 50 })]),
      new Set(["a"]),
      2
    );
    expect(read(out.doc, "b")).toEqual(rect({ id: "b", x: 0, y: 200, width: 100, height: 50 }));
  });

  it("skips a locked layer", () => {
    const out = scaleSelectionInDocument(doc([rect({ locked: true })]), new Set(["r"]), 2);
    expect(out.changed).toBe(false);
    expect(out.refusal).toBe("locked");
  });

  it("reports an empty selection rather than committing a no-op", () => {
    const out = scaleSelectionInDocument(doc([rect({})]), new Set(), 2);
    expect(out.changed).toBe(false);
    expect(out.refusal).toBe("empty");
  });

  it("reports a factor of 1 as a no-op", () => {
    const out = scaleSelectionInDocument(doc([rect({})]), new Set(["r"]), 1);
    expect(out.changed).toBe(false);
    expect(out.refusal).toBe("no-op");
  });

  it("returns the same element list when nothing is scaleable", () => {
    const elements = [rect({ id: "r" })];
    expect(scaleElements(elements, new Set(["nope"]), 2)).toBe(elements);
  });
});

/**
 * The anchor is the point a scale grows FROM, held fixed while the box grows
 * around it. These assert that point literally, because "did the middle stay in
 * the middle" is the whole feature and a box-only assertion cannot see it.
 */
describe("the anchor holds its point while the box grows", () => {
  const at = (elements: DesignElement[], id: string) => {
    const el = elements.find((e) => e.id === id)!;
    return { cx: el.x + el.width / 2, cy: el.y + el.height / 2, x: el.x, y: el.y };
  };

  it("a centre anchor keeps the centre pinned", () => {
    const out = scaleSelectionToSizeInDocument(doc([rect({ x: 100, y: 100, width: 200, height: 100 })]), new Set(["r"]), { width: 400, height: 200 }, { x: 0.5, y: 0.5 });
    const r = at(getActivePage(out.doc).children, "r");
    expect([r.cx, r.cy], "centre").toEqual([200, 150]);
    expect([r.x, r.y], "box grew out both ways").toEqual([0, 50]);
  });

  it("a top-left anchor keeps the top-left corner pinned", () => {
    const out = scaleSelectionToSizeInDocument(doc([rect({ x: 100, y: 100, width: 200, height: 100 })]), new Set(["r"]), { width: 400, height: 200 }, { x: 0, y: 0 });
    const r = at(getActivePage(out.doc).children, "r");
    expect([r.x, r.y], "corner").toEqual([100, 100]);
    expect([r.cx, r.cy], "centre moved").toEqual([300, 200]);
  });

  it("a bottom-right anchor keeps the bottom-right corner pinned", () => {
    const out = scaleSelectionToSizeInDocument(doc([rect({ x: 100, y: 100, width: 200, height: 100 })]), new Set(["r"]), { width: 400, height: 200 }, { x: 1, y: 1 });
    // The bottom-right corner was at (300, 200) and must still be after a 2x grow.
    const r = at(getActivePage(out.doc).children, "r");
    expect([r.x + 400, r.y + 200], "bottom-right").toEqual([300, 200]);
  });

  it("a non-uniform scale moves each axis by its own factor", () => {
    const out = scaleSelectionToSizeInDocument(doc([rect({ x: 0, y: 0, width: 100, height: 100 })]), new Set(["r"]), { width: 300, height: 100 }, { x: 0.5, y: 0.5 });
    const el = getActivePage(out.doc).children[0];
    expect([el.width, el.height], "box").toEqual([300, 100]);
    expect(el.x, "width grew, so it started further left").toBe(-100);
    expect(el.y, "height is unchanged").toBe(0);
  });

  it("scales a subtree's children away from the card's corner, not their own centres", () => {
    // The bug this pins: giving every descendant the same 0.5 anchor holds each
    // child centred inside a box that is itself moving.
    // A 200x100 card to 400x200, so the scale really is 2x on both axes.
    const out = scaleSelectionToSizeInDocument(
      doc([frame({ x: 100, y: 100, width: 200, height: 100, children: [rect({ id: "a", x: 20, y: 0, width: 60, height: 20 })] })]),
      new Set(["F"]),
      { width: 400, height: 200 },
      { x: 0.5, y: 0.5 }
    );
    const a = read(out.doc, "a");
    // Child position and size both double, measured from the frame's own corner.
    expect([a.x, a.y, a.width, a.height]).toEqual([40, 0, 120, 40]);
  });

  it("offers exactly the nine anchor positions, centre by default", () => {
    expect(SCALE_ANCHORS).toHaveLength(9);
    expect(DEFAULT_SCALE_ANCHOR).toEqual({ x: 0.5, y: 0.5 });
    expect(new Set(SCALE_ANCHORS.map((a) => `${a.x},${a.y}`)).size).toBe(9);
  });

  it("scales a multi-selection by the ratio its union takes", () => {
    // "Make these 400 wide" has no single answer for two differently-sized layers;
    // the ratio is the only reading that preserves their relationship.
    const out = scaleSelectionToSizeInDocument(
      doc([rect({ id: "a", x: 0, y: 0, width: 100, height: 100 }), rect({ id: "b", x: 200, y: 0, width: 100, height: 100 })]),
      new Set(["a", "b"]),
      { width: 600, height: 200 },
      { x: 0.5, y: 0.5 }
    );
    expect(getActivePage(out.doc).children.map((e) => e.width)).toEqual([200, 200]);
  });

  /**
   * A group is dragged by the handles on its union, so these pin the two contracts
   * that drag is built out of: a corner grows the whole group away from the opposite
   * corner, and an edge moves its own axis and nothing else. A group has no single
   * element to steer, which is why both have to hold through the union rather than
   * through one layer — the per-layer assertions below would pass either way.
   */
  const pair = () => [
    rect({ id: "a", x: 0, y: 0, width: 100, height: 100 }),
    rect({ id: "b", x: 200, y: 0, width: 100, height: 100 })
  ];

  it("a corner drag grows the group away from the opposite corner", () => {
    const start = selectionWorldBounds(pair(), new Set(["a", "b"]))!;
    expect([start.x, start.y, start.width, start.height], "the union being steered").toEqual([0, 0, 300, 100]);
    // The `br` handle, so the anchor is the top-left corner.
    const out = scaleSelectionToSizeInDocument(doc(pair()), new Set(["a", "b"]), { width: 600, height: 200 }, { x: 0, y: 0 });
    const after = selectionWorldBounds(getActivePage(out.doc).children, new Set(["a", "b"]))!;
    expect([after.x, after.y], "the opposite corner stayed put").toEqual([0, 0]);
    expect([after.width, after.height], "and the box doubled").toEqual([600, 200]);
    // The relationship is the point: the 100px gap between them is a 200px gap now,
    // and a resize that moved the layers independently would have left it at 100.
    const [, b] = getActivePage(out.doc).children;
    expect(b.x, "the gap scaled with the group").toBe(400);
  });

  it("an edge drag moves its own axis and leaves the other exactly alone", () => {
    // The `mr` handle: width doubles, and height must be untouched — not merely
    // close, because a one-axis drag that nudged the other would distort a group of
    // squares into a group of rectangles on a gesture that never asked for it.
    const out = scaleSelectionToSizeInDocument(doc(pair()), new Set(["a", "b"]), { width: 600, height: 100 }, { x: 0, y: 0.5 });
    const after = selectionWorldBounds(getActivePage(out.doc).children, new Set(["a", "b"]))!;
    expect([after.width, after.height], "width moved, height did not").toEqual([600, 100]);
    expect([after.x, after.y], "and the left edge is still the left edge").toEqual([0, 0]);
    expect(getActivePage(out.doc).children.map((e) => e.height), "every layer keeps its height").toEqual([100, 100]);
  });

  it("carries a frame's children out with it, so a group is not a pile of boxes", () => {
    const out = scaleSelectionToSizeInDocument(
      doc([frame({ id: "F", x: 0, y: 0, width: 200, height: 200, children: [rect({ id: "in", x: 20, y: 20, width: 40, height: 40 })] }), rect({ id: "b", x: 300, y: 0, width: 100, height: 100 })]),
      new Set(["F", "b"]),
      { width: 800, height: 200 },
      { x: 0, y: 0 }
    );
    const inner = find(getActivePage(out.doc).children, "in")!;
    // 2x on the width, 1x on the height: the child is wider and the same tall.
    expect([inner.x, inner.y, inner.width, inner.height]).toEqual([40, 20, 80, 40]);
  });
});

/**
 * Text and paths store their shape somewhere the box cannot recover it from, so the
 * floor is not a rounding detail for them — it is the difference between a layer that
 * comes back and one that does not.
 *
 * A text box's height is *derived* from its type, and a path's outline lives in `d`.
 * Both are read back out of a proportional scale, and a floor that moved the axes by
 * different amounts left them describing a box that was no longer there: a 200x19 line
 * of type asked for 0.5% came back 200x200 at 168px, and a 100x100 path came back
 * doubled with its stroke doubled.
 *
 * With a sub-pixel floor that whole class of damage is unreachable, so what is left to
 * pin is the stronger guarantee: at the ends of the legal factor range the round trip
 * is exact, not merely proportional.
 */
describe("text and paths survive the floor", () => {
  const text = (props: Partial<TextElement> = {}): TextElement => ({
    id: "t",
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 19,
    style: { fontFamily: "Inter", fontSize: 16, lineHeight: "19px", color: "#000" },
    ...props
  } as TextElement);

  const path = (props: Partial<PathElement> = {}): PathElement => ({
    id: "p",
    type: "path",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    d: "M 0 0 L 100 0 L 100 100 L 0 100 Z",
    strokes: [{ color: "#000", width: 4 }],
    ...props
  } as PathElement);

  /** Shrink to the smallest factor the tool allows, then grow back the way the UI
   *  does: to the original size. Not by the reciprocal of the request, because the
   *  factor range is bounded — 1% down can only be undone 100x up. */
  const throughTheFloor = (el: DesignElement) => {
    const small = scaleSelectionInDocument(doc([el]), new Set([el.id]), 0.01);
    const tiny = read(small.doc, el.id);
    const back = scaleSelectionToSizeInDocument(small.doc, new Set([el.id]), {
      width: el.width,
      height: el.height
    });
    return { tiny, back: read(back.doc, el.id) };
  };

  it("keeps a text box's aspect at the floor, so its type still describes it", () => {
    const { tiny } = throughTheFloor(text());
    // 19 is the short side, so 0.01 is the factor asked for and 0.01/19 the floor just
    // behind it. A per-axis floor would have given a square and lost the 19:1.
    expect([tiny.width, tiny.height], "aspect intact").toEqual([2, 0.19]);
    expect((tiny as TextElement).style.fontSize, "type scaled with the box").toBe(0.16);
  });

  it("brings the text back at its original size", () => {
    const { back } = throughTheFloor(text());
    const style = (back as TextElement).style;
    // Exact, not in proportion: the floor is sub-pixel, so the type the box was derived
    // from is still there to multiply.
    expect([back.width, back.height], "box").toEqual([200, 19]);
    expect(style.fontSize, "type size — was 168").toBe(16);
    expect(style.lineHeight, "leading — was 22").toBe("19px");
  });

  it("brings a path back with its outline and stroke exactly", () => {
    const { tiny, back } = throughTheFloor(path());
    expect([tiny.width, tiny.height], "a square floor is the square's own").toEqual([1, 1]);
    expect((back as PathElement).d, "outline").toBe("M 0 0 L 100 0 L 100 100 L 0 100 Z");
    expect((back as PathElement).strokes?.[0]?.width, "stroke — was 8, doubled").toBe(4);
    expect([back.width, back.height], "box — was 200x200").toEqual([100, 100]);
  });

  it("still floors each axis on a non-uniform drag, where the aspect is the request", () => {
    // Scaling tool with the corner held off is a per-axis request, and one of them lands
    // far below the 1% a factor input would floor to. The absolute path takes the
    // request; MIN_DIMENSION is the floor behind it, so a tenth of a pixel is as
    // small as the box gets, while the height is taken exactly as asked.
    const out = scaleSelectionToSizeInDocument(doc([path()]), new Set(["p"]), { width: 0.01, height: 90 }, { x: 0, y: 0 });
    const p = getActivePage(out.doc).children[0];
    expect([p.width, p.height], "width at MIN_DIMENSION, height as asked").toEqual([0.01, 90]);
  });
});

describe("selectionWorldBounds", () => {  it("measures the union across parent frames, in canvas space", () => {
    const elements = [
      frame({ id: "F", x: 300, y: 300, children: [rect({ id: "a", x: 0, y: 0, width: 100, height: 50 })] }),
      rect({ id: "b", x: 0, y: 600, width: 40, height: 40 })
    ];
    // "a" sits at the frame's own origin, so it lands at (300, 300) and the union
    // spans from there down to "b" at y 600.
    expect(selectionWorldBounds(elements, new Set(["a", "b"]))).toEqual({ x: 0, y: 300, width: 400, height: 340 });
  });

  it("is null for an empty selection", () => {
    expect(selectionWorldBounds([rect({})], new Set())).toBeNull();
  });
});

/**
 * The other half of the resize path's rule: an axis the layout engine owns is not
 * this layer's to resize.
 *
 * `fit-content` takes its size from its content and `fill` takes it from its parent,
 * so a box written there is one the engine is about to replace. The scale used to
 * write it anyway, and the replacement was invisible: the drag moved and the type
 * grew, then the relayout put the box back to the measured content width or to the
 * parent's width, so the one dimension the user was pointing at did nothing at all.
 *
 * The guarantee pinned here: the scale leaves an engine-owned axis alone and still
 * takes the axis it does own, because a scale whose type did not grow along with the
 * line it sits on would leave the design internally inconsistent.
 */
describe("an engine-owned axis is not the scale's to write", () => {
  const label = (props: Partial<TextElement> = {}): TextElement =>
    ({
      id: "t",
      type: "text",
      content: "Hello world",
      x: 10,
      y: 10,
      width: 200,
      height: 19,
      style: { fontFamily: "Inter", fontSize: 16, lineHeight: "19px", color: "#000" },
      ...props
    }) as TextElement;

  /** A frame with a real layout pass, so `fill` has a parent to fill and
   *  `fit-content` has content to measure — the conditions that make the engine
   *  the owner. A parent without a layout downgrades both to `fixed`, which is
   *  exactly why these cases need one. */
  const holder = (child: DesignElement, props: Partial<FrameElement> = {}): FrameElement =>
    frame({ ...flattenLayout({ mode: "flex", gap: 0, padding: 0 }), children: [child], ...props });

  it("leaves a fit-content width to the content, and still scales the line", () => {
    const t = label({ sizing: { width: "fit-content" } });
    const out = scaleSelectionToSizeInDocument(doc([holder(t)]), new Set(["t"]), { width: 400, height: 38 }, { x: 0, y: 0 });
    const after = read(out.doc, "t") as TextElement;
    expect(after.width, "the width is the content's to measure").toBe(200);
    expect(after.height, "the height is the scale's to write").toBe(38);
    expect(after.style.fontSize, "type grows with the line it sits on").toBe(32);
  });

  it("leaves a fill width to the parent, and still scales the type", () => {
    const t = label({ sizing: { width: "fill" } });
    const out = scaleSelectionToSizeInDocument(doc([holder(t)]), new Set(["t"]), { width: 400, height: 38 }, { x: 0, y: 0 });
    const after = read(out.doc, "t") as TextElement;
    expect(after.width, "a fill child takes the parent's width, not the drag's").toBe(200);
    expect(after.height).toBe(38);
    expect(after.style.fontSize).toBe(32);
  });

  it("scales the box of a sibling that does own its axes", () => {
    // Placed so the selection is exactly 400 wide, which makes the intended factor
    // read straight off the numbers: a sibling that does not own its axis must not
    // quietly become the one that decides how far the whole group scales.
    const hug = label({ id: "hug", x: 0, sizing: { width: "fill" } });
    const fixed = label({ id: "fixed", x: 200 });
    const out = scaleSelectionToSizeInDocument(doc([holder(hug, { height: 300 }), fixed]), new Set(["hug", "fixed"]), { width: 800, height: 76 }, { x: 0, y: 0 });
    expect((read(out.doc, "hug") as TextElement).width, "still the parent's to give").toBe(200);
    expect(read(out.doc, "fixed").width, "and the fixed one scales").toBe(400);
  });

  it("refuses when no axis is the scale's, instead of reporting an out-of-range factor", () => {
    const t = label({ sizing: { width: "fill", height: "fill" } });
    const out = scaleSelectionToSizeInDocument(doc([holder(t)]), new Set(["t"]), { width: 400, height: 38 }, { x: 0, y: 0 });
    expect(out.changed, "a scale with no box to write is not a silent success").toBe(false);
    expect(out.refusal).toBe("engine-sized");
  });
});

/**
 * A refusal that is computed and then dropped is the failure LESSONS §15 names:
 * the number in the field moves, the box does not, and nothing says why. The
 * branches above cover that each refusal is *reached*; this covers that it
 * *arrives* — every refusal names a key the dictionary actually has.
 *
 * That it reaches the SCREEN is the panel's half, and it is asserted in a real
 * browser by `tests/e2e/inspector-colors-and-scale.spec.mjs`: a locked layer
 * scaled from the inspector must show the reason and leave the box alone. This
 * file used to regex `onHint(t(SCALE_REFUSALS[result.refusal]))` out of the
 * panel source instead, which stayed green against the exact bug it described —
 * the call survived in a function nothing called.
 */
describe("a refused scale says why", () => {
  it("gives every refusal a message that resolves in the dictionary", () => {
    for (const refusal of Object.keys(SCALE_REFUSALS) as ScaleRefusal[]) {
      const message = t(SCALE_REFUSALS[refusal]);
      expect(message, `${refusal} points at a key the dictionary does not have`).not.toBe(
        SCALE_REFUSALS[refusal]
      );
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
