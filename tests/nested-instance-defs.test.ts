import { describe, it, expect } from "vitest";
import { CanvasDefs } from "../src/ui/canvas/CanvasDefs";
import type { ComponentElement, DesignElement, InstanceElement } from "../src/core/dsl/types";

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
