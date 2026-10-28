import { flattenLayout } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, expect, it } from "vitest";
import { geometryReport } from "../src/core/geometry-report";
import { relayoutDocumentTree } from "../src/core/compile";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { validateDocument } from "../src/core/validate";
import type { DesignDocument } from "../src/core/dsl/types";

// Normalized first, because that is what the CLI hands it: without the pass
// every text measures 0×0 and a hugging container hugs nothing, which would pin
// the wrong numbers.
const doc = (elements: unknown[]): DesignDocument =>
  normalizeDesignDocument({ version: "0.1", canvas: { width: 1200, height: 800 }, elements })
    .document as DesignDocument;

const kinds = (elements: unknown[]) => geometryReport(doc(elements)).map((f) => f.kind);

/**
 * These pin the measurements a probe produced once, not a guess about them:
 * a stack with `sizing.height: fit-content` measures 144 tall and 0 without it,
 * a plain frame's children keep the coordinates they were authored at, an
 * `absolute` child sits outside the box it was placed in and does not count
 * towards it, and a text with no width mode measures 569 in a 312 content box.
 */
describe("geometry report", () => {
  it("says nothing about a stack that fits", () => {
    expect(
      kinds([
        {
          id: "card",
          type: "frame",
          width: 360,
          sizing: { height: "fit-content" },
          ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
          children: [
            { id: "a", type: "rect", width: 100, height: 40 },
            { id: "b", type: "rect", width: 100, height: 40 }
          ]
        }
      ])
    ).toEqual([]);
  });

  // An auto-layout container now hugs when it was told nothing, so the collapse
  // this used to report no longer happens — measured: 24 + 40 + 16 + 40 + 24.
  it("leaves an auto-layout container alone, because it hugs by default now", () => {
    expect(
      kinds([
        {
          id: "card",
          type: "frame",
          width: 360,
          fills: [{ type: "solid", color: "#141414" }],
          ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
          children: [
            { id: "a", type: "rect", width: 100, height: 40 },
            { id: "b", type: "rect", width: 100, height: 40 }
          ]
        }
      ])
    ).toEqual([]);
    const hugged = relayoutDocumentTree(
      getActivePage(doc([
        {
          id: "card",
          type: "frame",
          width: 360,
          ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
          children: [
            { id: "a", type: "rect", width: 100, height: 40 },
            { id: "b", type: "rect", width: 100, height: 40 }
          ]
        }
      ])).children
    );
    expect(Math.round((hugged[0] as any).height)).toBe(144);
  });

  // The box can still be collapsed on purpose, and then paint on it is still a
  // defect — that is what zero-size is for.
  it("reports a container explicitly given a zero height while carrying paint", () => {
    const found = geometryReport(
      doc([
        {
          id: "card",
          type: "frame",
          width: 360,
          height: 0,
          fills: [{ type: "solid", color: "#141414" }],
          children: [{ id: "a", type: "rect", width: 100, height: 40 }]
        }
      ])
    );
    const zero = found.find((f) => f.kind === "zero-size");
    expect(zero, "a 0-height frame carrying a fill went unreported").toBeTruthy();
    expect(zero!.level).toBe("warning");
  });

  // A frame with no paint and no clipping is a structural wrapper: its own box
  // collapsing is invisible, so reporting it would be noise on a real pattern.
  it("says nothing about a collapsed container that paints nothing", () => {
    expect(
      kinds([
        {
          id: "wrapper",
          type: "frame",
          width: 360,
          ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
          children: [{ id: "a", type: "rect", width: 100, height: 40 }]
        }
      ])
    ).toEqual([]);
  });

  // Free placement is what a plain frame is for: two children authored on top of
  // each other are a design, not a defect.
  it("says nothing about children of a plain frame that overlap", () => {
    expect(
      kinds([
        {
          id: "plain",
          type: "frame",
          width: 360,
          height: 200,
          children: [
            { id: "a", type: "rect", x: 0, y: 0, width: 100, height: 40 },
            { id: "b", type: "rect", x: 10, y: 10, width: 100, height: 40 }
          ]
        }
      ])
    ).toEqual([]);
  });

  // An absolute child is an overlay by definition, and it is excluded from the
  // parent's hugged size — so it is outside the box on purpose.
  it("says nothing about an absolute child placed outside its parent", () => {
    expect(
      kinds([
        {
          id: "card",
          type: "frame",
          width: 360,
          sizing: { height: "fit-content" },
          ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
          children: [
            { id: "a", type: "rect", width: 100, height: 40 },
            { id: "badge", type: "rect", x: 300, y: 300, width: 24, height: 24, position: "absolute" }
          ]
        }
      ])
    ).toEqual([]);
  });

  // It used to measure 569 in a 312 content box and not wrap. Text in a layout
  // parent now defaults to fit-content, so it wraps to the box instead.
  it("wraps a text that was given no width mode, instead of measuring it past the card", () => {
    const body = (
      relayoutDocumentTree(
        getActivePage(doc([
          {
            id: "card",
            type: "frame",
            width: 360,
            sizing: { height: "fit-content" },
            ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
            children: [{ id: "body", type: "text", content: "A ".repeat(29), style: { fontSize: 14 } }]
          }
        ])).children
      )[0] as any
    ).children[0];
    // 312 is the content box: 360 minus 24 padding on each side. It used to be 569.
    expect(Math.round(body.width), "569 wide in a 312 box — the old default came back").toBe(312);
  });

  it("reports a child that overflows because it was told not to wrap", () => {
    const found = geometryReport(
      doc([
        {
          id: "card",
          type: "frame",
          width: 360,
          sizing: { height: "fit-content" },
          ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
          children: [
            { id: "body", type: "text", content: "A ".repeat(29), style: { fontSize: 14 }, sizing: { width: "max-content" } }
          ]
        }
      ])
    );
    const over = found.find((f) => f.kind === "overflow");
    expect(over, "a max-content text wider than its card went unreported").toBeTruthy();
    expect(over!.level).toBe("info");
    expect(over!.message).toContain("312");
  });

  it("reports a child cut by a clipping parent, as info, with the amount", () => {
    const found = geometryReport(
      doc([
        {
          id: "photo_frame",
          type: "frame",
          width: 100,
          height: 100,
          clipContent: true,
          children: [{ id: "photo", type: "rect", x: 0, y: 0, width: 140, height: 100 }]
        }
      ])
    );
    const cut = found.find((f) => f.kind === "clipped");
    expect(cut, "a child cut by clipContent went unreported").toBeTruthy();
    expect(cut!.level).toBe("info");
    expect(cut!.message).toContain("40px");
    // The fix has to name the spelling the dialect accepts, not the internal one.
    expect(cut!.message).toContain('"overflow": "visible"');
  });

  it("measures a turned child by the envelope it paints, not the box it was authored in", () => {
    // A 220×40 horizontal label turned 90° paints a 40×220 column. Its stored
    // x is outside the frame, so the unturned box reported a 90px cut that no
    // pixel ever showed.
    const vertical = geometryReport(
      doc([
        {
          id: "poster",
          type: "frame",
          width: 400,
          height: 300,
          clipContent: true,
          children: [
            {
              id: "vertical",
              type: "text",
              x: -90,
              y: 130,
              width: 220,
              height: 40,
              rotation: 90,
              content: "SIMPLY MOVING",
              style: { fontFamily: "Inter, sans-serif", fontSize: 32 }
            }
          ]
        }
      ])
    ).filter((f) => f.kind === "clipped");
    expect(vertical, "a label whose turned envelope fits was reported as cut").toHaveLength(0);

    // Turning does not excuse a real cut: 120×40 at x -60 becomes a 40×120
    // column at x -20, so the honest number is 20px, not the authored 60.
    const stillCut = geometryReport(
      doc([
        {
          id: "poster",
          type: "frame",
          width: 400,
          height: 300,
          clipContent: true,
          children: [
            { id: "bar", type: "rect", x: -60, y: 50, width: 120, height: 40, rotation: 90 }
          ]
        }
      ])
    ).find((f) => f.kind === "clipped");
    expect(stillCut, "a turned envelope that really crosses the clip went unreported").toBeTruthy();
    expect(stillCut!.message).toContain("20px");
  });

  it("does not report clipped on bleeding atmospheric glows with screen blend or radial gradient", () => {
    const found = geometryReport(
      doc([
        {
          id: "card",
          type: "frame",
          width: 300,
          height: 200,
          clipContent: true,
          children: [
            {
              id: "glow1",
              type: "ellipse",
              x: -50,
              y: -50,
              width: 150,
              height: 150,
              blendMode: "screen",
              fills: [{ type: "radial-gradient", from: "#ffffff", to: "#000000" }]
            },
            {
              id: "glow2",
              type: "rect",
              x: 200,
              y: 100,
              width: 150,
              height: 150,
              fills: [{ type: "solid", color: "#3b82f6", blendMode: "plus-lighter" }]
            }
          ]
        }
      ])
    );
    expect(found.filter((f) => f.kind === "clipped")).toHaveLength(0);
  });

  it("never emits an error, so it cannot fail a pipeline on a design choice", () => {
    const found = geometryReport(
      doc([
        {
          id: "frame",
          type: "frame",
          width: 100,
          height: 100,
          clipContent: true,
          children: [
            { id: "a", type: "rect", x: 0, y: 0, width: 140, height: 100 },
            { id: "b", type: "rect", x: -20, y: 0, width: 40, height: 100 }
          ]
        },
        {
          id: "collapsed",
          type: "frame",
          width: 360,
          height: 0,
          fills: [{ type: "solid", color: "#141414" }],
          children: [{ id: "c", type: "rect", width: 100, height: 40 }]
        }
      ])
    );
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.level).not.toBe("error");
  });
});

/**
 * A text with no colour is normalized to black and reports no repair, so on a
 * dark card it is invisible and every diagnostic reads clean. A text on a light
 * card inside a dark page is fine — the card is what it sits on.
 */
describe("invisible text", () => {
  it("speaks up for black text on a dark card, and stays quiet on a light one", () => {
    const dark = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#0D0D0D" } },
        elements: [
          {
            id: "card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#141414" }],
            children: [{ id: "t", type: "text", content: "hi", style: { fontSize: 14 } }]
          }
        ]
      }).document
    );
    expect(dark.some((d) => d.elementId === "t" && /will not read/.test(d.message))).toBe(true);

    const light = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#0D0D0D" } },
        elements: [
          {
            id: "card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#FFFFFF" }],
            children: [{ id: "t", type: "text", content: "hi", style: { fontSize: 14 } }]
          }
        ]
      }).document
    );
    expect(light.some((d) => /will not read/.test(d.message))).toBe(false);
  });

  it("stays quiet for white text on a translucent glass card with rgba fill or opacity", () => {
    const glassRgba = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#0D0D0D" } },
        elements: [
          {
            id: "glass_card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "rgba(255, 255, 255, 0.05)" }],
            children: [{ id: "t", type: "text", content: "Readable title", style: { color: "#FFFFFF", fontSize: 14 } }]
          }
        ]
      }).document
    );
    expect(glassRgba.some((d) => /will not read/.test(d.message))).toBe(false);

    const glassOpacity = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#0D0D0D" } },
        elements: [
          {
            id: "glass_card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#ffffff", opacity: 0.08 }],
            children: [{ id: "t", type: "text", content: "Readable title", style: { color: "#FFFFFF", fontSize: 14 } }]
          }
        ]
      }).document
    );
    expect(glassOpacity.some((d) => /will not read/.test(d.message))).toBe(false);
  });

  it("recognizes pure red #E00000 on dark background as having adequate WCAG contrast", () => {
    const redOnDark = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#121212" } },
        elements: [
          {
            id: "card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#141414" }],
            children: [{ id: "t", type: "text", content: "Error alert", style: { color: "#E00000", fontSize: 14 } }]
          }
        ]
      }).document
    );
    expect(redOnDark.some((d) => d.elementId === "t" && /will not read/.test(d.message))).toBe(false);
  });

  it("suggests accessible color when text contrast is genuinely below 3:1", () => {
    const lowContrast = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#121212" } },
        elements: [
          {
            id: "card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#181818" }],
            children: [{ id: "t", type: "text", content: "Muted text", style: { color: "#222222", fontSize: 14 } }]
          }
        ]
      }).document
    );
    const diag = lowContrast.find((d) => d.elementId === "t" && /will not read/.test(d.message));
    expect(diag).toBeDefined();
    expect(diag?.message).toContain("Recommended readable color: #FFFFFF");
  });

  /**
   * The ratio and the suggestion are only as good as the colour they measured.
   * An `oklch()` ink read as `#000000` reported 1.1:1 against a dark backdrop
   * and recommended a colour for a text that was already light — and the advice
   * is the part an agent acts on.
   */
  it("measures an oklch ink on its real colour, not on black", () => {
    const wideInk = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#101010" } },
        elements: [
          {
            id: "card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#141414" }],
            children: [
              { id: "t", type: "text", content: "Light ink", fills: [{ type: "solid", color: "oklch(0.95 0.02 250)" }], style: { fontSize: 14 } }
            ]
          }
        ]
      }).document
    );
    expect(wideInk.some((d) => d.elementId === "t" && /will not read/.test(d.message))).toBe(false);
  });

  /**
   * A wordmark set in a gradient is not wearing black. `paintSolidColor` only
   * recognised solid layers, so a gradient fell through to the black default and
   * a white→orange title on a dark card came back as 1.1:1 "will not read" —
   * with a colour suggestion telling the agent to change ink that was fine.
   */
  it("reads gradient ink from its stops instead of the black default", () => {
    const gradient = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#101010" } },
        elements: [
          {
            id: "card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#141414" }],
            children: [
              {
                id: "t",
                type: "text",
                content: "Wordmark",
                style: { fontSize: 14 },
                fills: [
                  {
                    type: "linear-gradient",
                    angle: 90,
                    stops: [
                      { color: "#FFFFFF", offset: 0 },
                      { color: "#FF8A00", offset: 1 }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }).document
    );
    expect(gradient.some((d) => d.elementId === "t" && /will not read/.test(d.message))).toBe(false);
  });

  /**
   * Reading the stops has to keep finding a real failure: a gradient whose dark
   * end lands on a dark card loses half the word there, and that is still worth
   * reporting — measured against the stop that fails, not against the whole.
   */
  it("still reports the gradient stop that does go missing", () => {
    const fade = validateDocument(
      normalizeDesignDocument({
        version: "0.1",
        canvas: { width: 400, height: 300, background: { type: "solid", color: "#101010" } },
        elements: [
          {
            id: "card",
            type: "frame",
            width: 300,
            height: 120,
            fills: [{ type: "solid", color: "#141414" }],
            children: [
              {
                id: "t",
                type: "text",
                content: "Half gone",
                style: { fontSize: 14 },
                fills: [
                  {
                    type: "linear-gradient",
                    angle: 90,
                    stops: [
                      { color: "#FFFFFF", offset: 0 },
                      { color: "#0A0A0A", offset: 1 }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }).document
    );
    // Reported at 1.1:1 rather than ~13:1 — the white end reads fine, so only
    // the ratio proves the failing stop was the one that was measured.
    const diag = fade.find((d) => d.elementId === "t" && /will not read/.test(d.message));
    expect(diag).toBeDefined();
    expect(diag?.message).toContain("1.1:1 against backdrop #141414");
  });

  /**
   * Ink that is fully transparent is a decision, not a contrast failure. The
   * check measured only the `hex6` a colour carries, so `transparent` — the
   * engine's own spelling for no ink — read as black and produced a 1.1:1
   * warning with a colour suggestion for text that paints nothing at all.
   */
  it("says nothing about a text whose ink is fully transparent", () => {
    const report = (color: string) =>
      validateDocument(
        normalizeDesignDocument({
          version: "0.1",
          canvas: { width: 400, height: 300, background: { type: "solid", color: "#101010" } },
          elements: [
            {
              id: "card",
              type: "frame",
              width: 300,
              height: 120,
              fills: [{ type: "solid", color: "#141414" }],
              children: [{ id: "t", type: "text", content: "Ink", style: { color, fontSize: 14 } }]
            }
          ]
        }).document
      );
    const warns = (diagnostics: ReturnType<typeof validateDocument>) =>
      diagnostics.some((d) => d.elementId === "t" && /will not read/.test(d.message));

    // The same text carrying real black ink is genuinely unreadable and reported.
    expect(warns(report("#000000"))).toBe(true);
    expect(warns(report("transparent"))).toBe(false);
    expect(warns(report("rgba(0, 0, 0, 0)"))).toBe(false);
  });
});

/**
 * The mirror of overflow, on the axis a column stack distributes.
 *
 * A mobile section authored at a fixed 600 whose two children stop at 120 is the
 * case this exists for: the box is taller than what it holds, and nothing in the
 * document says whether that was meant. Rows are deliberately excluded — every
 * header row would fire.
 */
describe("unused space below a stack", () => {
  const section = (extra: object = {}) => ({
    id: "section",
    type: "frame",
    width: 375,
    height: 600,
    fills: [{ type: "solid", color: "#F5F5F5" }],
    ...flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24 }),
    children: [
      { id: "a", type: "rect", width: 327, height: 40 },
      { id: "b", type: "rect", width: 327, height: 40 }
    ],
    ...extra
  });

  it("reports the gap in a fixed-height column", () => {
    const found = geometryReport(doc([section()])).filter((f) => f.kind === "unused-space");
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("info");
    expect(found[0].elementId).toBe("section");
    expect(found[0].message).toContain("456px unused");
    expect(found[0].message).toContain('"justify-content": "space-between"');
  });

  it("says nothing when the box hugs its content", () => {
    expect(kinds([section({ height: undefined, sizing: { height: "fit-content" } })])).not.toContain("unused-space");
  });

  it("says nothing when the gap is meant to be distributed", () => {
    expect(kinds([section(flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24, justify: "space-between" }))]))
      .not.toContain("unused-space");
    expect(kinds([section(flattenLayout({ mode: "flex", direction: "column", gap: 16, padding: 24, justify: "center" }))]))
      .not.toContain("unused-space");
  });

  it("says nothing about a row", () => {
    // A row's children end at their own widths; 375 wide with 327 of content is
    // a normal header, not a defect.
    const row = section(flattenLayout({ mode: "flex", direction: "row", gap: 16, padding: 24 }));
    expect(kinds([row])).not.toContain("unused-space");
  });

  it("says nothing when the content fills the box", () => {
    const full = section({
      children: [
        { id: "a", type: "rect", width: 327, height: 250 },
        { id: "b", type: "rect", width: 327, height: 250 }
      ]
    });
    expect(kinds([full])).not.toContain("unused-space");
  });

  it("ignores an absolute child, which is not in the flow", () => {
    const floating = section({
      children: [
        { id: "a", type: "rect", width: 327, height: 40 },
        { id: "b", type: "rect", width: 327, height: 40 },
        { id: "fab", type: "rect", x: 300, y: 500, width: 56, height: 56, position: "absolute" }
      ]
    });
    const found = geometryReport(doc([floating])).filter((f) => f.kind === "unused-space");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("456px unused");
  });
});
