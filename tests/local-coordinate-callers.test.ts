import { describe, it, expect } from "vitest";
import { validateDocument } from "../src/core/validate";
import { insertClones, insertClonesIntoContainer, translateTreeInPlace } from "../src/core/interactions/clipboard";
import { resolveInstanceChildren } from "../src/core/interactions/instance-resolve";
import { alignElements } from "../src/core/interactions/alignment";
import type { ComponentElement, DesignDocument, DesignElement, FrameElement, InstanceElement } from "../src/core/dsl/types";

/**
 * Callers that mix two coordinate spaces — a child's local box against a
 * parent's own box, or an instance's origin against its master's — are how the
 * local-coordinate dialect silently breaks. Every case here failed once.
 */
const doc = (elements: unknown[]): DesignDocument =>
  ({
    version: "0.1",
    docId: "d",
    id: "d",
    name: "d",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas: { width: 1920, height: 1080, unit: "px" },
    pages: [{ id: "p1", name: "P", canvas: { width: 1920, height: 1080, unit: "px" }, children: elements }],
    activePageId: "p1"
  } as unknown as DesignDocument);

const frame = (id: string, x: number, y: number, children: any[] = [], extra: any = {}): FrameElement =>
  ({ id, type: "frame", x, y, width: 400, height: 300, children, ...extra } as FrameElement);

describe("validate reads children in their parent's space", () => {
  it("does not call a child outside a frame that sits away from the origin", () => {
    const diagnostics = validateDocument(doc([frame("f", 800, 300, [{ id: "c", type: "rect", x: 20, y: 20, width: 100, height: 50 }])]));
    expect(diagnostics.filter((d) => /outside its parent/.test(d.message))).toEqual([]);
  });

  it("accepts a line written with dx/dy and needs no legacy x2/y2", () => {
    const diagnostics = validateDocument(
      doc([{ id: "l", type: "line", x: 10, y: 20, dx: 100, dy: 0, width: 100, height: 0, strokes: [{ width: 1 }] }])
    );
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });
});

describe("clipboard moves a subtree once", () => {
  it("offsets only the clone's own origin, leaving descendants local", () => {
    const original = frame("f", 100, 100, [{ id: "c", type: "rect", x: 20, y: 30, width: 40, height: 40 }]);
    const clone = insertClones([original], [original], { x: 20, y: 20 }).elements[1] as FrameElement;
    expect(clone.x).toBe(120);
    expect((clone.children![0] as any).x).toBe(20);
  });

  it("translates the node it is given and nothing deeper", () => {
    const el = frame("f", 0, 0, [{ id: "c", type: "rect", x: 5, y: 5, width: 10, height: 10 }]);
    translateTreeInPlace(el, 10, 10);
    expect(el.x).toBe(10);
    expect((el.children![0] as any).x).toBe(5);
  });

  it("parents a paste to the nested target, in the target's own space", () => {
    const tree: DesignElement[] = [
      frame("outer", 1000, 500, [frame("target", 50, 50, [], { width: 200, height: 200 })]),
      { id: "src", type: "rect", x: 12, y: 34, width: 40, height: 40 }
    ];
    const next = insertClonesIntoContainer(tree, [tree[1]], "target").elements;
    const target = (next[0] as FrameElement).children![0] as FrameElement;
    const pasted = target.children![0] as any;
    // The clone is a child of `target`, and its coordinates are read in `target`'s
    // local space — the source's own x/y, with nothing added for the ancestors it
    // is being lifted past.
    expect(pasted.id).not.toBe("src");
    expect([pasted.x, pasted.y]).toEqual([12, 34]);
  });
});

describe("instances resolve into the instance's own box", () => {
  const master: ComponentElement = {
    id: "cmp",
    type: "component",
    name: "Card",
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    children: [{ id: "child", type: "rect", x: 20, y: 30, width: 40, height: 20 } as any]
  };
  const instance: InstanceElement = {
    id: "inst",
    type: "instance",
    componentId: "cmp",
    x: 400,
    y: 200,
    width: 200,
    height: 100
  };

  // The renderer draws resolved children inside `translate(instance.x, instance.y)`,
  // so their coordinates are instance-local and independent of where the master sits.
  it("returns instance-local coordinates, not a master-offset delta", () => {
    const resolved = resolveInstanceChildren(instance, master);
    expect(resolved[0].x).toBe(20);
    expect(resolved[0].y).toBe(30);
  });

  it("is unaffected by the master's own origin", () => {
    const moved = { ...master, x: 1000, y: 700 };
    const resolved = resolveInstanceChildren(instance, moved);
    expect(resolved[0].x).toBe(20);
    expect(resolved[0].y).toBe(30);
  });
});

describe("alignment uses the parent's own box", () => {
  it("aligns a child against a nested frame, not against the canvas", () => {
    const tree = [frame("outer", 1000, 500, [frame("inner", 50, 50, [{ id: "kid", type: "rect", x: 10, y: 10, width: 40, height: 40 }], { width: 200, height: 200 })])];
    const inner = (tree[0] as FrameElement).children![0] as FrameElement;
    const [kid] = alignElements([inner.children![0]], "right", { allElements: tree });
    expect((kid as any).x).toBe(160);
  });
});
