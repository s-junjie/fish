import { describe, it, expect } from "vitest";
import {
  ComponentElement,
  DesignDocument,
  DesignElement,
  InstanceElement
} from "../src/core/dsl/types";
import {
  createInstanceFromComponent,
  hasAnythingToReset,
  resetInstance,
  resetInstanceOverrides
} from "../src/core/interactions/component-ops";
import { findInstanceAtPoint } from "../src/core/interactions/component-inventory";
import { addVariantProperty, removeVariant } from "../src/core/interactions/component-variants";

/**
 * The three write paths that decide something by looking rather than by asking —
 * "is there anything to reset", "what did the drop land on", "which page is this
 * component on". Each of them could answer a question about one thing and act on
 * another, and each of those mismatches is silent.
 */

const canvas = {
  width: 800,
  height: 600,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#FFFFFF" }
};

function baseDoc(pages: DesignElement[][], activeIndex = 0): DesignDocument {
  const built = pages.map((elements, i) => ({
    id: `page_${i + 1}`,
    name: `Page ${i + 1}`,
    canvas,
    children: elements
  }));
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: built,
    activePageId: built[activeIndex].id,
    elements: built[activeIndex].children
  };
}

const instance = (extra: Partial<InstanceElement> = {}): InstanceElement =>
  ({
    id: "inst_1",
    type: "instance",
    componentId: "c_x",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...extra
  }) as InstanceElement;

describe("hasAnythingToReset agrees with what Reset would do", () => {
  it("says no for a virgin instance", () => {
    expect(hasAnythingToReset(instance())).toBe(false);
  });

  /**
   * `sizing` is COPIED from the master at creation (`createInstanceFromComponent`
   * does not materialise props, but it does copy the box and its sizing), so its
   * presence is not evidence that anybody changed it. Counting it as "dirty" made
   * every instance of a hugging master — or of a filled one, or one with a
   * corner radius — open with Reset already enabled, and pressing it produced a
   * commit and an undo step while the picture stayed identical.
   */
  it("says no for a fresh instance of a master that hugs", () => {
    const master: ComponentElement = {
      id: "c_hug",
      type: "component",
      name: "Hug",
      x: 0,
      y: 0,
      width: 80,
      height: 20,
      sizing: { width: "fit-content", height: "fit-content" },
      children: []
    };
    const { doc, instance: fresh } = createInstanceFromComponent(baseDoc([[master]]), "c_hug");
    expect(fresh!.sizing).toEqual({ width: "fit-content", height: "fit-content" });
    expect(hasAnythingToReset(fresh!, master)).toBe(false);
    // …and the command the button drives agrees, so Reset does not commit a
    // document that is byte-for-byte the one it started with.
    expect(resetInstance(doc, fresh!.id)).toBeNull();
  });

  it("still says yes when the user pinned an axis that the master does not pin", () => {
    const master: ComponentElement = {
      id: "c_hug",
      type: "component",
      name: "Hug",
      x: 0,
      y: 0,
      width: 80,
      height: 20,
      sizing: { width: "fit-content", height: "fit-content" },
      children: []
    };
    const pinned = instance({ sizing: { width: "fixed", height: "fit-content" } });
    expect(hasAnythingToReset(pinned, master)).toBe(true);
  });

  // The predicate used to ignore these keys while `resetInstanceOverrides`
  // deleted them, so an instance whose only change was one of them reported
  // "nothing to do" and the button that opens Reset stayed disabled.
  const resetClears: [string, Partial<InstanceElement>][] = [
    ["fillEnabled", { fillEnabled: false } as Partial<InstanceElement>],
    ["strokeStyleId", { strokeStyleId: "sty_1" } as Partial<InstanceElement>],
    ["textStyleId", { textStyleId: "sty_2" } as Partial<InstanceElement>],
    ["strokes", { strokes: [] } as Partial<InstanceElement>]
  ];

  for (const [name, patch] of resetClears) {
    it(`says yes for a lone ${name}`, () => {
      let inst = instance(patch);
      expect(hasAnythingToReset(inst)).toBe(true);
      // …and the reset really does clear it, which is the other half of the claim.
      inst = resetInstanceOverrides(inst);
      expect((inst as unknown as Record<string, unknown>)[name]).toBeUndefined();
      expect(hasAnythingToReset(inst)).toBe(false);
    });
  }
});

describe("findInstanceAtPoint does not reach into a definition", () => {
  const label = (id: string): DesignElement => ({
    id,
    type: "text",
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    content: "x",
    style: { fontFamily: "Inter", fontSize: 12, color: "#000000" }
  });

  const master: ComponentElement = {
    id: "c_card",
    type: "component",
    name: "Card",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    children: [
      {
        id: "card_slot",
        type: "instance",
        name: "Slot",
        componentId: "c_icon",
        x: 10,
        y: 10,
        width: 40,
        height: 40
      }
    ]
  };

  const sceneInstance = instance({ id: "inst_1", x: 200, y: 0, width: 100, height: 100 });

  it("ignores an instance that only exists inside a master", () => {
    const elements = [master, sceneInstance, label("t")];
    // The point is squarely on the master, and on the nested instance inside it.
    expect(findInstanceAtPoint(elements, 30, 30)).toBeNull();
  });

  it("still finds a real instance in the scene", () => {
    const elements = [master, sceneInstance, label("t")];
    expect(findInstanceAtPoint(elements, 240, 40)?.id).toBe("inst_1");
  });

  it("still descends into ordinary frames", () => {
    const frame: DesignElement = {
      id: "f_1",
      type: "frame",
      name: "F",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [instance({ id: "inst_inner", x: 20, y: 20, width: 40, height: 40 })]
    };
    expect(findInstanceAtPoint([frame], 40, 40)?.id).toBe("inst_inner");
  });
});

describe("variant writes stay on the page they read", () => {
  const LABELS = {
    property: (n: number) => `Property ${n}`,
    firstValue: "Default",
    nthValue: (n: number) => `Variant ${n}`
  };
  const component = (id: string, setId?: string): ComponentElement =>
    ({
      id,
      type: "component",
      name: id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      ...(setId ? { setId, variantProperties: { State: "on" } } : {})
    }) as ComponentElement;

  it("refuses to start a set from a component on another page", () => {
    // `locate` used to walk every page while the write went to the active one, so
    // this created a copy on the WRONG page and reported success.
    const doc = baseDoc([[component("c_here")], [component("c_there")]], 0);
    expect(addVariantProperty(doc, "c_there", LABELS).set).toBeNull();
    expect(addVariantProperty(doc, "c_here", LABELS).set).not.toBeNull();
  });

  it("refuses to remove a member that is not on the active page", () => {
    // The dangerous half: the removal found nothing, but the count of remaining
    // members was taken across every page — so the survivor lost its `setId` and
    // stopped being a member of a set nobody had touched.
    const onPage2 = component("c_b", "set_1");
    const doc = baseDoc([[component("c_a", "set_1")], [onPage2]], 0);

    expect(removeVariant(doc, "c_b")).toBeNull();
    expect((doc.pages![1].children[0] as ComponentElement).setId).toBe("set_1");
    expect((doc.pages![1].children[0] as ComponentElement).variantProperties).toEqual({
      State: "on"
    });
  });
});
