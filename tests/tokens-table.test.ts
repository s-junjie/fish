import { describe, expect, it } from "vitest";
import { groupTokensByName, generateUniqueTokenName } from "../src/ui/tokens/token-table-utils";
import { createColorToken } from "../src/core/interactions/token-ops";
import {
  createNumberToken,
  isNumberToken
} from "../src/core/interactions/number-token-ops";
import {
  addDocumentMode,
  addDocumentNumberMode,
  deleteDocumentMode,
  deleteDocumentNumberMode,
  getColorTokenModeColor,
  getNumberTokenModeValue,
  updateColorTokenWithModes,
  updateNumberTokenWithModes
} from "../src/core/interactions/mode-ops";
import type { ColorToken, DesignDocument } from "../src/core/dsl/types";

describe("Tokens Table Overview", () => {
  describe("groupTokensByName", () => {
    it("groups tokens by prefix before slash", () => {
      const tokens = [
        { name: "bg/canvas" },
        { name: "bg/card" },
        { name: "brand/primary" },
        { name: "accent" }
      ];

      const groups = groupTokensByName(tokens);

      expect(groups).toHaveLength(3);
      expect(groups[0].groupName).toBe("bg");
      expect(groups[0].items).toHaveLength(2);
      expect(groups[0].items[0].displayName).toBe("canvas");
      expect(groups[0].items[1].displayName).toBe("card");

      expect(groups[1].groupName).toBe("brand");
      expect(groups[1].items[0].displayName).toBe("primary");

      expect(groups[2].groupName).toBe("");
      expect(groups[2].items[0].displayName).toBe("accent");
    });

    it("filters tokens by search query across groups", () => {
      const tokens = [
        { name: "bg/card" },
        { name: "brand/primary" },
        { name: "brand/secondary" }
      ];

      const groups = groupTokensByName(tokens, "brand");
      expect(groups).toHaveLength(1);
      expect(groups[0].groupName).toBe("brand");
      expect(groups[0].items).toHaveLength(2);

      const emptyGroups = groupTokensByName(tokens, "nonexistent");
      expect(emptyGroups).toHaveLength(0);
    });
  });

  describe("generateUniqueTokenName", () => {
    it("generates sequential unique names", () => {
      const existing = [{ name: "color 1" }, { name: "color 2" }];
      expect(generateUniqueTokenName(existing, "color")).toBe("color 3");
    });

    it("generates group prefixed names", () => {
      const existing = [{ name: "brand/color 1" }];
      expect(generateUniqueTokenName(existing, "color", "brand")).toBe("brand/color 2");
    });
  });

  describe("Color Token multi-mode updates in table matrix", () => {
    it("updates light color and mode overrides independently", () => {
      const token = createColorToken("bg/card", "#FFFFFF");
      expect(getColorTokenModeColor(token, "light")).toBe("#FFFFFF");

      // Add dark override
      const withDark = updateColorTokenWithModes(token, "bg/card", "#FFFFFF", {
        dark: "#121212"
      });
      expect(getColorTokenModeColor(withDark, "light")).toBe("#FFFFFF");
      expect(getColorTokenModeColor(withDark, "dark")).toBe("#121212");

      // Reset dark override to inherited
      const resetDark = updateColorTokenWithModes(withDark, "bg/card", "#FFFFFF", {
        dark: undefined
      });
      expect(resetDark.modes).toBeUndefined();
      expect(getColorTokenModeColor(resetDark, "dark")).toBe("#FFFFFF");
    });

    it("never stores baseModeId in token.modes and encodes opacity into color for canvas sync", () => {
      const token = createColorToken("bg/glass", "#1B72FF");
      const updated = updateColorTokenWithModes(
        token,
        "bg/glass",
        "#1B72FF",
        {
          default: "#1B72FF",
          dark: { color: "#0A0A0A", opacity: 0.5 }
        },
        undefined,
        0.8,
        "default"
      );
      expect(updated.modes?.default).toBeUndefined();
      expect(getColorTokenModeColor(updated, "default")).toBe("#1b72ffcc");
      expect(getColorTokenModeColor(updated, "dark")).toBe("#0a0a0a80");
    });
  });

  describe("Number Token multi-mode updates in table matrix", () => {
    it("updates light value and mode overrides independently", () => {
      const token = createNumberToken("space/md", 16, "spacing");
      expect(getNumberTokenModeValue(token, "light")).toBe(16);

      // Add dark override
      const withDark = updateNumberTokenWithModes(token, "space/md", "spacing", 16, {
        dark: 20
      });
      expect(getNumberTokenModeValue(withDark, "light")).toBe(16);
      expect(getNumberTokenModeValue(withDark, "dark")).toBe(20);

      // Reset dark override
      const resetDark = updateNumberTokenWithModes(withDark, "space/md", "spacing", 16, {
        dark: undefined
      });
      expect(resetDark.modes).toBeUndefined();
      expect(getNumberTokenModeValue(resetDark, "dark")).toBe(16);
    });
  });

  describe("Mode addition and deletion in table matrix", () => {
    it("deletes a custom mode and cleans up overrides across tokens", () => {
      const doc = {
        id: "d1",
        name: "Test Doc",
        tokens: [
          createColorToken("bg/canvas", "#FFFFFF"),
          createNumberToken("space/md", 16, "spacing")
        ]
      } as unknown as DesignDocument;

      // Add a Dark mode
      const { doc: docWithDark, mode: dark } = addDocumentMode(doc, "Dark");
      expect(dark.id).toBe("dark");
      expect(docWithDark.modes?.length).toBe(2);

      // Add overrides to tokens
      const updatedColor = updateColorTokenWithModes(
        docWithDark.tokens![0] as ColorToken,
        "bg/canvas",
        "#FFFFFF",
        { dark: "#000000" }
      );
      const updatedNumber = updateNumberTokenWithModes(
        docWithDark.tokens![1] as any,
        "space/md",
        "spacing",
        16,
        { dark: 24 }
      );
      const docWithOverrides: DesignDocument = {
        ...docWithDark,
        tokens: [updatedColor, updatedNumber]
      };

      // Delete the COLOUR mode: only the colour token's override goes. The
      // number token is filed under the NUMBER axis, where `dark` means nothing.
      const cleanedDoc = deleteDocumentMode(docWithOverrides, "dark");

      expect(cleanedDoc.modes?.some((m) => m.id === "dark")).toBe(false);
      expect(cleanedDoc.tokens![0].modes).toBeUndefined();
      expect(cleanedDoc.tokens![1].modes).toEqual({ dark: 24 });
    });

    it("deletes a number mode and cleans up only the number overrides", () => {
      const doc = {
        id: "d1",
        name: "Test Doc",
        tokens: [
          createColorToken("bg/canvas", "#FFFFFF"),
          createNumberToken("space/md", 16, "spacing")
        ]
      } as unknown as DesignDocument;

      const { doc: withDensity, mode: compact } = addDocumentNumberMode(doc, "Compact");
      expect(compact.id).toBe("compact");

      const docWithOverrides: DesignDocument = {
        ...withDensity,
        tokens: [
          withDensity.tokens![0],
          updateNumberTokenWithModes(withDensity.tokens![1] as any, "space/md", "spacing", 16, {
            compact: 12
          })
        ]
      };

      const cleanedDoc = deleteDocumentNumberMode(docWithOverrides, "compact");
      expect(cleanedDoc.numberModes?.some((m) => m.id === "compact")).toBe(false);
      expect(cleanedDoc.tokens![1].modes).toBeUndefined();
      expect(cleanedDoc.tokens![0].modes).toBeUndefined();
    });
  });
});

