import { describe, it, expect } from "vitest";
import {
  PRESET_FONTS,
  buildFontOptions,
  currentLabel,
  firstFamily,
  localFamilyOption
} from "../src/ui/inspector/fonts";

describe("firstFamily", () => {
  it("extracts the leading family from a stack", () => {
    expect(firstFamily("Inter, sans-serif")).toBe("Inter");
    expect(firstFamily("Arial, sans-serif")).toBe("Arial");
  });

  it("strips surrounding quotes", () => {
    expect(firstFamily('"Comic Sans MS", cursive')).toBe("Comic Sans MS");
    expect(firstFamily("'Fira Code', monospace")).toBe("Fira Code");
  });

  it("tolerates empty and raw values", () => {
    expect(firstFamily("")).toBe("");
    expect(firstFamily("Helvetica")).toBe("Helvetica");
  });
});

describe("buildFontOptions", () => {
  it("always keeps the current value selectable when it has no preset or local entry", () => {
    const options = buildFontOptions("Montserrat, sans-serif", null);
    expect(options.some((o) => o.label === "Montserrat")).toBe(true);
    expect(options.some((o) => o.id === "Montserrat, sans-serif")).toBe(true);
  });

  it("merges local families with the preset stack and sorts by label", () => {
    const options = buildFontOptions("Inter, sans-serif", ["Arial", "Zapf Dingbats", "PingFang SC"]);
    const labels = options.map((o) => o.label);
    expect(labels[0]).toBe("Arial");
    expect(labels).toContain("Zapf Dingbats");
    expect(labels).toContain("PingFang SC");
    expect(options.find((o) => o.label === "PingFang SC")?.id).toBe("PingFang SC");
  });

  it("keeps the preset entry when a local family collides with it", () => {
    const options = buildFontOptions("Inter", ["Arial", "Helvetica Neue"]);
    const arial = options.find((o) => o.label === "Arial");
    expect(arial?.isLocal).toBe(false);
    expect(arial?.id).toBe("Arial");
  });

  it("local families that collide with the current value's first family are not duplicated", () => {
    const options = buildFontOptions("Arial, sans-serif", ["Arial"]);
    const arials = options.filter((o) => o.label === "Arial");
    expect(arials.length).toBe(1);
    expect(arials[0].isLocal).toBe(false);
  });

  it("offers only the presets the platform actually has", () => {
    const options = buildFontOptions("Inter", ["Inter", "Georgia"]);
    const labels = options.map((o) => o.label);
    expect(labels).toContain("Georgia");
    expect(labels).not.toContain("Arial");
    expect(labels).not.toContain("Roboto");
  });

  it("keeps a generic-only preset, which no font list can report as installed", () => {
    const options = buildFontOptions("Georgia", ["Georgia"]);
    const systemUi = options.find((o) => o.label === "System UI");
    expect(systemUi?.id).toBe("system-ui");
  });

  it("keeps every preset while the platform has not been asked", () => {
    const options = buildFontOptions("Inter", null);
    for (const p of PRESET_FONTS) {
      expect(options.some((o) => o.label === p.label)).toBe(true);
    }
  });

  it("keeps every preset when the platform returned no list (denied or unsupported)", () => {
    const options = buildFontOptions("Inter", []);
    for (const p of PRESET_FONTS) {
      expect(options.some((o) => o.label === p.label)).toBe(true);
    }
  });
});

describe("localFamilyOption", () => {
  it("quotes families with special characters and leaves word/space names bare", () => {
    // The id is what the document will store: the bare family, quoted only when
    // CSS needs it. The fallback is appended at paint time by `resolveStack`.
    expect(localFamilyOption("PingFang SC").id).toBe("PingFang SC");
    expect(localFamilyOption("Comic Sans MS").id).toBe("Comic Sans MS");
    expect(localFamilyOption('Heavy "Impact" Cut').id).toBe('"Heavy \\"Impact\\" Cut"');
  });
});

describe("currentLabel", () => {
  it("resolves the label for a local font whose id is the fallback stack", () => {
    const options = buildFontOptions("PingFang SC", ["PingFang SC"]);
    expect(currentLabel(options, options.find((o) => o.label === "PingFang SC")!.id)).toBe("PingFang SC");
  });

  it("falls back to the first family for unknown stacks", () => {
    expect(currentLabel(buildFontOptions("Inter", null), "Totally Unknown, serif")).toBe("Totally Unknown");
  });
});