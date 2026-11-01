import { describe, expect, it } from "vitest";
import { scopeValidate } from "../src/core/report-scope";
import type { CompileDiagnostic } from "../src/core/compile";

/**
 * A shot is cropped to one element; the verdicts it carries have to be cropped
 * with it, and nothing may be lost on the way.
 */

const doc = {
  version: "0.1",
  pages: [
    {
      id: "page",
      name: "Page",
      children: [
        {
          id: "s1",
          type: "frame",
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          children: [
            { id: "s1_title", type: "text", x: 20, y: 30, width: 300, height: 40, content: "A" },
            { id: "s1_sub", type: "text", x: 20, y: 80, width: 300, height: 20, content: "B" }
          ]
        },
        { id: "s2", type: "frame", x: 400, y: 0, width: 390, height: 844, children: [] }
      ]
    }
  ]
} as never;

const finding = (elementId: string | undefined, message = "x"): CompileDiagnostic => ({
  level: "warning",
  elementId,
  message
});

describe("which findings a cropped shot carries", () => {
  it("keeps the ones attributed to the element and its descendants", () => {
    const scoped = scopeValidate(doc, "s1", [finding("s1_title"), finding("s1_sub"), finding("s2")]);
    expect(scoped?.inScope.map((d) => d.elementId)).toEqual(["s1_title", "s1_sub"]);
    expect(scoped?.elsewhere.map((d) => d.elementId)).toEqual(["s2"]);
    expect(scoped?.elements).toBe(3);
  });

  it("keeps an unattributed document-level finding out of the crop, but published", () => {
    const scoped = scopeValidate(doc, "s1_title", [finding(undefined, "canvas"), finding("s1_title")]);
    expect(scoped?.inScope.map((d) => d.message)).toEqual(["x"]);
    expect(scoped?.elsewhere.map((d) => d.message)).toEqual(["canvas"]);
  });

  it("does not invent an owner for an id outside the subtree", () => {
    const scoped = scopeValidate(doc, "s1_title", [finding("s1_btn_label")]);
    expect(scoped?.inScope).toHaveLength(0);
    expect(scoped?.elsewhere).toHaveLength(1);
  });

  it("answers nothing for an id the document does not hold", () => {
    expect(scopeValidate(doc, "nope", [])).toBeNull();
  });

  it("is exact about the id, so a name that starts with another name is elsewhere", () => {
    const scoped = scopeValidate(doc, "s1_title", [finding("s1_title_extra")]);
    expect(scoped?.inScope).toHaveLength(0);
    expect(scoped?.elsewhere).toHaveLength(1);
  });
});
