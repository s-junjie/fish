import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, PathElement } from "../src/core/dsl/types";

/**
 * `fillRule` is the only key that decides whether a path's own subpaths count
 * as inside it, so it has to survive a load and reject a value it does not
 * know.
 *
 * What it does not do here is prove it reaches the screen under the name SVG
 * spells it with. That mapping belongs to `preact/compat`'s global `options`
 * hook, and importing compat to call it rewrites the props of *every* vnode in
 * the process — which, with `isolate: false` in the vitest config, breaks
 * `non-uniform-stroke.test.ts` whenever this file happens to load first. A real
 * browser is the only honest place to check it, so
 * `tests/e2e/svg-export.spec.mjs` does.
 */

const doc = (path: Record<string, unknown>): DesignDocument =>
  ({
    docId: "d",
    version: "0.1",
    name: "n",
    pages: [
      {
        id: "p1",
        name: "P1",
        children: [
          { id: "e", type: "path", x: 0, y: 0, width: 24, height: 24, d: "M0 0H24V24H0Z", ...path }
        ]
      }
    ]
  }) as unknown as DesignDocument;

const load = (path: Record<string, unknown>) =>
  normalizeDesignDocument(doc(path) as DesignDocument, { preserveUnknown: true });

const only = (result: { document: DesignDocument }): PathElement =>
  result.document.pages[0].children[0] as PathElement;

describe("fillRule", () => {
  it("keeps evenodd through a load", () => {
    expect(only(load({ fillRule: "evenodd" })).fillRule).toBe("evenodd");
  });

  it("stays absent when unset, so loading a document does not rewrite it", () => {
    expect("fillRule" in only(load({}))).toBe(false);
  });

  it("refuses the snake_case spelling, loudly", () => {
    // snake_case is neither of the dialect's two spellings (camelCase for the
    // DSL, kebab-case for CSS), so it is reported rather than half-read.
    const { document } = load({ fill_rule: "evenodd" });
    expect((document.pages[0].children[0] as PathElement).fillRule).toBeUndefined();
    const strict = normalizeDesignDocument(doc({ fill_rule: "evenodd" }) as DesignDocument);
    expect(
      strict.repairs.some((r) => r.kind === "dropped-property" && r.message.includes("fill_rule"))
    ).toBe(true);
  });

  it("reports a value outside the vocabulary instead of storing it", () => {
    const { document, repairs } = load({ fillRule: "winding" });
    expect((document.pages[0].children[0] as PathElement).fillRule).toBeUndefined();
    expect(repairs.some((r) => r.kind === "element" && r.path.endsWith("/fill-rule"))).toBe(true);
  });
});
