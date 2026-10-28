import { describe, expect, it } from "vitest";
import type { GradientStop } from "../src/core/dsl/types";
import { linearAngleFromVector } from "../src/core/geometry/gradient-utils";
import type { GradientPaint } from "../src/ui/color-panel/kind-memory";
import {
  clampStopOffset,
  insertStopAt,
  rotateAxisToAngle,
  roundOffset,
  withStops
} from "../src/ui/color-panel/stop-edit";

const RAMP: GradientStop[] = [
  { color: "#FF0000", offset: 0 },
  { color: "#00FF00", offset: 0.5 },
  { color: "#0000FF", offset: 1 }
];

const gradient = (over: Partial<GradientPaint> = {}): GradientPaint =>
  ({
    type: "linear-gradient",
    from: "#FF0000",
    to: "#0000FF",
    angle: 90,
    stops: RAMP,
    ...over
  }) as GradientPaint;

describe("gradient stop editing", () => {
  it("keeps `from`/`to` in step with the sorted stops", () => {
    const next = withStops(gradient(), [
      { color: "#0000FF", offset: 1 },
      { color: "#FF0000", offset: 0 }
    ]);
    expect(next).toMatchObject({
      stops: [
        { color: "#FF0000", offset: 0 },
        { color: "#0000FF", offset: 1 }
      ],
      from: "#FF0000",
      to: "#0000FF",
      fromOffset: 0,
      toOffset: 1
    });
  });

  it("holds a stop between its neighbours, and the ramp's ends at 0 and 1", () => {
    expect(clampStopOffset(RAMP, 2, 0.2)).toBe(0.5);
    expect(clampStopOffset(RAMP, 0, 0.3)).toBe(0.3);
    expect(clampStopOffset(RAMP, 0, -2)).toBe(0);
    expect(clampStopOffset(RAMP, 2, 9)).toBe(1);
  });

  it("splits the ramp with the colour it already has at that offset", () => {
    const flat: GradientStop[] = [
      { color: "#FF0000", offset: 0 },
      { color: "#FF0000", offset: 1 }
    ];
    const { stops, index } = insertStopAt(flat, 0.25);
    expect(index).toBe(1);
    expect(stops).toEqual([
      { color: "#FF0000", offset: 0 },
      { color: "#ff0000", offset: 0.25 },
      { color: "#FF0000", offset: 1 }
    ]);
  });

  it("inserts before the first stop and selects it", () => {
    const { stops, index } = insertStopAt(
      [
        { color: "#FF0000", offset: 0.2 },
        { color: "#0000FF", offset: 1 }
      ],
      0
    );
    expect(index).toBe(0);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toMatchObject({ color: "#FF0000", offset: 0 });
  });

  it("rounds an offset to the precision the field shows, inside 0..1", () => {
    expect(roundOffset(0.12345)).toBe(0.123);
    expect(roundOffset(-0.5)).toBe(0);
    expect(roundOffset(1.7)).toBe(1);
  });

  it("sets the angle alone when the axis has no independent endpoints", () => {
    const radial = gradient({ type: "radial-gradient" } as Partial<GradientPaint>);
    expect(rotateAxisToAngle(radial, 45)).toMatchObject({ angle: 45, type: "radial-gradient" });
  });

  it("re-aims independent endpoints to the requested angle about their midpoint", () => {
    const paint = gradient({ start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } });
    const next = rotateAxisToAngle(paint, 90);
    const { start, end } = next as { start: { x: number; y: number }; end: { x: number; y: number } };
    expect(linearAngleFromVector(end.x - start.x, end.y - start.y)).toBeCloseTo(90, 4);
    expect((start.x + end.x) / 2).toBeCloseTo(0.5, 6);
    expect((start.y + end.y) / 2).toBeCloseTo(0.5, 6);
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo(1, 6);
  });

  it("leaves endpoints where they are when the angle does not change", () => {
    const paint = gradient({ angle: 180, start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } });
    const next = rotateAxisToAngle(paint, 180);
    expect(next).toMatchObject({ start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 }, angle: 180 });
  });
});
