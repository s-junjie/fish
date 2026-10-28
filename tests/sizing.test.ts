import { flattenLayout } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { containerSizesAxis, resolveAxis, resolveAxisDetail, withAxisMode } from "../src/core/geometry/resolve-axis";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { applyAutoLayout, resolveDynamicLineHeight, resolveElementSizing, syncTextSizing } from "../src/core/compile";
import { FrameElement, AutoLayout, RectElement, TextElement } from "../src/core/dsl/types";

const rect = (id: string, sizing?: RectElement["sizing"]): RectElement => ({
  id,
  type: "rect",
  x: 0,
  y: 0,
  width: 50,
  height: 40,
  ...(sizing ? { sizing } : {})
});

const frame = (
  id: string,
  layout: AutoLayout | undefined,
  children: FrameElement["children"] = [],
  sizing?: FrameElement["sizing"]
): FrameElement => ({
  id,
  type: "frame",
  x: 0,
  y: 0,
  width: 400,
  height: 200,
  ...(layout ? flattenLayout(layout) : {}),
  ...(sizing ? { sizing } : {}),
  children
});

const text = (id: string, content: string, overrides: Partial<TextElement> = {}): TextElement => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 40,
  content,
  style: { fontFamily: "Arial", fontSize: 20, color: "#000000" },
  ...overrides
});

describe("resolveAxis", () => {
  it("defaults every axis to fixed", () => {
    expect(resolveAxis(rect("r"), null, "width")).toBe("fixed");
    expect(resolveAxis(rect("r"), null, "height")).toBe("fixed");
  });

  it("downgrades fill when there is no parent to distribute", () => {
    const detail = resolveAxisDetail(rect("r", { width: "fill" }), null, "width");
    expect(detail.mode).toBe("fixed");
    expect(detail.downgrade).toBe("no-parent");
  });

  it("downgrades fill inside a parent that has no auto layout", () => {
    const parent = frame("p", undefined, [rect("r", { width: "fill" })]);
    const detail = resolveAxisDetail(parent.children[0], parent, "width");
    expect(detail.mode).toBe("fixed");
    expect(detail.downgrade).toBe("parent-not-layout");
  });

  it("keeps fill inside a grid parent, where it means the cell", () => {
    const grid = frame("g", { mode: "grid", columns: 2 }, [rect("r", { width: "fill", height: "fill" })]);
    expect(resolveAxis(grid.children[0], grid, "width")).toBe("fill");
    expect(resolveAxis(grid.children[0], grid, "height")).toBe("fill");
  });

  it("downgrades a fill child of a grid that hugs the same axis", () => {
    const grid = frame("g", { mode: "grid", columns: 2 }, [rect("r", { width: "fill" })], {
      width: "fit-content"
    });
    const detail = resolveAxisDetail(grid.children[0], grid, "width");
    expect(detail.mode).toBe("fit-content");
    expect(detail.downgrade).toBe("parent-fits-content");
  });

  it("downgrades a fill child of a parent that hugs the same axis", () => {
    const parent = frame("p", { mode: "flex", direction: "row" }, [], { width: "fit-content" });
    const child = rect("r", { width: "fill" });
    const detail = resolveAxisDetail(child, parent, "width");
    expect(detail.mode).toBe("fit-content");
    expect(detail.downgrade).toBe("parent-fits-content");
  });

  it("keeps fill when the parent distributes that axis", () => {
    const parent = frame("p", { mode: "flex", direction: "row" });
    expect(resolveAxis(rect("r", { width: "fill" }), parent, "width")).toBe("fill");
    expect(resolveAxis(rect("r", { height: "fill" }), parent, "height")).toBe("fill");
  });

  it("never returns max-content on the height axis", () => {
    const el = { ...text("t", "hello"), sizing: { width: "max-content" as const } };
    const detail = resolveAxisDetail(el, null, "height");
    expect(detail.mode).toBe("fixed");
    expect(resolveAxis(el, null, "width")).toBe("max-content");
  });

  it("rejects fit-content on element types with no content", () => {
    const detail = resolveAxisDetail(rect("r", { width: "fit-content" }), null, "width");
    expect(detail.mode).toBe("fixed");
    expect(detail.downgrade).toBe("cannot-fit-content");
  });
});

describe("withAxisMode", () => {
  it("writes one axis and leaves the other alone", () => {
    const el = withAxisMode(rect("r", { width: "max-content" }), "height", "fill");
    expect(el.sizing).toEqual({ width: "max-content", height: "fill" });
  });

  it("writes the pin, because an unsaid axis is the container's to decide", () => {
    // Not `undefined`: with `fixed` spelled by the absence, a grid cell could not
    // tell an unsaid axis from a declared one and stretched both.
    const el = withAxisMode(rect("r", { width: "fill" }), "width", "fixed");
    expect(el.sizing).toEqual({ width: "fixed" });
  });

  it("leaves max-content off the height axis, as the height menu says", () => {
    const el = withAxisMode(rect("r", { width: "fill" }), "height", "max-content");
    expect(el.sizing).toEqual({ width: "fill" });
  });
});

describe("containerSizesAxis", () => {
  it("is the grid cell, for an axis the child left unsaid", () => {
    const grid = frame("g", { mode: "grid", columns: 2 }, [rect("r")]);
    expect(containerSizesAxis(grid.children[0], grid, "width")).toBe(true);
  });

  it("is false once the child pinned that axis", () => {
    const grid = frame("g", { mode: "grid", columns: 2 }, [rect("r", { width: "fixed" })]);
    expect(containerSizesAxis(grid.children[0], grid, "width")).toBe(false);
  });

  it("follows cellAlign and the child's own align-self", () => {
    const grid = frame("g", { mode: "grid", columns: 2, cellAlign: "start" }, [rect("r")]);
    expect(containerSizesAxis(grid.children[0], grid, "width")).toBe(false);
    const stretched = frame("g", { mode: "grid", columns: 2 }, [
      { ...rect("r"), "align-self": "stretch" as const }
    ]);
    expect(containerSizesAxis(stretched.children[0], stretched, "height")).toBe(true);
  });

  it("is the cross axis of a stack, which stretches by CSS's default", () => {
    const row = frame("f", { mode: "flex", direction: "row" }, [rect("r")]);
    // The main axis is never distributed to a child that did not ask for `fill`.
    expect(containerSizesAxis(row.children[0], row, "width")).toBe(false);
    // The cross axis is `align-items: stretch`, which is what CSS does when the
    // container says nothing — a row's height, a column's width.
    expect(containerSizesAxis(row.children[0], row, "height")).toBe(true);
    const column = frame("c", { mode: "flex", direction: "column" }, [rect("r2")]);
    expect(containerSizesAxis(column.children[0], column, "width")).toBe(true);
    expect(containerSizesAxis(column.children[0], column, "height")).toBe(false);
  });

  it("is false in a stack whose align-items says so", () => {
    const row = frame("f", { mode: "flex", direction: "row", align: "start" }, [rect("r")]);
    expect(containerSizesAxis(row.children[0], row, "height")).toBe(false);
  });
});

describe("element sizing constraints", () => {
  const doc = (elements: unknown[]) => ({
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: { width: 400, height: 400, unit: "px", background: { type: "solid", color: "#fff" } },
    elements
  });

  it("keeps a written-down fixed, which is the only way to keep a grid cell off", () => {
    const { document } = normalizeDesignDocument(
      doc([
        {
          id: "g",
          type: "frame",
          x: 0,
          y: 0,
          width: 400,
          height: 400,
          ...flattenLayout({ mode: "grid", columns: 2 }),
          children: [
            { id: "pinned", type: "rect", x: 0, y: 0, width: 50, height: 40, sizing: { width: "fixed" } },
            { id: "open", type: "rect", x: 0, y: 0, width: 50, height: 40 }
          ]
        }
      ])
    );
    const children = (getActivePage(document).children[0] as FrameElement).children;
    expect(children[0].sizing).toEqual({ width: "fixed" });
    expect(children[1].sizing).toBeUndefined();
  });
});

describe("frame self-hug tightens only the axes that ask for it", () => {
  it("leaves a fixed height alone when only the width hugs", () => {
    const el = frame(
      "f",
      { mode: "flex", direction: "row", gap: 10, padding: 10 },
      [rect("a"), rect("b")],
      { width: "fit-content" }
    );
    const res = applyAutoLayout(el);
    expect(res.width).toBe(10 + 50 + 10 + 50 + 10);
    expect(res.height).toBe(200);
  });

  it("hugs both axes when both ask for it", () => {
    const el = frame(
      "f",
      { mode: "flex", direction: "row", gap: 10, padding: 10, align: "start" },
      [rect("a"), rect("b")],
      { width: "fit-content", height: "fit-content" }
    );
    const res = applyAutoLayout(el);
    expect(res.width).toBe(130);
    expect(res.height).toBe(10 + 40 + 10);
  });

  it("gives a filled axis the parent's full extent, and leaves the other axis' hug to the child's own pass", () => {
    const parent = frame("p", { mode: "flex", direction: "row", padding: 0 }, [], undefined);
    const child = frame("c", { mode: "flex", direction: "row" }, [rect("a")], {
      width: "fill",
      height: "fit-content"
    });
    const laidOut = applyAutoLayout({ ...parent, width: 400, children: [child] });
    const placed = laidOut.children[0] as FrameElement;
    expect(placed.width).toBe(400);
    // A parent pass never resolves a container child's own hug; that happens
    // when the child is laid out in its own pass.
    expect(placed.height).toBe(200);
    expect(applyAutoLayout(placed).height).toBe(40);
  });
});

describe("text sizing", () => {
  it("derives height from the content when it declares fit-content", () => {
    const one = resolveElementSizing(text("t", "hello", { sizing: { height: "fit-content" } }));
    const two = resolveElementSizing(
      text("t", "hello\nhello\nhello", { sizing: { height: "fit-content" } })
    );
    expect(two.height).toBeGreaterThan(one.height);
  });

  it("leaves an authored box alone when both axes are fixed", () => {
    const el = text("t", "hello");
    expect(resolveElementSizing(el)).toBe(el);
  });

  it("wraps at the box width for fit-content, and never wraps for max-content", () => {
    const long = "the quick brown fox jumps over the lazy dog";
    const hugging = resolveElementSizing(
      text("t", long, { width: 100, height: 40, sizing: { height: "fit-content" } })
    );
    const single = resolveElementSizing(
      text("t", long, { width: 100, height: 40, sizing: { width: "max-content", height: "fit-content" } })
    );
    expect(hugging.width).toBe(100);
    expect(hugging.height).toBeGreaterThan(40);
    expect(single.width).toBeGreaterThan(100);
    expect(single.height).toBeLessThan(hugging.height);
  });

  it("lets a text child of a flex row measure itself against the content box", () => {
    const el = frame(
      "f",
      { mode: "flex", direction: "row", padding: 10 },
      [text("t", "Wrapped body copy that is far too long for a narrow frame.", { width: 40, height: 20, sizing: { height: "fit-content" } })],
      undefined
    );
    const res = applyAutoLayout(el);
    expect(res.children[0].height).toBeGreaterThan(20);
  });
});

describe("syncTextSizing", () => {
  const lineHeight = resolveDynamicLineHeight(20);

  it("bakes a hugged box onto a canvas-level text", () => {
    const el = text("t", "hello", { sizing: { width: "fit-content", height: "fit-content" } });
    const [synced] = syncTextSizing([el]) as TextElement[];
    expect(synced.width).toBe(5 * (20 * 0.6));
    expect(synced.height).toBe(lineHeight);
  });

  it("lets the box grow with the content instead of clamping to its own current width", () => {
    const short = text("t", "hi", { sizing: { width: "fit-content", height: "fit-content" } });
    const [grown] = syncTextSizing([short]) as TextElement[];
    const longer = text("t", "hi there, this is a much longer line", {
      width: grown.width,
      height: grown.height,
      sizing: { width: "fit-content", height: "fit-content" }
    });
    const [resynced] = syncTextSizing([longer]) as TextElement[];
    expect(resynced.width).toBeGreaterThan(grown.width);
  });

  it("leaves text owned by an auto-layout parent to the layout pass", () => {
    const child = text("t", "hello", { sizing: { height: "fit-content" } });
    const parent = frame("f", { mode: "flex", direction: "row" }, [child], undefined);
    const [syncedParent] = syncTextSizing([parent]) as FrameElement[];
    expect(syncedParent).toBe(parent);
    expect(syncedParent.children[0]).toBe(child);
  });

  it("still reaches text inside a plain frame", () => {
    const child = text("t", "hello", { sizing: { height: "fit-content" } });
    const parent = frame("f", undefined, [child]);
    const [syncedParent] = syncTextSizing([parent]) as FrameElement[];
    expect(syncedParent).not.toBe(parent);
    expect(syncedParent.children[0].height).toBe(lineHeight);
  });

  it("returns the same array when nothing needs measuring", () => {
    const elements = [rect("r"), text("t", "hello")];
    expect(syncTextSizing(elements)).toBe(elements);
  });
});

describe("max-content on a container", () => {
  // `max-content` reads as a text-only mode — the height axis downgrades it and
  // the text path measures it — so the layout pass never treated it as a hug and
  // a container that declared it kept its authored width. Every authoring route
  // offers the mode (schema, normalizer, size menu), so the silent outcome was
  // a container full of children stacked on each other.
  const run = (width: NonNullable<FrameElement["sizing"]>["width"]) => {
    const f = frame(
      "f",
      { mode: "flex", direction: "row", gap: 6 },
      [
        text("a", "Alpha", { width: 0, sizing: { width: "max-content", height: "fit-content" } }),
        text("b", "Beta", { width: 0, sizing: { width: "max-content", height: "fit-content" } })
      ],
      { width, height: "fit-content" }
    );
    return applyAutoLayout({ ...f, width: 0 } as FrameElement);
  };

  it("sizes a row to its content rather than leaving the authored zero", () => {
    const out = run("max-content");
    expect(out.width).toBeGreaterThan(0);
    // A non-wrapping container has no difference between the two modes.
    expect(out.width).toBe(run("fit-content").width);
  });

  it("places the children side by side inside that box", () => {
    const out = run("max-content");
    expect(out.children[1].x).toBeGreaterThan(out.children[0].x);
  });
});

/**
 * `sizing.minWidth` / `maxWidth` / `minHeight` / `maxHeight` — CSS's bounds, on
 * the sizes the layout pass DERIVES rather than on the number in the document.
 */
describe("size bounds", () => {
  const row = (a: RectElement["sizing"], b: RectElement["sizing"]) =>
    applyAutoLayout({
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 320,
      height: 40,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 0 }),
      children: [rect("a", a), rect("b", b)]
    } as FrameElement);

  it("stops a fill child at its max, and gives what it did not take to the other", () => {
    const out = row({ width: "fill", maxWidth: 120 }, { width: "fill" });
    // 320 − 8 gap = 312 to share; the bounded one takes 120 and the rest follows.
    expect(Math.round(out.children[0].width)).toBe(120);
    expect(Math.round(out.children[1].width)).toBe(192);
    expect(Math.round(out.children[1].x)).toBe(128);
  });

  it("leaves a bounded child alone where the bound does not bite", () => {
    const out = row({ width: "fill", maxWidth: 400 }, { width: "fill" });
    expect(out.children.map((c) => Math.round(c.width))).toEqual([156, 156]);
  });

  it("holds a fill child up to its min", () => {
    const out = row({ width: "fill", minWidth: 200 }, { width: "fill" });
    expect(Math.round(out.children[0].width)).toBe(200);
  });

  it("bounds a grid cell too, where a stretch would otherwise be the whole cell", () => {
    const out = applyAutoLayout({
      id: "g",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 100,
      ...flattenLayout({ mode: "grid", columns: 2, gap: 0, padding: 0 }),
      children: [
        { ...rect("a"), sizing: { maxWidth: 80 } },
        rect("b")
      ]
    } as FrameElement);
    // The bounded child stops at 80 inside a 150 cell and the rest of that cell
    // stays empty — the same as CSS, where a max-width does not hand its slack
    // to a sibling in the next cell.
    expect(Math.round(out.children[0].width)).toBe(80);
    expect(Math.round(out.children[1].width)).toBe(150);
  });

  it("floors a hugging container", () => {
    const out = applyAutoLayout({
      id: "h",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 0 }),
      sizing: { width: "fit-content", minWidth: 260 },
      children: [rect("a", { width: "fit-content" })]
    } as FrameElement);
    expect(Math.round(out.width)).toBe(260);
  });

  /**
   * LESSON 138: a bound has to be applied where the size is DERIVED, not where
   * it is written down. Flex applies it to the base size it distributes; grid
   * used to sum the raw child box into its hug extent and clamp only at
   * placement, so a hugging grid came out wider than the content it was
   * hugging — a frame sized to a child that is then painted narrower.
   */
  it("derives a hugging grid from the bounded width, not the stored one", () => {
    const out = applyAutoLayout({
      id: "g",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      ...flattenLayout({ mode: "grid", columns: 1, gap: 0, padding: 0 }),
      sizing: { width: "fit-content", height: "fit-content" },
      children: [{ id: "a", type: "rect", x: 0, y: 0, width: 300, height: 60, sizing: { maxWidth: 120, maxHeight: 30 } }]
    } as FrameElement);
    expect(Math.round(out.width)).toBe(120);
    expect(Math.round(out.height)).toBe(30);
  });

  it("derives a hugging grid row height from the bounded height", () => {
    const out = applyAutoLayout({
      id: "g",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      ...flattenLayout({ mode: "grid", columns: 1, gap: 0, padding: 0 }),
      sizing: { height: "fit-content" },
      children: [
        { id: "a", type: "rect", x: 0, y: 0, width: 100, height: 200, sizing: { maxHeight: 50 } },
        { id: "b", type: "rect", x: 0, y: 0, width: 100, height: 20 }
      ]
    } as FrameElement);
    // Row 0 is as tall as its bounded child (50), row 1 as its own (20).
    expect(Math.round(out.children[0].y + out.children[0].height)).toBe(50);
    expect(Math.round(out.height)).toBe(70);
  });

  it("resolves a grid child's size through the caller's resolver", () => {
    // An instance of a hugging master is stored at its authored box and paints
    // at its resolved one. `applyGridLayout` takes the resolver and used to
    // ignore it, so a hugging grid sized itself to the authored box while the
    // instance painted larger and spilled out of the frame (LESSON 71).
    const out = applyAutoLayout(
      {
        id: "g",
        type: "frame",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        ...flattenLayout({ mode: "grid", columns: 1, gap: 0, padding: 0 }),
        sizing: { height: "fit-content" },
        children: [{ id: "a", type: "rect", x: 0, y: 0, width: 100, height: 40 }]
      } as FrameElement,
      () => ({ width: 100, height: 92 })
    );
    expect(Math.round(out.height)).toBe(92);
  });

  it("settles a contradictory pair the way CSS does — the floor wins", () => {
    // CSS 2.1 §10.4 applies max-width first and min-width second, so 300 and 40
    // is 300 in a browser. Applying the floor first would make the ceiling win,
    // which is a difference nobody designs on purpose and everybody sees as a bug.
    const out = row({ width: "fill", minWidth: 300, maxWidth: 40 }, { width: "fill" });
    expect(Math.round(out.children[0].width)).toBe(300);
  });

  it("reads camelCase and kebab bounds, and names one that is not a length", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "1.0",
      canvas: { width: 400, height: 200, unit: "px" },
      elements: [
        { id: "a", type: "rect", width: 50, height: 40, sizing: { width: "fill", "max-width": "120" } },
        { id: "b", type: "rect", width: 50, height: 40, sizing: { minHeight: "tall" } }
      ]
    } as never);
    expect(getActivePage(document).children[0].sizing?.maxWidth).toBe(120);
    expect(getActivePage(document).children[1].sizing?.minHeight).toBeUndefined();
    expect(repairs.some((r) => r.path.endsWith("/sizing/minHeight"))).toBe(true);
  });
});
