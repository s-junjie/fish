import { describe, it, expect } from "vitest";
import { syncDocumentBindings } from "../src/core/interactions/style-ops";
import { canonicalDocument } from "../src/core/document-json";
import type { DesignDocument, DesignElement, TextElement } from "../src/core/dsl/types";

/**
 * A document that was AUTHORED rather than edited carries style ids and token
 * ids with no values beside them — normalize keeps the reference and copies
 * nothing, and the renderer paints `el.style` / `el.fills`, never the id. A
 * file written by hand or by an agent through the CLI used to open as Inter
 * 24px. These are the read paths that have to make the reference true.
 */

const doc = (children: DesignElement[], styles: DesignDocument["styles"], tokens: DesignDocument["tokens"]): DesignDocument =>
  ({
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 100, height: 100 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 100, height: 100 }, children }],
    activePageId: "page_1",
    styles,
    tokens
  } as unknown as DesignDocument);

describe("syncDocumentBindings", () => {
  it("puts a text style's declarations on the text that names it", () => {
    const before = doc(
      [{ id: "t1", type: "text", x: 0, y: 0, width: 200, height: 40, content: "Hello", textStyleId: "ts_display" } as unknown as DesignElement],
      [
        {
          id: "ts_display",
          name: "display",
          styleType: "text",
          style: { fontFamily: "Playfair Display", fontSize: 64, lineHeight: 1.1, letterSpacing: -1 }
        }
      ] as DesignDocument["styles"],
      []
    );

    const text = syncDocumentBindings(before).pages![0].children[0] as TextElement;
    expect(text.style?.fontFamily).toBe("Playfair Display");
    expect(text.style?.fontSize).toBe(64);
    expect(text.style?.lineHeight).toBe(1.1);
    expect(text.style?.letterSpacing).toBe(-1);
    // The binding survives: materialising is not detaching.
    expect(text.textStyleId).toBe("ts_display");
  });

  it("fills in a paint style and a colour token the same way", () => {
    const before = doc(
      [
        { id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10, fillStyleId: "sty_card" },
        { id: "r2", type: "rect", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#000000", tokenId: "tok_surface" }] }
      ] as unknown as DesignElement[],
      [{ id: "sty_card", name: "card", styleType: "paint", paints: [{ type: "solid", color: "#F5F0E8" }] }] as DesignDocument["styles"],
      [{ id: "tok_surface", name: "surface", type: "color", value: "#123456FF" }] as DesignDocument["tokens"]
    );

    const [r1, r2] = syncDocumentBindings(before).pages![0].children;
    expect((r1 as any).fills[0].color).toBe("#F5F0E8");
    expect((r2 as any).fills[0].color).toBe("#123456FF");
  });

  it("is idempotent — a second pass changes nothing", () => {
    const before = doc(
      [{ id: "t1", type: "text", x: 0, y: 0, width: 200, height: 40, content: "Hello", textStyleId: "ts_display" } as unknown as DesignElement],
      [{ id: "ts_display", name: "display", styleType: "text", style: { fontSize: 64 } }] as DesignDocument["styles"],
      []
    );
    const once = syncDocumentBindings(before);
    expect(syncDocumentBindings(once).pages![0].children[0]).toEqual(once.pages![0].children[0]);
  });

  it("leaves a layer with no reference exactly as it was", () => {
    const before = doc(
      [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#ABCDEF" }] } as unknown as DesignElement],
      [],
      []
    );
    expect(syncDocumentBindings(before).pages![0].children[0]).toBe(before.pages![0].children[0]);
  });
});

describe("canonicalDocument", () => {
  it("writes a text style out materialised, so the file paints it on reopen", () => {
    const before = doc(
      [{ id: "t1", type: "text", x: 0, y: 0, width: 200, height: 40, content: "Hello", textStyleId: "ts_display" } as unknown as DesignElement],
      [{ id: "ts_display", name: "display", styleType: "text", style: { fontFamily: "Playfair Display", fontSize: 64 } }] as DesignDocument["styles"],
      []
    );
    const text = canonicalDocument(before).pages![0].children[0] as TextElement;
    expect(text.style?.fontSize).toBe(64);
    expect(text.textStyleId).toBe("ts_display");
  });
});
