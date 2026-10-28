import { describe, it, expect } from "vitest";
import {
  interpolateCornerRadius,
  interpolateEffects
} from "../src/core/presentation/interpolate-effects";
import type { Effect, TearEffect, DropShadowEffect, LiquidGlassEffect } from "../src/core/dsl/types";

describe("interpolate-effects", () => {
  it("returns undefined when both sides have no effects", () => {
    expect(interpolateEffects(undefined, undefined, 0.5)).toBeUndefined();
    expect(interpolateEffects([], [], 0.5)).toBeUndefined();
  });

  it("interpolates layer-blur from zero and to zero", () => {
    const blur20: Effect[] = [{ type: "layer-blur", blur: 20 }];
    const half = interpolateEffects(undefined, blur20, 0.5);
    expect(half).toHaveLength(1);
    expect(half![0]).toEqual({ type: "layer-blur", blur: 10 });

    const fadeOut = interpolateEffects(blur20, undefined, 0.25);
    expect(fadeOut![0]).toEqual({ type: "layer-blur", blur: 15 });
  });

  it("interpolates backdrop-blur smoothly", () => {
    const blurA: Effect[] = [{ type: "backdrop-blur", blur: 6 }];
    const blurB: Effect[] = [{ type: "backdrop-blur", blur: 14 }];
    const res = interpolateEffects(blurA, blurB, 0.5);
    expect(res![0]).toEqual({ type: "backdrop-blur", blur: 10 });
  });

  it("interpolates tear hole form with EdgeInsets inset", () => {
    const holeA: Effect[] = [
      {
        type: "tear",
        profile: "torn",
        form: "hole",
        scale: 100,
        seed: 1,
        inset: [20, 20, 40, 40],
        fiber: 0.2,
        roughness: 0.4
      } as TearEffect
    ];
    const holeB: Effect[] = [
      {
        type: "tear",
        profile: "torn",
        form: "hole",
        scale: 200,
        seed: 1,
        inset: [40, 40, 20, 20],
        fiber: 0.6,
        roughness: 0.8
      } as TearEffect
    ];
    const mid = interpolateEffects(holeA, holeB, 0.5)![0] as any;
    expect(mid.scale).toBe(150);
    expect(mid.inset).toEqual([30, 30, 30, 30]);
    expect(mid.fiber).toBe(0.4);
    expect(mid.roughness).toBe(0.6);
  });

  it("interpolates drop-shadow offset, blur, spread and color", () => {
    const shadowA: Effect[] = [
      {
        type: "drop-shadow",
        offset: { x: 0, y: 0 },
        blur: 0,
        spread: 0,
        color: "rgba(0, 0, 0, 0)"
      } as DropShadowEffect
    ];
    const shadowB: Effect[] = [
      {
        type: "drop-shadow",
        offset: { x: 10, y: 20 },
        blur: 30,
        spread: 10,
        color: "rgba(200, 100, 50, 1)"
      } as DropShadowEffect
    ];
    const mid = interpolateEffects(shadowA, shadowB, 0.5)![0] as DropShadowEffect;
    expect(mid.offset).toEqual({ x: 5, y: 10 });
    expect(mid.blur).toBe(15);
    expect(mid.spread).toBe(5);
    expect(mid.color).toBe("rgba(100, 50, 25, 0.5)");
  });

  it("interpolates liquid-glass parameters", () => {
    const glassA: Effect[] = [
      {
        type: "liquid-glass",
        frost: 10,
        refraction: 20,
        depth: 5,
        dispersion: 0,
        lightAngle: 0,
        lightIntensity: 50,
        splay: 20
      } as LiquidGlassEffect
    ];
    const glassB: Effect[] = [
      {
        type: "liquid-glass",
        frost: 30,
        refraction: 60,
        depth: 15,
        dispersion: 40,
        lightAngle: 90,
        lightIntensity: 100,
        splay: 60
      } as LiquidGlassEffect
    ];
    const mid = interpolateEffects(glassA, glassB, 0.5)![0] as LiquidGlassEffect;
    expect(mid.frost).toBe(20);
    expect(mid.refraction).toBe(40);
    expect(mid.depth).toBe(10);
    expect(mid.dispersion).toBe(20);
    expect(mid.lightAngle).toBe(45);
    expect(mid.lightIntensity).toBe(75);
    expect(mid.splay).toBe(40);
  });

  it("interpolates cornerRadius", () => {
    expect(interpolateCornerRadius(undefined, undefined, 0.5)).toBeUndefined();
    expect(interpolateCornerRadius(0, 20, 0.5)).toBe(10);
    expect(interpolateCornerRadius([0, 0, 10, 10], [20, 20, 30, 30], 0.5)).toEqual([10, 10, 20, 20]);
    expect(interpolateCornerRadius(10, [10, 20, 30, 40], 0.5)).toEqual([10, 15, 20, 25]);
  });
});
