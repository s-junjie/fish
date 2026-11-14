import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { ColorToken, DesignDocument } from "../src/core/dsl/types";
import { switchDocumentTheme } from "../src/core/interactions/mode-ops";
import { removeTokenFromDoc, syncDocumentBindings, updateTokenInDoc } from "../src/core/interactions/style-ops";
import { validateTokenRefs } from "../src/core/validate-tokens";

function makeDoc(overrides: Partial<DesignDocument> = {}): DesignDocument {
  const surfaceToken: ColorToken = {
    id: "tok_surface",
    type: "color",
    name: "surface",
    value: "#F5F5F5",
    modes: { dark: "#181818" }
  };
  return {
    id: "doc_1",
    version: "0.1",
    name: "Canvas Token Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activePageId: "page_1",
    activeTheme: "light",
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" }
    ],
    tokens: [surfaceToken],
    canvas: {
      width: 800,
      height: 600,
      unit: "px",
      background: { type: "solid", color: "#F5F5F5", tokenId: "tok_surface" }
    },
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: {
          width: 800,
          height: 600,
          unit: "px",
          background: { type: "solid", color: "#F5F5F5", tokenId: "tok_surface" }
        },
        children: []
      }
    ],
    ...overrides
  };
}

describe("canvas background color token binding", () => {
  it("materializes updated token color onto doc.canvas and page.canvas", () => {
    const doc = makeDoc();
    const updatedToken: ColorToken = {
      id: "tok_surface",
      type: "color",
      name: "surface",
      value: "#EAEAEA",
      modes: { dark: "#222222" }
    };

    const next = updateTokenInDoc(doc, updatedToken);
    expect(next.canvas.background).toEqual({
      type: "solid",
      color: "#EAEAEA",
      tokenId: "tok_surface"
    });
    expect(next.pages?.[0].canvas?.background).toEqual({
      type: "solid",
      color: "#EAEAEA",
      tokenId: "tok_surface"
    });
  });

  it("updates canvas background color when switching activeTheme", () => {
    const doc = makeDoc();
    const darkDoc = switchDocumentTheme(doc, "dark");

    expect(darkDoc.activeTheme).toBe("dark");
    expect(darkDoc.canvas.background).toEqual({
      type: "solid",
      color: "#181818",
      tokenId: "tok_surface"
    });
    expect(darkDoc.pages?.[0].canvas?.background).toEqual({
      type: "solid",
      color: "#181818",
      tokenId: "tok_surface"
    });

    const lightDoc = switchDocumentTheme(darkDoc, "light");
    expect(lightDoc.canvas.background).toEqual({
      type: "solid",
      color: "#F5F5F5",
      tokenId: "tok_surface"
    });
  });

  it("syncDocumentBindings materializes stale canvas background colors", () => {
    const doc = makeDoc({
      canvas: {
        width: 800,
        height: 600,
        unit: "px",
        background: { type: "solid", color: "#000000", tokenId: "tok_surface" }
      },
      pages: [
        {
          id: "page_1",
          name: "Page 1",
          canvas: {
            width: 800,
            height: 600,
            unit: "px",
            background: { type: "solid", color: "#000000", tokenId: "tok_surface" }
          },
          children: []
        }
      ]
    });

    const synced = syncDocumentBindings(doc);
    expect(synced.canvas.background).toEqual({
      type: "solid",
      color: "#F5F5F5",
      tokenId: "tok_surface"
    });
    expect(synced.pages?.[0].canvas?.background).toEqual({
      type: "solid",
      color: "#F5F5F5",
      tokenId: "tok_surface"
    });
  });

  it("removeTokenFromDoc unbinds tokenId from canvas backgrounds while keeping materialized color", () => {
    const doc = makeDoc();
    const next = removeTokenFromDoc(doc, "tok_surface");

    expect(next.canvas.background).toEqual({
      type: "solid",
      color: "#F5F5F5"
    });
    expect(next.pages?.[0].canvas?.background).toEqual({
      type: "solid",
      color: "#F5F5F5"
    });
  });

  it("normalizes $token shorthand on document and page canvas.background", () => {
    const result = normalizeDesignDocument({
      version: "0.1",
      name: "Shorthand Canvas",
      activeTheme: "dark",
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" }
      ],
      tokens: [
        {
          id: "tok_bg",
          type: "color",
          name: "bg",
          value: "#FFFFFF",
          modes: { dark: "#121212" }
        }
      ],
      canvas: {
        width: 1080,
        height: 1080,
        unit: "px",
        background: "$bg"
      },
      pages: [
        {
          id: "page_1",
          name: "Page 1",
          canvas: {
            width: 1080,
            height: 1080,
            unit: "px",
            background: { type: "solid", color: "$bg" }
          },
          children: []
        }
      ]
    });

    expect(result.document.canvas.background).toEqual({
      type: "solid",
      color: "#121212",
      tokenId: "tok_bg"
    });
    expect(result.document.pages?.[0].canvas?.background).toEqual({
      type: "solid",
      color: "#121212",
      tokenId: "tok_bg"
    });
  });

  it("validateTokens reports dangling tokenId on canvas.background", () => {
    const doc = makeDoc({
      canvas: {
        width: 800,
        height: 600,
        unit: "px",
        background: { type: "solid", color: "#FFFFFF", tokenId: "tok_missing" }
      }
    });

    const issues = validateTokenRefs(doc);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("tok_missing") && i.message.includes("canvas.background"))).toBe(true);
  });
});
