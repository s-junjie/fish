import { describe, expect, it } from "vitest";
import { colorModeLabels, numberModeLabels } from "../src/ui/inspector/mode-labels";
import { createColorToken } from "../src/core/interactions/token-ops";
import { createNumberToken } from "../src/core/interactions/number-token-ops";
import { updateColorTokenWithModes, updateNumberTokenWithModes } from "../src/core/interactions/mode-ops";
import type { ColorToken, DocumentMode } from "../src/core/dsl/types";

const LIGHT_DARK: DocumentMode[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" }
];

function colorWithDark(base: string, dark: string): ColorToken {
  const token = createColorToken("color/canvas", base);
  return updateColorTokenWithModes(token, token.name, base, { dark });
}

describe("colorModeLabels", () => {
  it("reads a single value when the token has one colour", () => {
    const token = createColorToken("color/canvas", "#E8E7E3");
    expect(colorModeLabels(token, LIGHT_DARK)).toEqual(["#E8E7E3"]);
  });

  it("reads one hex per mode that holds a value, in document order", () => {
    expect(colorModeLabels(colorWithDark("#E8E7E3", "#1B1B1F"), LIGHT_DARK)).toEqual([
      "#E8E7E3",
      "#1B1B1F"
    ]);
  });

  it("omits a mode that inherits the base colour", () => {
    const token = createColorToken("color/canvas", "#E8E7E3");
    const withThirdMode = updateColorTokenWithModes(token, token.name, "#E8E7E3", {
      dark: "#1B1B1F"
    });
    const modes: DocumentMode[] = [...LIGHT_DARK, { id: "hc", name: "High Contrast" }];

    expect(colorModeLabels(withThirdMode, modes)).toEqual(["#E8E7E3", "#1B1B1F"]);
  });

  it("carries alpha in the readout, tight against the dot", () => {
    const token = createColorToken("color/scrim", "#000000");
    const translucent = updateColorTokenWithModes(token, token.name, "#000000", {
      dark: { color: "#000000", opacity: 0.5 }
    });

    // No spaces: a mono space is a full cell, and it opened an 11px gap around the dot.
    expect(colorModeLabels(translucent, LIGHT_DARK)).toEqual(["#000000", "#000000·50%"]);
  });
});

describe("numberModeLabels", () => {
  it("reads a single value when the token has one number", () => {
    expect(numberModeLabels(createNumberToken("space/md", 16, "spacing"), LIGHT_DARK)).toEqual([
      "16px"
    ]);
  });

  it("reads one value per mode that holds one", () => {
    const token = updateNumberTokenWithModes(
      createNumberToken("space/md", 16, "spacing"),
      "space/md",
      "spacing",
      16,
      { dark: 20 }
    );

    expect(numberModeLabels(token, LIGHT_DARK)).toEqual(["16px", "20px"]);
  });
});
