import { describe, expect, it } from "vitest";
import {
  VIEWER_MAX_WIDTH,
  editorHref,
  resolveViewMode,
  type ViewModeInput
} from "../src/ui/viewer/viewer-mode";

const phone = (overrides: Partial<ViewModeInput> = {}): ViewModeInput => ({
  search: "",
  width: 390,
  coarsePointer: true,
  ...overrides
});

describe("resolveViewMode", () => {
  it("opens the reader on a narrow touch device", () => {
    expect(resolveViewMode(phone())).toBe("viewer");
  });

  it("leaves a narrow window on a mouse-driven desktop in the editor", () => {
    // The failure this prevents is the editor appearing to break when a window
    // is dragged narrow — the same widths, a different input device.
    expect(resolveViewMode(phone({ coarsePointer: false }))).toBe("editor");
  });

  it("leaves a tablet in landscape in the editor", () => {
    expect(resolveViewMode(phone({ width: VIEWER_MAX_WIDTH + 1 }))).toBe("editor");
  });

  it.each(["canvas", "viewer", "editor"] as const)("lets ?view=%s win over the device", (mode) => {
    expect(resolveViewMode(phone({ search: `?view=${mode}`, coarsePointer: false }))).toBe(mode);
    expect(resolveViewMode(phone({ search: `?view=${mode}` }))).toBe(mode);
  });

  it("ignores an unknown ?view= value instead of falling into a shell", () => {
    expect(resolveViewMode(phone({ search: "?view=2", coarsePointer: true }))).toBe("viewer");
  });

  it("reads a query with other parameters", () => {
    expect(resolveViewMode(phone({ search: "?file=x&view=canvas" }))).toBe("canvas");
  });

  it("opens a read-only file in the reader on every device", () => {
    // A desktop has no third shell to offer it: the reader is the only one with
    // no write path, and a disabled editor would read as a broken one.
    expect(resolveViewMode({ search: "", width: 1440, coarsePointer: false, readOnly: true })).toBe("viewer");
    expect(resolveViewMode(phone({ readOnly: true }))).toBe("viewer");
  });

  it("refuses ?view=editor on a read-only file", () => {
    expect(resolveViewMode(phone({ search: "?view=editor", readOnly: true }))).toBe("viewer");
  });

  it("keeps ?view=canvas on a read-only file — an embed never had an editor", () => {
    expect(resolveViewMode(phone({ search: "?view=canvas", readOnly: true }))).toBe("canvas");
  });
});

describe("editorHref", () => {
  it("adds the escape hatch to a bare address", () => {
    expect(editorHref("", "https://example.test/fish.html")).toBe("https://example.test/fish.html?view=editor");
  });

  it("replaces an existing view instead of stacking two", () => {
    expect(editorHref("?view=viewer", "https://example.test/fish.html")).toBe(
      "https://example.test/fish.html?view=editor"
    );
  });

  it("keeps every other parameter", () => {
    expect(editorHref("?file=kit&view=viewer", "https://example.test/fish.html")).toBe(
      "https://example.test/fish.html?file=kit&view=editor"
    );
  });

  it("drops a hash, which the reader has no use for", () => {
    expect(editorHref("", "https://example.test/fish.html#design-doc")).toBe(
      "https://example.test/fish.html?view=editor"
    );
  });
});
