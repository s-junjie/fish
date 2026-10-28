import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { getActivePage, type DesignElement, type InstanceElement } from "../src/core/dsl/types";
import { validateDocument } from "../src/core/validate";

const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#ffffff" } };

function docWith(children: unknown[]) {
  return normalizeDesignDocument({
    version: "0.1",
    id: "doc",
    name: "doc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas,
    pages: [{ id: "p", name: "P", canvas, children }],
    activePageId: "p"
  }).document;
}

const master = {
  id: "cmp",
  type: "component",
  x: 0,
  y: 0,
  width: 100,
  height: 36,
  fills: [{ type: "solid", color: "#222222" }],
  children: []
};

const find = (els: DesignElement[], id: string): DesignElement => {
  for (const el of els) {
    if (el.id === id) return el;
    const children = (el as { children?: DesignElement[] }).children;
    if (children && children.length > 0) {
      const hit = find(children, id);
      if (hit) return hit;
    }
  }
  throw new Error(`missing ${id}`);
};

const instance = (extra: Record<string, unknown> = {}) => ({
  id: "inst",
  type: "instance",
  componentId: "cmp",
  x: 200,
  y: 0,
  ...extra
});

describe("instance box inheritance", () => {
  it("copies both axes when the instance omits its box", () => {
    const inst = find(getActivePage(docWith([master, instance()])).children, "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([100, 36]);
  });

  it("inherits only the omitted axis", () => {
    const inst = find(getActivePage(docWith([master, instance({ width: 80 })])).children, "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([80, 36]);
  });

  it("keeps an explicitly authored 0", () => {
    const inst = find(getActivePage(docWith([master, instance({ height: 0 })])).children, "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([100, 0]);
  });

  it("finds a master nested in a component set on another page", () => {
    const doc = normalizeDesignDocument({
      version: "0.1",
      id: "doc",
      name: "doc",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      canvas,
      pages: [
        { id: "masters", name: "Masters", canvas, children: [{ id: "set", type: "componentSet", x: 0, y: 0, width: 100, height: 36, children: [master] }] },
        { id: "p", name: "P", canvas, children: [instance(), { id: "frame", type: "frame", x: 0, y: 0, width: 300, height: 100, children: [instance({ id: "nested" })] }] }
      ],
      activePageId: "p"
    }).document;
    const page = doc.pages[1];
    expect((find(page.children, "inst") as InstanceElement).width).toBe(100);
    expect((find(page.children, "nested") as InstanceElement).height).toBe(36);
  });

  it("does not warn when the box was inherited", () => {
    const doc = docWith([master, instance()]);
    expect(validateDocument(doc).some((d) => d.message.includes("box while master"))).toBe(false);
  });

  it("warns when an explicit 0 leaves the master's chrome without a box", () => {
    const doc = docWith([master, instance({ height: 0 })]);
    expect(validateDocument(doc).some((d) => d.message.includes("box while master"))).toBe(true);
  });

  it("does not warn on a hugging axis", () => {
    const hug = { ...master, width: undefined, display: "flex" };
    const doc = docWith([hug, instance({ width: 0 })]);
    expect(validateDocument(doc).some((d) => d.message.includes("box while master"))).toBe(false);
  });

  it("works through the top-level elements spelling", () => {
    const doc = normalizeDesignDocument({
      version: "0.1",
      id: "doc",
      name: "doc",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      canvas,
      elements: [master, instance()],
      pages: [{ id: "p", name: "P", canvas, children: [] }],
      activePageId: "p"
    }).document;
    const inst = find(getActivePage(doc).children, "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([100, 36]);
  });

  it("leaves an instance alone when the master has no authored box", () => {
    const hug = { ...master, width: undefined, height: undefined, display: "flex" };
    const inst = find(getActivePage(docWith([hug, instance()])).children, "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([0, 0]);
  });
});
