import { describe, it, expect } from "vitest";
import {
  MAX_CLIPBOARD_CHARS,
  MAX_ELEMENT_DEPTH,
  MAX_IMPORTED_ELEMENTS,
  describeImportRefusal,
  refuseClipboardText,
  refuseElementTree,
  refuseFile
} from "../src/core/import/import-limits";

function deepTree(depth: number): { children: unknown[] } {
  let node: { children: unknown[] } = { children: [] };
  for (let i = 1; i < depth; i++) node = { children: [node] };
  return node;
}

describe("refuseClipboardText", () => {
  it("accepts a paste that fits", () => {
    expect(refuseClipboardText("x".repeat(1000))).toBeNull();
  });

  it("refuses a paste past the budget instead of letting it be parsed", () => {
    // 64 MB of text is one `JSON.parse` away from seconds of a stopped main
    // thread — there is no cancel, and nothing on screen to point at.
    expect(refuseClipboardText("x".repeat(MAX_CLIPBOARD_CHARS + 1))).toEqual({
      kind: "too-large",
      limit: MAX_CLIPBOARD_CHARS,
      actual: MAX_CLIPBOARD_CHARS + 1
    });
  });
});

describe("refuseFile", () => {
  it("accepts a real Figma export", () => {
    // One documented real export is 99.6 MB of inline base64. A ceiling below it
    // would refuse the case the import path exists for.
    expect(refuseFile(99_600_000)).toBeNull();
  });

  it("does not refuse a file whose size it cannot judge", () => {
    // A reader that cannot say how big something is does not get to block it:
    // the read itself is what will fail, and it will fail with a real message.
    expect(refuseFile(Number.NaN)).toBeNull();
  });
});

describe("refuseElementTree", () => {
  it("accepts an ordinary tree", () => {
    expect(
      refuseElementTree([
        { id: "a", children: [{ id: "b", children: [] }, { id: "c", fills: [{}, {}] }] }
      ])
    ).toBeNull();
  });

  it("refuses a tree that nests deeper than any recursive walk here can take", () => {
    expect(refuseElementTree([deepTree(MAX_ELEMENT_DEPTH + 1)])).toMatchObject({ kind: "too-deep" });
    expect(refuseElementTree([deepTree(MAX_ELEMENT_DEPTH)])).toBeNull();
  });

  it("refuses a tree with more layers than the walker will build", () => {
    const flat = Array.from({ length: MAX_IMPORTED_ELEMENTS + 1 }, (_, i) => ({ id: `e${i}` }));
    expect(refuseElementTree(flat)).toMatchObject({ kind: "too-many-elements" });
  });

  it("terminates on a tree that points at itself", () => {
    // Not reachable through `JSON.parse`, but `pasteFragmentIntoDoc` also takes
    // in-memory fragments, and a cycle there would hang this check instead of
    // the walker it stands in front of.
    const cyclic: { id: string; children: unknown[] } = { id: "a", children: [] };
    cyclic.children.push(cyclic);
    expect(refuseElementTree([cyclic])).toBeNull();
  });

  it("counts only `children`, so property arrays are not layers", () => {
    const wide = {
      id: "t",
      spans: Array.from({ length: MAX_IMPORTED_ELEMENTS + 1 }, (_, i) => ({ text: String(i) })),
      children: []
    };
    expect(refuseElementTree([wide])).toBeNull();
  });
});

describe("describeImportRefusal", () => {
  it("says which limit was broken, in the user's language rather than the key path", () => {
    const message = describeImportRefusal({ kind: "too-many-elements", limit: 20000, actual: 20001 });
    expect(message).toContain("20000");
    expect(message).not.toContain("importLimits.");
  });
});
