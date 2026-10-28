import { describe, it, expect } from "vitest";
import { sizeModeOptions } from "../src/ui/size-modes";
import { AutoLayout, FrameElement, RectElement, SizeMode, TextElement } from "../src/core/dsl/types";
import { flattenLayout } from "../src/core/dsl/layout-flat";

const rect: RectElement = { id: "r", type: "rect", x: 0, y: 0, width: 50, height: 40 };
const frameEl = (layout: AutoLayout | undefined, sizing?: FrameElement["sizing"]): FrameElement => ({
  id: "p",
  type: "frame",
  x: 0,
  y: 0,
  width: 400,
  height: 200,
  ...(layout ? flattenLayout(layout) : {}),
  ...(sizing ? { sizing } : {}),
  children: []
});
const text = (id: string): TextElement => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 20,
  content: "Hi",
  style: { fontFamily: "Inter", fontSize: 16, color: "#fff" }
});

const find = (opts: ReturnType<typeof sizeModeOptions>, mode: SizeMode) =>
  opts.find((o) => o.mode === mode)!;

describe("every axis explains every mode", () => {
  it("offers all four modes with a note on each axis", () => {
    for (const el of [rect, frameEl(undefined), text("t")]) {
      for (const axis of ["width", "height"] as const) {
        const opts = sizeModeOptions(el, null, axis);
        expect(opts.map((o) => o.mode)).toEqual(["fixed", "fit-content", "max-content", "fill"]);
        for (const opt of opts) {
          expect(opt.label.length).toBeGreaterThan(0);
          expect(opt.note.length).toBeGreaterThan(0);
          // A note that merely repeats the label teaches nothing.
          expect(opt.note).not.toBe(opt.label);
        }
      }
    }
  });

  it("tailors the hug note to what is hugging", () => {
    expect(sizeModeOptions(frameEl(undefined), null, "height")[1].note).toMatch(/children/i);
    expect(sizeModeOptions(text("t"), null, "width")[1].note).toMatch(/wrap|line/i);
  });
});

describe("a mode that would be substituted is shown as unavailable", () => {
  it("disables fill for anything with no auto-layout parent", () => {
    for (const parent of [null, frameEl(undefined)]) {
      const opts = sizeModeOptions(rect, parent, "width");
      const fill = find(opts, "fill");
      expect(fill.effective).toBe(false);
      expect(fill.reason).toMatch(/auto-layout|not inside/i);
    }
  });

  it("enables fill inside a stack and inside a grid", () => {
    const stack = frameEl({ mode: "flex", direction: "row" });
    const gridBoth = frameEl({ mode: "grid", columns: 2 });
    for (const parent of [stack, gridBoth]) {
      expect(find(sizeModeOptions(rect, parent, "width"), "fill").effective).toBe(true);
      expect(find(sizeModeOptions(rect, parent, "height"), "fill").effective).toBe(true);
    }
  });

  it("disables fill where the parent hugs that very axis", () => {
    const hugging = frameEl({ mode: "grid", columns: 2 }, { height: "fit-content" });
    const fillHeight = find(sizeModeOptions(rect, hugging, "height"), "fill");
    expect(fillHeight.effective).toBe(false);
    expect(fillHeight.reason).toMatch(/hugs/i);
  });

  it("disables max-content on the height axis and hug on contentless types", () => {
    const maxHeight = find(sizeModeOptions(text("t"), null, "height"), "max-content");
    expect(maxHeight.effective).toBe(false);
    expect(maxHeight.reason).toMatch(/max content/i);

    const hugWidth = find(sizeModeOptions(rect, null, "width"), "fit-content");
    expect(hugWidth.effective).toBe(false);
    expect(hugWidth.reason).toMatch(/no content/i);
  });

  it("always leaves fixed selectable", () => {
    expect(find(sizeModeOptions(rect, null, "width"), "fixed").effective).toBe(true);
  });
});

describe("a hug nothing can compute is shown as unavailable", () => {
  it("disables hug on a container with no auto layout", () => {
    const hug = find(sizeModeOptions(frameEl(undefined), null, "width"), "fit-content");
    expect(hug.effective).toBe(false);
    expect(hug.reason).toMatch(/auto-layout/i);
  });

  it("still enables hug on a container that does have one", () => {
    const hug = find(sizeModeOptions(frameEl({ mode: "flex", direction: "row" }), null, "width"), "fit-content");
    expect(hug.effective).toBe(true);
  });

  it("disables hug width on a grid whose columns come from that width", () => {
    const auto = frameEl({ mode: "grid", columnsMode: "auto", columnWidthMin: 100 });
    const hug = find(sizeModeOptions(auto, null, "width"), "fit-content");
    expect(hug.effective).toBe(false);
    expect(hug.reason).toMatch(/columns/i);

    // The height is unaffected: only the axis the column count depends on is dead.
    const hugHeight = find(sizeModeOptions(auto, null, "height"), "fit-content");
    expect(hugHeight.effective).toBe(true);
  });

  it("keeps hug width available for a grid with a fixed column count", () => {
    const fixed = frameEl({ mode: "grid", columns: 3 });
    expect(find(sizeModeOptions(fixed, null, "width"), "fit-content").effective).toBe(true);
  });

  it("disables hug on the main axis of a wrapping stack", () => {
    const rowWrap = frameEl({ mode: "flex", direction: "row", wrap: "wrap" });
    const hugWidth = find(sizeModeOptions(rowWrap, null, "width"), "fit-content");
    expect(hugWidth.effective).toBe(false);
    expect(hugWidth.reason).toMatch(/wrapping/i);

    // The cross axis (height) is unaffected: wrapping stacks hug their height
    const hugHeight = find(sizeModeOptions(rowWrap, null, "height"), "fit-content");
    expect(hugHeight.effective).toBe(true);
  });
});
