import { describe, it, expect } from "vitest";
import { CanvasDefs } from "../src/ui/canvas/CanvasDefs";
import type { ColorToken, ComponentElement, DesignDocument, DesignElement, InstanceElement } from "../src/core/dsl/types";

import { defsMarkup } from "./support/defs";

const image = (id: string): DesignElement =>
  ({
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 0,
    width: 56,
    height: 56,
    fills: [{ type: "image", assetId: "a1", fit: "cover" }]
  }) as DesignElement;

const ramp = (id: string): DesignElement =>
  ({
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 0,
    width: 56,
    height: 56,
    fills: [
      {
        type: "linear-gradient",
        angle: 90,
        stops: [
          { offset: 0, color: "#111111" },
          { offset: 1, color: "#EEEEEE" }
        ]
      }
    ]
  }) as DesignElement;

const shadowed = (id: string): DesignElement =>
  ({
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 60,
    width: 56,
    height: 20,
    fills: [{ type: "solid", color: "#FFFFFF" }],
    effects: [{ type: "drop-shadow", blur: 8, offset: { x: 0, y: 4 }, color: "#000000" }]
  }) as DesignElement;

const row: ComponentElement = {
  id: "row",
  type: "component",
  name: "ROW",
  x: 0,
  y: 0,
  width: 160,
  height: 90,
  children: [image("thumb"), ramp("ramp"), shadowed("shadow")]
};

const card: ComponentElement = {
  id: "card",
  type: "component",
  name: "CARD",
  x: 0,
  y: 200,
  width: 300,
  height: 120,
  children: [
    { id: "rowInst", type: "instance", name: "ROW", componentId: "row", x: 20, y: 20, width: 160, height: 90 } as InstanceElement
  ]
};

const cardInst: InstanceElement = {
  id: "cardInst",
  type: "instance",
  name: "CARD",
  componentId: "card",
  x: 400,
  y: 200,
  width: 300,
  height: 120
};

const defIds = (): string[] =>
  defsMarkup(
    CanvasDefs({
      allElements: [row, card, cardInst] as DesignElement[],
      selectedIds: new Set(),
      assets: [{ id: "a1", name: "photo", uri: "data:image/png;base64,AAAA", width: 64, height: 64 }]
    }) as any
  )
    .map((n) => n.props?.id)
    .filter((id: unknown): id is string => typeof id === "string");

/**
 * A def is reachable only through the element that references it, and the
 * renderer recurses through instance levels — so the `<defs>` pass must too.
 *
 * It stopped at the first crossing, which left every id minted for a nested
 * clone (`cardInst_rowInst_*`) referenced and never emitted. An SVG paint server
 * that does not exist paints nothing, so a component inside a component lost its
 * photograph, its ramp and its shadow and kept its type.
 */
describe("defs resolve through every instance level", () => {
  it("emits the image tile of a node two crossings down", () => {
    expect(defIds()).toContain("pat_cardInst_rowInst_thumb_0");
  });

  it("emits the ramp of a node two crossings down", () => {
    expect(defIds()).toContain("grad_fill_cardInst_rowInst_ramp_0");
  });

  it("emits the shadow filter of a node two crossings down", () => {
    expect(defIds()).toContain("filter_cardInst_rowInst_shadow");
  });

  it("emits nothing twice — the flat tree and the clones are disjoint", () => {
    const ids = defIds();
    expect(ids.length).toBe(new Set(ids).size);
  });
});

/**
 * The MODE a def is emitted in has to be the one the renderer paints it in, and
 * both walks resolve it the same way: an instance takes its master's mode until
 * it declares one, everything else its own or its parent's.
 *
 * This pass records the pair per node and reads it back by id — and a resolved
 * clone has no row until this walk puts it there. Falling back to `__instanceId`
 * answered for two levels and then, at the third, pointed at a clone that is not
 * in the table: the ramp came out of the document's active theme instead of the
 * one the card is rendered in.
 */
describe("a def resolves the mode of the node that references it", () => {
  const tokens: ColorToken[] = [
    { id: "tok_a", name: "ramp-start", type: "color", value: "#101010", modes: { dark: "#FF2200" } },
    { id: "tok_b", name: "ramp-end", type: "color", value: "#F0F0F0", modes: { dark: "#22FF66" } }
  ];

  const rampNode = (id: string): DesignElement =>
    ({
      id,
      type: "rect",
      name: id,
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      fills: [
        {
          type: "linear-gradient",
          angle: 90,
          stops: [
            { offset: 0, color: "#101010", tokenId: "tok_a" },
            { offset: 1, color: "#F0F0F0", tokenId: "tok_b" }
          ]
        }
      ]
    }) as unknown as DesignElement;

  const badge = (children: DesignElement[]): ComponentElement =>
    ({ id: "badge", type: "component", name: "Badge", x: 0, y: 0, width: 40, height: 40, children }) as ComponentElement;

  const icon = (children: DesignElement[]): ComponentElement =>
    ({ id: "icon", type: "component", name: "Icon", x: 0, y: 60, width: 40, height: 40, children }) as ComponentElement;

  const card = (children: DesignElement[], extra: Record<string, unknown> = {}): ComponentElement =>
    ({ id: "card", type: "component", name: "Card", x: 0, y: 140, width: 120, height: 120, children, ...extra }) as ComponentElement;

  const nested = (id: string, componentId: string): InstanceElement =>
    ({ id, type: "instance", name: componentId, componentId, x: 0, y: 0, width: 40, height: 40 }) as InstanceElement;

  const defsOf = (masters: DesignElement[], root: InstanceElement) => {
    const all = [...masters, root];
    const doc = {
      version: "0.1",
      canvas: { width: 800, height: 600, background: { type: "solid", color: "#FFFFFF" } },
      pages: [{ id: "p1", name: "P1", canvas: { width: 800, height: 600 }, children: all }],
      activePageId: "p1",
      tokens,
      styles: [],
      modes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }],
      activeTheme: "light"
    } as unknown as DesignDocument;
    return defsMarkup(
      CanvasDefs({
        allElements: all,
        selectedIds: new Set(),
        docRef: { current: doc }
      } as any) as any
    );
  };

  const stopsOf = (defs: any[], id: string): string[] => {
    const grad = defs.find((n) => n?.props?.id === id);
    expect(grad, `no gradient def ${id}`).toBeTruthy();
    // The resolved stack, not rendered markup: `GradientDef` is a component and
    // its stops only exist once it runs.
    return (grad.props.paint.stops as any[]).map((stop) => stop.color);
  };

  it("emits a three-level nest's ramp in the theme the outer instance declares", () => {
    const masters = [
      badge([rampNode("dot")]),
      icon([nested("badgeInst", "badge")]),
      card([nested("iconInst", "icon")], { themeMode: "dark" })
    ];
    const root = nested("cardInst", "card");
    const defs = defsOf(masters as DesignElement[], root);
    expect(stopsOf(defs, "grad_fill_cardInst_iconInst_badgeInst_dot_0")).toEqual(["#FF2200", "#22FF66"]);
  });

  it("carries a themed container between two instance levels", () => {
    // The crossing is not always instance → instance: a Frame that pins its own
    // mode sits in between, and the renderer honours it. Reading the owner off
    // `__instanceId` skipped the frame entirely and used the card's mode.
    //
    // The id is the CARD's chain, not the frame's: resolved ids are
    // `<ownerInstance>_<masterNode>`, and the frame is inside the same owner.
    const holder: DesignElement = {
      id: "holder",
      type: "frame",
      name: "Holder",
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      themeMode: "dark",
      children: [nested("iconInst", "icon") as DesignElement]
    } as unknown as DesignElement;
    const masters = [badge([rampNode("dot")]), icon([nested("badgeInst", "badge")]), card([holder])];
    const root = nested("cardInst", "card");
    const defs = defsOf(masters as DesignElement[], root);
    expect(stopsOf(defs, "grad_fill_cardInst_iconInst_badgeInst_dot_0")).toEqual(["#FF2200", "#22FF66"]);
  });

  it("keeps the document's own theme when nothing in the chain pins one", () => {
    const masters = [badge([rampNode("dot")]), icon([nested("badgeInst", "badge")]), card([nested("iconInst", "icon")])];
    const root = nested("cardInst", "card");
    const defs = defsOf(masters as DesignElement[], root);
    expect(stopsOf(defs, "grad_fill_cardInst_iconInst_badgeInst_dot_0")).toEqual(["#101010", "#F0F0F0"]);
  });
});
