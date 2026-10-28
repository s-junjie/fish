import { describe, it, expect } from "vitest";
import { computeSuggestionDiff, suggestionElementIds } from "../src/core/comments/diff";
import { placeCommentPopover } from "../src/core/comments/placement";
import type { DesignDocument } from "../src/core/dsl/types";

function doc(): DesignDocument {
  return {
    version: "0.1",
    id: "doc_diff",
    name: "Diff",
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    canvas: { width: 800, height: 600 },
    activePageId: "page_1",
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: { width: 800, height: 600 },
        children: [
          {
            id: "btn",
            type: "rect",
            name: "Button",
            x: 10,
            y: 10,
            width: 100,
            height: 40,
            borderRadius: 4,
            fills: [{ type: "solid", color: "#e5e5e5" }]
          }
        ]
      }
    ]
  } as DesignDocument;
}

describe("computeSuggestionDiff", () => {
  it("reads the changes off the document, not off the op payload", () => {
    const rows = computeSuggestionDiff(doc(), { pageId: "page_1", elementId: "btn" }, [
      { op: "patch", id: "btn", value: { width: 200, borderRadius: 8 } }
    ]);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey.width).toEqual({ key: "width", before: "100", after: "200" });
    expect(byKey.borderRadius).toEqual({ key: "borderRadius", before: "4", after: "8" });
    // Geometry that did not move is not a row.
    expect(byKey.height).toBeUndefined();
  });

  it("resolves CSS spellings the op runtime resolves, so the card cannot lie", () => {
    const rows = computeSuggestionDiff(doc(), { pageId: "page_1", elementId: "btn" }, [
      { op: "patch", id: "btn", value: { "border-radius": 12 } }
    ]);
    expect(rows.some((row) => row.key === "borderRadius" && row.after === "12")).toBe(true);
  });

  it("reports a paint change", () => {
    const rows = computeSuggestionDiff(doc(), { pageId: "page_1", elementId: "btn" }, [
      { op: "patch", id: "btn", value: { fills: [{ type: "solid", color: "#E8A33D" }] } }
    ]);
    const fill = rows.find((row) => row.key === "fills");
    expect(fill).toEqual({ key: "fills", before: "#E5E5E5", after: "#E8A33D" });
  });

  it("returns nothing when the ops do not land on the target", () => {
    expect(
      computeSuggestionDiff(doc(), { pageId: "page_1", elementId: "btn" }, [
        { op: "patch", id: "does_not_exist", value: { width: 200 } }
      ])
    ).toEqual([]);
    expect(computeSuggestionDiff(doc(), { pageId: "page_1", elementId: "missing" }, [
      { op: "patch", id: "btn", value: { width: 200 } }
    ])).toEqual([]);
  });

  it("touches the file's other page when the comment is on it", () => {
    const multi = doc();
    multi.pages.push({
      id: "page_2",
      name: "Page 2",
      canvas: multi.canvas,
      children: [
        { id: "btn", type: "rect", name: "Other button", x: 0, y: 0, width: 50, height: 50 } as never
      ]
    });
    // The ops land on the page the thread belongs to, not on the active one.
    const rows = computeSuggestionDiff(multi, { pageId: "page_2", elementId: "btn" }, [
      { op: "patch", id: "btn", value: { width: 90 } }
    ]);
    expect(rows).toEqual([{ key: "width", before: "50", after: "90" }]);
  });
});

describe("suggestionElementIds", () => {
  it("collects both spellings of an op target", () => {
    expect(
      suggestionElementIds([{ op: "patch", id: "a", value: {} }, { op: "patch", targetId: "b" }])
    ).toEqual(["a", "b"]);
  });
});

describe("placeCommentPopover", () => {
  const size = { width: 288, height: 200 };
  const viewport = { width: 1600, height: 1000 };

  it("opens to the right of a pin that has room", () => {
    expect(placeCommentPopover({ x: 400, y: 300 }, size, viewport)).toEqual({
      left: 420,
      top: 290,
      attachment: "right"
    });
  });

  it("flips to the left rather than sliding under the right rail", () => {
    const placement = placeCommentPopover({ x: 1400, y: 300 }, size, viewport);
    expect(placement.attachment).toBe("left");
    expect(placement.left).toBe(1400 - 20 - 288);
  });

  it("keeps a card on screen for a pin near the corner", () => {
    const placement = placeCommentPopover({ x: 1580, y: 990 }, size, viewport);
    // Flipped left, which puts it inside the window; the vertical axis has no
    // side to flip to, so that one is clamped.
    expect(placement.attachment).toBe("left");
    expect(placement.left).toBeLessThanOrEqual(1600 - 288 - 8);
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.top).toBe(1000 - 200 - 8);
  });
});
