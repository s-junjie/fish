import { describe, expect, it } from "vitest";
import type {
  ComponentElement,
  ComponentSetElement,
  DesignDocument,
  DesignElement,
  InstanceElement
} from "../src/core/dsl/types";
import { componentSwapOptions, findSwapTargetAtPoint } from "../src/core/interactions/component-swap";
import { groupComponentSets, variantHoles } from "../src/core/interactions/component-inventory";
import { parseBooleanPair } from "../src/ui/inspector/InstanceVariantSection";

const canvas = { width: 2000, height: 2000, background: { type: "solid", color: "#FFFFFF" } } as const;

function docOf(children: DesignElement[]): DesignDocument {
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: canvas as never,
    pages: [{ id: "p1", name: "P1", canvas: canvas as never, children }],
    activePageId: "p1"
  } as unknown as DesignDocument;
}

function member(
  id: string,
  setId: string,
  name: string,
  coords: Record<string, string>,
  y: number
): ComponentElement {
  return {
    id,
    type: "component",
    name,
    x: 0,
    y,
    width: 120,
    height: 40,
    setId,
    variantProperties: coords,
    children: [{ id: `${id}_label`, type: "rect", name: "label", x: 0, y: 0, width: 40, height: 20 }]
  };
}

function set(id: string, name: string, table: Record<string, string[]>, members: ComponentElement[]): ComponentSetElement {
  return {
    id,
    type: "componentSet",
    name,
    x: 0,
    y: 0,
    width: 300,
    height: 300,
    variantGroupProperties: table,
    children: members
  } as ComponentSetElement;
}

function standalone(id: string, name: string): ComponentElement {
  return {
    id,
    type: "component",
    name,
    x: 0,
    y: 900,
    width: 80,
    height: 40,
    children: []
  };
}

/**
 * `Button` is a 2×2 of State and Size; `Chip` shares the `State` axis so a swap
 * between them has something to carry across; `Badge` has neither, so a swap to
 * it must fall back to its default variant.
 */
function familyDoc(instance: InstanceElement): DesignDocument {
  const button = set(
    "set_button",
    "Button",
    { State: ["Default", "Hover"], Size: ["S", "L"] },
    [
      member("btn_d_s", "set_button", "State=Default, Size=S", { State: "Default", Size: "S" }, 0),
      member("btn_h_s", "set_button", "State=Hover, Size=S", { State: "Hover", Size: "S" }, 60),
      member("btn_d_l", "set_button", "State=Default, Size=L", { State: "Default", Size: "L" }, 120),
      member("btn_h_l", "set_button", "State=Hover, Size=L", { State: "Hover", Size: "L" }, 180)
    ]
  );
  const chip = set("set_chip", "Chip", { State: ["Default", "Hover"] }, [
    member("chip_d", "set_chip", "State=Default", { State: "Default" }, 0),
    member("chip_h", "set_chip", "State=Hover", { State: "Hover" }, 60)
  ]);
  const badge = set("set_badge", "Badge", { Tone: ["Neutral"] }, [
    member("badge_n", "set_badge", "Tone=Neutral", { Tone: "Neutral" }, 0)
  ]);
  return docOf([button, chip, badge, standalone("solo", "Solo"), instance]);
}

describe("the swap list is one row per component set", () => {
  const instance: InstanceElement = {
    id: "inst",
    type: "instance",
    name: "Button",
    componentId: "btn_h_s",
    x: 600,
    y: 0,
    width: 120,
    height: 40
  };

  it("offers each set once, by its own name, and each standalone component", () => {
    const options = componentSwapOptions(familyDoc(instance), "inst");
    expect(options.map((o) => o.label).sort()).toEqual(["Badge", "Button", "Chip", "Solo"]);
    expect(options.filter((o) => o.kind === "set").map((o) => o.setId).sort()).toEqual([
      "set_badge",
      "set_button",
      "set_chip"
    ]);
  });

  it("keeps the instance's own cell instead of collapsing it to the default", () => {
    const options = componentSwapOptions(familyDoc(instance), "inst");
    const button = options.find((o) => o.setId === "set_button")!;
    expect(button.id, "State=Hover is the member this instance already is").toBe("btn_h_s");
  });

  it("lands on the matching cell of the target set, and its default when there is none", () => {
    const options = componentSwapOptions(familyDoc(instance), "inst");
    expect(options.find((o) => o.setId === "set_chip")!.id, "Chip declares Hover").toBe("chip_h");
    expect(options.find((o) => o.setId === "set_badge")!.id, "Badge has no State at all").toBe("badge_n");
  });

  it("still refuses the components a swap would make circular", () => {
    const options = componentSwapOptions(familyDoc(instance), "inst");
    expect(options.find((o) => o.setId === "set_button")).toMatchObject({
      disabled: true,
      refusal: "same-component"
    });
  });

  it("points at the member it IS when two members share a cell", () => {
    // A set born from slash-less names starts with every member on
    // `Property 1=Default`, and a user can hand-edit two cells to the same value.
    // Matching by coordinates then answers with the FIRST of them, which is not
    // the instance: the picker held an id the instance is not, so it read as a
    // different component and announced a missing one.
    const twin = set(
      "set_twin",
      "Twin",
      { size: ["Default"] },
      [
        member("twin_a", "set_twin", "size=Default", { size: "Default" }, 0),
        member("twin_b", "set_twin", "size=Default", { size: "Default" }, 60)
      ]
    );
    const shared: InstanceElement = {
      id: "inst_twin",
      type: "instance",
      name: "Twin",
      componentId: "twin_b",
      x: 400,
      y: 0,
      width: 120,
      height: 40
    };
    const options = componentSwapOptions(docOf([twin, shared]), "inst_twin");
    const row = options.find((o) => o.setId === "set_twin")!;
    expect(row.id).toBe("twin_b");
    expect(row).toMatchObject({ disabled: true, refusal: "same-component" });
  });
});

describe("a matrix's empty cells are nameable", () => {
  it("reports the declared values no member fills", () => {
    const instance: InstanceElement = {
      id: "inst",
      type: "instance",
      name: "Button",
      componentId: "btn_d_s",
      x: 0,
      y: 0,
      width: 120,
      height: 40
    };
    const doc = familyDoc(instance);
    const button = groupComponentSets(doc).sets.find((s) => s.setId === "set_button")!;
    expect(variantHoles(button, "State", { State: "Default", Size: "S" })).toEqual([]);
    // Pressed is declared on the set but drawn by nobody.
    const withHole = {
      ...button,
      properties: button.properties.map((p) => (p.property === "State" ? { ...p, values: [...p.values, "Pressed"] } : p))
    };
    expect(variantHoles(withHole, "State", { State: "Default", Size: "S" })).toEqual(["Pressed"]);
  });
});

describe("a boolean axis is a switch, not a menu", () => {
  it("recognises the three spellings, in any case", () => {
    expect(parseBooleanPair(["True", "False"])).toEqual({ truthy: "True", falsy: "False" });
    expect(parseBooleanPair(["yes", "no"])).toEqual({ truthy: "yes", falsy: "no" });
    expect(parseBooleanPair(["On", "Off"])).toEqual({ truthy: "On", falsy: "Off" });
  });

  it("leaves real enumerations alone", () => {
    expect(parseBooleanPair(["Small", "Large"])).toBeNull();
    expect(parseBooleanPair(["True", "False", "Mixed"])).toBeNull();
  });
});

describe("the drop target descends into instance clones", () => {
  const icon: ComponentElement = {
    id: "cmp_icon",
    type: "component",
    name: "Icon",
    x: 0,
    y: 0,
    width: 24,
    height: 24,
    children: [{ id: "glyph", type: "rect", name: "glyph", x: 0, y: 0, width: 24, height: 24 }]
  };
  const card: ComponentElement = {
    id: "cmp_card",
    type: "component",
    name: "Card",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    children: [
      { id: "card_icon", type: "instance", name: "icon", componentId: "cmp_icon", x: 8, y: 8, width: 24, height: 24 }
    ]
  };
  const cardInstance: InstanceElement = {
    id: "inst_card",
    type: "instance",
    name: "Card",
    componentId: "cmp_card",
    x: 400,
    y: 0,
    width: 200,
    height: 100
  };

  it("hits the nested instance when the point is over it", () => {
    const target = findSwapTargetAtPoint(docOf([icon, card, cardInstance]), 400 + 12, 12);
    expect(target).toMatchObject({ kind: "nested", id: "inst_card_card_icon" });
  });

  it("falls back to the outer instance for a point beside the nested one", () => {
    const target = findSwapTargetAtPoint(docOf([icon, card, cardInstance]), 400 + 150, 80);
    expect(target).toMatchObject({ kind: "instance", id: "inst_card" });
  });

  it("ignores a master, which is a definition rather than scenery", () => {
    const target = findSwapTargetAtPoint(docOf([icon, card, cardInstance]), 12, 12);
    expect(target).toBeNull();
  });
});
