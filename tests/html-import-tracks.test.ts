import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { childSizingFor, parseTrackList } from "../src/core/import/html-layout";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { FrameElement } from "../src/core/dsl/types";

/**
 * The track list the AUTHOR wrote, which is the only place a ratio survives.
 *
 * Computed style has already thrown it away: `1fr` comes back as the px it
 * resolved to at one width, and `repeat(auto-fit, …)` as however many tracks
 * that width fit. Everything here is about getting the intent back off the
 * declaration, and about refusing the ones the DSL could only half-carry.
 */
describe("parseTrackList", () => {
  it("reads a mixed px/fr list as widths and shares", () => {
    expect(parseTrackList("280px 1fr 288px")).toEqual({ tracks: [280, { fr: 1 }, 288] });
  });

  it("expands a counted repeat, which is only a way of writing N tracks", () => {
    expect(parseTrackList("repeat(3, 1fr)")).toEqual({ tracks: [{ fr: 1 }, { fr: 1 }, { fr: 1 }] });
    expect(parseTrackList("repeat(2, 100px 1fr)")).toEqual({
      tracks: [100, { fr: 1 }, 100, { fr: 1 }]
    });
  });

  it("turns auto-fit into the minimum the count is derived from", () => {
    expect(parseTrackList("repeat(auto-fit, minmax(360px, 1fr))")).toEqual({ autoFit: { min: 360 } });
  });

  it("reads a weight above one, and a bare 0 as a length", () => {
    expect(parseTrackList("1fr 2fr")).toEqual({ tracks: [{ fr: 1 }, { fr: 2 }] });
    expect(parseTrackList("minmax(0, 1fr) 0")).toEqual({ tracks: [{ fr: 1 }, 0] });
  });

  /**
   * A floor above zero is a bound a share cannot carry, and a share that
   * quietly ignores it is worse than a reported gap — the caller names it and
   * falls back to the px the browser measured.
   */
  it("refuses what it could only half-carry", () => {
    expect(parseTrackList("minmax(360px, 1fr)")).toBeUndefined();
    expect(parseTrackList("auto 1fr")).toBeUndefined();
    expect(parseTrackList("repeat(auto-fill, 200px)")).toBeUndefined();
    expect(parseTrackList("none")).toBeUndefined();
  });

  /**
   * A relative unit read as its digits is the worst of both: the list parses,
   * so nothing reports it, and every length in it is wrong by the factor the
   * unit stood for. `20rem` must not become a 20px column.
   */
  it("refuses a relative length rather than reading its digits", () => {
    expect(parseTrackList("20rem 1fr")).toBeUndefined();
    expect(parseTrackList("50% 1fr")).toBeUndefined();
    expect(parseTrackList("2em 1fr")).toBeUndefined();
    expect(parseTrackList("10vw 1fr")).toBeUndefined();
    expect(parseTrackList("20px 1fr")).toEqual({ tracks: [20, { fr: 1 }] });
  });
});

describe("a track list in a document", () => {
  it("accepts both spellings of a share and names the track it dropped", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "1.0",
      canvas: { width: 400, height: 200, unit: "px" },
      elements: [
        {
          id: "g",
          type: "frame",
          width: 400,
          height: 200,
          children: [],
          display: "grid",
          "grid-template-columns": ["1fr", { fr: 2 }, 120, "auto"]
        }
      ]
    } as never);
    expect(layoutOf(getActivePage(document).children[0])?.columnSizes).toEqual([
      { fr: 1 },
      { fr: 2 },
      120
    ]);
    expect(repairs.some((r) => r.path.endsWith("/columnSizes") && r.message.includes("auto"))).toBe(true);
  });
});

/**
 * `grid-row: -1` counts back from the LAST line, so it means nothing without the
 * track count. Rows are the one count the importer cannot always supply: they are
 * derived from the children unless the author sized them, and resolving `-1`
 * against a stand-in of 1 pins the child to the first row of a three-row grid as
 * an EXPLICIT placement, which nothing downstream corrects.
 */
describe("a line that counts back from the end", () => {
  const grid = { mode: "grid", columns: 3 } as const;
  const child = (gridRowStart: string, gridRowEnd: string, layout = grid) =>
    childSizingFor(
      {
        gridRowStart,
        gridRowEnd,
        gridColumnStart: "auto",
        gridColumnEnd: "auto",
        order: "0",
        minWidth: "auto",
        maxWidth: "none",
        minHeight: "auto",
        maxHeight: "none"
      } as unknown as CSSStyleDeclaration,
      layout,
      { width: 300, height: 200 },
      { width: 100, height: 40 },
      () => {}
    ).cell;

  it("resolves against a row count the grid actually states", () => {
    const sized = { mode: "grid", columns: 3, rowSizes: [40, 40, 40] } as const;
    // `-1` alone is the LAST ROW, `1 / -1` is every row: the two count back from
    // different ends, and one formula for both loses a track.
    expect(child("-1", "auto", sized)).toEqual({ row: 3 });
    expect(child("1", "-1", sized)).toEqual({ row: 1, rowSpan: 3 });
  });

  it("reports the placement rather than pinning it to the first row", () => {
    const unmapped: string[] = [];
    const sink = (property: string, value: string) => unmapped.push(`${property}:${value}`);
    const result = childSizingFor(
      {
        gridRowStart: "-1",
        gridRowEnd: "auto",
        gridColumnStart: "auto",
        gridColumnEnd: "auto",
        order: "0",
        minWidth: "auto",
        maxWidth: "none",
        minHeight: "auto",
        maxHeight: "none"
      } as unknown as CSSStyleDeclaration,
      { mode: "grid", columns: 3 },
      { width: 300, height: 200 },
      { width: 100, height: 40 },
      sink
    );
    expect(result.cell).toBeUndefined();
    expect(unmapped.some((u) => u.startsWith("grid-row:"))).toBe(true);
  });

  it("still counts back on the column axis, whose count is always known", () => {
    const result = childSizingFor(
      {
        gridRowStart: "auto",
        gridRowEnd: "auto",
        gridColumnStart: "1",
        gridColumnEnd: "-1",
        order: "0",
        minWidth: "auto",
        maxWidth: "none",
        minHeight: "auto",
        maxHeight: "none"
      } as unknown as CSSStyleDeclaration,
      { mode: "grid", columns: 3 },
      { width: 300, height: 200 },
      { width: 100, height: 40 },
      () => {}
    );
    expect(result.cell).toEqual({ column: 1, columnSpan: 3 });
  });
});
