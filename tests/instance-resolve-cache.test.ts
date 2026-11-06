import { describe, it, expect, afterEach } from "vitest";
import type { ComponentElement, DesignElement, InstanceElement } from "../src/core/dsl/types";
import { resolveInstanceContent } from "../src/core/interactions/instance-resolve";
import { clearTextMeasureCache, textMeasureRevision } from "../src/core/geometry/text-measure";
import {
  clearAmbientChildSizeResolver,
  setAmbientChildSizeResolver
} from "../src/core/layout/context";

/**
 * A dragged instance is the same question asked once per frame: the renderer and
 * `<defs>` both resolve it, and neither `x` nor `y` reaches a child's local
 * coordinates. Re-resolving anyway cloned the subtree and re-ran its layout every
 * frame, so every cloned child's `prev.el !== next.el` failed and `<defs>` rebuilt
 * it. These tests pin the two halves of the answer: what must hit, and what must
 * NOT be served from the cache.
 */

const master = (): ComponentElement => ({
  id: "card",
  type: "component",
  name: "CARD",
  x: 0,
  y: 0,
  width: 200,
  height: 120,
  children: [
    { id: "bg", type: "rect", name: "bg", x: 0, y: 0, width: 200, height: 120 },
    {
      id: "label",
      type: "text",
      name: "label",
      x: 12,
      y: 12,
      width: 150,
      height: 20,
      content: "Card",
      style: { fontFamily: "Inter", fontSize: 14, color: "#111111" }
    }
  ]
});

const instance = (x: number, y: number): InstanceElement => ({
  id: "cardInst",
  type: "instance",
  name: "CARD",
  componentId: "card",
  x,
  y,
  width: 200,
  height: 120
});

afterEach(() => clearAmbientChildSizeResolver());

describe("resolveInstanceContent caching", () => {
  it("returns the same children when only the instance moved", () => {
    const m = master();
    const atOrigin = resolveInstanceContent(instance(0, 0), m);
    const moved = resolveInstanceContent(instance(300, 40), m);

    expect(moved).toBe(atOrigin);
    expect(moved.children).toBe(atOrigin.children);
    expect(moved.children[0]).toBe(atOrigin.children[0]);
  });

  it("resolves again when the box the layout reads changes", () => {
    const m = master();
    const base = resolveInstanceContent(instance(0, 0), m);
    const wider = resolveInstanceContent({ ...instance(0, 0), width: 260 }, m);

    expect(wider).not.toBe(base);
  });

  it("resolves again when the overrides change", () => {
    const m = master();
    const base = resolveInstanceContent(instance(0, 0), m);
    const overridden = resolveInstanceContent(
      {
        ...instance(0, 0),
        overrides: [{ targetId: "label", property: "content", value: "Changed" }]
      },
      m
    );

    expect(overridden).not.toBe(base);
    const label = overridden.children.find((el) => el.__masterNodeId === "label")!;
    expect(label.type === "text" && label.content).toBe("Changed");
  });

  it("keys the cache on the instance id, which is every child id's prefix", () => {
    const m = master();
    const a = resolveInstanceContent(instance(0, 0), m);
    const b = resolveInstanceContent({ ...instance(0, 0), id: "otherInst" }, m);

    expect(b).not.toBe(a);
    expect(b.children[0].id).not.toBe(a.children[0].id);
  });

  /**
   * The nested instance's MEASURED box is the one layout input outside the
   * master, the instance and its overrides: `relayoutDocumentTree` asks the
   * store's ambient resolver, which resolves that instance against the document.
   * If a change there were served from this cache, a card would stay laid out
   * against a nested size its own master no longer paints.
   */
  it("resolves again when a nested instance's measured box changes", () => {
    const m: ComponentElement = {
      id: "stack",
      type: "component",
      name: "STACK",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      display: "flex",
      "flex-direction": "column",
      "align-items": "flex-start",
      gap: 8,
      children: [
        {
          id: "nested",
          type: "instance",
          name: "NESTED",
          componentId: "chip",
          x: 0,
          y: 0,
          width: 60,
          height: 20
        } as InstanceElement,
        { id: "below", type: "rect", name: "below", x: 0, y: 0, width: 60, height: 20 } as DesignElement
      ]
    };
    const inst = (): InstanceElement => ({
      id: "stackInst",
      type: "instance",
      name: "STACK",
      componentId: "stack",
      x: 0,
      y: 0,
      width: 200,
      height: 200
    });

    let nestedHeight = 20;
    setAmbientChildSizeResolver((el) =>
      el.type === "instance" ? { width: 60, height: nestedHeight } : null
    );

    const first = resolveInstanceContent(inst(), m);
    expect(resolveInstanceContent(inst(), m)).toBe(first);

    nestedHeight = 60;
    expect(resolveInstanceContent(inst(), m)).not.toBe(first);
  });
});

/**
 * The key above lists everything a resolution READS — except the measurements it
 * takes. A font that arrives changes what a box measures while leaving the
 * master, the overrides and the instance untouched, so a cache that could not see
 * it kept the fallback face's boxes for the rest of the session.
 */
describe("a new set of measurements is a new resolution", () => {
  it("resolves again once the measurement cache is dropped", () => {
    const m = master();
    const first = resolveInstanceContent(instance(0, 0), m);
    expect(resolveInstanceContent(instance(0, 0), m), "nothing changed yet").toBe(first);

    clearTextMeasureCache();
    const again = resolveInstanceContent(instance(0, 0), m);
    expect(again).not.toBe(first);
  });

  it("moves the generation on a clear, and only then", () => {
    const before = textMeasureRevision();
    resolveInstanceContent(instance(0, 0), master());
    expect(textMeasureRevision(), "measuring is not invalidating").toBe(before);
    clearTextMeasureCache();
    expect(textMeasureRevision()).toBe(before + 1);
  });
});
