import { describe, expect, it } from "vitest";
import type { GradientStop } from "../src/core/dsl/types";
import { pickStopAtOffset } from "../src/ui/color-panel/stop-edit";

const stops: GradientStop[] = [
  { color: "#000000", offset: 0 },
  { color: "#FF0000", offset: 0.5 },
  { color: "#00FF00", offset: 0.5 },
  { color: "#FFFFFF", offset: 1 }
];

describe("pressing a stop that shares its offset", () => {
  it("cycles to the stop underneath when the selected twin is pressed again", () => {
    expect(pickStopAtOffset(stops, 1, 1)).toBe(2);
    expect(pickStopAtOffset(stops, 2, 2)).toBe(1);
  });

  it("selects a twin normally when it is not the selected one", () => {
    expect(pickStopAtOffset(stops, 2, 1)).toBe(2);
    expect(pickStopAtOffset(stops, 1, 2)).toBe(1);
  });

  it("leaves an unshared stop alone", () => {
    expect(pickStopAtOffset(stops, 0, 0)).toBe(0);
    expect(pickStopAtOffset(stops, 3, 0)).toBe(3);
  });

  it("does not invent a stop for an index that is not there", () => {
    expect(pickStopAtOffset(stops, 9, 0)).toBe(9);
  });
});
