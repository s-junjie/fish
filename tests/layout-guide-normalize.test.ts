import { describe, expect, it } from "vitest";
import { normalizeLayoutGuides } from "../src/core/dsl/normalize/layout-guides";
import type { NormalizationRepair } from "../src/core/dsl/normalize/shared";

const run = (el: Record<string, unknown>) => {
  const repairs: NormalizationRepair[] = [];
  const guides = normalizeLayoutGuides(el, "elements/0", repairs);
  return { guides, repairs };
};

describe("layout guide normalization", () => {
  it("reads both spellings and keeps the fields it was given", () => {
    const camel = run({ layoutGuides: [{ kind: "columns", count: 5, align: "stretch", gutter: 20 }] });
    expect(camel.guides).toEqual([{ kind: "columns", count: 5, align: "stretch", gutter: 20 }]);
    expect(camel.repairs).toEqual([]);

    const kebab = run({ "layout-guides": [{ kind: "grid", size: 8 }] });
    expect(kebab.guides).toEqual([{ kind: "grid", size: 8 }]);
  });

  it("is absent, not empty, when the document says nothing", () => {
    expect(normalizeLayoutGuides({}, "elements/0", [])).toBeUndefined();
  });

  it("drops the whole entry when there is nothing to draw", () => {
    const count = run({ layoutGuides: [{ kind: "columns", count: 2.5 }] });
    expect(count.guides).toEqual([]);
    expect(count.repairs[0].path).toBe("elements/0/layoutGuides/0/count");

    const size = run({ layoutGuides: [{ kind: "grid" }] });
    expect(size.guides).toEqual([]);
    expect(size.repairs[0].path).toBe("elements/0/layoutGuides/0/size");

    const kind = run({ layoutGuides: [{ kind: "spiral", count: 3 }] });
    expect(kind.guides).toEqual([]);
    expect(kind.repairs[0].path).toBe("elements/0/layoutGuides/0/kind");
  });

  it("costs one field, not the guide, for a value that only needs replacing", () => {
    const negative = run({ layoutGuides: [{ kind: "columns", count: 5, gutter: -1, margin: 12 }] });
    expect(negative.guides).toEqual([{ kind: "columns", count: 5, margin: 12 }]);
    expect(negative.repairs.map((r) => r.path)).toEqual(["elements/0/layoutGuides/0/gutter"]);

    const colour = run({ layoutGuides: [{ kind: "grid", size: 8, color: "#GGG" }] });
    expect(colour.guides).toEqual([{ kind: "grid", size: 8 }]);
    expect(colour.repairs[0].path).toBe("elements/0/layoutGuides/0/color");

    const align = run({ layoutGuides: [{ kind: "columns", count: 5, align: "middle" }] });
    expect(align.guides).toEqual([{ kind: "columns", count: 5 }]);
    expect(align.repairs[0].path).toBe("elements/0/layoutGuides/0/align");
  });

  it("refuses a fixed-size set that never says its size", () => {
    const { guides, repairs } = run({ layoutGuides: [{ kind: "rows", count: 3, align: "center" }] });
    expect(guides).toEqual([]);
    expect(repairs[0].path).toBe("elements/0/layoutGuides/0/height");
  });

  it("keeps an explicit hide and writes nothing for a visible one", () => {
    expect(run({ layoutGuides: [{ kind: "grid", size: 8, visible: false }] }).guides).toEqual([
      { kind: "grid", size: 8, visible: false }
    ]);
    expect(run({ layoutGuides: [{ kind: "grid", size: 8, visible: true }] }).guides).toEqual([
      { kind: "grid", size: 8 }
    ]);
  });

  it("reports a non-array rather than ignoring it", () => {
    const { guides, repairs } = run({ layoutGuides: { kind: "grid", size: 8 } });
    expect(guides).toBeUndefined();
    expect(repairs[0].path).toBe("elements/0/layoutGuides");
  });
});
