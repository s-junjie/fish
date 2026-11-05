import { describe, expect, it } from "vitest";
import {
  consumeGradientStopDelete,
  getGradientStopIndex,
  setGradientEditTarget,
  setGradientEditorOpen,
  setGradientStopIndex
} from "../src/ui/hooks/gradient-edit";

const FILL = { elId: "el_a", paintIndex: 0, stack: "fills" as const };

describe("the gradient editor's shared selection", () => {
  it("keeps the stop across edits of the same paint", () => {
    setGradientEditTarget(FILL);
    setGradientStopIndex(2);
    setGradientEditTarget(FILL);
    expect(getGradientStopIndex()).toBe(2);
  });

  it("starts a different paint at its first stop", () => {
    setGradientEditTarget({ elId: "el_b", paintIndex: 0, stack: "fills" });
    expect(getGradientStopIndex()).toBe(0);
    setGradientEditTarget({ elId: "el_b", paintIndex: 0, stack: "strokes" });
    expect(getGradientStopIndex()).toBe(0);
  });

  it("hands Delete to the panel only while a gradient editor is open", () => {
    expect(consumeGradientStopDelete(), "nothing open: the layer keeps the key").toBe(false);
    setGradientEditorOpen(true);
    expect(consumeGradientStopDelete(), "an open gradient takes the key").toBe(true);
    setGradientEditorOpen(false);
    expect(consumeGradientStopDelete(), "closed again: back to the layer").toBe(false);
  });
});
