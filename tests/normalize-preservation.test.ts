import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { getGradientStops } from "../src/core/geometry/gradient-utils";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * Normalization runs on every load AND every save, so a field it forgets is a
 * field the user cannot keep: the loss is silent, permanent, and only shows up
 * after a reload. Each case here is a field an app surface writes and the
 * renderer reads, so the writer exists, the reader exists, and only the
 * normalizer did not.
 */

const doc = (elements: unknown[]): DesignDocument =>
  ({
    docId: "d",
    version: "0.1",
    name: "n",
    canvas: { width: 1440, height: 900, background: { type: "solid", color: "#FFFFFF" } },
    pages: [{ id: "p1", name: "P1", children: elements }]
  }) as unknown as DesignDocument;

const only = (d: DesignDocument): DesignElement => d.pages[0].children[0] as DesignElement;

/** Normalizing twice must reach a fixed point, or a save keeps mutating the file. */
const twice = (input: unknown, preserveUnknown = true) => {
  const first = normalizeDesignDocument(input as DesignDocument, { preserveUnknown });
  const second = normalizeDesignDocument(first.document, { preserveUnknown });
  return { first, second };
};

describe("normalize preserves authored paint and stroke state", () => {
  it("keeps a disabled paint layer disabled", () => {
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          fills: [
            { type: "solid", color: "#ff0000", enabled: false },
            { type: "solid", color: "#00ff00" }
          ]
        }
      ])
    );
    const fills = (only(second.document) as any).fills;
    expect(fills[0].enabled).toBe(false);
    expect(fills[1].enabled).toBeUndefined();
    expect(second.repairs).toEqual([]);
  });

  /**
   * `spread` is what makes `box-shadow: 0 0 0 1px <c>` a ring on either shadow
   * kind. `innerShadowFrom` had no branch for it, so an inset ring the importer
   * wrote came back without one on the first save — the shadow then sat exactly
   * under its own shape and drew nothing.
   */
  it("keeps a shadow's spread", () => {
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          effects: [
            { type: "inner-shadow", color: "#242428", offset: { x: 0, y: 0 }, blur: 0, spread: 1 },
            { type: "drop-shadow", color: "#D9B441", offset: { x: 0, y: 0 }, blur: 0, spread: 1 }
          ]
        }
      ])
    );
    const effects = (only(second.document) as any).effects;
    expect(effects.map((e: any) => e.spread)).toEqual([1, 1]);
    expect(second.repairs).toEqual([]);
  });

  it("keeps every stop of a multi-stop gradient", () => {
    const stops = [
      { color: "#00ff00", offset: 0 },
      { color: "#888888", offset: 0.5 },
      { color: "#0000ff", offset: 1 }
    ];
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          fills: [{ type: "linear-gradient", from: "#00ff00", to: "#0000ff", angle: 90, stops }]
        }
      ])
    );
    const fill = (only(second.document) as any).fills[0];
    expect(fill.stops).toEqual(stops);
    expect(getGradientStops(fill)).toEqual(stops);
    expect(second.repairs).toEqual([]);
  });

  it("keeps a gradient whose endpoints match but whose middle does not", () => {
    // red -> green -> red: `from === to` used to collapse it to a solid and drop
    // the middle stop. Flatness is a property of the stops, not of the endpoints.
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          fills: [
            { type: "linear-gradient", from: "#ff0000", to: "#ff0000", angle: 90, stops: [
              { color: "#ff0000", offset: 0 },
              { color: "#00ff00", offset: 0.5 },
              { color: "#ff0000", offset: 1 }
            ] }
          ]
        }
      ])
    );
    const fill = (only(second.document) as any).fills[0];
    expect(fill.type).toBe("linear-gradient");
    expect(getGradientStops(fill).map((s) => s.color)).toEqual(["#ff0000", "#00ff00", "#ff0000"]);
  });

  it("still collapses a genuinely flat ramp to a solid", () => {
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          fills: [{ type: "linear-gradient", from: "#ff0000", to: "#ff0000", angle: 90 }]
        }
      ])
    );
    expect((only(second.document) as any).fills[0]).toMatchObject({ type: "solid", color: "#ff0000" });
  });

  it("keeps gradient endpoint offsets", () => {
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          fills: [{ type: "linear-gradient", from: "#00ff00", to: "#0000ff", angle: 90, fromOffset: 0.2, toOffset: 0.8 }]
        }
      ])
    );
    const fill = (only(second.document) as any).fills[0];
    expect(fill.fromOffset).toBe(0.2);
    expect(fill.toOffset).toBe(0.8);
  });

  it("keeps stroke line cap and join", () => {
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          strokes: [{ color: "#000", width: 2, cap: "round", join: "bevel" }]
        }
      ])
    );
    const stroke = (only(second.document) as any).strokes[0];
    expect(stroke.cap).toBe("round");
    expect(stroke.join).toBe("bevel");
  });

  it("ignores an unrecognised cap or join rather than writing it through", () => {
    const { second } = twice(
      doc([
        {
          id: "a", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10,
          strokes: [{ color: "#000", width: 2, cap: "onion", join: "sharp" }]
        }
      ])
    );
    const stroke = (only(second.document) as any).strokes[0];
    expect(stroke.cap).toBeUndefined();
    expect(stroke.join).toBeUndefined();
  });

  it("preserves explicit empty fills array on shapes without generating repairs", () => {
    const { first, second } = twice(
      doc([
        {
          id: "wireframe-rect",
          type: "rect",
          name: "border-only",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          fills: [],
          strokes: [{ color: "#000000", width: 1 }]
        },
        {
          id: "wireframe-ellipse",
          type: "ellipse",
          name: "circle-border",
          x: 100,
          y: 0,
          width: 50,
          height: 50,
          fills: [],
          strokes: [{ color: "#000000", width: 1 }]
        }
      ]),
      false
    );
    expect((first.document.pages[0].children[0] as any).fills).toEqual([]);
    expect((first.document.pages[0].children[1] as any).fills).toEqual([]);
    expect(first.repairs).toEqual([]);
    expect(second.repairs).toEqual([]);
  });
});

describe("normalize preserves a text's glyph outline", () => {
  // The importer writes it and a mask reads it, so a normalizer that forgets the
  // key loses the mask's geometry on the first load — and the file still opens,
  // still shows the text, and clips the layer under it to the wrong shape.
  const text = (extra: Record<string, unknown> = {}): unknown => ({
    id: "t",
    type: "text",
    content: "Aa",
    style: { color: "#000000", fontSize: 10 },
    outline: { d: "M0 0 H40 V10 H0 Z" },
    ...extra
  });

  const once = (element: unknown) => normalizeDesignDocument(doc([element]));
  const read = (d: DesignDocument) => (only(d) as unknown as { outline?: { d: string; fillRule?: string } }).outline;

  it("survives a load, which is where a key the engine never reads is lost", () => {
    const { document, repairs } = once(text());
    expect(read(document)?.d).toBe("M0 0 H40 V10 H0 Z");
    expect(repairs.filter((r) => r.message.includes("outline"))).toEqual([]);
  });

  it("survives the fill rule, which is what makes the counters holes", () => {
    const { document } = once(text({ outline: { d: "M0 0 H8 V8 H0 Z", fillRule: "evenodd" } }));

    expect(read(document)?.fillRule).toBe("evenodd");
  });
});

describe("normalize does not discard top-level elements", () => {
  it("adopts top-level elements when no page carries any", () => {
    const { first } = twice({
      docId: "d",
      version: "0.1",
      name: "n",
      elements: [{ id: "orphan", type: "rect", name: "o", x: 0, y: 0, width: 5, height: 5 }],
      pages: [{ id: "p1", name: "P1" }]
    });
    expect(first.document.pages[0].children.map((e) => e.id)).toEqual(["orphan"]);
    // The adoption is recorded, so a repair log can never claim a clean file
    // while content moved.
    expect(first.repairs.some((r) => r.path === "/elements")).toBe(true);
  });

  it("reports, rather than hides, a top-level array the pages supersede", () => {
    const { first } = twice({
      docId: "d",
      version: "0.1",
      name: "n",
      elements: [{ id: "top", type: "rect", name: "t", x: 0, y: 0, width: 5, height: 5 }],
      pages: [
        { id: "p1", name: "P1", children: [{ id: "own", type: "rect", name: "w", x: 0, y: 0, width: 5, height: 5 }] }
      ]
    });
    expect(first.document.pages[0].children.map((e) => e.id)).toEqual(["own"]);
    expect(first.repairs.some((r) => r.path === "/elements" && /ignored/.test(r.message))).toBe(true);
  });
});

/**
 * A token's other values live under a mode, and the mode list is what names
 * them. Losing either half leaves a document that looks correct in light and
 * has no way back to dark — the failure is invisible until someone switches.
 */
describe("normalize preserves the mode half of a design token", () => {
  const themed = (
    styles: unknown[],
    extra: Record<string, unknown> = {},
    tokens: unknown[] = []
  ) => ({
    docId: "d",
    version: "0.1",
    name: "n",
    canvas: { width: 100, height: 100, background: { type: "solid", color: "#FFFFFF" } },
    pages: [{ id: "p1", name: "P1", children: [] }],
    styles,
    ...(tokens.length > 0 ? { tokens } : {}),
    ...extra
  });

  it("keeps the mode list and the selected mode, and reaches a fixed point", () => {
    const { first, second } = twice(
      themed([], { modes: [{ id: "dark", name: "Dark" }], activeTheme: "dark" })
    );
    expect(first.document.modes).toEqual([{ id: "dark", name: "Dark" }]);
    expect(first.document.activeTheme).toBe("dark");
    expect(second.document.modes).toEqual(first.document.modes);
    expect(second.document.activeTheme).toBe("dark");
  });

  it("keeps a colour token's value for every mode", () => {
    const { second } = twice(
      themed(
        [
          { id: "style_card", name: "surface/card", styleType: "paint", paints: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_bg" }] }
        ],
        { modes: [{ id: "dark", name: "Dark" }], activeTheme: "dark" },
        [{ id: "tok_bg", name: "bg/canvas", type: "color", value: "#FFFFFF", modes: { dark: "#0A0A0A" } }]
      )
    );
    const token = second.document.tokens?.[0] as { modes?: Record<string, string> };
    // Hex is lower-cased on the way in: it is a value, not a spelling.
    expect(token.modes?.dark).toBe("#0a0a0a");
  });

  it("keeps a number token's value for every mode", () => {
    const { second } = twice(
      themed(
        [],
        { modes: [{ id: "compact", name: "Compact" }] },
        [{ id: "num_gap", name: "space/md", type: "number", value: 16, category: "spacing", modes: { compact: 12 } }]
      )
    );
    const token = second.document.tokens?.[0] as { modes?: Record<string, number>; value: number };
    expect(token.value).toBe(16);
    expect(token.modes).toEqual({ compact: 12 });
  });

  it("keeps the number axis' own mode list and selection, independently of the colour one", () => {
    const { first, second } = twice(
      themed([], {
        modes: [
          { id: "default", name: "Default" },
          { id: "dark", name: "Dark" }
        ],
        activeTheme: "dark",
        numberModes: [
          { id: "default", name: "Default" },
          { id: "compact", name: "Compact" }
        ],
        activeNumberMode: "compact"
      })
    );
    expect(first.document.modes?.map((m) => m.id)).toEqual(["default", "dark"]);
    expect(first.document.numberModes?.map((m) => m.id)).toEqual(["default", "compact"]);
    expect(first.document.activeNumberMode).toBe("compact");
    expect(second.document.numberModes).toEqual(first.document.numberModes);
    expect(second.document.activeNumberMode).toBe("compact");
  });

  /**
   * A file written before the axes were split filed a number token's per-mode
   * values under the COLOUR mode ids. Adopting those ids as the number axis is
   * what keeps an old document's radii from silently reverting to their base.
   */
  it("adopts a legacy document's colour mode ids as its number axis", () => {
    const { first } = twice(
      themed(
        [],
        {
          modes: [
            { id: "default", name: "Default" },
            { id: "dark", name: "Dark" }
          ],
          activeTheme: "dark"
        },
        [{ id: "num_gap", name: "space/md", type: "number", value: 16, category: "spacing", modes: { dark: 12 } }]
      )
    );
    expect(first.document.numberModes?.map((m) => m.id)).toEqual(["default", "dark"]);
    expect(first.document.activeNumberMode).toBe("dark");
  });

  it("declares no number axis when no number token ever filed a mode value", () => {
    const { first } = twice(
      themed([], {
        modes: [
          { id: "default", name: "Default" },
          { id: "dark", name: "Dark" }
        ]
      })
    );
    // Undeclared is the single `Default` axis the Numbers tab shows; a colour
    // mode must not invent a density column.
    expect(first.document.numberModes).toBeUndefined();
  });

  it("ignores a styleType the dialect does not have", () => {
    const { first, second } = twice(
      themed([
        { id: "num_gap", name: "space/md", styleType: "number", value: 16, category: "spacing" }
      ])
    );
    expect(first.document.styles ?? []).toHaveLength(0);
    expect(first.document.tokens ?? []).toHaveLength(0);
    expect(second.repairs).toEqual([]);
  });

  it("ignores a style's own modes, because a style follows its tokens now", () => {
    const { first, second } = twice(
      themed(
        [
          {
            id: "style_card",
            name: "surface/card",
            styleType: "paint",
            paints: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_bg" }],
            modes: { dark: [{ type: "solid", color: "#0A0A0A" }] }
          }
        ],
        {},
        [{ id: "tok_bg", name: "bg/canvas", type: "color", value: "#FFFFFF", modes: { dark: "#0A0A0A" } }]
      )
    );
    const style = first.document.styles?.[0] as { modes?: unknown; paints: { tokenId?: string }[] };
    expect(style.modes).toBeUndefined();
    // The paint's token link survives: that is where the mode difference lives now.
    expect(style.paints[0].tokenId).toBe("tok_bg");
    expect(second.repairs).toEqual([]);
  });

  it("names an unnamed mode after its id and keeps the first of two that share one", () => {
    const { second } = twice(
      themed([], {
        modes: [
          { id: "dark" },
          { id: "dark", name: "Second Dark" },
          { name: "No id at all" }
        ]
      })
    );
    expect(second.document.modes).toEqual([{ id: "dark", name: "dark" }]);
  });

  /**
   * A stroke row carries its own colour token, and that id is the only thing a
   * theme switch can repaint `color` from. The row kept `paintStyleId` but not
   * `tokenId`, so a token-bound stroke came back as a fixed value on the first
   * save — the layer still looked right in the mode it was authored in.
   */
  it("keeps a stroke row's colour token", () => {
    const { second } = twice(
      themed(
        [],
        {
          pages: [
            {
              id: "p1",
              name: "P1",
              children: [
                {
                  id: "a", type: "path", name: "glyph", x: 0, y: 0, width: 20, height: 20,
                  d: "M 2 2 L 18 18",
                  strokes: [{ color: "#111111", width: 1.6, tokenId: "tok_ink" }]
                }
              ]
            }
          ]
        },
        [{ id: "tok_ink", name: "ink/primary", type: "color", value: "#111111", modes: { dark: "#E8E9EC" } }]
      )
    );
    const stroke = (only(second.document) as { strokes?: { tokenId?: string }[] }).strokes?.[0];
    expect(stroke?.tokenId).toBe("tok_ink");
    expect(second.repairs).toEqual([]);
  });
});

/**
 * The cover frame is written by the context menu and read by the thumbnail
 * generator, and the normalizer did not know the key — so every load that did
 * not preserve unknown properties (the CLI, the headless report) dropped it and
 * the file fell back to its first frame. On a deck that is the board all screens
 * sit on, not the cover the author picked.
 */
describe("normalize preserves the designated cover frame", () => {
  const withCover = {
    ...doc([{ id: "f1", type: "frame", name: "cover", x: 0, y: 0, width: 390, height: 844 }]),
    thumbnailNodeId: "f1"
  };

  it("keeps thumbnailNodeId when unknown properties are not preserved", () => {
    const first = normalizeDesignDocument(withCover as unknown as DesignDocument, { preserveUnknown: false });
    expect(first.document.thumbnailNodeId).toBe("f1");
    expect(first.repairs.some((r) => r.path === "/thumbnailNodeId")).toBe(false);
  });

  it("keeps it across a second pass", () => {
    const { second } = twice(withCover, false);
    expect(second.document.thumbnailNodeId).toBe("f1");
  });
});
