import { layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { applyOps } from "../src/core/ops/apply-ops";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement, InstanceElement } from "../src/core/dsl/types";

const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#101010" } };

const doc = (elements: DesignElement[]): DesignDocument =>
  ({
    version: "0.1",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
    activePageId: "page_1"
  }) as unknown as DesignDocument;

const frame = (id: string, children: DesignElement[] = []): DesignElement =>
  ({
    id,
    type: "frame",
    name: id,
    x: 40,
    y: 40,
    width: 320,
    height: 200,
    children
  }) as unknown as DesignElement;

const rect = (id: string, x = 0, y = 0): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width: 100, height: 50 }) as unknown as DesignElement;

const byId = (d: DesignDocument, id: string): DesignElement | undefined =>
  getActivePage(d).children.find((el) => el.id === id);

describe("applyOps", () => {
  it("patches nested props and deletes on null", () => {
    const start = doc([{ ...rect("a"), style: { fontSize: 12, color: "#FFF" } } as DesignElement]);
    const { doc: next, outcomes } = applyOps(start, [
      { op: "patch", targetId: "a", props: { x: 10, style: { fontSize: 20 }, fills: null } }
    ]);
    expect(outcomes[0].ok).toBe(true);
    expect(byId(next, "a")!.x).toBe(10);
    expect((byId(next, "a") as unknown as { style: { fontSize: number; color: string } }).style).toEqual({
      fontSize: 20,
      color: "#FFF"
    });
    expect(byId(next, "a")!.fills).toBeUndefined();
  });

  it("lets CSS patch keys replace the stored fields they name", () => {
    const start = doc([
      {
        ...frame("f", [
          {
            ...rect("flex_child"),
            sizing: { width: "fill" },
            "flex-grow": 2,
            fills: [{ type: "solid", color: "#111111" }],
            strokes: [{ color: "#222222", width: 1, style: "solid" }]
          } as unknown as DesignElement
        ]),
        display: "flex",
        "flex-direction": "row",
        clipContent: false,
        rotation: 45,
        sizing: { minWidth: 100 }
      } as DesignElement,
      {
        ...frame("g", [
          {
            ...rect("grid_child"),
            "grid-area": { column: 2, columnSpan: 2, row: 1 }
          } as unknown as DesignElement
        ]),
        display: "grid",
        "grid-template-columns": 4
      } as DesignElement,
      {
        ...rect("t"),
        x: 0,
        y: 0,
        type: "text",
        content: "hi",
        style: { fontFamily: "Inter", fontSize: 16, align: "left", color: "#000000" },
        fills: [{ type: "solid", color: "#000000" }]
      } as unknown as DesignElement
    ]);
    const { doc: next, outcomes } = applyOps(start, [
      { op: "patch", targetId: "f", props: { overflow: "hidden", rotate: "90deg", "min-width": "200px" } },
      { op: "patch", targetId: "t", props: { "font-size": "24px", "text-align": "center", color: "#FFFFFF" } },
      {
        op: "patch",
        targetId: "flex_child",
        props: { background: "#FF0000", "border-bottom": "3px solid #00FF00" }
      },
      { op: "patch", targetId: "grid_child", props: { "grid-column": "3" } }
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true, true]);
    expect(byId(next, "f")).toMatchObject({ clipContent: true, rotation: 90, sizing: { minWidth: 200 } });
    expect((byId(next, "t") as unknown as { style: Record<string, unknown> }).style).toMatchObject({
      fontSize: 24,
      align: "center",
      color: "#FFFFFF"
    });
    expect(byId(next, "t")!.fills).toEqual([{ type: "solid", color: "#FFFFFF" }]);

    const flexChild = (byId(next, "f") as unknown as { children: DesignElement[] }).children[0];
    expect(flexChild["flex-grow"]).toBe(2);
    expect(flexChild.fills).toEqual([{ type: "solid", color: "#FF0000" }]);
    expect(flexChild.strokes?.[0]).toMatchObject({
      color: "#00FF00",
      width: 3,
      side: "custom",
      sides: { top: 0, right: 0, bottom: 3, left: 0 }
    });

    const gridChild = (byId(next, "g") as unknown as { children: DesignElement[] }).children[0];
    expect(gridChild["grid-area"]).toEqual({ column: 3, row: 1 });
  });

  it("runs geometry ops on the CSS document the CLI reads", () => {
    const raw = {
      version: "0.1",
      canvas: { width: 800, height: 600, background: { type: "solid", color: "#FFFFFF" } },
      pages: [{
        id: "page_1",
        name: "Page 1",
        canvas: { width: 800, height: 600 },
        children: [{
          id: "f",
          type: "frame",
          x: "100px",
          y: "100px",
          width: "320px",
          height: "200px",
          overflow: "hidden",
          children: []
        }]
      }],
      activePageId: "page_1"
    };
    const start = normalizeDesignDocument(raw).document;
    const { doc: next } = applyOps(start, [
      { op: "insert", parentId: "f", position: { x: 140, y: 140 }, element: { id: "c", type: "rect", width: 10, height: 10 } }
    ]);
    const child = (byId(next, "f") as unknown as { children: DesignElement[] }).children[0];
    expect(child).toMatchObject({ x: 40, y: 40 });
  });

  it("reports a missing target instead of inventing one", () => {
    const start = doc([rect("a")]);
    const { doc: next, outcomes } = applyOps(start, [{ op: "patch", targetId: "ghost", props: { x: 1 } }]);
    expect(outcomes[0].ok).toBe(false);
    expect(getActivePage(next).children).toHaveLength(1);
  });

  it("inserts at canvas level and into a frame, converting to local coordinates", () => {
    const start = doc([frame("f")]);
    const { doc: next } = applyOps(start, [
      { op: "insert", element: rect("top") },
      { op: "insert", parentId: "f", position: { x: 140, y: 140 }, element: rect("child") }
    ]);
    const child = (byId(next, "f") as unknown as { children: DesignElement[] }).children[0];
    expect(child.id).toBe("child");
    expect(child.x).toBe(100);
    expect(child.y).toBe(100);
  });

  it("preserves local coordinates on insert when position is omitted", () => {
    const start = doc([frame("f")]);
    const { doc: next } = applyOps(start, [
      { op: "insert", parentId: "f", element: { id: "child_local", type: "rect", x: 28, y: 108, width: 50, height: 50 } },
      { op: "insert", parentId: "f", element: { id: "child_css", type: "rect", left: 16, top: 32, width: 50, height: 50 } }
    ]);
    const f = byId(next, "f") as unknown as { children: DesignElement[] };
    const childLocal = f.children.find((c) => c.id === "child_local")!;
    const childCss = f.children.find((c) => c.id === "child_css")!;
    expect(childLocal.x).toBe(28);
    expect(childLocal.y).toBe(108);
    expect(childCss.x).toBe(16);
    expect(childCss.y).toBe(32);
  });

  it("refuses a parent that cannot hold children", () => {
    const start = doc([rect("r")]);
    const { outcomes } = applyOps(start, [{ op: "insert", parentId: "r", element: rect("c") }]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/only a frame/);
  });

  /**
   * `instantiate` + `parentId` was the one nesting path with no test, and it was
   * broken: the guard read a bare `origin`, which `lib.dom` declares as the page's
   * origin STRING. Truthy in a browser (so the feature worked), and a
   * `ReferenceError` under Node — which is exactly why writing the test is what
   * surfaced it.
   */
  it("nests an instantiated component into a frame, in local coordinates", () => {
    const master = {
      id: "c",
      type: "component",
      name: "c",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      children: []
    } as unknown as DesignElement;
    const start = doc([frame("f"), master]);
    const { doc: next, outcomes } = applyOps(start, [
      { op: "instantiate", componentId: "c", position: { x: 140, y: 140 }, parentId: "f" }
    ]);
    expect(outcomes[0].ok).toBe(true);
    const kids = (byId(next, "f") as unknown as { children: DesignElement[] }).children;
    expect(kids).toHaveLength(1);
    expect(kids[0].type).toBe("instance");
    // 140,140 world minus the frame's own 40,40 origin.
    expect(kids[0].x).toBe(100);
    expect(kids[0].y).toBe(100);
    expect(getActivePage(next).children.some((e) => e.type === "instance")).toBe(false);
  });

  it("places side-by-side next to the existing siblings", () => {
    const start = doc([rect("a", 0, 0)]);
    const { doc: next } = applyOps(start, [
      { op: "insert", position: "side-by-side", element: rect("b") }
    ]);
    expect(byId(next, "b")!.x).toBe(124);
  });

  it("replaces a subtree but keeps the id", () => {
    const start = doc([{ ...frame("f"), children: [rect("kid")] } as DesignElement]);
    const { doc: next } = applyOps(start, [
      { op: "replace", targetId: "f", element: { type: "rect", name: "gone", width: 10, height: 10 } }
    ]);
    expect(byId(next, "f")!.type).toBe("rect");
    expect((byId(next, "f") as unknown as { children?: DesignElement[] }).children).toBeUndefined();
  });

  it("removes by id and reports the ones it could not find", () => {
    const start = doc([rect("a"), rect("b")]);
    const { doc: next, outcomes } = applyOps(start, [{ op: "remove", targetIds: ["a", "ghost"] }]);
    expect(getActivePage(next).children.map((el) => el.id)).toEqual(["b"]);
    expect(outcomes[0].detail).toMatch(/not found: ghost/);
  });

  it("promotes a frame to a component and instantiates it", () => {
    const start = doc([frame("card")]);
    const made = applyOps(start, [{ op: "make-component", targetId: "card", name: "Card" }]);
    expect(byId(made.doc, "card")!.type).toBe("component");

    const placed = applyOps(made.doc, [
      { op: "instantiate", componentId: "card", position: { x: 400, y: 40 } }
    ]);
    const instance = getActivePage(placed.doc).children.find((el) => el.type === "instance");
    expect(instance).toBeDefined();
    expect(instance!.x).toBe(400);

    const reset = applyOps(placed.doc, [{ op: "reset-instance", targetId: instance!.id }]);
    expect((byId(reset.doc, instance!.id) as InstanceElement).overrides ?? []).toEqual([]);
  });

  it("wraps siblings that share a parent in a layout frame", () => {
    const start = doc([rect("a", 100, 100), rect("b", 300, 100)]);
    const { doc: next, outcomes } = applyOps(start, [
      { op: "intent", intent: "wrap-in-stack", targetIds: ["a", "b"], params: { gap: 16 } }
    ]);
    expect(outcomes[0].ok).toBe(true);
    const wrap = byId(next, outcomes[0].id as string)!;
    expect(wrap.x).toBe(100);
    expect(wrap.y).toBe(100);
    expect(wrap.width).toBe(300);
    expect(layoutOf(wrap)).toMatchObject({ mode: "flex", gap: 16 });
    expect((wrap as { children: DesignElement[] }).children.map((c) => [c.x, c.y])).toEqual([
      [0, 0],
      [200, 0]
    ]);
  });

  it("refuses a wrap across two different parents", () => {
    const start = doc([frame("f", [rect("kid")]), rect("top")]);
    const { outcomes } = applyOps(start, [
      { op: "intent", intent: "wrap-in-stack", targetIds: ["kid", "top"] }
    ]);
    expect(outcomes[0].ok).toBe(false);
  });

  it("unions top-level shapes into one path, replacing the operands", () => {
    const start = doc([rect("a", 0, 0), rect("b", 50, 0)]);
    const { doc: next, outcomes } = applyOps(start, [
      { op: "boolean", intent: "union", targetIds: ["a", "b"] }
    ]);
    expect(outcomes[0].ok).toBe(true);
    const id = outcomes[0].id as string;
    expect(getActivePage(next).children).toHaveLength(1);
    expect(getActivePage(next).children[0].id).toBe(id);
    expect(getActivePage(next).children[0].type).toBe("path");
  });

  it("refuses a boolean whose shapes are nested inside a frame", () => {
    const start = doc([frame("f", [rect("kid", 0, 0)]), rect("top", 200, 0)]);
    const { outcomes } = applyOps(start, [
      { op: "boolean", intent: "union", targetIds: ["kid", "top"] }
    ]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/nested/);
  });

  it("refuses a boolean on elements that draw no outline", () => {
    const start = doc([frame("f"), frame("g")]);
    const { outcomes } = applyOps(start, [
      { op: "boolean", intent: "union", targetIds: ["f", "g"] }
    ]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/outline/);
  });

  it("names an invalid boolean intent and an unknown target", () => {
    const start = doc([rect("a"), rect("b")]);
    const bad = applyOps(start, [{ op: "boolean", intent: "merge", targetIds: ["a", "b"] }]);
    expect(bad.outcomes[0].ok).toBe(false);
    expect(bad.outcomes[0].detail).toMatch(/intent/);
    const ghost = applyOps(start, [{ op: "boolean", intent: "union", targetIds: ["a", "ghost"] }]);
    expect(ghost.outcomes[0].ok).toBe(false);
    expect(ghost.outcomes[0].detail).toMatch(/ghost/);
  });

  it("names an unknown op and keeps going", () => {
    const start = doc([rect("a")]);
    const { outcomes } = applyOps(start, [{ op: "teleport" }, { op: "patch", targetId: "a", props: { x: 5 } }]);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/unknown op/);
    expect(outcomes[1].ok).toBe(true);
  });

  it("accepts { ops: [...] } as well as a bare array", () => {
    const start = doc([rect("a")]);
    const { outcomes } = applyOps(start, { ops: [{ op: "patch", targetId: "a", props: { x: 7 } }] });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
  });
});

/**
 * `repeat` — the authoring-time stamping macro (`docs/LOOP_EXPRESSION_PLAN.md`).
 * It is a verb the CLI runs and nothing the document stores, so no test here
 * reads a `repeat` field back out of the artifact; they assert the concrete
 * elements it wrote.
 */
describe("repeat", () => {
  const childrenOf = (d: DesignDocument, id: string): DesignElement[] =>
    (byId(d, id) as unknown as { children: DesignElement[] }).children;

  const stamp = (start: DesignDocument, op: Record<string, unknown>) => applyOps(start, [op]);

  it("stamps one element per `over` entry, substituting x/y/rotation and id/name", () => {
    const start = doc([frame("sun")]);
    const { doc: next, outcomes } = stamp(start, {
      op: "repeat",
      parentId: "sun",
      position: { x: 0, y: 0 },
      over: [
        { tip: [118, 22], rot: -36 },
        { tip: [200, 80], rot: 12 }
      ],
      as: "f",
      template: {
        id: "frond_$i",
        name: "frond $i",
        type: "path",
        x: "$f.tip.0",
        y: "$f.tip.1",
        d: "M0 0",
        rotation: "$f.rot"
      }
    });

    expect(outcomes[0].ok).toBe(true);
    const kids = childrenOf(next, "sun");
    expect(kids).toHaveLength(2);
    // World 118,22 minus the frame's own 40,40 origin.
    expect([kids[0].x, kids[0].y]).toEqual([78, -18]);
    expect(kids[0].rotation).toBe(-36);
    expect(kids[0].id).toBe("frond_0");
    expect(kids[0].name).toBe("frond 0");
    expect([kids[1].x, kids[1].y]).toEqual([160, 40]);
    expect(kids[1].rotation).toBe(12);
    expect(kids[1].id).toBe("frond_1");
  });

  it("keeps a whole-string token's native type — a number, not a string", () => {
    const { doc: next } = stamp(doc([]), {
      op: "repeat",
      over: [{ tip: [118, 22] }],
      as: "f",
      template: { id: "p_$i", type: "path", x: "$f.tip.0", y: "$f.tip.1" }
    });
    expect(typeof getActivePage(next).children[0].x).toBe("number");
    expect(getActivePage(next).children[0].x).toBe(118);
    expect(getActivePage(next).children[0].y).toBe(22);
  });

  it("`count` yields 0…N-1 and `$i` is the index in both modes", () => {
    const start = doc([frame("f")]);
    const { doc: next } = stamp(start, {
      op: "repeat",
      parentId: "f",
      count: 3,
      template: { id: "x_$i", type: "rect", rotation: "$i", width: 5, height: 5 }
    });
    const kids = childrenOf(next, "f");
    expect(kids.map((k) => k.id)).toEqual(["x_0", "x_1", "x_2"]);
    expect(kids.map((k) => k.rotation)).toEqual([0, 1, 2]);
  });

  it("splices a token mixed with text into a string, and leaves bare `$` alone", () => {
    const { doc: next } = stamp(doc([]), {
      op: "repeat",
      count: 1,
      template: { id: "a_$i", type: "rect", name: "$$ $i $5 price$", width: 5, height: 5 }
    });
    expect(getActivePage(next).children[0].name).toBe("$ 0 $5 price$");
  });

  it("offsets every stamped item by `position`", () => {
    const { doc: next } = stamp(doc([]), {
      op: "repeat",
      position: { x: 10, y: -5 },
      over: [{ tip: [118, 22] }],
      as: "f",
      template: { id: "p_$i", type: "rect", x: "$f.tip.0", y: "$f.tip.1", width: 5, height: 5 }
    });
    expect([getActivePage(next).children[0].x, getActivePage(next).children[0].y]).toEqual([128, 17]);
  });

  it("descends into nested `children`, so a repeated frame stamps its subtree", () => {
    const { doc: next } = stamp(doc([]), {
      op: "repeat",
      count: 2,
      template: {
        id: "card_$i",
        type: "frame",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        children: [{ id: "kid_$i", name: "kid $i", type: "rect", x: "$i", y: 0, width: 5, height: 5 }]
      }
    });
    const card = getActivePage(next).children[0] as unknown as { children: DesignElement[] };
    expect(card.children).toHaveLength(1);
    expect(card.children[0].id).toBe("kid_0");
    expect(card.children[0].name).toBe("kid 0");
    expect(card.children[0].x).toBe(0);
  });

  it("refuses `over` + `count` together, and neither", () => {
    const both = stamp(doc([]), { op: "repeat", over: [0], count: 1, template: { id: "a_$i", type: "rect" } });
    expect(both.outcomes[0].ok).toBe(false);
    const neither = stamp(doc([]), { op: "repeat", template: { id: "a_$i", type: "rect" } });
    expect(neither.outcomes[0].ok).toBe(false);
  });

  it("reserves `i` as the index name", () => {
    const { outcomes } = stamp(doc([]), { op: "repeat", count: 1, as: "i", template: { id: "a_$i", type: "rect" } });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/as/);
  });

  it("refuses an unbound token, naming it", () => {
    const { outcomes } = stamp(doc([]), {
      op: "repeat",
      count: 1,
      template: { id: "a_$i", type: "rect", x: "$j" }
    });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toContain("$j");
  });

  it("refuses a path that misses, naming the token and segment", () => {
    const { outcomes } = stamp(doc([]), {
      op: "repeat",
      over: [{ tip: [1] }],
      as: "f",
      template: { id: "a_$i", type: "rect", x: "$f.tip.5" }
    });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toContain("$f.tip.5");
  });

  it("refuses a constant id when more than one element would be stamped", () => {
    const { outcomes } = stamp(doc([]), {
      op: "repeat",
      count: 2,
      template: { id: "fixed", type: "rect", width: 5, height: 5 }
    });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/unique|repeats/);
  });

  it("refuses a `parentId` that is not a container", () => {
    const { outcomes } = stamp(doc([rect("r")]), {
      op: "repeat",
      parentId: "r",
      count: 1,
      template: { id: "c_$i", type: "rect", width: 5, height: 5 }
    });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/only a frame/);
  });

  it("refuses a parent that is a node inside an instance", () => {
    const start = doc([
      {
        id: "c_btn",
        type: "component",
        name: "Button",
        x: 0,
        y: 0,
        width: 80,
        height: 20,
        children: [rect("t_btn")]
      } as DesignElement,
      { id: "inst_1", type: "instance", componentId: "c_btn", x: 200, y: 0, width: 80, height: 20 } as DesignElement
    ]);
    const { outcomes } = stamp(start, {
      op: "repeat",
      parentId: "inst_1_t_btn",
      count: 1,
      template: { id: "c_$i", type: "rect", width: 5, height: 5 }
    });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toContain("c_btn");
  });

  it("refuses a non-object `position`", () => {
    const { outcomes } = stamp(doc([]), {
      op: "repeat",
      position: "side-by-side",
      count: 1,
      template: { id: "a_$i", type: "rect" }
    });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toMatch(/position/);
  });

  it("places nothing when one entry fails — the batch is atomic", () => {
    const start = doc([frame("f")]);
    const { doc: next, outcomes } = stamp(start, {
      op: "repeat",
      parentId: "f",
      over: [{ tip: [1, 2] }, { tip: [3] }],
      as: "f",
      template: { id: "p_$i", type: "rect", x: "$f.tip.0", y: "$f.tip.1", width: 5, height: 5 }
    });
    expect(outcomes[0].ok).toBe(false);
    expect(childrenOf(next, "f")).toHaveLength(0);
  });

  it("writes a concrete artifact — no `repeat` key and no `$` survives", () => {
    const { doc: next } = stamp(doc([frame("f")]), {
      op: "repeat",
      parentId: "f",
      over: [{ tip: [10, 20] }],
      as: "f",
      template: { id: "p_$i", name: "p $i", type: "rect", x: "$f.tip.0", y: "$f.tip.1", width: 5, height: 5 }
    });
    const serialized = JSON.stringify(next);
    expect(serialized).not.toContain("$");
    expect(serialized).not.toContain('"repeat"');
  });
});
