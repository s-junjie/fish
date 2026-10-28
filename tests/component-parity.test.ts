import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import {
  ComponentElement,
  ComponentOverride,
  DesignDocument,
  DesignElement,
  Effect,
  FrameElement,
  InstanceElement,
  Paint,
  Stroke,
  TextElement
} from "../src/core/dsl/types";
import { createComponentFromElement, detachInstance } from "../src/core/interactions/component-ops";
import { canCreateComponentHere, findComponentOwnerPageId, findMasterComponent, isDerivedNode } from "../src/core/interactions/component-inventory";
import { commitInstanceOverrides, resolveInstanceChildren, resolveInstanceSelection } from "../src/core/interactions/instance-resolve";
import {
  componentSwapOptions,
  swapInstanceComponent,
  swapNestedInstance,
  swapRefusal
} from "../src/core/interactions/component-swap";
import { activeInstanceFills, resolveInstanceBox } from "../src/core/interactions/instance-inherit";
import {
  findElementById,
  findParentById,
  findFrameAtPoint,
  flattenElements,
  insideComponent,
  moveElementInTree,
  nestsInstanceInOwnMaster,
  reparentOnCanvasDrop
} from "../src/core/geometry/tree-ops";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

const canvas = {
  width: 1200,
  height: 800,
  background: { type: "solid" as const, color: "#101010" },
  unit: "px" as const
};

const masterFills: Paint[] = [{ type: "solid", color: "#111111" }];
const masterStrokes: Stroke[] = [{ color: "#000000", width: 1 }];
const masterEffects: Effect[] = [
  { type: "drop-shadow", color: "rgba(0,0,0,0.4)", offset: { x: 0, y: 4 }, blur: 8 }
] as Effect[];

function component(id: string): ComponentElement {
  return { id, type: "component", name: id, x: 0, y: 0, width: 100, height: 40, children: [] };
}

function frame(id: string): FrameElement {
  return { id, type: "frame", name: id, x: 0, y: 0, width: 100, height: 40, children: [] };
}

/**
 * A master on a page that is not active is the normal case for imported files:
 * the importer parks every synthesized master on its own "❖ Components" page.
 */
function twoPageDoc(): DesignDocument {
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [
      { id: "page_design", name: "Design", canvas, children: [frame("f_1")] },
      { id: "page_comp", name: "Components", canvas, children: [component("cmp_a")] }
    ],
    activePageId: "page_design",
    elements: [frame("f_1")]
  };
}

describe("locating a main component across pages", () => {
  it("reports the owning page even when the master is not on the active page", () => {
    expect(findComponentOwnerPageId(twoPageDoc(), "cmp_a")).toBe("page_comp");
  });

  it("reports the active page when the master lives on it", () => {
    const doc = twoPageDoc();
    doc.pages![0].children.push(component("cmp_here"));
    expect(findComponentOwnerPageId(doc, "cmp_here")).toBe("page_design");
  });

  it("returns null for a non-component id and for an unknown id", () => {
    const doc = twoPageDoc();
    expect(findComponentOwnerPageId(doc, "f_1")).toBeNull();
    expect(findComponentOwnerPageId(doc, "nope")).toBeNull();
  });

  it("finds a master nested inside a frame on another page", () => {
    const doc = twoPageDoc();
    const host = frame("f_host");
    host.children.push(component("cmp_nested"));
    doc.pages![1].children.push(host);
    expect(findComponentOwnerPageId(doc, "cmp_nested")).toBe("page_comp");
  });
});

function master(overrides: Partial<ComponentElement> = {}): ComponentElement {
  return {
    id: "cmp",
    type: "component",
    name: "Card",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    fills: masterFills,
    strokes: masterStrokes,
    borderRadius: 8,
    clipContent: true,
    effects: masterEffects,
    children: [],
    ...overrides
  };
}

function instance(overrides: Partial<InstanceElement> = {}): InstanceElement {
  return {
    id: "inst",
    type: "instance",
    name: "Card Instance",
    componentId: "cmp",
    x: 400,
    y: 100,
    width: 200,
    height: 100,
    ...overrides
  };
}

/**
 * The rule these lock down: a field the instance SETS wins; a field it does not
 * set inherits from the master. Presence decides, never truthiness — otherwise
 * removing the last fill on an instance silently resurrects the master's fill.
 */
describe("instance box inheritance", () => {
  it("inherits every field the instance does not set", () => {
    const box = resolveInstanceBox(instance(), master());
    expect(box.fills).toEqual(masterFills);
    expect(box.fillsActive).toBe(true);
    expect(box.strokes).toEqual(masterStrokes);
    expect(box.borderRadius).toBe(8);
    expect(box.clipContent).toBe(true);
    expect(box.effects).toEqual(masterEffects);
    expect(box.width).toBe(200);
    expect(box.height).toBe(100);
  });

  it("treats an empty fills array as 'no fill', not as 'inherit'", () => {
    const box = resolveInstanceBox(instance({ fills: [] }), master());
    expect(box.fills).toEqual([]);
    expect(activeInstanceFills(box)).toEqual([]);
  });

  it("treats an empty strokes array as 'no stroke', not as 'inherit'", () => {
    const box = resolveInstanceBox(instance({ strokes: [] }), master());
    expect(box.strokes).toEqual([]);
    expect(box.strokes[0]).toBeUndefined();
  });

  it("lets the instance's own fields win over the master's", () => {
    const own: Paint[] = [{ type: "solid", color: "#FF0000" }];
    const ownEffects: Effect[] = [{ type: "layer-blur", blur: 12 }] as Effect[];
    const box = resolveInstanceBox(
      instance({
        fills: own,
        strokes: [],
        effects: ownEffects,
        borderRadius: 0,
        clipContent: false,
        width: 320
      }),
      master()
    );
    expect(box.fills).toEqual(own);
    expect(box.strokes).toEqual([]);
    expect(box.effects).toEqual(ownEffects);
    expect(box.borderRadius).toBe(0);
    expect(box.clipContent).toBe(false);
    expect(box.width).toBe(320);
    expect(box.height).toBe(100);
  });

  it("an instance's own stack wins over the master's", () => {
    const ownStroke: Stroke = { color: "#00FF00", width: 3 };
    expect(resolveInstanceBox(instance({ strokes: [ownStroke] }), master()).strokes).toEqual([ownStroke]);

    const masterOnly = master({ strokes: [{ color: "#0000FF", width: 2 }] });
    expect(resolveInstanceBox(instance(), masterOnly).strokes).toEqual([
      { color: "#0000FF", width: 2 }
    ]);
  });

  it("treats an absent fill on an instance as 'inherit' and switches it off via fillEnabled", () => {
    const inheriting = resolveInstanceBox(instance(), master());
    expect(inheriting.fills).toEqual(masterFills);

    const off = resolveInstanceBox(instance({ fillEnabled: false }), master());
    expect(activeInstanceFills(off)).toEqual([]);
  });
});

describe("instance overrides survive normalization", () => {
  function docWith(elements: InstanceElement[]): DesignDocument {
    return {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
      activePageId: "page_1",
      elements
    };
  }

  it("keeps an explicit empty fill stack, so deleting the last fill sticks", () => {
    const { document } = normalizeDesignDocument(docWith([instance({ fills: [] })]));
    const inst = document.pages![0].children[0] as InstanceElement;
    expect(inst.fills).toEqual([]);
  });

  it("keeps an explicit empty stroke stack", () => {
    const { document } = normalizeDesignDocument(docWith([instance({ strokes: [] })]));
    const inst = document.pages![0].children[0] as InstanceElement;
    expect(inst.strokes).toEqual([]);
  });

  it("keeps the instance's own fills, strokes, radius, clip and effects", () => {
    const own: Paint[] = [{ type: "solid", color: "#ABCDEF" }];
    const ownEffects: Effect[] = [{ type: "layer-blur", blur: 5 }] as Effect[];
    const { document } = normalizeDesignDocument(
      docWith([
        instance({
          fills: own,
          strokes: [{ color: "#123456", width: 2 }],
          borderRadius: 4,
          clipContent: true,
          effects: ownEffects
        })
      ])
    );
    const inst = document.pages![0].children[0] as InstanceElement;
    expect(inst.fills).toEqual(own);
    expect(inst.strokes).toHaveLength(1);
    expect(inst.strokes![0].color).toBe("#123456");
    expect(inst.strokes![0].width).toBe(2);
    expect(inst.borderRadius).toBe(4);
    expect(inst.clipContent).toBe(true);
    expect(inst.effects).toHaveLength(1);
    expect(inst.effects![0].type).toBe("layer-blur");
    expect((inst.effects![0] as { blur?: number }).blur).toBe(5);
  });

  it("leaves an unset fill/stroke absent, so the field still inherits", () => {
    const { document } = normalizeDesignDocument(docWith([instance()]));
    const inst = document.pages![0].children[0] as InstanceElement;
    expect(inst.fills).toBeUndefined();
    expect(inst.strokes).toBeUndefined();
  });
});

describe("overridable properties on an instance child", () => {
  function textMaster(): ComponentElement {
    return {
      id: "cmp",
      type: "component",
      name: "Card",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      children: [
        {
          id: "label",
          type: "text",
          name: "Label",
          x: 16,
          y: 16,
          width: 120,
          height: 24,
          content: "Hello",
          style: { fontFamily: "Inter", fontSize: 16, color: "#111111" }
        } as TextElement
      ]
    } as ComponentElement;
  }

  function docWithInstance(): { doc: DesignDocument; inst: InstanceElement } {
    const inst = instance();
    return {
      doc: {
        version: "0.1",
        id: "doc",
        name: "Doc",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        canvas,
        pages: [{ id: "page_1", name: "Page 1", canvas, children: [textMaster(), inst] }],
        activePageId: "page_1",
        elements: [textMaster(), inst]
      },
      inst
    };
  }

  const resolvedLabel = (doc: DesignDocument, inst: InstanceElement) => {
    const derivedId = resolveInstanceChildren(inst, findMasterComponent(doc, "cmp")!).find(
      (el) => el.type === "text"
    )!.id;
    const sel = resolveInstanceSelection(doc, derivedId);
    expect(sel).toBeTruthy();
    return sel!;
  };

  it("writes a text-style override and merges it instead of replacing the style", () => {
    const { doc, inst } = docWithInstance();
    const sel = resolvedLabel(doc, inst);
    const next = commitInstanceOverrides(doc, [sel], (el) => ({
      ...el,
      style: { ...(el as TextElement).style, fontSize: 24 }
    }));
    expect(next).toBeTruthy();

    const updated = next!.pages![0].children[1] as InstanceElement;
    expect(updated.overrides).toEqual([{ targetId: "label", property: "style", value: { fontSize: 24 } }]);

    // Applied on resolve, and the axes the override did not mention survive.
    const clone = resolveInstanceChildren(updated, findMasterComponent(next!, "cmp")!).find(
      (el) => el.type === "text"
    ) as TextElement;
    expect(clone.style.fontSize).toBe(24);
    expect(clone.style.fontFamily).toBe("Inter");
    expect(clone.style.color).toBe("#111111");
  });

  it("carries effects, adjust, radius and blend mode as overrides", () => {
    const { doc, inst } = docWithInstance();
    const sel = resolvedLabel(doc, inst);
    const ownEffects: Effect[] = [{ type: "layer-blur", blur: 9 }] as Effect[];
    const next = commitInstanceOverrides(doc, [sel], (el) => ({
      ...el,
      effects: ownEffects,
      adjust: { exposure: 10 } as never,
      borderRadius: 6,
      blendMode: "multiply" as never
    }));
    expect(next).toBeTruthy();
    const props = (next!.pages![0].children[1] as InstanceElement).overrides!.map((o) => o.property).sort();
    expect(props).toEqual(["adjust", "blendMode", "borderRadius", "effects"]);

    const clone = resolveInstanceChildren(
      next!.pages![0].children[1] as InstanceElement,
      findMasterComponent(next!, "cmp")!
    ).find((el) => el.type === "text")!;
    expect(clone.effects).toEqual(ownEffects);
    expect((clone as { borderRadius?: number }).borderRadius).toBe(6);
    expect((clone as { blendMode?: string }).blendMode).toBe("multiply");
  });

  it("keeps the new override properties through normalization", () => {
    const overrides = [
      { targetId: "label", property: "style" as const, value: { fontSize: 24 } },
      { targetId: "label", property: "effects" as const, value: [] },
      { targetId: "label", property: "borderRadius" as const, value: 6 }
    ];
    const { doc, inst } = docWithInstance();
    const withOverrides: DesignDocument = {
      ...doc,
      pages: [
        {
          ...doc.pages![0],
          children: [textMaster(), { ...inst, overrides } as InstanceElement]
        }
      ]
    };
    const { document } = normalizeDesignDocument(withOverrides);
    const kept = (document.pages![0].children[1] as InstanceElement).overrides!;
    expect(kept.map((o) => o.property)).toEqual(["style", "effects", "borderRadius"]);
  });
});

describe("swapping to another component keeps overrides by layer name", () => {
  function card(id: string, content: string, opts: Partial<ComponentElement> = {}): ComponentElement {
    return {
      id,
      type: "component",
      name: id,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      children: [
        {
          id: `${id}_label`,
          type: "text",
          name: "Label",
          x: 16,
          y: 16,
          width: 120,
          height: 24,
          content,
          style: { fontFamily: "Inter", fontSize: 16, color: "#111111" }
        } as TextElement
      ],
      ...opts
    };
  }

  function swapped(overrides: ComponentOverride[], target: ComponentElement) {
    const inst: InstanceElement = {
      ...instance(),
      componentId: "cmp_a",
      overrides
    };
    const doc: DesignDocument = {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [
        { id: "page_1", name: "Page 1", canvas, children: [card("cmp_a", "Hello"), target, inst] }
      ],
      activePageId: "page_1",
      elements: [card("cmp_a", "Hello"), target, inst]
    };
    const next = swapInstanceComponent(doc, inst.id, target.id);
    return (next!.pages![0].children[2] as InstanceElement).overrides || [];
  }

  const contentOverride: ComponentOverride[] = [
    { targetId: "cmp_a_label", property: "content", value: "Overridden" }
  ];

  it("re-points an override at the same-named layer of the new master", () => {
    const kept = swapped(contentOverride, card("cmp_b", "Hello"));
    expect(kept).toEqual([{ targetId: "cmp_b_label", property: "content", value: "Overridden" }]);
  });

  it("drops the override when the two masters started from different defaults", () => {
    // The new variant's layer already reads "Other": keeping a change the user
    // made against "Hello" would apply it to an unrelated base.
    expect(swapped(contentOverride, card("cmp_c", "Other"))).toEqual([]);
  });

  it("drops the override when the layer does not exist under that name", () => {
    const renamed = card("cmp_d", "Hello");
    renamed.children[0] = { ...(renamed.children[0] as TextElement), name: "Renamed" };
    expect(swapped(contentOverride, renamed)).toEqual([]);
  });

  it("carries a content override across by LAYER name, not by any property name", () => {
    // This is the case the removed named properties used to need a second
    // remapping pass for. Overrides are keyed on a master layer, so the layer's
    // name is already the only identity that can survive a swap — and the test
    // above it is the same rule with a different property.
    const a = card("cmp_a", "Hello");
    const b = card("cmp_b", "Hello");
    const inst: InstanceElement = {
      ...instance(),
      componentId: "cmp_a",
      overrides: [{ targetId: "cmp_a_label", property: "content", value: "typed" }]
    };
    const doc: DesignDocument = {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: [a, b, inst] }],
      activePageId: "page_1",
      elements: [a, b, inst]
    };
    const next = swapInstanceComponent(doc, inst.id, "cmp_b");
    expect((next!.pages![0].children[2] as InstanceElement).overrides).toEqual([
      { targetId: "cmp_b_label", property: "content", value: "typed" }
    ]);
  });

  /**
   * The sizing half of a swap, which no assertion above was watching: an instance
   * with no `sizeOverride` was TRACKING its master, so it has to start tracking
   * the new one. `propagateMasterSize` cannot rescue it — that fires when a master
   * is resized, and here the master was already the size it always was.
   */
  it("re-boxes a tracking instance onto the new master's size", () => {
    const inst: InstanceElement = { ...instance(), componentId: "cmp_a" };
    const doc: DesignDocument = {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas: { width: 2000, height: 2000 },
      pages: [{ id: "page_1", name: "Page 1", canvas: { width: 2000, height: 2000 }, children: [card("cmp_a", "A"), { ...card("cmp_b", "B"), width: 640, height: 320 }, inst] }],
      activePageId: "page_1"
    } as unknown as DesignDocument;
    const next = swapInstanceComponent(doc, inst.id, "cmp_b")!;
    const swappedInst = next.pages![0].children[2] as InstanceElement;
    expect(swappedInst.width).toBe(640);
    expect(swappedInst.height).toBe(320);
  });

  it("leaves a user-resized instance on its own box", () => {
    const inst: InstanceElement = {
      ...instance(),
      componentId: "cmp_a",
      width: 555,
      height: 111,
      sizeOverride: true
    };
    const doc: DesignDocument = {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas: { width: 2000, height: 2000 },
      pages: [{ id: "page_1", name: "Page 1", canvas: { width: 2000, height: 2000 }, children: [card("cmp_a", "A"), { ...card("cmp_b", "B"), width: 640, height: 320 }, inst] }],
      activePageId: "page_1"
    } as unknown as DesignDocument;
    const next = swapInstanceComponent(doc, inst.id, "cmp_b")!;
    const swappedInst = next.pages![0].children[2] as InstanceElement;
    expect(swappedInst.width).toBe(555);
    expect(swappedInst.height).toBe(111);
  });
});

describe("an instance applies its master's child constraints", () => {
  // Master 100×100, instance stretched to 300×200. A child at (80, 40) sized
  // 20×30 must land where the same constraint puts it inside a frame that grew
  // the same way — that is the whole point of Figma's "constraints are inherited
  // from the master and act when the instance is resized".
  const child = (mode: string, lockAspect = false) => ({
    id: "kid",
    type: "rect" as const,
    name: "kid",
    x: 80,
    y: 40,
    width: 20,
    height: 30,
    fills: [{ type: "solid" as const, color: "#FFFFFF" }],
    constraints: { horizontal: mode, vertical: "top", preserveAspectRatio: lockAspect }
  });

  const resolvedKid = (mode: string, lockAspect = false) => {
    const master = {
      id: "cmp",
      type: "component" as const,
      name: "Card",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [child(mode, lockAspect) as never]
    };
    const inst = { ...instance(), width: 300, height: 200 };
    const doc: DesignDocument = {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: [master, inst] }],
      activePageId: "page_1",
      elements: [master, inst]
    };
    return resolveInstanceChildren(inst, findMasterComponent(doc, "cmp")!)[0];
  };

  it("left keeps the distance to the left edge", () => {
    const kid = resolvedKid("left");
    expect(kid.x).toBe(80);
    expect(kid.width).toBe(20);
  });

  it("right pins to the right edge", () => {
    const kid = resolvedKid("right");
    expect(kid.x).toBe(280);
    expect(kid.width).toBe(20);
  });

  it("center keeps the centre offset", () => {
    expect(resolvedKid("center").x).toBe(180);
  });

  it("stretch follows both edges", () => {
    const kid = resolvedKid("stretch");
    expect(kid.x).toBe(80);
    expect(kid.width).toBe(220);
  });

  it("scale scales position and size", () => {
    const kid = resolvedKid("scale");
    expect(kid.x).toBe(240);
    expect(kid.width).toBe(60);
  });

  it("is idempotent: resolving twice gives the same geometry", () => {
    // The constraint pass runs on every render, so it must converge rather than
    // accumulate — the baseline is the master's box, not the last result.
    const master = {
      id: "cmp",
      type: "component" as const,
      name: "Card",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [child("stretch") as never]
    };
    const inst = { ...instance(), width: 300, height: 200 };
    const first = resolveInstanceChildren(inst, master as never)[0];
    const second = resolveInstanceChildren(inst, master as never)[0];
    expect(second.x).toBe(first.x);
    expect(second.width).toBe(first.width);
  });
});

describe("detaching transfers the resolved box", () => {
  function docWithMaster(cmp: ComponentElement, inst: InstanceElement): DesignDocument {
    return {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: [cmp, inst] }],
      activePageId: "page_1",
      elements: [cmp, inst]
    };
  }

  it("carries the master's effects onto the detached frame", () => {
    const cmp = master();
    const { doc, frame: detached } = detachInstance(docWithMaster(cmp, instance()), "inst", cmp);
    expect(detached).toBeTruthy();
    expect(detached!.effects).toEqual(masterEffects);
    expect(detached!.fills).toEqual(masterFills);
    expect(detached!.clipContent).toBe(true);
    expect(detached!.borderRadius).toBe(8);
    expect(doc.pages![0].children[1].type).toBe("frame");
  });

  it("keeps effects the instance set itself instead of overwriting them with the master's", () => {
    const cmp = master();
    const ownEffects: Effect[] = [{ type: "layer-blur", blur: 12 }] as Effect[];
    const { frame: detached } = detachInstance(
      docWithMaster(cmp, instance({ effects: ownEffects })),
      "inst",
      cmp
    );
    expect(detached!.effects).toEqual(ownEffects);
  });
});

/**
 * An instance is a projection of its master, so a master containing one of itself
 * can never be resolved. The rule belongs to the TREE, not to a gesture: the layer
 * tree and the canvas both funnel through `moveElementInTree` /
 * `reparentOnCanvasDrop`, and any depth counts (a clone buried in the master is
 * just as unresolvable as a direct child).
 */
describe("an instance never nests inside its own master", () => {
  const frameInMaster: DesignElement = {
    id: "cmp_sub",
    type: "frame",
    name: "Sub",
    x: 10,
    y: 10,
    width: 150,
    height: 70,
    children: []
  };

  function proxy(overrides: Partial<InstanceElement>): InstanceElement {
    return instance({ componentId: "cmp", x: 400, y: 200, ...overrides });
  }

  function scene(): DesignElement[] {
    return [
      {
        id: "cmp",
        type: "component",
        name: "Card",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        children: [frameInMaster]
      },
      { id: "cmp2", type: "component", name: "Other", x: 600, y: 0, width: 200, height: 100, children: [] },
      { id: "plain", type: "rect", name: "plain", x: 900, y: 0, width: 40, height: 20 },
      // Centre lands inside cmp_sub: the deepest container is not the master itself.
      proxy({ id: "deep", x: 0, y: 0 }),
      // Centre lands inside cmp but outside cmp_sub.
      proxy({ id: "shallow", x: 80, y: 0 }),
      // Same geometry, but it projects the OTHER master.
      proxy({ id: "free", componentId: "cmp2", x: 80, y: 0 })
    ];
  }

  it("sees the master itself and anything nested in it as forbidden", () => {
    const elements = scene();
    expect(nestsInstanceInOwnMaster(elements, "deep", "cmp")).toBe(true);
    expect(nestsInstanceInOwnMaster(elements, "deep", "cmp_sub")).toBe(true);
  });

  it("leaves every other destination alone", () => {
    const elements = scene();
    expect(nestsInstanceInOwnMaster(elements, "free", "cmp")).toBe(false);
    expect(nestsInstanceInOwnMaster(elements, "free", "cmp2")).toBe(true);
    expect(nestsInstanceInOwnMaster(elements, "plain", "cmp")).toBe(false);
  });

  it("refuses the layer-tree drop onto the master and onto its children", () => {
    const elements = scene();
    expect(moveElementInTree(elements, "deep", "cmp", "inside")).toBe(elements);
    // Dropping *next to* a master child still lands inside the master.
    expect(moveElementInTree(elements, "deep", "cmp_sub", "before")).toBe(elements);
    expect(moveElementInTree(elements, "deep", "cmp_sub", "after")).toBe(elements);
  });

  it("still lets another master's instance nest there", () => {
    const elements = scene();
    const next = moveElementInTree(elements, "free", "cmp_sub", "inside");
    expect(next).not.toBe(elements);
    expect(findElementById(next, "free")).toBeTruthy();
  });

  it("refuses the canvas drop, without decaying into 'moved out to the root'", () => {
    const elements = scene();
    const deep = reparentOnCanvasDrop(elements, "deep");
    expect(deep.refused).toBe("instance-in-own-master");
    expect(deep.reparented).toBe(false);
    expect(deep.elements).toBe(elements);

    const shallow = reparentOnCanvasDrop(elements, "shallow");
    expect(shallow.refused).toBe("instance-in-own-master");
    expect(shallow.elements).toBe(elements);
  });

  it("still reparents a different instance into that master", () => {
    const res = reparentOnCanvasDrop(scene(), "free");
    expect(res.refused).toBeNull();
    expect(res.reparented).toBe(true);
    expect(findElementById(res.elements, "free")).toBeTruthy();
  });

  it("hides the master subtree from the drag preview, and only when asked", () => {
    const elements = scene();
    expect(findFrameAtPoint(elements, 180, 50, "deep")).toBe(findElementById(elements, "cmp"));
    expect(findFrameAtPoint(elements, 180, 50, ["deep", "cmp"])).toBeNull();
  });
});

/**
 * A detached frame is a real subtree, but it is built from the resolved clones.
 * Keeping their derived markers would keep every "not in the document tree"
 * refusal alive: no handles, no drag, no delete, an inspector strip claiming the
 * layers still live in an instance. Detaching has to hand over plain nodes.
 */
describe("detaching releases the resolved clones", () => {
  function docWithMaster(cmp: ComponentElement, inst: InstanceElement): DesignDocument {
    return {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: [cmp, inst] }],
      activePageId: "page_1",
      elements: [cmp, inst]
    };
  }

  /** Master with a leaf and a frame holding a grandchild. */
  function nestedMaster(): ComponentElement {
    return master({
      children: [
        { id: "kid", type: "rect", name: "kid", x: 5, y: 5, width: 20, height: 10 },
        {
          id: "wrap",
          type: "frame",
          name: "wrap",
          x: 40,
          y: 40,
          width: 60,
          height: 40,
          children: [{ id: "inner", type: "text", name: "inner", x: 4, y: 4, width: 20, height: 10, content: "hi" }]
        }
      ] as never
    });
  }

  it("drops the derived markers from every node it hands over", () => {
    const cmp = nestedMaster();
    const { frame: detached } = detachInstance(docWithMaster(cmp, instance()), "inst", cmp);
    const nodes: DesignElement[] = [];
    const walk = (els: DesignElement[]) => {
      for (const el of els) {
        nodes.push(el);
        walk((el as { children?: DesignElement[] }).children || []);
      }
    };
    walk(detached!.children || []);

    expect(nodes.map((el) => el.id)).toEqual(["inst_kid", "inst_wrap", "inst_inner"]);
    expect(nodes.every((el) => !isDerivedNode(el))).toBe(true);
    expect(nodes.every((el) => (el as { __masterNodeId?: string }).__masterNodeId === undefined)).toBe(true);
  });

  it("puts the released nodes in the document tree, so edits can find them", () => {
    const cmp = nestedMaster();
    const { doc, frame: detached } = detachInstance(docWithMaster(cmp, instance()), "inst", cmp);
    expect(findElementById(doc.pages![0].children, "inst_inner")).toBeTruthy();
    expect(detached!.children![0].id).toBe("inst_kid");
  });

  it("leaves a nested instance inside the detached frame a real instance", () => {
    const inner = { ...component("cmp_inner"), children: [{ id: "dot", type: "rect" as const, name: "dot", x: 0, y: 0, width: 4, height: 4 }] };
    const outer = master({
      children: [
        {
          id: "nested",
          type: "instance",
          name: "Nested",
          componentId: "cmp_inner",
          x: 0,
          y: 0,
          width: 100,
          height: 40
        }
      ] as never
    });
    const doc: DesignDocument = {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: [outer, inner, instance()] }],
      activePageId: "page_1",
      elements: [outer, inner, instance()]
    };
    const { doc: next, frame: detached } = detachInstance(doc, "inst", outer);
    const nested = detached!.children![0];
    expect(nested.type).toBe("instance");
    expect(isDerivedNode(nested)).toBe(false);
    expect(nested.id).toBe("inst_nested");
    expect(findElementById(next.pages![0].children, "inst_nested")).toBeTruthy();
  });
});

/**
 * A master is a definition; a definition inside another definition cannot be
 * resolved as one (FISH finds masters by id from anywhere in the file, so the
 * inner node would be cloned into every instance of the outer as a SECOND
 * definition). Inside a component an instance is the way to reuse one.
 */
describe("a main component never nests inside another", () => {
  const innerFrame: DesignElement = {
    id: "outer_sub",
    type: "frame",
    name: "Sub",
    x: 10,
    y: 10,
    width: 50,
    height: 50,
    children: []
  };

  function scene(): DesignElement[] {
    return [
      { id: "outer", type: "component", name: "Outer", x: 0, y: 0, width: 200, height: 100, children: [innerFrame] },
      { id: "plain", type: "frame", name: "Plain", x: 600, y: 0, width: 200, height: 100, children: [] },
      // Sits over `outer`, so a canvas drop lands on the master.
      { id: "other", type: "component", name: "Other", x: 80, y: 0, width: 200, height: 100, children: [] },
      // An instance of `outer`: the supported way to reuse it inside a component.
      { id: "proj", type: "instance", name: "proj", componentId: "outer", x: 400, y: 300, width: 200, height: 100 }
    ];
  }

  it("refuses the layer-tree drop, at any depth", () => {
    const elements = scene();
    expect(moveElementInTree(elements, "other", "outer", "inside")).toBe(elements);
    expect(moveElementInTree(elements, "other", "outer_sub", "inside")).toBe(elements);
    // Landing next to a master's child still puts it inside the master.
    expect(moveElementInTree(elements, "other", "outer_sub", "after")).toBe(elements);
  });

  it("still allows a master anywhere else", () => {
    const elements = scene();
    expect(moveElementInTree(elements, "other", "plain", "inside")).not.toBe(elements);
  });

  it("refuses the canvas drop with the component reason", () => {
    const res = reparentOnCanvasDrop(scene(), "other");
    expect(res.refused).toBe("component-in-component");
    expect(res.reparented).toBe(false);
  });

  it("leaves an instance free to nest — that is the supported shape", () => {
    const res = reparentOnCanvasDrop(scene(), "proj");
    expect(res.refused).toBeNull();
  });

  it("refuses to turn a layer inside a master into another master", () => {
    const elements = scene();
    const inside = findElementById(elements, "outer_sub")!;
    const outside = findElementById(elements, "plain")!;
    expect(canCreateComponentHere(elements, inside)).toBe(false);
    expect(canCreateComponentHere(elements, outside)).toBe(true);

    const doc: DesignDocument = {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
      activePageId: "page_1",
      elements
    };
    expect(createComponentFromElement(doc, "outer_sub").component).toBeNull();
    expect(createComponentFromElement(doc, "plain").component).toBeTruthy();
  });
});

/**
 * A component that reuses another component does it with a NESTED INSTANCE (the
 * icon inside a button). Swapping that nested instance is the whole point of the
 * structure, and the only place to do it from is the outer instance: the nested
 * node is a resolved clone, so the change lands as a `componentId` override.
 */
describe("a nested instance can be swapped from the outside", () => {
  const icon = (id: string, color: string): ComponentElement => ({
    id,
    type: "component",
    name: id,
    x: 0,
    y: 400,
    width: 24,
    height: 24,
    children: [
      { id: "dot", type: "rect", name: "dot", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color }] }
    ]
  });

  const card = (): ComponentElement => ({
    id: "card",
    type: "component",
    name: "card",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    children: [
      { id: "iconInst", type: "instance", name: "iconInst", componentId: "icon_a", x: 8, y: 8, width: 24, height: 24 },
      {
        id: "deep",
        type: "frame",
        name: "deep",
        x: 40,
        y: 8,
        width: 100,
        height: 60,
        children: [{ id: "leaf", type: "rect", name: "leaf", x: 4, y: 4, width: 20, height: 20 }]
      }
    ]
  });

  const cardInst = (): InstanceElement => ({
    id: "cardInst",
    type: "instance",
    name: "Card Instance",
    componentId: "card",
    x: 300,
    y: 0,
    width: 200,
    height: 100
  });

  function doc(): DesignDocument {
    const elements: DesignElement[] = [card(), icon("icon_a", "#FF0000"), icon("icon_b", "#00FF00"), cardInst()];
    return {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
      activePageId: "page_1",
      elements
    };
  }

  const outerOf = (d: DesignDocument) => getActivePage(d).children.find((el) => el.id === "cardInst") as InstanceElement;

  it("writes a componentId override on the instance that owns the nested one", () => {
    const next = swapNestedInstance(doc(), "cardInst_iconInst", "icon_b");
    expect(next).toBeTruthy();
    expect(outerOf(next!).overrides).toEqual([
      { targetId: "iconInst", property: "componentId", value: "icon_b" }
    ]);
  });

  it("makes the resolved clone follow the new master", () => {
    const next = swapNestedInstance(doc(), "cardInst_iconInst", "icon_b")!;
    const master = findMasterComponent(next, "card")!;
    const nested = resolveInstanceChildren(outerOf(next), master).find(
      (el) => el.id === "cardInst_iconInst"
    ) as InstanceElement;
    expect(nested.componentId).toBe("icon_b");
    // …and what it paints is the new master's content.
    const painted = resolveInstanceChildren(nested, findMasterComponent(next, "icon_b")!);
    expect(painted.map((el) => el.id)).toEqual(["cardInst_iconInst_dot"]);
  });

  it("refuses a node deeper than one level, and an unknown master", () => {
    expect(swapNestedInstance(doc(), "cardInst_deep_leaf", "icon_b")).toBeNull();
    expect(swapNestedInstance(doc(), "cardInst_iconInst", "nope")).toBeNull();
  });

  it("survives a save", () => {
    const next = swapNestedInstance(doc(), "cardInst_iconInst", "icon_b")!;
    const { document } = normalizeDesignDocument(next);
    const saved = document.pages![0].children.find((el) => el.id === "cardInst") as InstanceElement;
    expect(saved.overrides).toEqual([
      { targetId: "iconInst", property: "componentId", value: "icon_b" }
    ]);
  });
});

/**
 * A definition cannot be nested inside another one, but the tree only refuses the
 * DROP — a frame that already HOLDS a master is legal right up until it is
 * promoted. Promotion therefore resolves it instead of refusing: the master moves
 * out to become the new component's sibling, and an instance of it takes the
 * slot, so the drawing does not move by a pixel.
 */
describe("promoting a frame that holds a master", () => {
  function docOf(elements: DesignElement[]): DesignDocument {
    return {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
      activePageId: "page_1",
      elements
    };
  }

  const iconMaster = (): ComponentElement => ({
    id: "icon",
    type: "component",
    name: "Icon",
    x: 20,
    y: 20,
    width: 40,
    height: 40,
    children: [{ id: "dot", type: "rect", name: "dot", x: 4, y: 4, width: 10, height: 10 }]
  });

  const shell = (): FrameElement => ({
    id: "shell",
    type: "frame",
    name: "Shell",
    x: 100,
    y: 100,
    width: 300,
    height: 200,
    children: [
      iconMaster(),
      { id: "label", type: "text", name: "label", x: 20, y: 80, width: 60, height: 20, content: "hi", style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" } }
    ]
  });

  it("takes the master out and leaves an instance in its slot", () => {
    const { doc, component: made, hoisted } = createComponentFromElement(
      docOf([shell(), component("plain")]),
      "shell"
    );
    const page = doc.pages![0].children;

    expect(made!.id).toBe("shell");
    expect(made!.type).toBe("component");
    expect(hoisted.map((h) => h.id)).toEqual(["icon"]);

    const node = findElementById(page, "shell") as ComponentElement;
    const kids = node.children!;
    expect(kids.map((k) => k.type)).toEqual(["instance", "text"]);

    const placed = kids[0] as InstanceElement;
    expect(placed.componentId).toBe("icon");
    // Same box as the master it replaced: the slot, and therefore the drawing, is
    // exactly where it was (both live in the same frame's local space).
    expect([placed.x, placed.y, placed.width, placed.height]).toEqual([20, 20, 40, 40]);
  });

  it("drops the master beside the component, whole", () => {
    const { doc } = createComponentFromElement(docOf([shell(), component("plain")]), "shell");
    const page = doc.pages![0].children;

    expect(page.map((el) => el.id)).toEqual(["shell", "icon", "plain"]);
    const master = findElementById(page, "icon") as ComponentElement;
    expect(master.type).toBe("component");
    // Left of the gap it was in, so it does not sit on top of the component.
    expect([master.x, master.y]).toEqual([100 + 300 + 40, 100]);
    expect((master.children || []).map((c) => c.id)).toEqual(["dot"]);
  });

  it("paints through the instance what the master painted", () => {
    const { doc } = createComponentFromElement(docOf([shell()]), "shell");
    const page = doc.pages![0].children;
    const node = findElementById(page, "shell") as ComponentElement;
    const placed = node.children![0] as InstanceElement;
    const master = findMasterComponent(doc, "icon")!;

    const clone = resolveInstanceChildren(placed, master);
    expect(clone.map((el) => [el.id, el.x, el.y])).toEqual([[`${placed.id}_dot`, 4, 4]]);
    // World box of the slot: frame origin + local, identical to the master's old
    // one (the frame itself never moved).
    expect(node.x + placed.x).toBe(100 + 20);
    expect(node.y + placed.y).toBe(100 + 20);
  });

  it("hoists a legacy nested master out of the master too", () => {
    const outer: ComponentElement = {
      id: "outer",
      type: "component",
      name: "Outer",
      x: 20,
      y: 20,
      width: 100,
      height: 50,
      children: [
        { id: "inner", type: "component", name: "Inner", x: 5, y: 5, width: 20, height: 20, children: [] },
        { id: "rest", type: "rect", name: "rest", x: 40, y: 5, width: 10, height: 10 }
      ]
    };
    const host: FrameElement = {
      id: "host",
      type: "frame",
      name: "Host",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      children: [outer]
    };

    const { doc, hoisted } = createComponentFromElement(docOf([host]), "host");
    const page = doc.pages![0].children;

    expect(hoisted.map((h) => h.id).sort()).toEqual(["inner", "outer"]);
    // The invariant, not just the two ids: nothing that is a component sits inside
    // another component afterwards. (`insideComponent` counts the element itself
    // when it is a component, so the question has to be asked of the parent.)
    for (const el of flattenElements(page)) {
      if (el.type !== "component") continue;
      const parent = findParentById(page, el.id);
      expect(Boolean(parent && insideComponent(page, parent.id))).toBe(false);
    }
    const outerNode = findElementById(page, "outer") as ComponentElement;
    expect(outerNode.children!.map((c) => c.type)).toEqual(["instance", "rect"]);
    expect((outerNode.children![0] as InstanceElement).componentId).toBe("inner");
    const hostNode = findElementById(page, "host") as ComponentElement;
    expect((hostNode.children![0] as InstanceElement).componentId).toBe("outer");
  });

  it("leaves a frame with no master alone", () => {
    const plainFrame: FrameElement = {
      id: "plain_frame",
      type: "frame",
      name: "Plain",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      children: [{ id: "rect", type: "rect", name: "rect", x: 0, y: 0, width: 10, height: 10 }]
    };
    const before = docOf([plainFrame, component("plain")]);
    const { doc, component: made, hoisted } = createComponentFromElement(before, "plain_frame");

    expect(hoisted).toEqual([]);
    expect(made!.children!.map((c) => c.id)).toEqual(["rect"]);
    expect(doc.pages![0].children.map((el) => el.id)).toEqual(["plain_frame", "plain"]);
  });
});

/**
 * Swapping is a re-pointing of one instance, and the components around it are off
 * limits: the one it projects (nothing to do), the ones that CONTAIN it (the
 * instance would become its own ancestor — `resolveInstanceChildren` would clone
 * forever) and the ones it already shows (it would become its own descendant).
 * The guard lives in the core because both swap controls and the writes behind
 * them have to agree: a disabled option is a hint, not a lock.
 */
describe("a swap never points an instance at its own family", () => {
  const leaf = (id: string): ComponentElement => ({
    id,
    type: "component",
    name: id,
    x: 0,
    y: 500,
    width: 24,
    height: 24,
    children: [{ id: `${id}_dot`, type: "rect", name: "dot", x: 0, y: 0, width: 8, height: 8 }]
  });

  function doc(): DesignDocument {
    const elements: DesignElement[] = [
      leaf("icon_a"),
      leaf("icon_b"),
      leaf("unrelated"),
      // `badge` USES icon_a…
      {
        id: "badge",
        type: "component",
        name: "badge",
        x: 0,
        y: 600,
        width: 40,
        height: 24,
        children: [
          { id: "badgeIcon", type: "instance", name: "badgeIcon", componentId: "icon_a", x: 8, y: 0, width: 24, height: 24 }
        ]
      },
      // …and `shell` uses badge plus icon_b, one level deeper.
      {
        id: "shell",
        type: "component",
        name: "shell",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        children: [
          { id: "slot", type: "instance", name: "slot", componentId: "badge", x: 8, y: 8, width: 40, height: 24 },
          {
            id: "wrap",
            type: "frame",
            name: "wrap",
            x: 60,
            y: 8,
            width: 60,
            height: 40,
            children: [
              { id: "innerSlot", type: "instance", name: "innerSlot", componentId: "icon_b", x: 4, y: 4, width: 24, height: 24 }
            ]
          }
        ]
      },
      { id: "inst", type: "instance", name: "inst", componentId: "shell", x: 400, y: 0, width: 200, height: 100 },
      // A master that HOLDS an instance of shell: the containing case with no
      // clone involved.
      {
        id: "host",
        type: "component",
        name: "host",
        x: 0,
        y: 700,
        width: 200,
        height: 100,
        children: [
          { id: "hostInst", type: "instance", name: "hostInst", componentId: "shell", x: 0, y: 0, width: 200, height: 100 }
        ]
      }
    ];
    return {
      version: "0.1",
      id: "doc",
      name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
      activePageId: "page_1",
      elements
    };
  }

  it("refuses the component the instance already projects", () => {
    expect(swapRefusal(doc(), "inst", "shell")).toBe("same-component");
    expect(swapRefusal(doc(), "inst_slot", "badge")).toBe("same-component");
    expect(swapRefusal(doc(), "hostInst", "shell")).toBe("same-component");
  });

  it("refuses every component the instance already shows", () => {
    // Directly, through a nested instance's master, and through a frame in between.
    expect(swapRefusal(doc(), "inst", "badge")).toBe("inside-instance");
    expect(swapRefusal(doc(), "inst", "icon_a")).toBe("inside-instance");
    expect(swapRefusal(doc(), "inst", "icon_b")).toBe("inside-instance");
    // The guard is per node: icon_a lives inside badge, which is what slot shows.
    expect(swapRefusal(doc(), "inst_slot", "icon_a")).toBe("inside-instance");
  });

  it("refuses every component that contains the instance", () => {
    // The master of the instance you are inside…
    expect(swapRefusal(doc(), "inst_slot", "shell")).toBe("contains-instance");
    // …and the same rule for a node two levels down. Its id is flat
    // (`inst_` + the master node), the nesting lives in the children, not the id.
    expect(swapRefusal(doc(), "inst_innerSlot", "shell")).toBe("contains-instance");
    // …and for a stored instance sitting inside a master.
    expect(swapRefusal(doc(), "hostInst", "host")).toBe("contains-instance");
  });

  it("leaves everything else alone", () => {
    expect(swapRefusal(doc(), "inst", "unrelated")).toBeNull();
    expect(swapRefusal(doc(), "inst_slot", "icon_b")).toBeNull();
    expect(swapRefusal(doc(), "hostInst", "unrelated")).toBeNull();
  });

  it("refuses the write, not just the control", () => {
    expect(swapInstanceComponent(doc(), "inst", "icon_a")).toBeNull();
    expect(swapNestedInstance(doc(), "inst_slot", "shell")).toBeNull();
    expect(swapInstanceComponent(doc(), "inst", "unrelated")).toBeTruthy();
    expect(swapNestedInstance(doc(), "inst_slot", "icon_b")).toBeTruthy();
  });

  it("hands the control the refusals as disabled options", () => {
    const options = componentSwapOptions(doc(), "base", "inst");
    const byId = Object.fromEntries(options.map((o) => [o.id, o]));
    expect(byId.shell.disabled).toBe(true);
    expect(byId.shell.refusal).toBe("same-component");
    expect(byId.badge).toMatchObject({ disabled: true, refusal: "inside-instance" });
    expect(byId.icon_a.disabled).toBe(true);
    expect(byId.unrelated.disabled).toBeUndefined();
    // Without a node, the list is what it always was — every component.
    expect(componentSwapOptions(doc(), "base").every((o) => !o.disabled)).toBe(true);
  });
});

/**
 * `overridable` is the single gate on the whole override write path, and it reads
 * like a depth test while it is not one. It asks: was this clone minted by the
 * resolve pass of the instance we found? A node under the master's root, or under
 * any number of plain frames, was — so the override lands on a stored instance and
 * has somewhere to live. A node one crossing deeper (the master's child is itself
 * an instance and you went past it) was minted by THAT instance, which is itself
 * only a clone, so there is nothing to hang the override on.
 *
 * This is pinned because the two things it is not are easy to assume: it is not
 * tree depth, and it has nothing to do with frames. A nested instance crossing
 * ("master→frame→instance") is exactly one crossing and therefore writable.
 */
describe("overridable counts instance crossings, not tree levels", () => {
  const iconMaster = (): ComponentElement => ({
    id: "IconMaster",
    type: "component",
    name: "IconMaster",
    x: 900,
    y: 0,
    width: 24,
    height: 24,
    children: [{ id: "glyph", type: "rect", name: "glyph", x: 0, y: 0, width: 8, height: 8 }] as DesignElement[]
  });

  /** The same nested instance, at three tree depths, all under the same root. */
  const buttonAt = (wrap: (icon: DesignElement) => DesignElement[]): ComponentElement => ({
    id: "Button",
    type: "component",
    name: "Button",
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    children: [
      ...wrap({ id: "icon", type: "instance", name: "icon", componentId: "IconMaster", x: 8, y: 8, width: 24, height: 24 } as DesignElement),
      { id: "lbl", type: "text", name: "lbl", x: 40, y: 10, width: 60, height: 20, content: "Go",
        style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" } } as DesignElement
    ]
  });

  const docWith = (button: ComponentElement): DesignDocument => {
    const els: DesignElement[] = [
      iconMaster(),
      button,
      { id: "btn", type: "instance", name: "btn", componentId: "Button", x: 300, y: 0, width: 120, height: 40 }
    ];
    return {
      version: "0.1", id: "doc", name: "Doc",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      canvas, pages: [{ id: "page_1", name: "Page 1", canvas, children: els }],
      activePageId: "page_1", elements: els
    };
  };

  const cases: Array<[string, ComponentElement]> = [
    ["directly under the root", buttonAt((icon) => [icon])],
    ["under one frame", buttonAt((icon) => [
      { id: "content", type: "frame", name: "content", x: 0, y: 0, width: 40, height: 40, children: [icon] } as DesignElement
    ])],
    ["under two frames", buttonAt((icon) => [
      { id: "a", type: "frame", name: "a", x: 0, y: 0, width: 40, height: 40, children: [
        { id: "b", type: "frame", name: "b", x: 0, y: 0, width: 40, height: 40, children: [icon] } as DesignElement
      ] } as DesignElement
    ])]
  ];

  it("the number of frames in between changes nothing", () => {
    for (const [label, button] of cases) {
      const doc = docWith(button);
      const icon = resolveInstanceSelection(doc, "btn_icon");
      expect(icon?.masterNodeId, label).toBe("icon");
      expect(icon?.overridable, label).toBe(true);
      // One crossing deeper is addressable too, through a path: the outer
      // instance cannot resolve that far, so it hands the tail to the nested
      // one when it resolves.
      const deep = resolveInstanceSelection(doc, "btn_icon_glyph");
      expect(deep?.masterNodeId, label).toBe("icon/glyph");
      expect(deep?.overridable, label).toBe(true);
    }
  });

  it("an override on it lands on the instance and leaves the master alone", () => {
    const doc = docWith(cases[1][1]);
    const sel = resolveInstanceSelection(doc, "btn_icon")!;
    const next = commitInstanceOverrides(doc, [sel], (el) => ({ ...el, opacity: 0.5 }))!;
    const btn = findElementById(next.pages![0].children, "btn") as InstanceElement;
    const master = findElementById(next.pages![0].children, "Button") as ComponentElement;
    expect(btn.overrides).toEqual([{ targetId: "icon", property: "opacity", value: 0.5 }]);
    // The master's own nested instance gained nothing — the whole point of the gate.
    const masterIcon = flattenElements(master.children || []).find((e) => e.id === "icon") as InstanceElement;
    expect(masterIcon.overrides).toBeUndefined();
  });
});
