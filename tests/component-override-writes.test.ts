import { describe, it, expect } from "vitest";
import { applyOps } from "../src/core/ops/apply-ops";
import {
  commitInstanceOverrides,
  resolveInstanceChildren,
  resolveInstanceSelection
} from "../src/core/interactions/instance-resolve";
import { ComponentElement, DesignDocument, DesignElement, InstanceElement, TextElement } from "../src/core/dsl/types";

/**
 * The two write paths that still carry a DELTA into a container of keys: `patch`
 * with a nested-object delta, and an override on a bag property (`style`).
 *
 * Both used to read the delta as the finished value, so the second write erased
 * whatever the first had put there. Neither test suite caught it: the property
 * tests exercised `removePropDef` directly rather than through the op, and the
 * nested-property tests only ever wrote ONE key, which reads as "the bag is kept"
 * when the bag has nothing else in it.
 *
 * `variantProperties` is what a nested patch targets now that `propDefs` is gone —
 * `{ variantProperties: { State: "Hover" } }` means "rename this axis and keep
 * every other one", and reading it as the finished value would silently drop the
 * rest of a variant's coordinates.
 */

const baseCanvas = { width: 400, height: 200, unit: "px" as const, background: { type: "solid" as const, color: "#101010" } };

function baseDoc(elements: DesignElement[]): DesignDocument {
  return {
    version: "0.1",
    id: "d",
    name: "D",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: baseCanvas,
    pages: [{ id: "p", name: "P", canvas: baseCanvas, children: elements }],
    activePageId: "p",
    elements
  };
}

const text = (id: string, content: string): TextElement =>
  ({
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 80,
    height: 20,
    content,
    style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" }
  }) as TextElement;

const variant = (id: string, coords: Record<string, string>): ComponentElement =>
  ({
    id,
    type: "component",
    name: Object.entries(coords).map(([k, v]) => `${k}=${v}`).join(", "),
    setId: "set_1",
    variantProperties: coords,
    x: 0,
    y: 0,
    width: 80,
    height: 20,
    children: [text(`${id}_t`, "Buy")]
  }) as ComponentElement;

const twoAxisFixture = (): DesignDocument =>
  baseDoc([variant("c_a", { Size: "Small", State: "Default" })]);

describe("patch with a nested-object delta", () => {
  it("keeps the sibling keys the patch did not name", () => {
    const { doc } = applyOps(twoAxisFixture(), [
      {
        op: "patch",
        targetId: "c_a",
        props: { variantProperties: { State: "Hover" } }
      }
    ]);
    // A deep merge, so one renamed axis cannot quietly blank the other.
    expect((doc.pages![0].children[0] as ComponentElement).variantProperties).toEqual({
      Size: "Small",
      State: "Hover"
    });
  });

  it("keeps the layer the variant names after it in sync", () => {
    const { doc } = applyOps(twoAxisFixture(), [
      { op: "patch", targetId: "c_a", props: { variantProperties: { State: "Hover" } } }
    ]);
    // The name IS the coordinates, so a patch that renames an axis has to rename
    // the member too — a layer reading `Size=Small, State=Default` beside a member
    // at `State=Hover` is the confusing pairing this model exists to prevent.
    expect((doc.pages![0].children[0] as ComponentElement).name).toBe("Size=Small, State=Hover");
  });
});

describe("an override on a bag property", () => {
  const master = (): ComponentElement =>
    ({
      id: "c_btn",
      type: "component",
      name: "Button",
      x: 0,
      y: 0,
      width: 80,
      height: 20,
      children: [text("t_btn", "Buy")]
    }) as ComponentElement;

  const docWith = (overrides: InstanceElement["overrides"]): DesignDocument =>
    baseDoc([
      master(),
      {
        id: "inst_1",
        type: "instance",
        componentId: "c_btn",
        x: 200,
        y: 0,
        width: 80,
        height: 20,
        overrides
      } as InstanceElement
    ]);

  /** One axis edited, through the same path the inspector uses. */
  const editStyle = (doc: DesignDocument, patch: Record<string, unknown>): DesignDocument => {
    const sel = resolveInstanceSelection(doc, "inst_1_t_btn")!;
    const next = commitInstanceOverrides(doc, [sel], (el) => ({
      ...el,
      style: { ...((el as TextElement).style ?? {}), ...patch }
    }))!;
    return next;
  };

  it("stores only the axis that changed, so the rest still follows the master", () => {
    const one = editStyle(docWith([]), { fontSize: 18 });
    expect((one.pages![0].children[1] as InstanceElement).overrides).toEqual([
      { targetId: "t_btn", property: "style", value: { fontSize: 18 } }
    ]);
  });

  it("keeps an axis an earlier edit wrote when a second one lands", () => {
    const one = editStyle(docWith([]), { fontSize: 18 });
    const two = editStyle(one, { color: "#FF0000" });
    // Both, and neither is the whole bag: storing the object wholesale would pin
    // fontFamily and every other axis onto this instance for good.
    expect((two.pages![0].children[1] as InstanceElement).overrides).toEqual([
      { targetId: "t_btn", property: "style", value: { fontSize: 18, color: "#FF0000" } }
    ]);
  });

  it("resolves both values together", () => {
    const doc = editStyle(editStyle(docWith([]), { fontSize: 18 }), { color: "#FF0000" });
    const painted = resolveInstanceChildren(
      doc.pages![0].children[1] as InstanceElement,
      doc.pages![0].children[0] as ComponentElement
    )[0] as TextElement;
    expect(painted.style.fontSize).toBe(18);
    expect(painted.style.color).toBe("#FF0000");
    // The axis neither edit touched still comes from the master — which is the
    // whole reason a bag override is stored per key.
    expect(painted.style.fontFamily).toBe("Inter");
  });
});