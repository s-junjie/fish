import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { applyCssSpelling } from "../src/core/dsl/css-spelling";
import { rectToPathData, cornerRadiiXYOf } from "../src/core/geometry/shape-path";
import { resolveStrokeWeights, strokeDashAttrs } from "../src/core/geometry/stroke-utils";
import { relayoutDocumentTree } from "../src/core/layout/auto-layout";
import { applyOps } from "../src/core/ops/apply-ops";
import { renderNonUniformStroke } from "../src/ui/canvas/non-uniform-stroke";
import type { DesignDocument, FrameElement, RectElement } from "../src/core/dsl/types";

function docWith(children: unknown[], variables?: Record<string, unknown>) {
  return normalizeDesignDocument({
    docId: "d1",
    version: "0.1",
    name: "p1-2",
    canvas: { width: 1200, height: 800, backgroundColor: "#FFFFFF" },
    ...(variables ? { variables } : {}),
    activePageId: "p1",
    pages: [{ id: "p1", name: "P1", children }]
  } as any);
}

const solid = [{ type: "solid", color: "#E5E7EB" }];

describe("P1-2 — % sizes, mixed calc(), CSS auto, and elliptical border-radius", () => {
  it("resolves % width/height against parent content box (respecting padding) and recomputes on parent resize", () => {
    const norm = docWith([
      {
        id: "card",
        type: "frame",
        name: "card",
        x: 0,
        y: 0,
        width: 400,
        height: 200,
        display: "flex",
        "flex-direction": "row",
        padding: 20,
        children: [
          {
            id: "box",
            type: "rect",
            name: "box",
            fills: solid,
            width: "50%",
            height: "calc(100% - 20px)",
            "min-width": "10%",
            "max-width": "min(80%, 240px)"
          }
        ]
      }
    ]);
    expect(norm.repairs).toEqual([]);
    const card = norm.document.pages[0].children[0] as FrameElement;
    const box = card.children[0] as RectElement;
    // Parent content box = (400 - 40, 200 - 40) = (360, 160)
    expect(box.width).toBe(180);
    expect(box.height).toBe(140);
    expect(box.sizing).toMatchObject({
      width: "fixed",
      height: "fixed",
      widthExpr: "50%",
      heightExpr: "calc(100% - 20px)",
      minWidth: 36,
      maxWidth: 240,
      minWidthExpr: "10%",
      maxWidthExpr: "min(80%, 240px)"
    });

    // Resize parent frame + relayout -> child % & calc() track new parent content box dynamically
    const patched = applyOps(norm.document, [
      {
        op: "patch",
        targetId: "card",
        props: { width: 640, height: 340 }
      }
    ]);
    expect(patched.outcomes[0].ok).toBe(true);
    const resizedCard = relayoutDocumentTree(patched.doc.pages[0].children)[0] as FrameElement;
    const resizedBox = resizedCard.children[0] as RectElement;
    // Content box = (600, 300): 50% of 600 = 300, clamped by min(80% = 480, 240) = 240
    expect(resizedBox.width).toBe(240);
    expect(resizedBox.height).toBe(280);
  });

  it("evaluates calc() combining % and var(--token) lengths", () => {
    const norm = docWith(
      [
        {
          id: "parent",
          type: "frame",
          name: "parent",
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          children: [
            {
              id: "child",
              type: "rect",
              name: "child",
              fills: solid,
              x: 0,
              y: 0,
              width: "calc(100% - 2 * var(--pad))",
              height: "clamp(40px, 50%, 90px)"
            }
          ]
        }
      ],
      { "--pad": "16px" }
    );
    expect(norm.repairs).toEqual([]);
    const parent = norm.document.pages[0].children[0] as FrameElement;
    const child = parent.children[0] as RectElement;
    expect(child.width).toBe(268);
    expect(child.height).toBe(90);
    expect(child.sizing?.widthExpr).toBe("calc(100% - 32px)");
  });

  it("maps 100% to fill on in-flow layout axes and keeps dynamic 100% in free/absolute boxes", () => {
    const norm = docWith([
      {
        id: "flex",
        type: "frame",
        name: "flex",
        x: 0,
        y: 0,
        width: 320,
        height: 200,
        display: "flex",
        "flex-direction": "column",
        children: [
          { id: "inflow", type: "rect", name: "inflow", fills: solid, width: "100%", height: 40 },
          {
            id: "abs",
            type: "rect",
            name: "abs",
            fills: solid,
            position: "absolute",
            x: 0,
            y: 0,
            width: "100%",
            height: "50%"
          }
        ]
      }
    ]);
    expect(norm.repairs.filter((r) => r.severity !== "info")).toEqual([]);
    const laidOut = relayoutDocumentTree(norm.document.pages[0].children);
    const flex = laidOut[0] as FrameElement;
    const inflow = flex.children[0] as RectElement;
    const abs = flex.children[1] as RectElement;
    expect(inflow.sizing?.width).toBe("fill");
    expect(inflow.sizing?.widthExpr).toBeUndefined();
    expect(inflow.width).toBe(320);

    expect(abs.sizing?.width).toBe("fixed");
    expect(abs.sizing?.widthExpr).toBe("100%");
    expect(abs.sizing?.heightExpr).toBe("50%");
    expect(abs.width).toBe(320);
    expect(abs.height).toBe(100);
  });

  it("maps CSS width/height 'auto' to fill under stretch and fit-content otherwise", () => {
    const norm = docWith([
      {
        id: "col",
        type: "frame",
        name: "col",
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        display: "flex",
        "flex-direction": "column",
        "align-items": "stretch",
        children: [
          {
            id: "stretchedChild",
            type: "frame",
            name: "stretchedChild",
            width: "auto",
            height: "auto",
            display: "flex",
            children: [{ id: "inner", type: "rect", name: "inner", fills: solid, width: 80, height: 30 }]
          },
          {
            id: "startChild",
            type: "frame",
            name: "startChild",
            width: "auto",
            height: 40,
            "align-self": "start",
            display: "flex",
            children: [{ id: "inner2", type: "rect", name: "inner2", fills: solid, width: 80, height: 30 }]
          }
        ]
      }
    ]);
    expect(norm.repairs.filter((r) => r.severity !== "info")).toEqual([]);
    const laidOut = relayoutDocumentTree(norm.document.pages[0].children);
    const col = laidOut[0] as FrameElement;
    const stretchedChild = col.children[0] as FrameElement;
    const startChild = col.children[1] as FrameElement;
    expect(stretchedChild.sizing).toMatchObject({ width: "fill", height: "fit-content" });
    expect(stretchedChild.width).toBe(300);
    expect(stretchedChild.height).toBe(30);
    expect(startChild.sizing?.width).toBe("fit-content");
    expect(startChild.sizing?.height).toBeUndefined();
    expect(startChild.width).toBe(80);
  });

  it("supports elliptical & % border-radius (50%, rx / ry, dynamic resize) and emits elliptical SVG arcs", () => {
    const norm = docWith([
      {
        id: "pill",
        type: "rect",
        name: "pill",
        fills: solid,
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        "border-radius": "50%"
      },
      {
        id: "elliptical",
        type: "rect",
        name: "elliptical",
        fills: solid,
        x: 0,
        y: 120,
        width: 120,
        height: 80,
        "border-radius": "10px 20px / 5px 15px"
      },
      {
        id: "parent",
        type: "frame",
        name: "parent",
        x: 0,
        y: 220,
        width: 200,
        height: 100,
        display: "flex",
        children: [
          {
            id: "dyn",
            type: "rect",
            name: "dyn",
            fills: solid,
            width: "100%",
            height: "100%",
            "border-radius": "50% / 25%"
          }
        ]
      }
    ]);
    expect(norm.repairs.filter((r) => r.severity !== "info")).toEqual([]);

    const pill = norm.document.pages[0].children[0] as RectElement;
    expect(pill.borderRadius).toBe(100);
    expect(pill.sizing?.borderRadiusY).toBe(50);
    expect(pill.sizing?.borderRadiusExpr).toBe("50%");
    expect(rectToPathData(pill)).toContain("A 100 50 0 0 1");

    const elliptical = norm.document.pages[0].children[1] as RectElement;
    expect(elliptical.borderRadius).toEqual([10, 20, 10, 20]);
    expect(elliptical.sizing?.borderRadiusY).toEqual([5, 15, 5, 15]);
    const pathD = rectToPathData(elliptical);
    expect(pathD).toContain("A 20 15 0 0 1");
    expect(pathD).toContain("A 10 5 0 0 1");

    // Non-uniform stroke with elliptical radii emits rx/ry SVG arcs
    const [radii, radiiY] = cornerRadiiXYOf(elliptical.borderRadius, elliptical.sizing?.borderRadiusY, 120, 80);
    const weights = resolveStrokeWeights({ width: 4, side: "custom", sides: { top: 4, right: 0, bottom: 0, left: 4 } });
    const strokeNode: any = renderNonUniformStroke(
      weights,
      { width: 120, height: 80, radii, radiiY },
      "#000",
      "center",
      strokeDashAttrs({ width: 4 }),
      1,
      "c",
      "m"
    );
    const cornerArc = ([].concat(strokeNode.props.children) as any[]).find((c: any) => c.key === "c_tl");
    expect(cornerArc?.props.d).toBe("M 10 0 A 10 5 0 0 0 0 5");

    // Parent resize + relayout updates child dynamic 50% / 25% borderRadius + borderRadiusY
    const resized = applyOps(norm.document as DesignDocument, [
      {
        op: "patch",
        targetId: "parent",
        props: { width: 400, height: 200 }
      }
    ]);
    expect(resized.outcomes[0].ok).toBe(true);
    const dynChild = (relayoutDocumentTree(resized.doc.pages[0].children)[2] as FrameElement)
      .children[0] as RectElement;
    expect(dynChild.width).toBe(400);
    expect(dynChild.height).toBe(200);
    expect(dynChild.borderRadius).toBe(200);
    expect(dynChild.sizing?.borderRadiusY).toBe(50);

    // CSS spelling round-trip emits clean CSS strings and re-normalizes with 0 repairs
    const spelled = applyCssSpelling(norm.document as any);
    const pillSpelled = (spelled.pages as any[])[0].children[0];
    expect(pillSpelled["border-radius"]).toBe("50%");
    const ellipticalSpelled = (spelled.pages as any[])[0].children[1];
    expect(ellipticalSpelled["border-radius"]).toBe("10px 20px / 5px 15px");
    const back = normalizeDesignDocument(spelled);
    expect(back.repairs).toEqual([]);
  });
});
