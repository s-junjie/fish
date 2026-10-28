import { describe, expect, it } from "vitest";
import type { AssetRef, Paint } from "../src/core/dsl/types";
import {
  emptyKindMemory,
  gradientSwitchPaint,
  imageSwitchPaint,
  patternSwitchPaint,
  rememberPaint
} from "../src/ui/color-panel/kind-memory";

const asset = (id: string, uri = "blob:x"): AssetRef => ({ id, name: id, uri });

const linear = (angle: number): Paint => ({
  type: "linear-gradient",
  from: "#FF0000",
  to: "#0000FF",
  angle,
  stops: [
    { color: "#FF0000", offset: 0 },
    { color: "#0000FF", offset: 1 }
  ]
});

const radial: Paint = {
  type: "radial-gradient",
  from: "#FFFFFF",
  to: "#000000",
  center: { x: 0.2, y: 0.8 },
  radius: 0.4,
  angle: 30
};

const STOPS = [
  { color: "#111111", offset: 0 },
  { color: "#EEEEEE", offset: 1 }
];

describe("kind memory", () => {
  it("re-points at the bitmap the layer last painted, keeping its framing and adjust", () => {
    const memory = emptyKindMemory();
    rememberPaint(memory, {
      type: "image",
      assetId: "a1",
      fit: "crop",
      focalPoint: { x: 0.3, y: 0.7 },
      adjust: { brightness: 0.2 }
    });
    expect(imageSwitchPaint(memory, [asset("a1")])).toMatchObject({
      assetId: "a1",
      fit: "crop",
      focalPoint: { x: 0.3, y: 0.7 }
    });
  });

  it("falls back to the first usable asset, cover-framed, when the remembered one is gone", () => {
    const memory = emptyKindMemory();
    rememberPaint(memory, { type: "image", assetId: "deleted", fit: "crop" });
    const next = imageSwitchPaint(memory, [asset("blank", ""), asset("a2")]);
    expect(next).toEqual({ type: "image", assetId: "a2", fit: "cover" });
  });

  it("reports no paint when the document has no bitmap at all", () => {
    expect(imageSwitchPaint(emptyKindMemory(), [asset("blank", "")])).toBeNull();
  });

  it("carries a pattern's own memory by copy, not by reference", () => {
    const memory = emptyKindMemory();
    const pattern: Paint = {
      type: "pattern",
      motif: "grid",
      tile: { width: 8, height: 8 },
      foreground: "#123456"
    };
    rememberPaint(memory, pattern);
    const next = patternSwitchPaint(memory, "#FFFFFF");
    expect(next).toMatchObject({ motif: "grid", foreground: "#123456" });
    expect(next).not.toBe(pattern);
  });

  it("remembers the linear angle for a paint that states none of its own", () => {
    const memory = emptyKindMemory();
    rememberPaint(memory, linear(37));
    rememberPaint(memory, radial);
    const back = gradientSwitchPaint("linear-gradient", { type: "solid", color: "#FFFFFF" }, STOPS, "#FFFFFF", memory);
    expect(back).toMatchObject({ type: "linear-gradient", angle: 37 });
  });

  it("lets a live gradient's own angle win over the remembered one", () => {
    const memory = emptyKindMemory();
    rememberPaint(memory, linear(37));
    const angular: Paint = { type: "angular-gradient", from: "#000000", to: "#FFFFFF", angle: 75, stops: STOPS };
    rememberPaint(memory, angular);
    expect(gradientSwitchPaint("linear-gradient", angular, STOPS, "#FFFFFF", memory)).toMatchObject({ angle: 75 });
  });

  it("re-enters a radial at its remembered centre and radius, but at the default rotation", () => {
    const memory = emptyKindMemory();
    rememberPaint(memory, radial);
    rememberPaint(memory, linear(90));
    const back = gradientSwitchPaint("radial-gradient", linear(90), STOPS, "#FFFFFF", memory);
    expect(back).toMatchObject({ center: { x: 0.2, y: 0.8 }, radius: 0.4 });
    expect(back).not.toHaveProperty("angle");
  });

  it("turns a solid's colour into a two-stop ramp at the defaults when nothing was remembered", () => {
    const next = gradientSwitchPaint("linear-gradient", { type: "solid", color: "#ABCDEF" }, [], "#ABCDEF", emptyKindMemory());
    expect(next).toMatchObject({
      from: "#ABCDEF",
      to: "#8B5CF6",
      angle: 90,
      fromOffset: 0,
      toOffset: 100,
      stops: [
        { color: "#ABCDEF", offset: 0 },
        { color: "#8B5CF6", offset: 100 }
      ]
    });
  });
});
