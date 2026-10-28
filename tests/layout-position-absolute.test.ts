import { flattenLayout } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { relayoutDocumentTree, resizeStackWithPins } from "../src/core/compile";
import { resizeContainerWithConstraints } from "../src/core/geometry/constraints";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { reorderInAutoLayout, nudgeElements } from "../src/core/interactions/alignment";
import { findParentById } from "../src/core/geometry/tree-ops";
import type { DesignElement, DesignDocument, FrameElement, RectElement } from "../src/core/dsl/types";

const rect = (id: string, extra: Partial<RectElement> = {}): RectElement => ({
  id, type: "rect", x: 0, y: 0, width: 50, height: 50, ...extra
});

/** A column stack of 50x50 boxes with no gaps. */
const columnStack = (children: DesignElement[], height?: number): FrameElement => ({
  id: "stack",
  type: "frame",
  x: 0, y: 0, width: 200,
  height: height ?? children.length * 50,
  ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 0 }),
  children
});

const child = (els: DesignElement[], id: string) =>
  (findParentById(els, id) as FrameElement).children!.find((c) => c.id === id)!;

describe("position: absolute", () => {
  it("keeps an absolute child where it was put and packs the rest around it", () => {
    // b is authored at y=200 and pulled out of the flow; a and c must close the
    // gap, so they sit at 0 and 50.
    const els = relayoutDocumentTree([
      columnStack([
        rect("a"),
        rect("b", { x: 20, y: 200, position: "absolute" }),
        rect("c")
      ])
    ]);
    expect(child(els, "a").y).toBe(0);
    expect(child(els, "c").y).toBe(50);
    expect(child(els, "b")).toMatchObject({ x: 20, y: 200 });
  });

  it("preserves the authored z-order when the flow is rearranged", () => {
    const els = relayoutDocumentTree([
      columnStack([rect("a"), rect("b", { position: "absolute" }), rect("c")])
    ]);
    expect((els[0] as FrameElement).children!.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("stops counting towards a hugging parent", () => {
    const hug = (extra: Partial<RectElement>) =>
      (relayoutDocumentTree([
        {
          ...columnStack([rect("a"), rect("big", { height: 400, ...extra })]),
          sizing: { height: "fit-content" }
        }
      ])[0] as FrameElement).height;

    expect(hug({})).toBe(450);
    expect(hug({ position: "absolute" })).toBe(50);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = relayoutDocumentTree([
      columnStack([rect("a"), rect("b", { x: 20, y: 200, position: "absolute" }), rect("c")])
    ]);
    expect(relayoutDocumentTree(once)).toEqual(once);
  });

  it("hugs onto padding when every child left the flow", () => {
    const els = relayoutDocumentTree([
      {
        ...columnStack([rect("a", { position: "absolute" })]),
        sizing: { height: "fit-content" },
        ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 12 })
      }
    ]);
    expect(els[0].height).toBe(24);
    expect(child(els, "a")).toMatchObject({ y: 0 });
  });

  it("ignores the child in a grid too", () => {
    const els = relayoutDocumentTree([
      {
        id: "g", type: "frame", x: 0, y: 0, width: 200, height: 200,
        ...flattenLayout({ mode: "grid", columns: 2, gap: 0, padding: 0, cellAlign: "start" }),
        children: [
          rect("a"), rect("b"),
          rect("c", { x: 7, y: 9, position: "absolute" }), rect("d")
        ]
      }
    ]);
    // Three in-flow children over two rows: a(0,0), b(100,0), d(0,100). The rows
    // divide the grid's declared 200px height, so c takes no cell at all.
    expect(child(els, "c")).toMatchObject({ x: 7, y: 9 });
    expect(child(els, "d")).toMatchObject({ x: 0, y: 100 });
  });
});

describe("constraints reach the child that left the flow", () => {
  const stackWith = (el: RectElement): DesignElement[] => [
    {
      ...columnStack([rect("a"), el]),
      constraints: { horizontal: "left", vertical: "top" }
    } as FrameElement
  ];

  it("leaves an in-flow child alone", () => {
    const before = relayoutDocumentTree(stackWith(rect("b")));
    const resized = resizeContainerWithConstraints(
      before[0] as FrameElement,
      { width: 200, height: 100 },
      { width: 400, height: 100 }
    );
    expect(child([resized], "b")).toEqual(child(before, "b"));
  });

  it("applies to an absolute child, which is the only place the rule is writable", () => {
    const before = relayoutDocumentTree(stackWith(rect("b", { position: "absolute" })));
    const resized = resizeContainerWithConstraints(
      before[0] as FrameElement,
      { width: 200, height: 100 },
      { width: 400, height: 100 }
    );
    expect(child([resized], "b").x).toBe(0); // `left` pins to the left edge
  });

  it("pins an absolute child to the right edge via its constraints", () => {
    const before = relayoutDocumentTree(
      stackWith(rect("b", { x: 150, position: "absolute", constraints: { horizontal: "right", vertical: "top" } }))
    );
    expect(child(before, "b").x).toBe(150);
    const resized = resizeContainerWithConstraints(
      before[0] as FrameElement,
      { width: 200, height: 100 },
      { width: 400, height: 100 }
    );
    // rightDist was 0, so it stays flush against the new right edge.
    expect(child([resized], "b").x).toBe(350);
  });
});

describe("resizing a stack is two passes, not one", () => {
  // The canvas resize gesture used to call `applyAutoLayout` alone, so a pinned
  // absolute child followed a width typed into the inspector and stood still
  // while the handle was dragged. These are the gestures' composition.
  const stackWith = (el: RectElement): FrameElement =>
    relayoutDocumentTree([
      columnStack([rect("a"), el], 100)
    ])[0] as FrameElement;

  it("moves an absolute child pinned to the right edge", () => {
    const before = stackWith(
      rect("b", { x: 150, position: "absolute", constraints: { horizontal: "right", vertical: "top" } })
    );
    expect(child([before], "b").x).toBe(150);
    const resized = resizeStackWithPins(
      { ...before, width: 400 },
      before,
      { width: 200, height: 100 },
      { width: 400, height: 100 }
    );
    expect(child([resized], "b").x).toBe(350);
  });

  it("still reflows the in-flow children, in the same pass", () => {
    const before = stackWith(rect("b", { position: "absolute" }));
    const resized = resizeStackWithPins(
      { ...before, width: 400 },
      before,
      { width: 200, height: 100 },
      { width: 400, height: 100 }
    );
    expect(child([resized], "a").y).toBe(0);
    expect(child([resized], "b")).toMatchObject({ position: "absolute" });
  });

  it("measures from the drag-start snapshot, so every frame of a drag lands the same", () => {
    const dragStart = stackWith(
      rect("b", { x: 150, position: "absolute", constraints: { horizontal: "right", vertical: "top" } })
    );
    const from = { width: 200, height: 100 };
    const to = { width: 400, height: 100 };
    // The gesture re-runs this on every frame, always with the drag-start box.
    // The tree it is handed already carries the resized parent AND the pinned
    // child from the previous frame — passing THAT as the snapshot would walk
    // the child one frame's delta further each time.
    const frame1 = resizeStackWithPins({ ...dragStart, width: 400 }, dragStart, from, to);
    const frame2 = resizeStackWithPins(frame1, dragStart, from, to);
    expect(child([frame1], "b").x).toBe(350);
    expect(child([frame2], "b").x).toBe(350);
  });
});

describe("an absolute child is a free layer again", () => {
  it("arrows nudge it instead of walking it through the stack", () => {
    const els = [columnStack([rect("a"), rect("b", { position: "absolute" })])];
    expect(reorderInAutoLayout(els, new Set(["b"]), "down")).toBeNull();
    expect(child(nudgeElements(els, new Set(["b"]), 0, 1), "b").y).toBe(1);
  });

  it("its flow siblings still reorder", () => {
    const els = [columnStack([rect("a"), rect("b"), rect("c", { position: "absolute" })])];
    const res = reorderInAutoLayout(els, new Set(["a"]), "down");
    expect(res?.moved).toBe(true);
    expect((res!.elements[0] as FrameElement).children!.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });
});

describe("the dialect", () => {
  const doc = (el: unknown): DesignDocument => ({
    id: "d", version: "0.1", name: "n",
    canvas: { width: 100, height: 100, background: { type: "solid", color: "#000" } },
    pages: [{ id: "p", name: "P", children: [columnStack([rect("a"), el as RectElement])] }],
    elements: [columnStack([rect("a"), el as RectElement])]
  } as unknown as DesignDocument);

  it("keeps the field across a load and reports a bad value instead of guessing", () => {
    const ok = normalizeDesignDocument(doc(rect("b", { position: "absolute" })), { preserveUnknown: true });
    expect(child(getActivePage(ok.document).children, "b").position).toBe("absolute");
    expect(ok.repairs.filter((r) => r.path.endsWith("/position"))).toEqual([]);

    const bad = normalizeDesignDocument(
      doc(rect("b", { position: "fixed" } as unknown as Partial<RectElement>)),
      { preserveUnknown: true }
    );
    expect(child(getActivePage(bad.document).children, "b").position).toBeUndefined();
    expect(bad.repairs.some((r) => r.path.endsWith("/position"))).toBe(true);
  });

  it("refuses the pre-P2 `layout_position` spelling", () => {
    // `layoutPosition` / `layout_position` were the pre-P2 spellings of
    // `position`. There are no v1 documents written against them, so the key is
    // no longer honoured at all.
    const spelling = { layout_position: "absolute" } as unknown as Partial<RectElement>;
    const out = normalizeDesignDocument(doc(rect("b", spelling)), { preserveUnknown: true });
    expect(child(getActivePage(out.document).children, "b").position).toBeUndefined();

    // `fish check` normalizes without `preserveUnknown`, so there the key is
    // reported as dropped rather than carried.
    const strict = normalizeDesignDocument(doc(rect("b", spelling)));
    expect(strict.repairs.some((r) => r.message.includes("layout_position"))).toBe(true);
  });
});
