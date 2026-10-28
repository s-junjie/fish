import { describe, it, expect } from "vitest";
import { childSizingFor, layoutFor } from "../src/core/import/html-layout";

/**
 * The flex half of the importer, exercised through the two exported entry points
 * rather than the private `flexLayout`/`childSizingFor` internals: a container's
 * gap pair, `align-content` and a child's `flexGrow`.
 */
describe("importing a flex container's gaps and align-content", () => {
  const sink = () => {};

  const cs = (over: Record<string, string>): CSSStyleDeclaration =>
    ({
      display: "flex",
      flexDirection: "row",
      rowGap: "0px",
      columnGap: "0px",
      justifyContent: "normal",
      alignItems: "normal",
      flexWrap: "nowrap",
      alignContent: "normal",
      ...over
    }) as unknown as CSSStyleDeclaration;

  it("keeps an unequal row/column gap as the main gap plus the cross gap", () => {
    // A row: columnGap is between items, rowGap is between wrapped lines.
    expect(layoutFor(cs({ rowGap: "12px", columnGap: "30px" }), sink, { width: 200, height: 200 }).layout).toMatchObject(
      { gap: 30, rowGap: 12 }
    );
  });

  it("swaps the axes for a column", () => {
    // A column: rowGap is between items, columnGap is between wrapped lines.
    const layout = layoutFor(
      cs({ flexDirection: "column", rowGap: "30px", columnGap: "12px" }),
      sink,
      { width: 200, height: 200 }
    ).layout;
    expect(layout).toMatchObject({ gap: 30, columnGap: 12 });
    expect(layout?.rowGap).toBeUndefined();
  });

  it("writes only `gap` when the two axes agree", () => {
    const layout = layoutFor(cs({ rowGap: "20px", columnGap: "20px" }), sink, { width: 200, height: 200 }).layout;
    expect(layout).toMatchObject({ gap: 20 });
    expect(layout?.rowGap).toBeUndefined();
  });

  it("maps align-content but drops CSS's default `stretch` and `normal`", () => {
    const wrapped = (alignContent: string) =>
      layoutFor(cs({ flexWrap: "wrap", alignContent }), sink, { width: 200, height: 200 }).layout?.alignContent;
    expect(wrapped("space-between")).toBe("space-between");
    expect(wrapped("flex-end")).toBe("end");
    expect(wrapped("stretch")).toBeUndefined();
    expect(wrapped("normal")).toBeUndefined();
  });
});

describe("importing a flex child's grow", () => {
  const child = (over: Record<string, string>) =>
    childSizingFor(
      {
        flexGrow: "0",
        flexShrink: "1",
        alignSelf: "auto",
        alignItems: "normal",
        minWidth: "auto",
        maxWidth: "none",
        minHeight: "auto",
        maxHeight: "none",
        ...over
      } as unknown as CSSStyleDeclaration,
      { mode: "flex", direction: "row" },
      { width: 300, height: 100 },
      { width: 50, height: 40 },
      () => {}
    );

  it("keeps a share above one and implies fill on the main axis", () => {
    const result = child({ flexGrow: "2" });
    expect(result.grow).toBe(2);
    expect(result.sizing?.width).toBe("fill");
  });

  it("does not store the implicit equal share of `flex: 1`", () => {
    const result = child({ flexGrow: "1" });
    expect(result.grow).toBeUndefined();
    expect(result.sizing?.width).toBe("fill");
  });

  it("writes nothing for a child that does not grow", () => {
    expect(child({ flexGrow: "0" })).toEqual({});
  });
});
