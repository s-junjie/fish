import { describe, expect, it } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import schema from "../src/core/dsl/fish.schema.json";
import { FLAT_LAYOUT_KEYS, flattenLayout, layoutOf, withLayout } from "../src/core/dsl/layout-flat";
import { FLAT_ROUTED_KEYS, FLAT_TO_FIELD } from "../src/core/dsl/normalize/flat-layout";
import { normalizeDesignDocument, CANONICAL_KEYS } from "../src/core/dsl/normalize";
import { canonicalKey } from "../src/core/dsl/normalize/shared";
import type { AutoLayout } from "../src/core/dsl/types";

/**
 * The stored flat layout vocabulary is written down in more than one place — the
 * erase in `withLayout`, the reader in `normalize/flat-layout.ts`, the
 * unknown-key gate in `element.ts`, the published schema — and each of them was
 * a hand copy. They agreed, but nothing made them agree: a key added to one left
 * the others silent, and the failures are the quiet kind (a key that survives
 * "remove auto layout" and returns later, or a `dropped-property` repair naming
 * a key the engine read).
 *
 * Everything below grades against `FLAT_LAYOUT_KEYS`, never against a copied
 * list: add a key there and every test that has nothing to say about it fails.
 */

/** One value that must survive for each stored key, and the mode that makes it legal. */
const SAMPLE: Record<string, { display: "flex" | "grid"; value: unknown }> = {
  display: { display: "flex", value: "flex" },
  "flex-direction": { display: "flex", value: "row" },
  "justify-content": { display: "flex", value: "center" },
  "align-items": { display: "flex", value: "center" },
  "align-content": { display: "flex", value: "center" },
  "flex-wrap": { display: "flex", value: "wrap" },
  gap: { display: "flex", value: 8 },
  "row-gap": { display: "flex", value: 4 },
  "column-gap": { display: "flex", value: 6 },
  padding: { display: "flex", value: 12 },
  "grid-template-columns": { display: "grid", value: 3 },
  "grid-template-rows": { display: "grid", value: 2 },
  "grid-auto-flow": { display: "grid", value: "column" },
  masonry: { display: "grid", value: true },
  "columns-mode": { display: "grid", value: "fixed" },
  "column-width-min": { display: "grid", value: 100 }
};

const frame = (el: Record<string, unknown>) => ({
  canvas: { width: 400, height: 300 },
  elements: [{ id: "f", type: "frame", x: 0, y: 0, width: 300, height: 200, children: [], ...el }]
});

/** A layout per mode that names every field `flattenLayout` can write. */
const LAYOUTS: AutoLayout[] = [
  {
    mode: "flex",
    direction: "row",
    gap: 8,
    rowGap: 4,
    columnGap: 6,
    padding: [1, 2, 3, 4],
    justify: "center",
    align: "end",
    alignContent: "space-between",
    wrap: "wrap"
  },
  {
    mode: "grid",
    gap: 8,
    padding: 12,
    columns: 3,
    rows: 2,
    cellAlign: "end",
    placement: "column",
    masonry: true,
    columnsMode: "fixed",
    columnWidthMin: 100
  },
  { mode: "grid", columnSizes: [100, { fr: 1 }], rowSizes: [{ fr: 2 }, 40] }
];

describe("the stored flat layout vocabulary", () => {
  it("has a sample for every key, so a new key cannot slip in unread", () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...FLAT_LAYOUT_KEYS].sort());
  });

  it("is read by normalization, not just accepted as a known name", () => {
    const failures = FLAT_LAYOUT_KEYS.flatMap((key) => {
      const { display, value } = SAMPLE[key];
      const res = normalizeDesignDocument(frame({ display, [key]: value }) as never);
      const el = getActivePage(res.document).children?.[0] as unknown as Record<string, unknown> | undefined;
      const repairs = res.repairs.filter((r) => r.path.endsWith(`/${key}`));
      if (repairs.length > 0) return [`${key}: ${repairs.map((r) => r.kind).join("|")}`];
      if (el?.[key] === undefined) return [`${key}: dropped without a repair`];
      return [];
    });
    expect(failures).toEqual([]);
  });

  it("is erased completely by withLayout(el, undefined)", () => {
    const el = Object.fromEntries(FLAT_LAYOUT_KEYS.map((key) => [key, SAMPLE[key].value]));
    expect(Object.keys(withLayout(el, undefined) as object)).toEqual([]);
  });

  it("is exactly what flattenLayout writes, and reads back unchanged", () => {
    for (const layout of LAYOUTS) {
      const flat = flattenLayout(layout);
      expect(
        Object.keys(flat).filter((key) => !FLAT_LAYOUT_KEYS.includes(key)),
        `${layout.mode}: written but not in FLAT_LAYOUT_KEYS`
      ).toEqual([]);
      expect(layoutOf(flat), `${layout.mode}: flatten/read is not a round trip`).toEqual(layout);
    }
  });

  it("is covered key-for-key by the reader's two tables", () => {
    const direct = FLAT_TO_FIELD.map(([key]) => key);
    expect(direct.filter((key) => FLAT_ROUTED_KEYS.includes(key)), "a key in both tables").toEqual([]);
    expect([...direct, ...FLAT_ROUTED_KEYS].sort()).toEqual([...FLAT_LAYOUT_KEYS].sort());
  });

  it("is declared by the schema and known to the unknown-key gate", () => {
    const declared = Object.keys(schema.definitions.DesignElement.properties);
    expect(FLAT_LAYOUT_KEYS.filter((key) => !declared.includes(key)), "stored but not in the schema").toEqual([]);
    const known = new Set([...CANONICAL_KEYS].map(canonicalKey));
    expect(
      FLAT_LAYOUT_KEYS.filter((key) => !known.has(canonicalKey(key))),
      "read by the engine but reported as an unknown property"
    ).toEqual([]);
  });
});
