import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, it, expect } from "vitest";
import { canonicalDocument, compactDocumentJson, documentJson } from "../src/core/document-json";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignDocument, DesignElement, Page } from "../src/core/dsl/types";

const canvas = {
  width: 1440,
  height: 900,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#101010" }
};

// A 1x1 transparent PNG: the point is only that `assets` carries a payload big
// enough that dropping it would be visible in the byte counts below.
const BITMAP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const master: DesignElement = {
  id: "cmp_card",
  type: "component",
  name: "Card",
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  visible: true,
  rotation: 0,
  opacity: 1,
  fills: [{ type: "solid", color: "#1c1c1c" }],
  children: [
    {
      id: "cmp_card_label",
      type: "text",
      name: "Label",
      x: 16,
      y: 16,
      width: 288,
      height: 24,
      content: "Card",
      style: {
        fontFamily: "Inter",
        fontSize: 16,
        color: "#ededed",
        align: "left",
        textDecoration: [],
        textOverflow: "clip"
      }
    }
  ]
};

const pageElements: DesignElement[] = [
  master,
  {
    id: "inst_1",
    type: "instance",
    name: "Card / Large",
    x: 40,
    y: 40,
    width: 320,
    height: 180,
    componentId: "cmp_card",
    visible: true,
    rotation: 0
  },
  {
    id: "hero",
    type: "frame",
    name: "Hero",
    x: 0,
    y: 0,
    width: 1440,
    height: 520,
    clipContent: true,
    borderRadius: 16,
    ...flattenLayout({ mode: "flex", direction: "column", gap: 24, padding: 32, align: "start", justify: "start" }),
    fills: [
      { type: "linear-gradient", angle: 90, from: "#2a1b00", to: "#101010" }
    ],
    children: [
      {
        id: "hero_title",
        type: "text",
        name: "Title",
        x: 32,
        y: 32,
        width: 800,
        height: 64,
        content: "Ship the document, not the file",
        style: { fontFamily: "Inter", fontSize: 48, fontWeight: 600, color: "#fafafa" },
        textStyleId: "text_display"
      }
    ]
  }
];

const page: Page = { id: "page_1", name: "Cover", canvas, children: pageElements };
const secondPage: Page = { id: "page_2", name: "Detail", canvas, children: [] };

function makeDoc(): DesignDocument {
  return {
    docId: "doc_fixture",
    version: LATEST_DOCUMENT_VERSION,
    id: "doc_fixture",
    name: "JSON fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    canvas,
    pages: [page, secondPage],
    activePageId: "page_1",
    elements: pageElements,
    styles: [
      { id: "text_display", name: "Display", type: "text", style: { fontFamily: "Inter", fontSize: 48, fontWeight: 600 } }
    ],
    assets: [{ id: "ast_hero", name: "hero.png", uri: BITMAP, width: 2048, height: 1024 }],
    fonts: [{ family: "Inter", weights: [400, 600] }]
  } as unknown as DesignDocument;
}

const readBack = (json: string): DesignDocument =>
  normalizeDesignDocument(JSON.parse(json)).document as DesignDocument;

describe("document JSON", () => {
  it("round-trips the live document through the canonical form", () => {
    expect(readBack(documentJson(makeDoc()))).toEqual(canonicalDocument(makeDoc()));
  });

  it("round-trips through the compact form — the invariant the feature rests on", () => {
    expect(readBack(compactDocumentJson(makeDoc()))).toEqual(canonicalDocument(makeDoc()));
  });

  it("keeps the asset payload, which a projection would silently drop", () => {
    const back = readBack(compactDocumentJson(makeDoc()));
    expect(back.assets?.[0]?.uri).toBe(BITMAP);
  });

  it("carries the tree only inside `pages`, in both forms", () => {
    expect(Object.keys(JSON.parse(documentJson(makeDoc())))).not.toContain("elements");
    expect(Object.keys(JSON.parse(compactDocumentJson(makeDoc())))).not.toContain("elements");
    expect(getActivePage(readBack(documentJson(makeDoc()))).children).toHaveLength(pageElements.length);
    expect(getActivePage(readBack(compactDocumentJson(makeDoc()))).children).toHaveLength(pageElements.length);
  });

  it("is materially smaller, because compact drops the whitespace", () => {
    const full = documentJson(makeDoc()).length;
    const compact = compactDocumentJson(makeDoc()).length;
    expect(compact).toBeLessThan(full);
    expect(full - compact).toBeGreaterThan(0);
  });

  it("expands fast-draft authoring shorthands (sizing, style, fills) with zero repairs", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: LATEST_DOCUMENT_VERSION,
      name: "Fast Draft Shorthands",
      canvas: { width: 1440, height: 900, background: "#0E0E10" },
      elements: [
        {
          id: "card_1",
          type: "frame",
          width: 360,
          sizing: "fixed hug",
          display: "flex",
          "flex-direction": "column",
          gap: 16,
          padding: "20 24",
          "align-items": "start",
          "justify-content": "space-between",
          borderRadius: 16,
          fills: ["#18181B"],
          children: [
            {
              id: "badge",
              type: "text",
              content: "FAST TRACK",
              sizing: "max-content",
              style: "600 11/1.0 Inter #E8A33D uppercase ls=1.5"
            },
            {
              id: "body",
              type: "text",
              content: "Zero-repair shorthand authoring for instant layout turnaround.",
              sizing: "fill hug",
              style: "400 14/1.5 Inter #A1A1AA"
            }
          ]
        },
        {
          id: "bento_grid",
          type: "frame",
          width: 1120,
          sizing: "fixed hug",
          display: "grid",
          "grid-template-columns": 3,
          gap: 24,
          padding: 32,
          "align-items": "stretch",
          fills: []
        }
      ]
    });

    expect(repairs).toEqual([]);
    const card = getActivePage(document).children[0] as any;
    expect(layoutOf(card)).toEqual({
      mode: "flex",
      direction: "column",
      gap: 16,
      padding: [20, 24, 20, 24],
      align: "start",
      justify: "space-between"
    });
    expect(card.sizing).toEqual({ width: "fixed", height: "fit-content" });
    expect(card.fills).toEqual([{ type: "solid", color: "#18181B" }]);

    const badge = card.children[0];
    expect(badge.sizing).toEqual({ width: "max-content", height: "fit-content" });
    expect(badge.style).toMatchObject({
      fontFamily: "Inter",
      fontSize: 11,
      fontWeight: 600,
      lineHeight: 1,
      color: "#E8A33D",
      textTransform: "uppercase",
      letterSpacing: 1.5
    });

    const grid = getActivePage(document).children[1] as any;
    expect(layoutOf(grid)).toEqual({
      mode: "grid",
      columns: 3,
      gap: 24,
      padding: 32,
      cellAlign: "stretch"
    });
  });
});