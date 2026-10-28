import { flattenLayout } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import {
  ComponentElement,
  DesignDocument,
  DesignElement,
  FrameElement,
  InstanceElement,
  Page
} from "../src/core/dsl/types";
import { EditorStore } from "../src/core/store/editor-store";
import { propagateMasterSize } from "../src/core/interactions/instance-inherit";
import { resetInstanceOverrides } from "../src/core/interactions/component-ops";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

const canvas = {
  width: 1600,
  height: 1000,
  background: { type: "solid" as const, color: "#101010" },
  unit: "px" as const
};

const master = (w = 200, h = 100): ComponentElement => ({
  id: "cmp",
  type: "component",
  name: "Card",
  x: 0,
  y: 0,
  width: w,
  height: h,
  children: []
});

const instance = (overrides: Partial<InstanceElement> = {}): InstanceElement => ({
  id: "inst",
  type: "instance",
  name: "Card Instance",
  componentId: "cmp",
  x: 400,
  y: 0,
  width: 200,
  height: 100,
  ...overrides
});

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
    activePageId: "page_1"
  };
}

const withMaster = (w: number, h: number, elements: DesignElement[]) =>
  docOf(elements.map((el) => (el.id === "cmp" ? { ...master(w, h) } : el)));

describe("a resized master reaches its instances", () => {
  it("copies the new box onto an instance that never set its own", () => {
    const next = propagateMasterSize(docOf([master(), instance()]), withMaster(320, 240, [master(), instance()]));
    const inst = getActivePage(next).children.find((el) => el.id === "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([320, 240]);
  });

  it("leaves an instance the user sized by hand alone", () => {
    const own = instance({ width: 999, height: 111, sizeOverride: true });
    const next = propagateMasterSize(docOf([master(), own]), withMaster(320, 240, [master(), own]));
    const inst = getActivePage(next).children.find((el) => el.id === "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([999, 111]);
  });

  it("is a no-op while the master keeps its size", () => {
    const before = docOf([master(), instance()]);
    const after = docOf([master(), { ...instance(), x: 900 }]);
    expect(propagateMasterSize(before, after)).toBe(after);
  });

  it("writes the new box onto the page record, not beside it", () => {
    const next = propagateMasterSize(docOf([master(), { ...instance(), width: 100 }]), withMaster(320, 240, [master(), { ...instance(), width: 100 }]));
    expect(next.pages![0].children.find((el) => el.id === "inst")).toMatchObject({ width: 320, height: 240 });
  });

  it("reaches instances on another page", () => {
    const design = docOf([master(), instance()]);
    const second: Page = { id: "page_2", name: "Page 2", canvas, children: [instance({ id: "far" })] };
    const before: DesignDocument = { ...design, pages: [...design.pages!, second] };
    const after: DesignDocument = { ...withMaster(320, 240, [master(), instance()]), pages: [...withMaster(320, 240, [master(), instance()]).pages!, { ...second, children: [instance({ id: "far" })] }] };
    const next = propagateMasterSize(before, after);
    expect((next.pages![1].children[0] as InstanceElement).width).toBe(320);
  });

  it("leaves an axis owned by the parent's layout to that layout", () => {
    // `fill` width belongs to the flex parent, so only the height follows the
    // master — the same axis a canvas resize refuses to drag.
    const row: FrameElement = {
      id: "row",
      type: "frame",
      name: "Row",
      x: 0,
      y: 300,
      width: 600,
      height: 100,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 0 }),
      children: [instance({ id: "kid", width: 600, height: 100, sizing: { width: "fill", height: "fixed" } })]
    };
    const before = docOf([master(), row]);
    const widened: FrameElement = { ...row, children: [{ ...(row.children![0] as InstanceElement), height: 100 }] };
    const after = withMaster(320, 240, [master(), widened]);
    const next = propagateMasterSize(before, after);
    const kid = ((getActivePage(next).children.find((el) => el.id === "row") as FrameElement).children![0] as InstanceElement);
    expect(kid.width).toBe(600);
    expect(kid.height).toBe(240);
  });
});

describe("the editor store is what runs the propagation", () => {
  it("propagates on a plain commit", () => {
    const store = new EditorStore(docOf([master(), instance()]));
    store.commit(withMaster(320, 240, [master(), instance()]));
    const inst = getActivePage(store.getDoc()).children.find((el) => el.id === "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([320, 240]);
  });

  it("propagates on a transient frame too (a gesture resizing a master)", () => {
    const store = new EditorStore(docOf([master(), instance()]));
    store.setTransient(withMaster(320, 240, [master(), instance()]));
    const inst = getActivePage(store.getDoc()).children.find((el) => el.id === "inst") as InstanceElement;
    expect(inst.width).toBe(320);
  });

  it("leaves the size alone when a snapshot is restored (undo)", () => {
    const store = new EditorStore(docOf([master(), instance()]));
    store.commit(withMaster(320, 240, [master(), instance()]));
    store.undo();
    const inst = getActivePage(store.getDoc()).children.find((el) => el.id === "inst") as InstanceElement;
    expect([inst.width, inst.height]).toEqual([200, 100]);
  });
});

describe("reset releases the hand-set box", () => {
  it("restores the master's size and drops the flag", () => {
    const own = instance({ width: 999, height: 111, sizeOverride: true });
    const next = resetInstanceOverrides(own, master(320, 240));
    expect([next.width, next.height]).toEqual([320, 240]);
    expect(next.sizeOverride).toBeUndefined();
    expect(next.overrides).toEqual([]);
  });

  it("keeps the box when no master is at hand", () => {
    const own = instance({ width: 999, height: 111, sizeOverride: true });
    const next = resetInstanceOverrides(own);
    expect([next.width, next.height]).toEqual([999, 111]);
  });
});

describe("the flag survives a save", () => {
  it("normalize keeps sizeOverride and drops it when absent", () => {
    const { document: saved } = normalizeDesignDocument(
      docOf([master(), instance({ width: 999, sizeOverride: true })])
    );
    const kept = saved.pages![0].children.find((el) => el.id === "inst") as InstanceElement;
    expect(kept.sizeOverride).toBe(true);

    const { document: plain } = normalizeDesignDocument(docOf([master(), instance()]));
    const bare = plain.pages![0].children.find((el) => el.id === "inst") as InstanceElement;
    expect(bare.sizeOverride).toBeUndefined();
  });
});
