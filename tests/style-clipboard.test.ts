import { describe, it, expect } from "vitest";
import {
  applyCopiedStyle,
  copyStyleFrom,
  styleClipboard
} from "../src/core/interactions/style-clipboard";
import { RectElement, TextElement } from "../src/core/dsl/types";

const red: RectElement = {
  id: "a",
  type: "rect",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fills: [{ type: "solid", color: "#FF0000" }],
  strokes: [{ color: "#00FF00", width: 2 }],
  effects: [{ type: "layer-blur", blur: 4 }],
  borderRadius: 8,
  opacity: 0.5
};

describe("copy / paste properties", () => {
  it("carries the paint, not the geometry", () => {
    const copied = copyStyleFrom(red)!;
    const target: RectElement = { id: "b", type: "rect", x: 500, y: 500, width: 40, height: 40, rotation: 30 };
    const next = applyCopiedStyle(target, copied);

    const nextRect = next as RectElement;
    expect(nextRect.fills).toEqual(red.fills);
    expect(nextRect.strokes).toEqual(red.strokes);
    expect(nextRect.effects).toEqual(red.effects);
    expect(nextRect.borderRadius).toBe(8);
    expect(nextRect.opacity).toBe(0.5);
    // Geometry and identity are not properties.
    expect([next.x, next.y, next.width, next.height, next.rotation]).toEqual([500, 500, 40, 40, 30]);
    expect(next.id).toBe("b");
  });

  it("does not share paint objects with the source", () => {
    const next = applyCopiedStyle({ id: "b", type: "rect", x: 0, y: 0, width: 1, height: 1 }, copyStyleFrom(red)!);
    (next.fills as any[])[0].color = "#0000FF";
    expect((red.fills as any[])[0].color).toBe("#FF0000");
  });

  it("treats an empty paint stack as a decision, not as nothing to copy", () => {
    // `fills: []` means "no fill" (LESSONS §38) — pasting it has to clear the
    // target's fill, and the target's own absent field must stay absent.
    const cleared: RectElement = { id: "a", type: "rect", x: 0, y: 0, width: 1, height: 1, fills: [] };
    const copied = copyStyleFrom(cleared)!;
    expect(copied.fills).toEqual([]);

    const target: RectElement = { id: "b", type: "rect", x: 0, y: 0, width: 1, height: 1, fills: [{ type: "solid", color: "#123456" }] };
    expect(applyCopiedStyle(target, copied).fills).toEqual([]);
  });

  it("leaves fields the source had no opinion about alone", () => {
    const bare: RectElement = { id: "a", type: "rect", x: 0, y: 0, width: 1, height: 1, fills: [{ type: "solid", color: "#111111" }] };
    const copied = copyStyleFrom(bare)!;
    expect("effects" in copied).toBe(false);
    expect("borderRadius" in copied).toBe(false);

    const target: RectElement = { id: "b", type: "rect", x: 0, y: 0, width: 1, height: 1, effects: [{ type: "layer-blur", blur: 9 }], borderRadius: 3 };
    const next = applyCopiedStyle(target, copied) as RectElement;
    expect(next.effects).toEqual([{ type: "layer-blur", blur: 9 }]);
    expect(next.borderRadius).toBe(3);
  });

  it("returns null for a layer with nothing to copy", () => {
    expect(copyStyleFrom({ id: "a", type: "rect", x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    expect(copyStyleFrom(null)).toBeNull();
  });

  it("merges typography onto a text without blanking what it did not author", () => {
    const source: TextElement = {
      id: "a",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hello",
      style: { fontFamily: "Inter", fontSize: 24, color: "#FFFFFF" }
    };
    const target: TextElement = {
      id: "b",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hello",
      style: { fontFamily: "Georgia", fontSize: 12, letterSpacing: 2, color: "#000000" }
    };
    const next = applyCopiedStyle(target, copyStyleFrom(source)!) as TextElement;
    expect(next.style).toEqual({ fontFamily: "Inter", fontSize: 24, letterSpacing: 2, color: "#FFFFFF" });
  });

  it("ignores typography on a shape, which has nowhere to put it", () => {
    const source: TextElement = {
      id: "a",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      content: "Hello",
      style: { fontFamily: "Inter", fontSize: 24, color: "#FFFFFF" }
    };
    const next = applyCopiedStyle({ id: "b", type: "rect", x: 0, y: 0, width: 1, height: 1 }, copyStyleFrom(source)!);
    expect((next as unknown as Record<string, unknown>).style).toBeUndefined();
  });

  it("holds one payload at a time, the way the file clipboard does", () => {
    styleClipboard.write(null);
    expect(styleClipboard.has()).toBe(false);
    styleClipboard.write(copyStyleFrom(red));
    expect(styleClipboard.has()).toBe(true);
    expect(styleClipboard.read()!.fills).toEqual(red.fills);
    styleClipboard.write(null);
  });
});
