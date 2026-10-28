import { describe, it, expect } from "vitest";
import { boundColorTokenFor, boundFillStyleFor, collectSelectedColors, applyColorToSelection, applyPaintToSelection, selectedColorCss, SelectedColor } from "../src/core/interactions/selected-colors";
import { ColorToken, ComponentElement, DesignDocument, DesignElement, InstanceElement, Page, Paint, PaintStyle, RectElement, getActivePage } from "../src/core/dsl/types";

const rect = (props: Partial<RectElement>): RectElement => ({
  id: "r",
  type: "rect",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...props
});

const solid = (color: string, extra: Record<string, unknown> = {}) =>
  ({ type: "solid", color, ...extra }) as RectElement["fills"] extends undefined ? never : any;

const canvas = { width: 2000, height: 1200, background: { type: "solid" as const, color: "#101010" }, unit: "px" as const };

function docOf(elements: DesignElement[]): DesignDocument {
  const page: Page = { id: "page_1", name: "Page 1", canvas, children: elements };
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [page],
    activePageId: "page_1",
    elements
  };
}

/*
 * These functions take a DOCUMENT: an instance's colours are projected from its
 * master and its children are written back as overrides, neither of which a bare
 * element list can answer. The cases below are about what the palette does with a
 * tree, so the document is hung off it here once rather than at every call site.
 */
const collect = (elements: DesignElement[]) => collectSelectedColors(docOf(elements), elements);
const applyColor = (elements: DesignElement[], target: SelectedColor, hex: string) =>
  applyColorToSelection(docOf(elements), elements, target, hex);
const applyPaint = (elements: DesignElement[], target: SelectedColor, paint: Paint) =>
  applyPaintToSelection(docOf(elements), elements, target, paint);

describe("collectSelectedColors", () => {
  it("lists one entry per distinct colour, with the layer count", () => {
    const colors = collect([
      rect({ id: "a", fills: [solid("#ff0000")] }),
      rect({ id: "b", fills: [solid("#FF0000")] }),
      rect({ id: "c", fills: [solid("#00ff00")] })
    ]);
    // #ff0000 and #FF0000 are the same colour, so the strip must not show two.
    expect(colors).toHaveLength(2);
    const red = colors.find((c) => c.hex === "#ff0000")!;
    expect(red.count).toBe(2);
    expect(red.elementIds.sort()).toEqual(["a", "b"]);
  });

  it("keeps alpha off the colour's identity but records it", () => {
    const colors = collect([
      rect({ id: "a", fills: [solid("rgba(255, 0, 0, 0.5)")] }),
      rect({ id: "b", fills: [solid("rgba(255, 0, 0, 1)")] })
    ]);
    expect(colors).toHaveLength(1);
    expect(colors[0].hex).toBe("#ff0000");
  });

  it("records a no-fill layer as no colour, not as opaque black", () => {
    // `{ type: "solid", color: "transparent" }` is what the normalizer writes for
    // a layer with no fill. It was read as `#000000` at 100%, so a no-fill layer
    // contributed a black swatch to every selection it joined.
    const colors = collect([rect({ id: "a", fills: [solid("transparent")] })]);
    expect(colors).toHaveLength(1);
    expect(colors[0].alpha).toBe(0);
  });

  it("merges fill and stroke sharing the same colour into one entry", () => {
    // In selection colors, colors are classified purely by color value/token:
    // a red fill and a red stroke on the same element or across elements merge into
    // one swatch that edits both places.
    const colors = collect([
      rect({ id: "a", fills: [solid("#ff0000")], strokes: [{ width: 2, color: "#ff0000" }] })
    ]);
    expect(colors).toHaveLength(1);
    expect(colors[0].hex).toBe("#ff0000");
    expect(colors[0].elementIds).toEqual(["a"]);
    expect(colors[0].count).toBe(1);
  });

  it("reads a stroke's colour from whichever of the two forms the layer stores", () => {
    // The shorthand is what importers write; `paint` is what this editor writes.
    const shorthand = collect([rect({ id: "a", strokes: [{ width: 1, color: "#00ff00" }] })]);
    expect(shorthand.map((c) => c.hex)).toEqual(["#00ff00"]);

    const painted = collect([rect({ id: "a", strokes: [{ width: 1, paint: solid("#00ff00") }] })]);
    expect(painted.map((c) => c.hex)).toEqual(["#00ff00"]);
  });

  it("skips a hidden lower paint layer in either channel", () => {
    const colors = collect([
      rect({
        id: "a",
        fills: [solid("#ff0000"), { ...solid("#00ff00"), enabled: false }],
        strokes: [{ width: 1, color: "#0000ff" }]
      })
    ]);
    expect(colors.map((c) => c.hex).sort()).toEqual(["#0000ff", "#ff0000"]);
  });

  it("counts a stack once, not once per layer", () => {
    const colors = collect([
      rect({ id: "a", fills: [solid("#ff0000"), solid("#ff0000"), solid("#ff0000")] })
    ]);
    expect(colors[0].count).toBe(1);
  });

  it("reads the top VISIBLE layer, so a hidden one contributes no colour", () => {
    const colors = collect([
      rect({ id: "a", fills: [solid("#111111"), solid("#222222", { enabled: false })] })
    ]);
    expect(colors).toHaveLength(1);
    expect(colors[0].hex).toBe("#111111");
  });

  it("skips hidden elements entirely", () => {
    const colors = collect([rect({ id: "a", visible: false, fills: [solid("#123456")] })]);
    expect(colors).toHaveLength(0);
  });

  it("orders most-used first, then alphabetically, so the strip does not reshuffle", () => {
    const colors = collect([
      rect({ id: "a", fills: [solid("#00ff00")] }),
      rect({ id: "b", fills: [solid("#ff0000")] }),
      rect({ id: "c", fills: [solid("#ff0000")] })
    ]);
    expect(colors.map((c) => c.hex)).toEqual(["#ff0000", "#00ff00"]);
  });

  it("lists a gradient as one entry, and leaves an image out entirely", () => {
    const colors = collect([
      rect({
        id: "g",
        fills: [{ type: "linear-gradient", from: "#ff0000", to: "#0000ff", angle: 90, stops: [{ color: "#ff0000", offset: 0 }, { color: "#00ff00", offset: 0.5 }] } as any]
      }),
      rect({ id: "i", fills: [{ type: "image", assetId: "a1" } as any] })
    ]);
    // A gradient is one row however many stops it has. An image is no row at all:
    // it is not a colour, and a row that can neither be edited nor usefully located
    // only makes the palette harder to read. Its fill is still in the layer's own
    // Fill section, so nothing is lost.
    expect(colors.map((c) => c.kind)).toEqual(["gradient"]);
    expect(colors[0].elementIds, "the image layer is not in the palette at all").toEqual(["g"]);
  });

  it("carries the layer it found, so a gradient is editable as the gradient it is", () => {
    const layer = { type: "linear-gradient", from: "#ff0000", to: "#0000ff", angle: 45, stops: [{ color: "#ff0000", offset: 0 }, { color: "#0000ff", offset: 1 }] } as any;
    const [color] = collect([rect({ id: "g", fills: [layer] })]);
    // A CSS key can be rendered from these stops but not parsed back into an
    // angle and an offset list, and the editor needs the real thing.
    expect(color.paint).toEqual(layer);
  });

  it("keeps a solid's alpha on the paint it carries, not just on the label", () => {
    const [color] = collect([rect({ id: "a", fills: [solid("rgba(255, 0, 0, 0.4)")] })]);
    expect((color.paint as any).color).toBe("rgba(255, 0, 0, 0.4)");
    expect(color.alpha).toBe(40);
  });

  it("is empty for elements with no fill at all", () => {
    expect(collect([rect({ id: "a" })])).toEqual([]);
  });
});

/**
 * A selection is its subtrees. Selecting a card is selecting what is inside it, and
 * a frame normally has no fill of its own — so reading only the selected nodes
 * reported an empty palette for a selection that is visibly three colours.
 */
describe("collectSelectedColors resolves children", () => {
  const frame = (children: DesignElement[]) =>
    ({ id: "card", type: "frame", x: 0, y: 0, width: 300, height: 200, children }) as any;

  it("lists the colours of a frame's children", () => {
    const colors = collect([
      frame([
        rect({ id: "hd", fills: [solid("#ff0000")] }),
        rect({ id: "bd", fills: [solid("#00ff00")] })
      ])
    ]);
    expect(colors.map((c) => c.hex).sort()).toEqual(["#00ff00", "#ff0000"]);
  });

  it("counts a child as a layer, and names it for the bulk edit", () => {
    const colors = collect([
      frame([rect({ id: "hd", fills: [solid("#ff0000")] }), rect({ id: "bd", fills: [solid("#ff0000")] })])
    ]);
    const red = colors.find((c) => c.hex === "#ff0000")!;
    expect(red.count).toBe(2);
    expect(red.elementIds.sort()).toEqual(["bd", "hd"]);
  });

  it("includes the frame's own fill when it has one", () => {
    const withFill = { ...frame([rect({ id: "hd", fills: [solid("#00ff00")] })]), fills: [solid("#ff0000")] };
    expect(collect([withFill as any]).map((c) => c.hex).sort()).toEqual(["#00ff00", "#ff0000"]);
  });

  it("reaches grandchildren", () => {
    const nested = frame([frame([rect({ id: "deep", fills: [solid("#0000ff")] })]) as any]);
    expect(collect([nested]).map((c) => c.hex)).toEqual(["#0000ff"]);
  });

  it("skips a hidden child", () => {
    const colors = collect([frame([rect({ id: "hd", visible: false, fills: [solid("#ff0000")] })])]);
    expect(colors).toEqual([]);
  });
});

/**
 * The regression that made this worth writing down: the strip handed the WRITE the
 * selected elements and committed its result as the page's element list, so
 * recolouring a two-layer selection deleted every other layer in the document. Five
 * elements in, two out, and the palette editor was the most destructive command in
 * the app.
 */
describe("applyColorToSelection must not lose the rest of the document", () => {
  const doc = [
    rect({ id: "a", fills: [solid("#ff0000")] }),
    rect({ id: "b", fills: [solid("#ff0000")] }),
    rect({ id: "c", fills: [solid("#00ff00")] }),
    rect({ id: "d", x: 200, fills: [solid("#123456")] }),
    rect({ id: "e", x: 200, y: 100, fills: [solid("#654321")] })
  ];

  it("keeps every element that was not in the selection", () => {
    const target = collect([doc[0]])[0];
    const next = applyColor(doc, target, "#00aaff");
    expect(next.map((e) => e.id)).toEqual(["a", "b", "c", "d", "e"]);
    // An untouched element is returned by reference, so the layer tree does not
    // re-render and undo does not see a change it has to skip.
    expect(next[3]).toBe(doc[3]);
    expect(next[4]).toBe(doc[4]);
  });

  it("rewrites only the layers that carried the colour", () => {
    const target = collect(doc)[0];
    expect(target.elementIds).toEqual(["a", "b"]);
    const next = applyColor(doc, target, "#00aaff");
    expect((next[0].fills as any)[0].color).toBe("#00aaff");
    expect((next[1].fills as any)[0].color).toBe("#00aaff");
    expect((next[2].fills as any)[0].color, "green is not red").toBe("#00ff00");
  });

  it("rewrites a NESTED layer without touching its siblings or its parent", () => {
    const nested = [
      {
        id: "card", type: "frame", x: 0, y: 0, width: 200, height: 200,
        children: [
          rect({ id: "hd", fills: [solid("#ff0000")] }),
          rect({ id: "bd", fills: [solid("#00ff00")] })
        ]
      } as any,
      rect({ id: "outside", x: 400, fills: [solid("#654321")] })
    ];
    const target = collect([nested[0]]).find((c) => c.hex === "#ff0000")!;
    const next = applyColor(nested, target, "#00aaff") as any[];
    expect(next[0].children[0].fills[0].color).toBe("#00aaff");
    expect(next[0].children[1].fills[0].color).toBe("#00ff00");
    expect(next[1]).toBe(nested[1]);
  });
});

describe("applyColorToSelection", () => {
  const red = () => collect([rect({ id: "a", fills: [solid("#ff0000")] })])[0];

  it("rewrites only the layers that carried the colour", () => {
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [solid("#ff0000")] }),
      rect({ id: "b", fills: [solid("#00ff00")] })
    ];
    const target = collect([elements[0]])[0];
    const next = applyColor(elements, target, "#0000ff");
    expect((next[0].fills as any)[0].color).toBe("#0000ff");
    expect((next[1].fills as any)[0].color).toBe("#00ff00");
  });

  it("rewrites every layer that shared the colour", () => {
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [solid("#ff0000")] }),
      rect({ id: "b", fills: [solid("#ff0000")] })
    ];
    const target = collect(elements)[0];
    expect(target.count).toBe(2);
    const next = applyColor(elements, target, "#00ff00");
    expect((next[0].fills as any)[0].color).toBe("#00ff00");
    expect((next[1].fills as any)[0].color).toBe("#00ff00");
  });

  it("writes the TOP layer and leaves the ones under it alone", () => {
    const elements: DesignElement[] = [rect({ id: "a", fills: [solid("#111111"), solid("#ff0000")] })];
    const target = collect(elements)[0];
    expect(target.hex).toBe("#ff0000");
    const next = applyColor(elements, target, "#0000ff");
    const fills = next[0].fills as any[];
    expect(fills[0].color).toBe("#111111");
    expect(fills[1].color).toBe("#0000ff");
  });

  it("preserves the layer's own blend mode, opacity and enabled flag", () => {
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [solid("#ff0000", { blendMode: "multiply", opacity: 0.5, enabled: true })] })
    ];
    const target = collect(elements)[0];
    const next = applyColor(elements, target, "#0000ff");
    const paint = (next[0].fills as any[])[0];
    expect([paint.blendMode, paint.opacity, paint.enabled]).toEqual(["multiply", 0.5, true]);
  });

  it("refuses to rewrite a gradient or an image, which have no colour to replace", () => {
    const elements: DesignElement[] = [rect({ id: "g", fills: [{ type: "linear-gradient", from: "#f00", to: "#00f", angle: 0 } as any] })];
    const target = collect(elements)[0];
    expect(applyColor(elements, target, "#0000ff")).toBe(elements);
  });

  it("returns the same list when nothing matched", () => {
    const elements: DesignElement[] = [rect({ id: "b", fills: [solid("#00ff00")] })];
    const target = collect([rect({ id: "a", fills: [solid("#ff0000")] })])[0];
    expect(applyColor(elements, target, "#0000ff")).toBe(elements);
  });

  it("carries an alpha through the replacement", () => {
    const elements: DesignElement[] = [rect({ id: "a", fills: [solid("#ff0000")] })];
    const target = collect([rect({ id: "a", fills: [solid("#ff0000")] })])[0];
    const next = applyColor(elements, target, "rgba(0, 0, 255, 0.4)");
    expect((next[0].fills as any[])[0].color).toBe("rgba(0, 0, 255, 0.4)");
  });
});

/**
 * A gradient row used to be a swatch that looked editable and was not: the entry
 * carried a CSS string and no stops, so there was nothing to open an editor on
 * and nothing to write back. The whole paint now rides along, so the gradient is
 * as editable as the solid beside it.
 */
describe("applyPaintToSelection edits a gradient", () => {
  const gradient = (extra: Record<string, unknown> = {}) =>
    ({
      type: "linear-gradient",
      from: "#ff0000",
      to: "#0000ff",
      angle: 90,
      stops: [
        { color: "#ff0000", offset: 0 },
        { color: "#0000ff", offset: 1 }
      ],
      ...extra
    }) as any;

  const twoGradients = (): DesignElement[] => [
    rect({ id: "a", fills: [gradient()] }),
    rect({ id: "b", y: 200, fills: [gradient()] }),
    rect({ id: "c", y: 400, fills: [solid("#00ff00")] })
  ];

  it("writes the edited stops onto every layer that shared the gradient", () => {
    const target = collect([twoGradients()[0], twoGradients()[1]])[0];
    expect(target.kind).toBe("gradient");
    const next = applyPaint(twoGradients(), target, gradient({ stops: [{ color: "#00ff00", offset: 0 }, { color: "#ffff00", offset: 1 }] }));
    expect((next[0].fills as any[])[0].stops).toEqual([{ color: "#00ff00", offset: 0 }, { color: "#ffff00", offset: 1 }]);
    expect((next[1].fills as any[])[0].stops).toEqual([{ color: "#00ff00", offset: 0 }, { color: "#ffff00", offset: 1 }]);
    expect((next[2].fills as any[])[0].color, "a solid is not in the entry").toBe("#00ff00");
  });

  it("refuses a cross-kind write by default, so a stray hex cannot flatten a gradient", () => {
    const target = collect([rect({ id: "a", fills: [gradient()] })])[0];
    const next = applyPaint([rect({ id: "a", fills: [gradient()] })], target, solid("#00ff00"));
    expect((next[0].fills as any[])[0].type, "the gradient must survive").toBe("linear-gradient");
  });

  it("converts the kind when the caller says the change came from the switcher", () => {
    // The guard above and this one are the same line of code. The strip's panel can
    // now switch solid <-> gradient, and an EXPLICIT switch has to land or the
    // control is a button that does nothing.
    const elements = [rect({ id: "a", fills: [gradient()] })];
    const target = collect(elements)[0];
    const next = applyPaintToSelection(docOf(elements), elements, target, solid("#00ff00"), {
      allowKindChange: true
    });
    expect((next[0].fills as any[])[0].type).toBe("solid");
    expect((next[0].fills as any[])[0].color).toBe("#00ff00");
  });

  it("still refuses an image even when a kind change is allowed", () => {
    // An image has no colour of its own, so it is not an entry this strip can
    // hold. Allowing kind changes must not open that door.
    const elements = [rect({ id: "a", fills: [solid("#00ff00")] })];
    const target = collect(elements)[0];
    const next = applyPaintToSelection(
      docOf(elements),
      elements,
      target,
      { type: "image", assetId: "a1" } as any,
      { allowKindChange: true }
    );
    expect((next[0].fills as any[])[0].type).toBe("solid");
  });

  it("keeps the angle, because a gradient's direction is part of what it is", () => {
    const target = collect([rect({ id: "a", fills: [gradient()] })])[0];
    const next = applyPaint([rect({ id: "a", fills: [gradient()] })], target, gradient({ angle: 0 }));
    expect((next[0].fills as any[])[0].angle).toBe(0);
  });

  /**
   * The entry is one entry by what it LOOKS like, so two layers can share a
   * gradient and differ only in how it composites. The editor returns the paint it
   * was opened on, so writing it back would hand the second layer the first one's
   * opacity — a change nobody made and nobody could see was requested.
   */
  it("leaves each layer's own opacity alone", () => {
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [gradient()] }),
      rect({ id: "b", y: 200, fills: [gradient({ opacity: 0.5 })] })
    ];
    const target = collect(elements)[0];
    const next = applyPaint(elements, target, gradient({ opacity: 1 }));
    expect((next[0].fills as any[])[0].opacity).toBeUndefined();
    expect((next[1].fills as any[])[0].opacity).toBe(0.5);
  });

  it("does not leave a field the layer never had, just because the editor had one", () => {
    const elements: DesignElement[] = [rect({ id: "a", fills: [gradient()] })];
    const target = collect(elements)[0];
    const next = applyPaint(elements, target, gradient({ opacity: 0.5 }));
    // `toBeUndefined` would not catch this: the key is what survives a save.
    expect("opacity" in ((next[0].fills as any[])[0] as object)).toBe(false);
  });

  it("refuses to write over an image fill, which has no colour to replace", () => {
    const elements: DesignElement[] = [rect({ id: "a", fills: [{ type: "image", assetId: "x" } as any] })];
    // Hand-built, because an image layer is no longer in the palette — the guard is
    // what stands between a stale id and a rewrite, so it is tested directly.
    const target: SelectedColor = {
      hex: "#ff0000",
      alpha: 100,
      count: 1,
      elementIds: ["a"],
      channel: "fill",
      kind: "solid",
      paint: solid("#ff0000") as any
    };
    expect(applyPaint(elements, target, solid("#00ff00") as any)).toBe(elements);
    expect(applyPaint(elements, target, { type: "image", assetId: "y" } as any)).toBe(elements);
  });

  it("refuses a paint of a different kind than the layer it would land on", () => {
    const elements: DesignElement[] = [rect({ id: "a", fills: [solid("#ff0000")] })];
    const target = collect(elements)[0];
    expect(applyPaint(elements, target, gradient())).toBe(elements);
  });

  it("writes a solid through the same path, keeping the layer's compositing", () => {
    const elements: DesignElement[] = [rect({ id: "a", fills: [solid("#ff0000", { blendMode: "multiply" })] })];
    const target = collect(elements)[0];
    const next = applyPaint(elements, target, { type: "solid", color: "#00aaff" } as any);
    const paint = (next[0].fills as any[])[0];
    expect([paint.color, paint.blendMode]).toEqual(["#00aaff", "multiply"]);
  });
});

describe("selectedColorCss", () => {
  it("renders an opaque colour as the hex", () => {
    const c = collect([rect({ id: "a", fills: [solid("#ff0000")] })])[0];
    expect(selectedColorCss(c)).toBe("#ff0000");
  });

  it("appends the alpha byte for a translucent colour", () => {
    const c = collect([rect({ id: "a", fills: [solid("rgba(255, 0, 0, 0.5)")] })])[0];
    expect(selectedColorCss(c)).toBe("#ff000080");
  });

  it("renders a gradient as the CSS that identifies it", () => {
    const c = collect([rect({ id: "a", fills: [{ type: "linear-gradient", from: "#ff0000", to: "#0000ff", angle: 90, stops: [{ color: "#ff0000", offset: 0 }, { color: "#0000ff", offset: 1 }] } as any] })])[0];
    expect(selectedColorCss(c)).toBe(c.hex);
    expect(c.hex).toContain("gradient");
  });
});

/**
 * An instance is a subtree the document does not hold: its children live on the
 * master and are reached by projection, and its own box paints whatever
 * `resolveInstanceBox` says. Before this the strip showed nothing at all for a
 * selected instance, and a colour only its children carried could not be written
 * either — `mapElements` never enters an instance, so the write had nowhere to
 * land and silently changed nothing.
 */
describe("an instance's colours", () => {
  const fixture = (headFill = "#ff0000"): DesignDocument => {
    const card: ComponentElement = {
      id: "card",
      type: "component",
      name: "CARD",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      fills: [solid("#112233")],
      children: [
        rect({ id: "head", fills: [solid(headFill)] }),
        rect({ id: "body", fills: [solid("#00ff00")] })
      ]
    };
    const inst: InstanceElement = {
      id: "cardInst",
      type: "instance",
      name: "CARD",
      componentId: "card",
      x: 400,
      y: 0,
      width: 200,
      height: 80
    };
    return docOf([card, inst]);
  };

  const instanceOf = (doc: DesignDocument) => getActivePage(doc).children[1] as InstanceElement;

  it("lists the projected children and the box the instance actually paints", () => {
    const doc = fixture();
    const colors = collectSelectedColors(doc, [instanceOf(doc)]);
    // #112233 is the MASTER's fill: the instance stores none, and the FILL
    // section above the strip already shows it, so the palette must too.
    expect(colors.map((c) => c.hex).sort()).toEqual(["#00ff00", "#112233", "#ff0000"]);
    const red = colors.find((c) => c.hex === "#ff0000")!;
    expect(red.count).toBe(1);
    // The resolved id, which is what the write turns back into an override.
    expect(red.elementIds).toEqual(["cardInst_head"]);
  });

  it("writes a child's colour as an override, leaving the master alone", () => {
    const doc = fixture();
    const target = collectSelectedColors(doc, [instanceOf(doc)]).find((c) => c.hex === "#ff0000")!;
    const elements = applyColorToSelection(doc, getActivePage(doc).children, target, "#00aaff");

    const master = elements.find((el) => el.id === "card") as ComponentElement;
    expect((master.children[0] as RectElement).fills![0], "the master is not edited").toEqual(solid("#ff0000"));

    expect((elements[1] as InstanceElement).overrides).toEqual([
      { targetId: "head", property: "fills", value: [{ type: "solid", color: "#00aaff" }] }
    ]);
  });

  it("writes an inherited colour onto the instance as its own fills", () => {
    const doc = fixture();
    const target = collectSelectedColors(doc, [instanceOf(doc)]).find((c) => c.hex === "#112233")!;
    expect(target.elementIds).toEqual(["cardInst"]);
    const elements = applyColorToSelection(doc, getActivePage(doc).children, target, "#00aaff");

    expect((elements[1] as InstanceElement).fills, "the instance now owns the stack").toEqual([
      { type: "solid", color: "#00aaff" }
    ]);
    expect((elements[0] as ComponentElement).fills![0], "the master is not edited").toEqual(solid("#112233"));
  });

  it("counts one colour shared by the box and a child as one entry, and writes both", () => {
    const doc = fixture("#112233");
    const target = collectSelectedColors(doc, [instanceOf(doc)]).find((c) => c.hex === "#112233")!;
    expect(target.count).toBe(2);
    expect(target.elementIds).toEqual(["cardInst", "cardInst_head"]);

    const elements = applyColorToSelection(doc, getActivePage(doc).children, target, "#00aaff");
    const inst = elements[1] as InstanceElement;
    expect((inst.fills![0] as { color: string }).color).toBe("#00aaff");
    expect(inst.overrides).toEqual([
      { targetId: "head", property: "fills", value: [{ type: "solid", color: "#00aaff" }] }
    ]);
  });

  it("reads an instance root's style binding off the master, the way FILL does", () => {
    const doc = fixture();
    const style: PaintStyle = {
      id: "cardBg",
      styleType: "paint",
      name: "Card BG",
      paints: [solid("#112233")]
    };
    doc.styles = [style];
    ((doc.pages![0].children[0]) as ComponentElement).fillStyleId = "cardBg";

    const target = collectSelectedColors(doc, [instanceOf(doc)]).find((c) => c.hex === "#112233")!;
    // A row claiming a literal hex here would fork the instance away from the
    // style it is still bound to the moment it was edited.
    expect(boundFillStyleFor(doc, target)).toBe(style);
  });

  it("a stroke entry writes the STROKE, and leaves the fill alone", () => {
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [solid("#ffffff")], strokes: [{ width: 2, color: "#ff0000" }] })
    ];
    const stroke = collect(elements).find((c) => c.channel === "stroke")!;
    const next = applyColor(elements, stroke, "#00ff00");
    expect((next[0].fills as { color: string }[])[0].color).toBe("#ffffff");
    expect((next[0].strokes as { color?: string }[])[0].color).toBe("#00ff00");
  });

  it("a stroke edit writes the stack, never a second singular spelling", () => {
    const elements: DesignElement[] = [rect({ id: "a", strokes: [{ width: 2, color: "#ff0000" }] })];
    const stroke = collect(elements)[0];
    const next = applyColor(elements, stroke, "#00ff00");
    expect((next[0] as { stroke?: unknown }).stroke).toBeUndefined();
    expect((next[0].strokes as Array<{ color: string }>)[0].color).toBe("#00ff00");
  });

  it("rewrites nothing for an id that is neither stored nor resolvable", () => {
    const doc = fixture();
    const elements = getActivePage(doc).children;
    const target: SelectedColor = {
      hex: "#ff0000",
      alpha: 100,
      count: 1,
      elementIds: ["gone"],
      channel: "fill",
      kind: "solid",
      paint: solid("#ff0000") as unknown as Paint
    };
    expect(applyColorToSelection(doc, elements, target, "#00aaff")).toBe(elements);
  });
});

describe("collectSelectedColors — patterns", () => {
  const dots = (foreground: string) =>
    ({ type: "pattern", motif: "dots", tile: { width: 8, height: 8 }, foreground }) as unknown as Paint;

  it("lists a pattern as one entry, keyed by the tile it paints", () => {
    const colors = collect([
      rect({ id: "a", fills: [dots("#ff0000")] }),
      rect({ id: "b", fills: [dots("#ff0000")] }),
      rect({ id: "c", fills: [dots("#00ff00")] })
    ]);
    expect(colors).toHaveLength(2);
    const red = colors.find((c) => c.kind === "pattern" && c.hex.includes("#ff0000"))!;
    expect(red.count).toBe(2);
    expect(red.elementIds.sort()).toEqual(["a", "b"]);
    expect(selectedColorCss(red)).toContain("radial-gradient");
  });

  it("rewrites every layer carrying the pattern", () => {
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [dots("#ff0000")] }),
      rect({ id: "b", fills: [dots("#ff0000")] })
    ];
    const next = applyPaint(elements, collect(elements)[0], { ...(dots("#ff0000") as any), motif: "grid" });
    for (const el of next) expect((el.fills as any[])[0].motif).toBe("grid");
  });
});

describe("color tokens in selected-colors", () => {
  const tokenBrand: ColorToken = {
    id: "token_brand",
    name: "Brand / Primary",
    type: "color",
    value: "#2563eb"
  };

  it("separates token-bound colors from raw colors even if hex matches", () => {
    const doc: DesignDocument = {
      ...docOf([]),
      tokens: [tokenBrand]
    };
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [{ type: "solid", color: "#2563eb", tokenId: "token_brand" }] }),
      rect({ id: "b", fills: [{ type: "solid", color: "#2563eb" }] })
    ];
    const colors = collectSelectedColors(doc, elements);
    expect(colors).toHaveLength(2);
    const bound = colors.find((c) => c.tokenId === "token_brand")!;
    const raw = colors.find((c) => !c.tokenId)!;
    expect(bound).toBeDefined();
    expect(bound.count).toBe(1);
    expect(bound.elementIds).toEqual(["a"]);
    expect(boundColorTokenFor(doc, bound)?.name).toBe("Brand / Primary");
    expect(raw).toBeDefined();
    expect(raw.count).toBe(1);
    expect(raw.elementIds).toEqual(["b"]);
    expect(boundColorTokenFor(doc, raw)).toBeNull();
  });

  it("recolors both fills and strokes sharing the target color simultaneously", () => {
    const doc = docOf([]);
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [solid("#ff0000")] }),
      rect({ id: "b", strokes: [{ width: 2, color: "#ff0000" }] }),
      rect({ id: "c", fills: [solid("#ff0000")], strokes: [{ width: 1, color: "#ff0000" }] }),
      rect({ id: "d", fills: [solid("#00ff00")] })
    ];
    doc.pages[0].children = elements;

    const colors = collectSelectedColors(doc, elements);
    const red = colors.find((c) => c.hex === "#ff0000")!;
    expect(red.count).toBe(3);
    expect(red.elementIds.sort()).toEqual(["a", "b", "c"]);

    // Recolor all red instances to blue
    const updated = applyPaintToSelection(doc, elements, red, { type: "solid", color: "#0000ff" });
    const elA = updated.find((e) => e.id === "a") as RectElement;
    const elB = updated.find((e) => e.id === "b") as RectElement;
    const elC = updated.find((e) => e.id === "c") as RectElement;
    const elD = updated.find((e) => e.id === "d") as RectElement;

    expect((elA.fills?.[0] as any)?.color).toBe("#0000ff");
    expect(elB.strokes?.[0]?.color).toBe("#0000ff");
    expect((elC.fills?.[0] as any)?.color).toBe("#0000ff");
    expect(elC.strokes?.[0]?.color).toBe("#0000ff");
    // elD untouched
    expect((elD.fills?.[0] as any)?.color).toBe("#00ff00");
  });

  it("binds both fill and stroke to a color token in bulk", () => {
    const doc: DesignDocument = {
      ...docOf([]),
      tokens: [tokenBrand]
    };
    const elements: DesignElement[] = [
      rect({ id: "a", fills: [solid("#ff0000")] }),
      rect({ id: "b", strokes: [{ width: 2, color: "#ff0000" }] })
    ];
    doc.pages[0].children = elements;

    const [red] = collectSelectedColors(doc, elements);
    const updated = applyPaintToSelection(doc, elements, red, {
      type: "solid",
      color: "#2563eb",
      tokenId: "token_brand"
    });

    const elA = updated.find((e) => e.id === "a") as RectElement;
    const elB = updated.find((e) => e.id === "b") as RectElement;
    expect(elA.fills?.[0]?.tokenId).toBe("token_brand");
    // A token is a VALUE and a fill style is a POINTER at doc.styles. Binding a
    // token must fill `tokenId` only — writing the same id into `paintStyleId`
    // (as this did) put a `tok_…` where every reader looks for a style id.
    expect(elB.strokes?.[0]?.tokenId).toBe("token_brand");
    expect(elB.strokes?.[0]?.paint?.tokenId).toBe("token_brand");
  });
});
