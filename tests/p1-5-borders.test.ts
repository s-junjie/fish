import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { relayoutDocumentTree } from "../src/core/layout/auto-layout";
import { applyOps } from "../src/core/ops/apply-ops";
import { strokeDashAttrs } from "../src/core/geometry/stroke-utils";
import { layoutPadding } from "../src/core/import/html-layout";
import { spacingBindingsOf } from "../src/core/import/html-elements";
import { visualStyleOf } from "../src/core/import/html-style";
import type { DesignDocument, FrameElement } from "../src/core/dsl/types";

function layoutDoc(children: unknown[]) {
  const normalized = normalizeDesignDocument({
    docId: "d1",
    version: "0.1",
    name: "p1-5",
    canvas: { width: 1200, height: 800, backgroundColor: "#FFFFFF" },
    activePageId: "p1",
    pages: [{ id: "p1", name: "P1", children }]
  } as any);
  const laidOut = relayoutDocumentTree(normalized.document.pages[0].children);
  const doc: DesignDocument = {
    ...normalized.document,
    pages: [{ ...normalized.document.pages[0], children: laidOut }]
  };
  return { repairs: normalized.repairs, doc };
}

describe("P1-5: border-box inside-border deduction, multi-side colors/styles, and dotted strokes", () => {
  it("deducts enabled align: inside borders from flex content box (fixed + fill + hug)", () => {
    const { doc, repairs } = layoutDoc([
      {
        id: "card",
        type: "frame",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        display: "flex",
        "flex-direction": "row",
        padding: 10,
        border: "4px solid #111111",
        children: [
          { id: "fill_child", type: "rect", fills: [{ type: "solid", color: "#FFFFFF" }], sizing: { width: "fill", height: "fill" } }
        ]
      },
      {
        id: "hug_card",
        type: "frame",
        x: 0,
        y: 120,
        display: "flex",
        "flex-direction": "row",
        padding: [8, 12, 8, 12],
        "border-top": "2px solid #111111",
        "border-bottom": "4px solid #222222",
        "border-left": "3px dashed #333333",
        children: [
          { id: "fixed_child", type: "rect", fills: [{ type: "solid", color: "#FFFFFF" }], width: 50, height: 20 }
        ]
      }
    ]);
    expect(repairs).toEqual([]);
    const card = doc.pages[0].children[0] as FrameElement;
    const fillChild = card.children[0];
    // 200 - (10 + 4) * 2 = 172, 100 - (10 + 4) * 2 = 72
    expect(fillChild.x).toBe(14);
    expect(fillChild.y).toBe(14);
    expect(fillChild.width).toBe(172);
    expect(fillChild.height).toBe(72);

    const hugCard = doc.pages[0].children[1] as FrameElement;
    // width = (12 + 3) + 50 + (12 + 0) = 77; height = (8 + 2) + 20 + (8 + 4) = 42
    expect(hugCard.width).toBe(77);
    expect(hugCard.height).toBe(42);
    expect(hugCard.children[0].x).toBe(15);
    expect(hugCard.children[0].y).toBe(10);
  });

  it("ignores disabled, center, and outside strokes in content insets and takes max per side for multiple inside layers", () => {
    const { doc } = layoutDoc([
      {
        id: "stacked",
        type: "frame",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        display: "flex",
        padding: 10,
        strokes: [
          { color: "#111111", width: 3, align: "inside" },
          { color: "#222222", width: 5, align: "inside", side: "left" },
          { color: "#333333", width: 20, align: "inside", enabled: false },
          { color: "#444444", width: 20, align: "center" },
          { color: "#555555", width: 20, align: "outside" }
        ],
        children: [{ id: "child", type: "rect", sizing: { width: "fill", height: "fill" } }]
      }
    ]);
    const frame = doc.pages[0].children[0] as FrameElement;
    const child = frame.children[0];
    // left = 10 + max(3, 5) = 15, right/top/bottom = 10 + 3 = 13
    expect(child.x).toBe(15);
    expect(child.y).toBe(13);
    expect(child.width).toBe(200 - 15 - 13);
    expect(child.height).toBe(100 - 13 - 13);
  });

  it("deducts inside borders in grid tracks and percentage children while keeping absolute children relative to border-box", () => {
    const { doc } = layoutDoc([
      {
        id: "grid_box",
        type: "frame",
        x: 0,
        y: 0,
        width: 220,
        height: 120,
        display: "grid",
        "grid-template-columns": 2,
        gap: 10,
        padding: 10,
        border: "5px solid #000000",
        children: [
          { id: "cell1", type: "rect", width: "100%", height: 20 },
          { id: "cell2", type: "rect", width: "50%", height: 20 },
          { id: "badge", type: "rect", position: "absolute", x: 0, y: 0, width: "50%", height: "50%" }
        ]
      }
    ]);
    const grid = doc.pages[0].children[0] as FrameElement;
    // contentW = 220 - (10 + 5) * 2 = 190; 2 equal cols with gap 10 -> 90 each
    expect(grid.children[0].x).toBe(15);
    expect(grid.children[0].y).toBe(15);
    expect(grid.children[0].width).toBe(90);
    // Percentage in-flow child uses contentW (190 * 50% = 95)
    expect(grid.children[1].width).toBe(95);
    // Absolute child still uses border-box (220 * 50% = 110, 120 * 50% = 60)
    expect(grid.children[2].width).toBe(110);
    expect(grid.children[2].height).toBe(60);
  });

  it("splits differing per-side colors and styles into multiple stroke layers cleanly", () => {
    const { doc, repairs } = layoutDoc([
      {
        id: "panel",
        type: "frame",
        x: 0,
        y: 0,
        width: 160,
        height: 80,
        border: "2px solid #111111",
        "border-bottom": "4px dotted #EF4444"
      },
      {
        id: "longhands",
        type: "rect",
        fills: [{ type: "solid", color: "#FFFFFF" }],
        x: 0,
        y: 100,
        width: 160,
        height: 40,
        "border-width": 2,
        "border-color": "#334155",
        "border-style": "solid",
        "border-top-color": "#0EA5E9",
        "border-top-style": "dashed",
        "border-bottom-style": "dotted"
      }
    ]);
    expect(repairs).toEqual([]);
    const panel = doc.pages[0].children[0] as FrameElement;
    expect(panel.strokes).toEqual([
      {
        color: "#111111",
        width: 2,
        style: "solid",
        align: "inside",
        side: "custom",
        sides: { top: 2, right: 2, bottom: 0, left: 2 }
      },
      {
        color: "#EF4444",
        width: 4,
        style: "dotted",
        align: "inside",
        side: "bottom"
      }
    ]);
    expect(strokeDashAttrs(panel.strokes![1])).toEqual({
      strokeDasharray: "0 8",
      strokeLinecap: "round"
    });

    const rect = doc.pages[0].children[1];
    expect(rect.strokes).toEqual([
      {
        color: "#0EA5E9",
        width: 2,
        style: "dashed",
        align: "inside",
        side: "top",
        dashArray: [6, 4]
      },
      {
        color: "#334155",
        width: 2,
        style: "solid",
        align: "inside",
        side: "custom",
        sides: { top: 0, right: 2, bottom: 0, left: 2 }
      },
      {
        color: "#334155",
        width: 2,
        style: "dotted",
        align: "inside",
        side: "bottom"
      }
    ]);
  });

  it("supports patching per-side border colors and dotted style onto an existing bordered element", () => {
    const start = layoutDoc([
      {
        id: "box",
        type: "frame",
        x: 0,
        y: 0,
        width: 120,
        height: 60,
        border: "2px solid #111111"
      }
    ]).doc;
    const { doc: patched, outcomes } = applyOps(start, [
      {
        op: "patch",
        targetId: "box",
        props: {
          "border-bottom-color": "#2563EB",
          "border-bottom-style": "dotted"
        }
      }
    ]);
    expect(outcomes[0].ok).toBe(true);
    const box = patched.pages[0].children[0];
    expect(box.strokes).toEqual([
      {
        color: "#111111",
        width: 2,
        style: "solid",
        align: "inside",
        side: "custom",
        sides: { top: 2, right: 2, bottom: 0, left: 2 }
      },
      {
        color: "#2563EB",
        width: 2,
        style: "dotted",
        align: "inside",
        side: "bottom"
      }
    ]);
  });

  it("imports HTML flex boxes without baking border into padding, binds padding tokens on bordered frames, and keeps dotted borders", () => {
    const cs = {
      getPropertyValue: () => "",
      paddingTop: "10px",
      paddingRight: "10px",
      paddingBottom: "10px",
      paddingLeft: "10px",
      borderTopWidth: "4px",
      borderRightWidth: "4px",
      borderBottomWidth: "4px",
      borderLeftWidth: "4px",
      borderTopStyle: "dotted",
      borderRightStyle: "dotted",
      borderBottomStyle: "dotted",
      borderLeftStyle: "dotted",
      borderTopColor: "rgb(34, 34, 34)",
      borderRightColor: "rgb(34, 34, 34)",
      borderBottomColor: "rgb(34, 34, 34)",
      borderLeftColor: "rgb(34, 34, 34)",
      boxShadow: "none",
      filter: "none",
      transform: "none",
      backgroundColor: "transparent",
      backgroundImage: "none",
      opacity: "1"
    } as unknown as CSSStyleDeclaration;

    expect(layoutPadding(cs)).toBe(10);

    const bindings = spacingBindingsOf(
      { number: (names: string[]) => (names.includes("padding") ? "tok_pad" : undefined) } as any,
      { mode: "flex", direction: "row", padding: 10 },
      cs,
      { top: 4, right: 4, bottom: 4, left: 4, uniform: true, color: "#222222" }
    );
    expect(bindings).toEqual({ padding: "tok_pad" });

    const unmapped: string[] = [];
    const vs = visualStyleOf(cs, { width: 200, height: 60 }, (p) => unmapped.push(p));
    expect(vs.stroke).toMatchObject({ width: 4, style: "dotted", align: "inside" });
    expect(unmapped).toEqual([]);
  });
});
