import { describe, expect, it } from "vitest";
import {
  addDocumentMode,
  addDocumentNumberMode,
  deleteDocumentMode,
  deleteDocumentNumberMode,
  getActiveNumberMode,
  getActiveTheme,
  getColorTokenModeColor,
  getDocumentModes,
  getDocumentNumberModes,
  getElementInheritedNumberMode,
  getElementInheritedTheme,
  getNumberTokenModeValue,
  renameDocumentMode,
  setElementNumberMode,
  setElementThemeMode,
  switchDocumentNumberMode,
  switchDocumentTheme,
  updateColorTokenWithModes,
  updateNumberTokenWithModes
} from "../src/core/interactions/mode-ops";
import { countStyleUses, countTokenUses, createColorToken } from "../src/core/interactions/token-ops";
import { countNumberTokenUses, createNumberToken } from "../src/core/interactions/number-token-ops";
import { updateTokenInDoc } from "../src/core/interactions/style-ops";
import {
  DesignDocument,
  DesignElement,
  FrameElement,
  Paint,
  PaintStyle,
  RectElement,
  TextElement,
  TextStyleDefinition
} from "../src/core/dsl/types";

describe("mode-ops token value extraction and updates", () => {
  it("defaults active theme to default", () => {
    const doc = { id: "d", name: "Doc" } as any;
    expect(getActiveTheme(doc)).toBe("default");
    expect(getActiveTheme({ ...doc, activeTheme: "dark" })).toBe("dark");
  });

  it("extracts color token values per mode with fallback", () => {
    let token = createColorToken("bg/card", "#FFFFFF");
    token = updateColorTokenWithModes(token, "bg/card", "#FFFFFF", "#1E1E20");

    expect(getColorTokenModeColor(token, "default")).toBe("#FFFFFF");
    expect(getColorTokenModeColor(token, "dark")).toBe("#1E1E20");
    // Undefined custom mode falls back to default
    expect(getColorTokenModeColor(token, "high-contrast")).toBe("#FFFFFF");

    // The mode read IS the value: a colour token has no paint stack to unwrap.
    expect(token.value).toBe("#FFFFFF");
    expect(token.modes?.dark).toBe("#1E1E20");
  });

  it("extracts number token values per mode with fallback", () => {
    let token = createNumberToken("space/md", 16, "spacing");
    token = updateNumberTokenWithModes(token, "space/md", "spacing", 16, 12);

    expect(getNumberTokenModeValue(token, "default")).toBe(16);
    expect(getNumberTokenModeValue(token, "dark")).toBe(12);
    // Undefined mode falls back to default value
    expect(getNumberTokenModeValue(token, "compact")).toBe(16);
  });

  it("supports dynamic modes dictionary in updateColorTokenWithModes and updateNumberTokenWithModes", () => {
    let colorToken = createColorToken("brand", "#0055FF");
    colorToken = updateColorTokenWithModes(colorToken, "brand", "#0055FF", {
      dark: "#3388FF",
      cyberpunk: "#00FFCC"
    });
    expect(getColorTokenModeColor(colorToken, "default")).toBe("#0055FF");
    expect(getColorTokenModeColor(colorToken, "dark")).toBe("#3388FF");
    expect(getColorTokenModeColor(colorToken, "cyberpunk")).toBe("#00FFCC");

    let numToken = createNumberToken("gap", 8, "spacing");
    numToken = updateNumberTokenWithModes(numToken, "gap", "spacing", 8, {
      dark: 12,
      compact: 4
    });
    expect(getNumberTokenModeValue(numToken, "default")).toBe(8);
    expect(getNumberTokenModeValue(numToken, "dark")).toBe(12);
    expect(getNumberTokenModeValue(numToken, "compact")).toBe(4);
  });
});

describe("document custom modes management", () => {
  it("defaults modes to default if not specified on document", () => {
    const doc = { id: "d1", name: "Test" } as DesignDocument;
    const modes = getDocumentModes(doc);
    expect(modes).toEqual([
      { id: "default", name: "Default" }
    ]);
  });

  it("adds, renames, and deletes custom modes", () => {
    let doc = { id: "d1", name: "Test" } as DesignDocument;
    const { doc: docWithMode, mode } = addDocumentMode(doc, "Cyberpunk");
    expect(docWithMode.modes?.length).toBe(2);
    expect(docWithMode.modes?.[1].name).toBe("Cyberpunk");
    expect(mode.id).toBeDefined();

    const renamedDoc = renameDocumentMode(docWithMode, mode.id, "Neon Cyberpunk");
    expect(renamedDoc.modes?.find((m) => m.id === mode.id)?.name).toBe("Neon Cyberpunk");

    // Switching active theme to custom mode, then deleting it should revert active theme to default
    const activeCustomDoc = { ...renamedDoc, activeTheme: mode.id };
    const afterDelete = deleteDocumentMode(activeCustomDoc, mode.id);
    expect(afterDelete.modes?.some((m) => m.id === mode.id)).toBe(false);
    expect(afterDelete.activeTheme).toBe("default");

    // Attempting to delete when only 1 mode remains is prohibited
    const cantDeleteLast = deleteDocumentMode(afterDelete, "default");
    expect(cantDeleteLast.modes?.length).toBe(1);
    expect(cantDeleteLast.modes?.[0].id).toBe("default");

    // Deleting the base mode ("default") when another mode exists promotes next mode to base
    const multiDoc = {
      ...doc,
      modes: [
        { id: "default", name: "Default" },
        { id: "dark", name: "Dark" }
      ]
    };
    const afterDeleteBase = deleteDocumentMode(multiDoc, "default");
    expect(afterDeleteBase.modes?.length).toBe(1);
    expect(afterDeleteBase.modes?.[0].id).toBe("dark");
  });
});

describe("switchDocumentTheme and active-theme token updates", () => {
  it("switches theme and cascades across fills, strokes (tokenId), effects, layout, and composite styles", () => {
    let bgToken = createColorToken("bg/canvas", "#FFFFFF");
    bgToken = updateColorTokenWithModes(bgToken, "bg/canvas", "#FFFFFF", "#0A0A0A");

    let radiusToken = createNumberToken("radius/base", 8, "radius");
    radiusToken = updateNumberTokenWithModes(radiusToken, "radius/base", "radius", 8, 4);

    let gapToken = createNumberToken("space/sm", 16, "spacing");
    gapToken = updateNumberTokenWithModes(gapToken, "space/sm", "spacing", 16, 24);

    const cardStyle: PaintStyle = {
      id: "s_card",
      name: "surface/card",
      styleType: "paint",
      paints: [{ type: "solid", color: "#FFFFFF", tokenId: bgToken.id }]
    };

    const textStyle: TextStyleDefinition = {
      id: "s_text",
      name: "body",
      styleType: "text",
      style: {
        fontFamily: "Inter",
        fontSize: 8,
        tokenBindings: {
          fontSize: radiusToken.id
        }
      }
    };

    const rect: RectElement = {
      id: "r1",
      type: "rect",
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      borderRadius: 8,
      tokenBindings: {
        borderRadius: radiusToken.id
      },
      fills: [
        {
          type: "solid",
          color: "#FFFFFF",
          tokenId: bgToken.id
        }
      ],
      strokes: [
        {
          color: "#FFFFFF",
          tokenId: bgToken.id,
          width: 1
        },
        {
          /* A free row: no token, no style — a theme switch must leave it alone. */
          color: "#FFFFFF",
          width: 2
        }
      ],
      effects: [
        {
          type: "drop-shadow",
          color: "#FFFFFF",
          tokenId: bgToken.id,
          offset: { x: 0, y: 2 },
          blur: 4
        }
      ]
    };

    const textEl: TextElement = {
      id: "t1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      content: "Themed Heading",
      textStyleId: textStyle.id,
      style: {
        fontFamily: "Inter",
        color: "#000000",
        fontSize: 8
      }
    };

    const frame: FrameElement = {
      id: "f1",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      display: "flex",
      "flex-direction": "row",
      gap: 16,
      tokenBindings: {
        gap: gapToken.id
      },
      children: [rect, textEl]
    };

    const canvasBg: Paint = { type: "solid", color: "#FFFFFF" };

    const doc: DesignDocument = {
      id: "doc1",
      name: "Doc",
      version: "0.1",
      createdAt: "",
      updatedAt: "",
      canvas: { background: canvasBg, unit: "px" },
      activePageId: "p1",
      numberModes: [
        { id: "default", name: "Default" },
        { id: "dark", name: "Dark" }
      ],
      tokens: [bgToken, radiusToken, gapToken],
      styles: [cardStyle, textStyle],
      pages: [
        {
          id: "p1",
          name: "Page 1",
          canvas: { background: canvasBg, unit: "px" },
          children: [frame]
        }
      ]
    };

    expect(countNumberTokenUses(doc, radiusToken.id)).toBe(2);
    // fill + stroke + effect on the rect, plus the paint style's bound paint.
    expect(countTokenUses(doc, bgToken.id)).toBe(4);
    expect(countTokenUses(doc, gapToken.id)).toBe(1);
    expect(countStyleUses(doc, textStyle.id)).toBe(1);
    // Nothing points at `cardStyle`: a style's id is only nameable by the
    // `*StyleId` field of its own kind.
    expect(countStyleUses(doc, cardStyle.id)).toBe(0);

    // Switch the COLOUR axis to dark. The number axis stays where it was — a
    // brightness change is not a density change, which is the whole point.
    const darkDoc = switchDocumentTheme(doc, "dark");
    expect(darkDoc.activeTheme).toBe("dark");
    expect(getActiveNumberMode(darkDoc)).toBe("default");

    const darkFrame = darkDoc.pages[0].children[0] as FrameElement;
    const darkRect = darkFrame.children[0] as RectElement;
    const darkText = darkFrame.children[1] as TextElement;

    // Fills, the token-bound stroke and effects repainted with dark color
    expect((darkRect.fills?.[0] as { color: string }).color).toBe("#0A0A0A");
    expect(darkRect.strokes?.[0].color).toBe("#0A0A0A");
    // The free row keeps the colour it names — no token, no style, no cascade.
    expect(darkRect.strokes?.[1].color).toBe("#FFFFFF");
    expect((darkRect.effects?.[0] as any).color).toBe("#0A0A0A");

    // …and every number keeps the base value it was authored with.
    expect(darkRect.borderRadius).toBe(8);
    expect(darkFrame.gap).toBe(16);
    expect(darkText.style.fontSize).toBe(8);

    // Switch the NUMBER axis: elements, the composite text style and layout follow.
    const compactDoc = switchDocumentNumberMode(darkDoc, "dark");
    expect(compactDoc.activeNumberMode).toBe("dark");
    expect(compactDoc.activeTheme).toBe("dark");
    const numFrame = compactDoc.pages[0].children[0] as FrameElement;
    const numRect = numFrame.children[0] as RectElement;
    const numText = numFrame.children[1] as TextElement;
    expect(numRect.borderRadius).toBe(4);
    expect(numFrame.gap).toBe(24);
    expect(numText.style.fontSize).toBe(4);
    // The colour axis did not move with it.
    expect((numRect.fills?.[0] as { color: string }).color).toBe("#0A0A0A");

    // Editing a token's dark value while in dark mode updates the canvas with the new dark value (not light)
    const editedBgToken = updateColorTokenWithModes(bgToken, "bg/canvas", "#FFFFFF", "#18181B");
    const afterDarkEdit = updateTokenInDoc(compactDoc, editedBgToken);
    const rectAfterDarkEdit = (afterDarkEdit.pages[0].children[0] as FrameElement).children[0] as RectElement;
    expect((rectAfterDarkEdit.fills?.[0] as { color: string }).color).toBe("#18181B");

    // Switch both axes back to their bases
    const lightDoc = switchDocumentNumberMode(switchDocumentTheme(afterDarkEdit, "light"), "default");
    expect(lightDoc.activeTheme).toBe("light");
    const lightRect = (lightDoc.pages[0].children[0] as FrameElement).children[0] as RectElement;
    expect((lightRect.fills?.[0] as { color: string }).color).toBe("#FFFFFF");
    expect(lightRect.borderRadius).toBe(8);
  });

  it("handles container-level overrides on both axes, and their inheritance", () => {
    let bgToken = createColorToken("card/bg", "#FFFFFF");
    bgToken = updateColorTokenWithModes(bgToken, "card/bg", "#FFFFFF", "#121212");

    let radiusToken = createNumberToken("card/radius", 12, "radius");
    radiusToken = updateNumberTokenWithModes(radiusToken, "card/radius", "radius", 12, { compact: 6 });

    const childRect: RectElement = {
      id: "childRect",
      type: "rect",
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      borderRadius: 12,
      tokenBindings: { borderRadius: radiusToken.id },
      fills: [{ type: "solid", color: "#FFFFFF", tokenId: bgToken.id }]
    };

    const cardFrame: FrameElement = {
      id: "cardFrame",
      type: "frame",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [{ type: "solid", color: "#FFFFFF", tokenId: bgToken.id }],
      children: [childRect]
    };

    const doc: DesignDocument = {
      id: "doc2",
      name: "Doc2",
      version: "0.1",
      createdAt: "",
      updatedAt: "",
      canvas: { background: { type: "solid", color: "#F0F0F0" }, unit: "px" },
      activePageId: "p1",
      activeTheme: "light",
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" }
      ],
      numberModes: [
        { id: "light", name: "Light" },
        { id: "compact", name: "Compact" }
      ],
      tokens: [bgToken, radiusToken],
      pages: [
        {
          id: "p1",
          name: "Page 1",
          canvas: { background: { type: "solid", color: "#F0F0F0" }, unit: "px" },
          children: [cardFrame]
        }
      ],
      elements: [cardFrame]
    };

    const tables = { tokens: [bgToken, radiusToken], styles: [] };

    // Initially inherits the document's active modes on both axes
    expect(getElementInheritedTheme(doc, "cardFrame")).toBe("light");
    expect(getElementInheritedTheme(doc, "childRect")).toBe("light");
    expect(getElementInheritedNumberMode(doc, "cardFrame")).toBe("light");
    expect(getElementInheritedNumberMode(doc, "childRect")).toBe("light");

    // Override the container's COLOUR mode only: the palette flips, the spacing
    // does not — the two axes are independent fields on the same node.
    const darkContainer = setElementThemeMode(cardFrame, "dark", tables, "light", "light") as FrameElement;
    expect(darkContainer.themeMode).toBe("dark");
    expect(darkContainer.numberMode).toBeUndefined();
    expect((darkContainer.fills?.[0] as { color: string }).color).toBe("#121212");
    const darkChild = darkContainer.children[0] as RectElement;
    expect((darkChild.fills?.[0] as { color: string }).color).toBe("#121212");
    expect(darkChild.borderRadius).toBe(12);

    // Now the NUMBER mode on the same frame: the radius moves, the colours stay
    // exactly where the colour override put them.
    const compactDark = setElementNumberMode(darkContainer, "compact", tables, "light", "light") as FrameElement;
    expect(compactDark.themeMode).toBe("dark");
    expect(compactDark.numberMode).toBe("compact");
    expect((compactDark.fills?.[0] as { color: string }).color).toBe("#121212");
    expect((compactDark.children[0] as RectElement).borderRadius).toBe(6);

    // Document with the container override in place
    const docWithDarkCard: DesignDocument = {
      ...doc,
      pages: [{ ...doc.pages[0], children: [compactDark] }],
      elements: [compactDark]
    };
    expect(getElementInheritedTheme(docWithDarkCard, "childRect")).toBe("dark");
    expect(getElementInheritedNumberMode(docWithDarkCard, "childRect")).toBe("compact");

    // Switching the document's colour axis preserves the pinned pair
    const allDarkDoc = switchDocumentTheme(docWithDarkCard, "dark");
    const cardInAllDark = allDarkDoc.pages[0].children[0] as FrameElement;
    expect(cardInAllDark.themeMode).toBe("dark");
    expect((cardInAllDark.fills?.[0] as { color: string }).color).toBe("#121212");

    // Resetting each axis returns only its own half to inherited
    const resetNumber = setElementNumberMode(compactDark, undefined, tables, "light", "light") as FrameElement;
    expect(resetNumber.numberMode).toBeUndefined();
    expect(resetNumber.themeMode).toBe("dark");
    expect((resetNumber.children[0] as RectElement).borderRadius).toBe(12);

    const resetContainer = setElementThemeMode(resetNumber, undefined, tables, "light", "light") as FrameElement;
    expect(resetContainer.themeMode).toBeUndefined();
    expect((resetContainer.fills?.[0] as { color: string }).color).toBe("#FFFFFF");
    expect((resetContainer.children[0] as RectElement).borderRadius).toBe(12);
  });
});

describe("deleting the base mode promotes the next mode's value", () => {
  const doc = (tokens: unknown[], children: DesignElement[] = []): DesignDocument => ({
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "",
    updatedAt: "",
    canvas: { unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    activePageId: "p",
    modes: [
      { id: "default", name: "Default" },
      { id: "dark", name: "Dark" }
    ],
    numberModes: [
      { id: "default", name: "Default" },
      { id: "dark", name: "Dark" }
    ],
    tokens: tokens as DesignDocument["tokens"],
    pages: [{ id: "p", name: "P", canvas: { unit: "px", background: { type: "solid", color: "#FFFFFF" } }, children }],
    elements: children
  });

  it("promotes the surviving mode into token.value instead of stranding it in modes", () => {
    const color = { ...createColorToken("bg", "#FFFFFF"), modes: { dark: "#0A0A0A" } };
    const number = { ...createNumberToken("gap", 16, "spacing"), modes: { dark: 24 } };

    const out = deleteDocumentMode(doc([color, number]), "default");

    const [nextColor, nextNumber] = out.tokens as Array<{ value: string | number; modes?: unknown }>;
    // The BASE mode's value lives in `value`, not in `modes.default`, so the
    // guard on `modeId in modes` used to skip the very case it was written for.
    expect(nextColor.value).toBe("#0A0A0A");
    expect(nextColor.modes).toBeUndefined();
    expect(out.modes?.map((m) => m.id)).toEqual(["dark"]);

    // A COLOUR mode is not a number mode: the number token's stack is untouched.
    expect(nextNumber.value).toBe(16);
    expect(nextNumber.modes).toEqual({ dark: 24 });
  });

  it("promotes on the NUMBER axis, and leaves the colour table alone", () => {
    const color = { ...createColorToken("bg", "#FFFFFF"), modes: { dark: "#0A0A0A" } };
    const number = { ...createNumberToken("gap", 16, "spacing"), modes: { dark: 24 } };

    const out = deleteDocumentNumberMode(doc([color, number]), "default");

    const [nextColor, nextNumber] = out.tokens as Array<{ value: string | number; modes?: unknown }>;
    expect(nextNumber.value).toBe(24);
    expect(nextNumber.modes).toBeUndefined();
    expect(out.numberModes?.map((m) => m.id)).toEqual(["dark"]);
    expect(out.modes?.map((m) => m.id)).toEqual(["default", "dark"]);
    expect(nextColor.value).toBe("#FFFFFF");
    expect(nextColor.modes).toEqual({ dark: "#0A0A0A" });
  });

  it("keeps the two axes' mode lists independent when one is added", () => {
    const base = doc([]);
    const { doc: withOled, mode } = addDocumentMode(base, "OLED");
    // A readable id, because an id is what a CSS export writes into a selector.
    expect(mode.id).toBe("oled");
    expect(withOled.modes?.map((m) => m.id)).toEqual(["default", "dark", "oled"]);
    expect(getDocumentNumberModes(withOled).map((m) => m.id)).toEqual(["default", "dark"]);

    const { doc: withCompact } = addDocumentNumberMode(base, "Compact");
    expect(getDocumentNumberModes(withCompact).map((m) => m.id)).toEqual([
      "default",
      "dark",
      "compact"
    ]);
    expect(withCompact.modes?.map((m) => m.id)).toEqual(["default", "dark"]);
    expect(getActiveNumberMode(withCompact)).toBe("default");
  });

  it("re-materializes the layers in the same commit as the promotion", () => {
    const color = { ...createColorToken("bg", "#FFFFFF"), modes: { dark: "#0A0A0A" } };
    const rect = {
      id: "r",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fills: [{ type: "solid", color: "#FFFFFF", tokenId: color.id }]
    } as RectElement;

    const out = deleteDocumentMode(doc([color], [rect]), "default");
    const layer = out.pages[0].children[0] as RectElement;
    expect((layer.fills?.[0] as { color: string }).color).toBe("#0A0A0A");
  });

  it("leaves a token that follows neither mode untouched", () => {
    const plain = createColorToken("plain", "#123456");
    const out = deleteDocumentMode(doc([plain]), "default");
    expect((out.tokens![0] as { value: string }).value).toBe("#123456");
  });
});

describe("updateColorTokenWithModes alpha handling", () => {
  it("clears the encoded alpha when opacity is reset to 1", () => {
    const token = createColorToken("scrim", "#2563EBcc");
    const out = updateColorTokenWithModes(token, "scrim", "#2563EBcc", undefined, undefined, 1);
    expect(out.value).toBe("#2563eb");
  });

  it("keeps each mode's own alpha instead of folding the base opacity into it", () => {
    const token = createColorToken("fade", "#2563EB");
    const out = updateColorTokenWithModes(token, "fade", "#2563EB", { dark: "#00000080" }, undefined, 0.5);
    // The base is half-transparent; the dark override says 50% itself and must
    // not pick up the base's alpha a second time.
    expect(out.value).toBe("#2563eb80");
    expect(out.modes).toEqual({ dark: "#00000080" });
  });
});
