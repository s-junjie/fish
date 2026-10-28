import { describe, it, expect } from "vitest";
import { parseDslClipboardText } from "../src/core/interactions/clipboard-dsl";

describe("parseDslClipboardText", () => {
  it("rejects non-json or non-dsl text", () => {
    expect(parseDslClipboardText("")).toBeNull();
    expect(parseDslClipboardText("hello world")).toBeNull();
    expect(parseDslClipboardText("{ foo: 'bar' }")).toBeNull();
    expect(parseDslClipboardText(JSON.stringify({ a: 1, b: 2 }))).toBeNull();
    expect(parseDslClipboardText(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  it("parses a single DesignElement object", () => {
    const rectJson = JSON.stringify({
      type: "rect",
      width: 100,
      height: 50,
      fills: [{ type: "solid", color: "#FF0000" }]
    });

    const res = parseDslClipboardText(rectJson);
    expect(res).not.toBeNull();
    expect(res!.elements.length).toBe(1);
    expect(res!.elements[0].type).toBe("rect");
    expect(res!.elements[0].width).toBe(100);
    expect(res!.elements[0].height).toBe(50);
  });

  it("parses an array of DesignElement objects", () => {
    const listJson = JSON.stringify([
      { type: "rect", width: 100, height: 50 },
      { type: "ellipse", width: 40, height: 40 }
    ]);

    const res = parseDslClipboardText(listJson);
    expect(res).not.toBeNull();
    expect(res!.elements.length).toBe(2);
    expect(res!.elements[0].type).toBe("rect");
    expect(res!.elements[1].type).toBe("ellipse");
  });

  it("parses a DesignDocument object with elements", () => {
    const docJson = JSON.stringify({
      version: "0.1",
      name: "Test Doc",
      canvas: { width: 800, height: 600, background: { type: "solid", color: "#FFFFFF" } },
      elements: [
        {
          id: "flower",
          type: "frame",
          width: 200,
          height: 200,
          children: [
            { type: "path", d: "M 0 0 L 10 10 Z" }
          ]
        }
      ]
    });

    const res = parseDslClipboardText(docJson);
    expect(res).not.toBeNull();
    expect(res!.elements.length).toBe(1);
    expect(res!.elements[0].type).toBe("frame");
    expect((res!.elements[0] as any).children.length).toBe(1);
  });
});
