import { describe, it, expect } from "vitest";
import { computeContentHash } from "../src/core/persistence/recovery";
import type { DesignDocument } from "../src/core/dsl/types";

function createTestDoc(): DesignDocument {
  return {
    docId: "doc_1",
    id: "doc_1",
    version: "0.1",
    name: "Test Document",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas: { width: 1000, height: 1000, unit: "px", background: { type: "solid", color: "#ffffff" } },
    elements: [],
    pages: [{ id: "p1", name: "Page 1", children: [] }]
  } as unknown as DesignDocument;
}

describe("unsaved changes beforeunload guard", () => {
  it("triggers beforeunload warning only when document has unsaved modifications", () => {
    const doc = createTestDoc();
    let savedHash = computeContentHash(doc);

    const isDirty = (currentDoc: DesignDocument) => computeContentHash(currentDoc) !== savedHash;

    const simulateBeforeUnload = (currentDoc: DesignDocument) => {
      let defaultPrevented = false;
      let returnValue = "";
      const event = {
        preventDefault: () => {
          defaultPrevented = true;
        },
        set returnValue(val: string) {
          returnValue = val;
        },
        get returnValue() {
          return returnValue;
        }
      } as unknown as BeforeUnloadEvent;

      if (isDirty(currentDoc)) {
        event.preventDefault();
        event.returnValue = "";
      }

      return { defaultPrevented, returnValue };
    };

    // 1. Initial document is clean -> no warning
    expect(isDirty(doc)).toBe(false);
    expect(simulateBeforeUnload(doc).defaultPrevented).toBe(false);

    // 2. Modified document -> dirty, triggers warning
    // The page is spread from the document's own, not spelled out: `Page`
    // carries the canvas too, and a literal here is a second copy of that
    // shape to fall behind the type.
    const modifiedDoc: DesignDocument = {
      ...doc,
      pages: [{ ...doc.pages[0], children: [{ id: "r1", type: "rect", x: 10, y: 10, width: 50, height: 50 } as any] }]
    };
    expect(isDirty(modifiedDoc)).toBe(true);
    const warned = simulateBeforeUnload(modifiedDoc);
    expect(warned.defaultPrevented).toBe(true);

    // 3. Saved -> clean, warning clears
    savedHash = computeContentHash(modifiedDoc);
    expect(isDirty(modifiedDoc)).toBe(false);
    expect(simulateBeforeUnload(modifiedDoc).defaultPrevented).toBe(false);

    // 4. Further edit -> dirty again
    const furtherEdit: DesignDocument = {
      ...modifiedDoc,
      pages: [{ ...modifiedDoc.pages[0], children: [{ id: "r1", type: "rect", x: 99, y: 10, width: 50, height: 50 } as any] }]
    };
    expect(isDirty(furtherEdit)).toBe(true);
    expect(simulateBeforeUnload(furtherEdit).defaultPrevented).toBe(true);

    // 5. Undo back to saved state -> clean
    expect(isDirty(modifiedDoc)).toBe(false);
    expect(simulateBeforeUnload(modifiedDoc).defaultPrevented).toBe(false);
  });
});
