import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

const docWith = (el: Record<string, unknown>) => ({
  name: "Stroke stack",
  pages: [{ id: "p1", name: "Page 1", children: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10, ...el }] }]
});

const normalizeOne = (el: Record<string, unknown>) => {
  const { document: normalized } = normalizeDesignDocument(docWith(el));
  return normalized.pages[0].children[0] as any;
};

describe("a stroke stack", () => {
  it("keeps its authored order, bottom layer first", () => {
    const el = normalizeOne({
      strokes: [
        { color: "#111111", width: 1 },
        { color: "#222222", width: 2 }
      ]
    });
    expect(el.strokes.map((s: any) => s.color)).toEqual(["#111111", "#222222"]);
  });

  it("carries no mirror of its own — `strokes` is the only spelling", () => {
    // The engine used to also hand back a singular `stroke` holding the top of
    // the stack. A writer that read it back re-saved one stroke and lost the
    // rest, which is why the mirror is gone rather than merely unused.
    const el = normalizeOne({
      strokes: [
        { color: "#111111", width: 1 },
        { color: "#222222", width: 2 }
      ]
    });
    expect(el.stroke).toBeUndefined();
  });

  // Saved files go through normalization on every write, so a stack that did not
  // survive it unchanged would be silently rewritten on each save.
  it("is a fixed point under re-normalization", () => {
    const once = normalizeOne({
      strokes: [
        { color: "#111111", width: 1 },
        { color: "#222222", width: 2 }
      ]
    });
    const twice = normalizeOne({ strokes: once.strokes });
    expect(twice.strokes.map((s: any) => s.color)).toEqual(["#111111", "#222222"]);
    expect(twice.strokes.map((s: any) => s.width)).toEqual([1, 2]);
  });

  it("does not read the singular `stroke` it used to accept", () => {
    // Refused, not migrated: a document that writes `stroke` is naming a field
    // the dialect does not have, so it gets the same treatment as any other
    // unknown key — dropped, and reported at the key the author typed.
    const { document, repairs } = normalizeDesignDocument(
      docWith({ stroke: { color: "#111111", width: 3 } })
    );
    const el = document.pages[0].children[0] as any;
    expect(el.strokes).toBeUndefined();
    expect(
      repairs.some((r) => r.kind === "dropped-property" && r.path === "/pages/0/children/0/stroke")
    ).toBe(true);
  });
});
