import { describe, expect, it } from "vitest";
import type { ComponentElement, DesignDocument, InstanceElement } from "../src/core/dsl/types";
import {
  instanceOwnFields,
  resetInstanceField
} from "../src/core/interactions/component-ops";

const canvas = { width: 1000, height: 1000, background: { type: "solid", color: "#FFFFFF" } } as const;

const master: ComponentElement = {
  id: "cmp",
  type: "component",
  name: "Card",
  x: 0,
  y: 0,
  width: 400,
  height: 200,
  sizing: { width: "fixed", height: "fixed" },
  fills: [{ type: "solid", color: "#111111" }],
  children: [
    { id: "title", type: "text", name: "Title", x: 16, y: 16, width: 200, height: 24, content: "Hello", style: { fontFamily: "Inter", fontSize: 14, color: "#111111" } }
  ]
};

function docWith(instance: InstanceElement): DesignDocument {
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "",
    updatedAt: "",
    canvas: canvas as never,
    pages: [{ id: "p1", name: "P1", canvas: canvas as never, children: [master, instance] }],
    activePageId: "p1"
  } as unknown as DesignDocument;
}

const pristine = (): InstanceElement => ({
  id: "inst",
  type: "instance",
  name: "Card",
  componentId: "cmp",
  x: 500,
  y: 0,
  width: 400,
  height: 200,
  sizing: { width: "fixed", height: "fixed" },
  overrides: []
});

describe("an instance's own fields are listed one by one", () => {
  it("says nothing about an instance that only ever copied its master", () => {
    expect(instanceOwnFields(pristine(), master)).toEqual([]);
  });

  it("names each field the user changed, and does not count an unchanged sizing", () => {
    const inst: InstanceElement = {
      ...pristine(),
      fills: [{ type: "solid", color: "#FF0000" }],
      borderRadius: 12,
      overrides: [{ targetId: "title", property: "content", value: "Hi" }]
    };
    expect(instanceOwnFields(inst, master)).toEqual(["fills", "borderRadius"]);
  });

  it("treats a resized box and a scale as two different answers", () => {
    expect(instanceOwnFields({ ...pristine(), sizeOverride: true }, master)).toEqual(["size"]);
    expect(instanceOwnFields({ ...pristine(), instanceScale: { x: 0.5, y: 0.5 } }, master)).toEqual([
      "instanceScale"
    ]);
  });

  it("counts a sizing that went from the master's to something else", () => {
    const inst: InstanceElement = { ...pristine(), sizing: { width: "fit-content", height: "fixed" } };
    expect(instanceOwnFields(inst, master)).toEqual(["sizing"]);
  });
});

describe("one field at a time goes back to the master", () => {
  const read = (doc: DesignDocument): InstanceElement =>
    doc.pages[0].children.find((el) => el.id === "inst") as InstanceElement;

  it("gives back the fill and keeps the rest", () => {
    const inst: InstanceElement = {
      ...pristine(),
      fills: [{ type: "solid", color: "#FF0000" }],
      borderRadius: 12,
      overrides: [{ targetId: "title", property: "content", value: "Hi" }]
    };
    const next = resetInstanceField(docWith(inst), "inst", "fills")!;
    const after = read(next);
    expect(after.fills, "inherits the master's fill again").toBeUndefined();
    expect(after.borderRadius, "the radius the user set survives").toBe(12);
    expect(after.overrides?.length, "and so does the child's copy").toBe(1);
  });

  it("gives back the scale together with the box it produced", () => {
    const inst: InstanceElement = { ...pristine(), instanceScale: { x: 0.5, y: 0.5 }, width: 200, height: 100 };
    const after = read(resetInstanceField(docWith(inst), "inst", "instanceScale")!);
    expect(after.instanceScale).toBeUndefined();
    expect([after.width, after.height]).toEqual([400, 200]);
  });

  it("resets the two box statements one at a time", () => {
    // Two tags, so two edits: giving back the hand-set box must not also drop a
    // scale, and giving back the scale must not claim the box the user dragged.
    const scaledAndDragged: InstanceElement = {
      ...pristine(),
      instanceScale: { x: 0.5, y: 0.5 },
      sizeOverride: true,
      width: 180,
      height: 90
    };
    const noSize = read(resetInstanceField(docWith(scaledAndDragged), "inst", "size")!);
    expect(noSize.sizeOverride).toBeUndefined();
    expect(noSize.instanceScale, "the scale the user applied is still a fact").toEqual({ x: 0.5, y: 0.5 });
    expect([noSize.width, noSize.height], "the box follows master × factor").toEqual([200, 100]);

    const noScale = read(resetInstanceField(docWith(scaledAndDragged), "inst", "instanceScale")!);
    expect(noScale.instanceScale).toBeUndefined();
    expect(noScale.sizeOverride, "a hand-set box stays the user's").toBe(true);
    expect([noScale.width, noScale.height], "and is not overwritten by the master's").toEqual([180, 90]);
  });

  it("gives back a hand-set box without touching anything else", () => {
    const inst: InstanceElement = { ...pristine(), sizeOverride: true, width: 320, height: 180, borderRadius: 8 };
    const after = read(resetInstanceField(docWith(inst), "inst", "size")!);
    expect(after.sizeOverride).toBeUndefined();
    expect([after.width, after.height]).toEqual([400, 200]);
    expect(after.borderRadius).toBe(8);
  });

  it("refuses a field the instance never set", () => {
    expect(resetInstanceField(docWith(pristine()), "inst", "fills")).toBeNull();
  });
});
