import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { DesignElement, FrameElement, RectElement } from "../src/core/dsl/types";

function toFlat(layout: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(layout)) {
    if (k === "mode") out.display = v;
    else if (k === "columns") out["grid-template-columns"] = v;
    else if (k === "rows") out["grid-template-rows"] = v;
    else if (k === "direction") out["flex-direction"] = v;
    else if (k === "justify") out["justify-content"] = v;
    else if (k === "align") out["align-items"] = v;
    else if (k === "alignItems") out["align-items"] = v;
    else if (k === "alignContent") out["align-content"] = v;
    else if (k === "cellAlign") out["align-items"] = v;
    else if (k === "placement") out["grid-auto-flow"] = v;
    else if (k === "wrap") out["flex-wrap"] = v;
    else out[k] = v;
  }
  return out;
}

const doc = (layout: Record<string, unknown>) => ({
  canvas: { width: 400, height: 400 },
  elements: [
    {
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      ...toFlat(layout),
      children: [{ id: "c", type: "rect", x: 0, y: 0, width: 10, height: 10 } as RectElement]
    } as unknown as FrameElement
  ]
});

const repairsFor = (layout: Record<string, unknown>) =>
  normalizeDesignDocument(doc(layout)).repairs;

describe("normalization reports what it dropped from `layout`", () => {
  it("names an out-of-enum value and lists what is allowed", () => {
    const repairs = repairsFor({ mode: "flex", align: "baseline", justify: "space-round" });
    const align = repairs.find((r) => r.path.endsWith("/layout/align"));
    const justify = repairs.find((r) => r.path.endsWith("/layout/justify"));
    expect(align?.kind).toBe("layout");
    expect(align?.message).toContain("align");
    expect(justify?.message).toContain("space-round");
    // The allowed list travels with the refusal, so a value that LOOKS like a
    // distribution mode but is not one can be told apart from a typo of the one
    // that is — `space-evenly` is supported and has to appear as a suggestion.
    expect(justify?.message).toContain("space-evenly");
  });

  it("accepts the explicit `stretch` cross-axis value (P1.1)", () => {
    const res = normalizeDesignDocument(doc({ mode: "flex", align: "stretch" }));
    expect(layoutOf(getActivePage(res.document).children[0] as FrameElement)?.align).toBe("stretch");
    expect(res.repairs.find((r) => r.path.endsWith("/layout/align"))).toBeUndefined();
  });

  it("accepts the CSS spelling of an align key (P0.5)", () => {
    // P0.5 absorbs `alignItems` as `align`; the refusal below moves to a key that
    // is genuinely not part of the vocabulary.
    const res = normalizeDesignDocument(doc({ mode: "flex", alignItems: "center" }));
    expect(layoutOf(getActivePage(res.document).children[0] as FrameElement)?.align).toBe("center");
    expect(res.repairs.find((r) => r.message.includes("alignItems"))).toBeUndefined();
  });

  it("reports an unknown layout key instead of swallowing it", () => {
    const repairs = repairsFor({ mode: "flex", alignItem: "center" });
    const dropped = repairs.find((r) => r.message.includes("alignItem"));
    expect(dropped).toBeDefined();
  });

  it("migrates `wrap: true` and says so", () => {
    const res = normalizeDesignDocument(doc({ mode: "flex", wrap: true }));
    expect(layoutOf(getActivePage(res.document).children[0] as FrameElement)?.wrap).toBe("wrap");
    expect(res.repairs.some((r) => /wrap/.test(r.message))).toBe(true);
  });

  it("reports an unsupported grid value", () => {
    const repairs = repairsFor({ mode: "grid", columns: 2, placement: "diagonal", cellAlign: "baseline" });
    expect(repairs.some((r) => r.message.includes("placement"))).toBe(true);
    expect(repairs.some((r) => r.message.includes("cellAlign"))).toBe(true);
  });

  it("stays quiet for a value it accepts", () => {
    const repairs = repairsFor({ mode: "grid", columns: 2, placement: "column", cellAlign: "end", gap: 8, padding: 16 });
    expect(repairs.filter((r) => r.path.includes("/layout/"))).toEqual([]);
  });
});

/**
 * The DSL stores `number | [t,r,b,l]`, but every CSS spelling of the shorthand
 * has to survive the way in. A two-value array used to vanish without a word, so
 * the frame rendered with no padding and nothing said why.
 */
describe("padding accepts every shorthand shape", () => {
  const storedPadding = (padding: unknown) =>
    layoutOf(getActivePage(normalizeDesignDocument(doc({ mode: "flex", padding })).document).children[0] as FrameElement)?.padding;

  it("keeps a uniform number as a number", () => {
    expect(storedPadding(16)).toBe(16);
    expect(storedPadding("16")).toBe(16);
    expect(storedPadding([16])).toBe(16);
  });

  it("expands 2, 3 and 4 value forms to [t,r,b,l]", () => {
    expect(storedPadding([16, 24])).toEqual([16, 24, 16, 24]);
    expect(storedPadding([16, 24, 8])).toEqual([16, 24, 8, 24]);
    expect(storedPadding([16, 24, 8, 4])).toEqual([16, 24, 8, 4]);
    expect(storedPadding("16 24")).toEqual([16, 24, 16, 24]);
    expect(storedPadding("16 24 8 4")).toEqual([16, 24, 8, 4]);
  });

  it("accepts a per-side object", () => {
    expect(storedPadding({ top: 16, right: 24, bottom: 8, left: 4 })).toEqual([16, 24, 8, 4]);
    expect(storedPadding({ t: 16, l: 16 })).toEqual([16, 0, 0, 16]);
  });

  it("clamps negatives and tolerates unit suffixes", () => {
    expect(storedPadding(-8)).toBe(0);
    expect(storedPadding(["-8px", "24px"])).toEqual([0, 24, 0, 24]);
  });

  it("reports a shape it cannot use instead of dropping it in silence", () => {
    for (const bad of ["auto", [1, 2, 3, 4, 5], [], true, { margin: 8 }]) {
      const res = normalizeDesignDocument(doc({ mode: "flex", padding: bad }));
      expect(layoutOf(getActivePage(res.document).children[0] as FrameElement)?.padding).toBeUndefined();
      const repair = res.repairs.find((r) => r.path.endsWith("/layout/padding"));
      expect(repair, "padding " + JSON.stringify(bad)).toBeDefined();
      expect(repair?.message).toContain("padding");
    }
  });
});

describe("the flex gap pair, align-content and flex-grow", () => {
  const readLayout = (layout: Record<string, unknown>) =>
    layoutOf(getActivePage(normalizeDesignDocument(doc(layout)).document).children[0] as FrameElement)!;

  it("keeps a uniform gap as `gap` and a two-value gap as the two axes", () => {
    expect(readLayout({ mode: "flex", gap: 12 }).gap).toBe(12);
    expect(readLayout({ mode: "flex", gap: [8, 16] })).toMatchObject({ rowGap: 8, columnGap: 16 });
    expect(readLayout({ mode: "flex", gap: "8 16" })).toMatchObject({ rowGap: 8, columnGap: 16 });
    expect(readLayout({ mode: "flex", gap: "8 16" }).gap).toBeUndefined();
  });

  it("reads per-axis gaps in flex mode, not only grid", () => {
    const layout = readLayout({ mode: "flex", columnGap: 24, rowGap: 6 });
    expect(layout.columnGap).toBe(24);
    expect(layout.rowGap).toBe(6);
  });

  it("keeps alignContent for flex and drops it from grid with a note", () => {
    expect(readLayout({ mode: "flex", alignContent: "space-between" }).alignContent).toBe("space-between");
    const repairs = repairsFor({ mode: "grid", columns: 2, alignContent: "center" });
    expect(repairs.some((r) => r.message.includes("alignContent"))).toBe(true);
  });

  it("keeps a child's flexGrow, folds the aliases into it, and drops the implicit 1", () => {
    const { document } = normalizeDesignDocument({
      canvas: { width: 400, height: 400, unit: "px" },
      elements: [
        {
          id: "f",
          type: "frame",
          width: 300,
          height: 200,
          ...flattenLayout({ mode: "flex", direction: "row" }),
          children: [
            { id: "a", type: "rect", width: 10, height: 10, flexGrow: 2 },
            { id: "b", type: "rect", width: 10, height: 10, layoutGrow: 2 },
            { id: "c", type: "rect", width: 10, height: 10, flex: "1 1 0" }
          ]
        }
      ]
    } as never);
    const kids = (getActivePage(document).children[0] as FrameElement).children as DesignElement[];
    expect(kids[0]["flex-grow"]).toBe(2);
    expect(kids[1]["flex-grow"]).toBe(2);
    expect(kids[2]["flex-grow"]).toBeUndefined();
    // A positive grow implies fill on the row's main axis, whichever key said it.
    expect(kids[0].sizing?.width).toBe("fill");
    expect(kids[1].sizing?.width).toBe("fill");
  });
});

/**
 * A container's own layout properties written at the element's top level, the
 * way CSS writes them (`display: flex; flex-wrap: wrap; padding: 24px`).
 *
 * The rule is meant to be one rule for every such key: fold it into the `layout`
 * slot that reads it, or report it and say what to write instead. Never invent a
 * layout — a synthesised `mode` / `direction` / `justify` reflows children that
 * were placed by hand, which is a silent geometry change where a repair is one
 * line of output.
 */
describe("outer-level layout properties (the CSS habit)", () => {
  const frameOf = (extra: Record<string, unknown>) =>
    normalizeDesignDocument({
      canvas: { width: 400, height: 400, unit: "px" },
      elements: [
        {
          id: "f",
          type: "frame",
          width: 300,
          height: 200,
          children: [{ id: "c", type: "rect", x: 0, y: 0, width: 10, height: 10 }],
          ...extra
        }
      ]
    } as never);

  const layoutOfFrame = (res: ReturnType<typeof frameOf>) =>
    layoutOf(getActivePage(res.document).children[0] as FrameElement);

  it("reads an outer padding, CSS shorthand and all", () => {
    const res = frameOf({ ...flattenLayout({ mode: "flex" }), padding: "12px 24px" });
    expect(layoutOfFrame(res)?.padding).toEqual([12, 24, 12, 24]);
  });

  it("folds an outer flex-wrap into layout.wrap", () => {
    const res = frameOf({ ...flattenLayout({ mode: "flex" }), "flex-wrap": "wrap" });
    expect(layoutOfFrame(res)?.wrap).toBe("wrap");
  });

  it("reads the boolean spelling `flex-wrap: true`", () => {
    const res = frameOf({ ...flattenLayout({ mode: "flex" }), "flex-wrap": true });
    expect(layoutOfFrame(res)?.wrap).toBe("wrap");
  });

  it("reports an outer wrap with no layout instead of swallowing it", () => {
    const res = frameOf({ wrap: "wrap" });
    const repair = res.repairs.find((r) => r.path.endsWith("/wrap"));
    expect(repair?.kind).toBe("dropped-property");
    expect(repair?.message).toContain("flex-wrap");
    expect(layoutOfFrame(res)).toBeUndefined();
  });

  it("reports an outer padding with no layout rather than inventing one", () => {
    const res = frameOf({ padding: 24 });
    const repair = res.repairs.find((r) => r.path.endsWith("/padding"));
    expect(repair?.kind).toBe("dropped-property");
    expect(layoutOfFrame(res)).toBeUndefined();
  });

  it("stores the absorbed keys under their flat names", () => {
    const res = frameOf({ ...flattenLayout({ mode: "flex" }), padding: 24, "flex-wrap": "wrap" });
    const frame = getActivePage(res.document).children[0] as unknown as Record<string, unknown>;
    expect(frame.padding).toBe(24);
    expect(frame["flex-wrap"]).toBe("wrap");
    expect(layoutOfFrame(res)?.padding).toBe(24);
    expect(layoutOfFrame(res)?.wrap).toBe("wrap");
  });
});
