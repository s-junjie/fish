import { describe, it, expect } from "vitest";
import { applyOps } from "../src/core/ops/apply-ops";
import {
  ComponentElement,
  DesignDocument,
  DesignElement,
  InstanceElement,
  TextElement
} from "../src/core/dsl/types";

/**
 * `patch` on a node inside an instance.
 *
 * A resolved clone is painted but never stored, so the id the canvas hands out
 * (`<instanceId>_<masterNodeId>`) names nothing a tree walk can find. Every op
 * reached by id therefore failed on one, and `patch` was the op that mattered:
 * "restyle this label inside this button" is one of the most common edits in the
 * document and the inspector reaches it by a route no script had.
 *
 * The refusals are here for the opposite reason. `replace` mapped over the
 * element list, so a derived id changed nothing and still answered ok — the
 * outcome apply-ops refuses to produce anywhere else, because a caller has no way
 * to learn the edit landed nowhere.
 */

const baseCanvas = {
  width: 400,
  height: 200,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#101010" }
};

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

const instance = (overrides?: InstanceElement["overrides"]): InstanceElement =>
  ({
    id: "inst_1",
    type: "instance",
    componentId: "c_btn",
    x: 200,
    y: 0,
    width: 80,
    height: 20,
    ...(overrides ? { overrides } : {})
  }) as InstanceElement;

const fixture = (): DesignDocument => baseDoc([master(), instance()]);

/** The clone id the canvas and `measure()` both hand out for the master's label. */
const CLONE_ID = "inst_1_t_btn";

const elsOf = (doc: DesignDocument): DesignElement[] => doc.pages![0].children;
const instanceIn = (doc: DesignDocument): InstanceElement =>
  elsOf(doc).find((el) => el.id === "inst_1") as InstanceElement;
const masterIn = (doc: DesignDocument): ComponentElement =>
  elsOf(doc).find((el) => el.id === "c_btn") as ComponentElement;

describe("patch on a node inside an instance", () => {
  it("writes an override on the instance instead of failing on the id", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { content: "Add to cart" } }
    ]);

    expect(result.outcomes[0].ok).toBe(true);
    const ov = instanceIn(result.doc).overrides ?? [];
    expect(ov).toContainEqual({ targetId: "t_btn", property: "content", value: "Add to cart" });
  });

  it("accepts the file's CSS spellings for a clone override", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { "font-size": "20px", color: "#FF0000" } }
    ]);

    expect(result.outcomes[0].ok).toBe(true);
    const ov = instanceIn(result.doc).overrides ?? [];
    expect(ov).toContainEqual({
      targetId: "t_btn",
      property: "style",
      value: expect.objectContaining({ fontSize: 20 })
    });
    expect(ov).toContainEqual({
      targetId: "t_btn",
      property: "fills",
      value: [{ type: "solid", color: "#FF0000" }]
    });
  });

  it("leaves the master alone — an override is the whole point", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { content: "Add to cart" } }
    ]);

    const label = masterIn(result.doc).children![0] as TextElement;
    expect(label.content).toBe("Buy");
  });

  it("names the instance and the master in the outcome detail", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { content: "Checkout" } }
    ]);

    expect(result.outcomes[0].ok).toBe(true);
    expect(result.outcomes[0].detail).toContain("inst_1");
    expect(result.outcomes[0].detail).toContain("c_btn");
    expect(result.outcomes[0].id).toBe(CLONE_ID);
  });

  it("writes one axis of `style` without pinning the other two on the instance", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { style: { fontSize: 18 } } }
    ]);

    expect(result.outcomes[0].ok).toBe(true);
    const ov = (instanceIn(result.doc).overrides ?? []).find((o) => o.property === "style");
    // The per-axis diff is what lets the instance keep following the master for
    // fontFamily and colour, which a whole-bag override would freeze forever.
    expect(ov?.value).toEqual({ fontSize: 18 });
  });

  it("keeps an override it already had", () => {
    const seeded = fixture();
    (elsOf(seeded)[1] as InstanceElement).overrides = [
      { targetId: "t_btn", property: "visible", value: false }
    ];

    const result = applyOps(seeded, [
      { op: "patch", targetId: CLONE_ID, props: { content: "Sold out" } }
    ]);

    const props = (instanceIn(result.doc).overrides ?? []).map((o) => o.property).sort();
    expect(props).toEqual(["content", "visible"]);
  });

  it("reports a property the instance cannot own rather than claiming success", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { width: 400 } }
    ]);

    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].detail).toContain("width");
    expect(instanceIn(result.doc).overrides ?? []).toHaveLength(0);
  });

  it("names the overridable set, so the next attempt does not repeat this one", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { width: 400 } }
    ]);

    expect(result.outcomes[0].detail).toContain("fills");
    expect(result.outcomes[0].detail).toContain("borderRadius");
  });

  it("reports a patch that changed nothing the clone had not already resolved to", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: CLONE_ID, props: { content: "Buy" } }
    ]);

    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].detail).toContain("nothing written");
  });

  it("returns the document untouched when the patch was refused", () => {
    const before = fixture();
    const result = applyOps(before, [
      { op: "patch", targetId: CLONE_ID, props: { width: 400 } }
    ]);

    expect(result.changed).toBe(false);
    expect(instanceIn(result.doc).overrides ?? []).toHaveLength(0);
    expect(masterIn(result.doc).children![0].id).toBe("t_btn");
  });
});

describe("an op that cannot reach a node inside an instance", () => {
  it("refuses `replace`, which would otherwise report success and write nothing", () => {
    const result = applyOps(fixture(), [
      { op: "replace", targetId: CLONE_ID, element: { type: "rect", width: 10, height: 10 } }
    ]);

    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].detail).toContain("c_btn");
    // The load-bearing half: nothing moved, and it says so.
    expect(masterIn(result.doc).children![0].id).toBe("t_btn");
  });

  it("refuses `remove` with the master to edit instead of 'not found'", () => {
    const result = applyOps(fixture(), [{ op: "remove", targetIds: [CLONE_ID] }]);

    expect(result.outcomes[0].ok).toBe(false);
    // "not found" reads as a stale id and sends the caller looking for a typo;
    // the real answer is that the node exists and lives somewhere else.
    expect(result.outcomes[0].detail).not.toContain("not found");
    expect(result.outcomes[0].detail).toContain("c_btn");
    expect(instanceIn(result.doc)).toBeTruthy();
  });

  it("refuses an insert whose parentId is a node inside an instance", () => {
    const result = applyOps(fixture(), [
      { op: "insert", parentId: CLONE_ID, element: { type: "rect", width: 10, height: 10 } }
    ]);

    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].detail).toContain("c_btn");
    expect(elsOf(result.doc)).toHaveLength(2);
  });

  it("refuses a wrap whose targetIds include one, rather than reparenting around it", () => {
    const result = applyOps(fixture(), [
      { op: "intent", intent: "wrap-in-stack", targetIds: [CLONE_ID] }
    ]);

    expect(result.outcomes[0].ok).toBe(false);
    expect(elsOf(result.doc)).toHaveLength(2);
  });

  it("removes the reachable target and still reports the unreachable one", () => {
    const withFrame = fixture();
    elsOf(withFrame).push({
      id: "f_card",
      type: "frame",
      x: 0,
      y: 100,
      width: 200,
      height: 80,
      children: []
    } as DesignElement);

    const result = applyOps(withFrame, [{ op: "remove", targetIds: ["f_card", CLONE_ID] }]);

    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].detail).toContain("removed f_card");
    expect(result.outcomes[0].detail).toContain("c_btn");
    // Partially applied, and the report says which half: returning the untouched
    // document would discard a removal the caller has no other record of.
    expect(elsOf(result.doc).some((el) => el.id === "f_card")).toBe(false);
    expect(instanceIn(result.doc)).toBeTruthy();
  });
});

describe("an id that names nothing at all", () => {
  it("still fails as a missing id, not as a derived node", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: "nope_1", props: { content: "x" } }
    ]);

    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].detail).toContain("no element with id");
  });

  it("leaves the stored-node path untouched", () => {
    const result = applyOps(fixture(), [
      { op: "patch", targetId: "t_btn", props: { content: "Order" } }
    ]);

    // No override: this id is a real node on the master, so it takes the
    // mapElements path and writes where it says it writes.
    expect(result.outcomes[0].ok).toBe(true);
    expect((masterIn(result.doc).children![0] as TextElement).content).toBe("Order");
    expect(instanceIn(result.doc).overrides ?? []).toHaveLength(0);
  });
});