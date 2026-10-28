import { describe, it, expect } from "vitest";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";
import type { AutoLayout } from "../src/core/dsl/types";
import { flattenLayout } from "../src/core/dsl/layout-flat";
import { orderRowsForPanel, rowOrderOf } from "../src/ui/layers/row-order";

const rect = (id: string): DesignElement => ({ id, type: "rect", name: id } as DesignElement);

const frame = (id: string, children: DesignElement[], layout?: AutoLayout): DesignElement =>
  ({ id, type: "frame", name: id, children, ...(layout ? flattenLayout(layout) : {}) } as unknown as DesignElement);

const stack = (id: string, children: DesignElement[]): DesignElement =>
  frame(id, children, { mode: "flex", direction: "column", gap: 8, padding: 8 });

const component = (id: string, children: DesignElement[], layout?: AutoLayout): DesignElement =>
  ({ id, type: "component", name: id, children, ...(layout ? flattenLayout(layout) : {}) } as unknown as DesignElement);

const instanceOf = (id: string, componentId: string): DesignElement =>
  ({ id, type: "instance", name: id, componentId } as DesignElement);

const docOf = (elements: DesignElement[]): DesignDocument =>
  ({
    version: "0.3",
    activePageId: "p1",
    pages: [{ id: "p1", name: "Page 1", children: elements }],
    elements
  }) as unknown as DesignDocument;

describe("rowOrderOf", () => {
  it("is front-first for the page root, which has no parent to ask", () => {
    expect(rowOrderOf(docOf([]), null)).toBe("z");
  });

  it("is front-first for a free frame, where array order is paint order", () => {
    expect(rowOrderOf(docOf([]), frame("free", []))).toBe("z");
  });

  it("is first-child-first for a stack, where array order is flow order", () => {
    expect(rowOrderOf(docOf([]), stack("card", []))).toBe("flow");
  });

  it("reads the MASTER's layout for an instance, which stores none of its own", () => {
    const master = component("cmp", [], { mode: "flex", direction: "column" });
    const doc = docOf([master, instanceOf("card", "cmp")]);
    expect(rowOrderOf(doc, instanceOf("card", "cmp"))).toBe("flow");
  });

  it("keeps an instance of a layout-less master front-first", () => {
    const master = component("cmp", []);
    const doc = docOf([master, instanceOf("card", "cmp")]);
    expect(rowOrderOf(doc, instanceOf("card", "cmp"))).toBe("z");
  });

  it("falls back to front-first when the master is missing", () => {
    expect(rowOrderOf(docOf([]), instanceOf("orphan", "nope"))).toBe("z");
  });
});

describe("orderRowsForPanel", () => {
  const rows = [rect("a"), rect("b"), rect("c")];

  it("puts the topmost child first in a front-first list", () => {
    expect(orderRowsForPanel(rows, "z").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps a stack's list in flow order, matching the canvas", () => {
    expect(orderRowsForPanel(rows, "flow").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("never mutates the caller's array", () => {
    orderRowsForPanel(rows, "z");
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  // A child that left the flow keeps its authored slot: its index is a paint
  // order, and hoisting it would make every drop line across the boundary
  // promise an index the splice does not take.
  it("leaves a child that left the flow in its authored slot", () => {
    const absolute = { ...rect("abs"), position: "absolute" as const };
    const withAbsolute = [rect("a"), absolute, rect("c")];
    expect(orderRowsForPanel(withAbsolute, "flow").map((r) => r.id)).toEqual(["a", "abs", "c"]);
  });
});
