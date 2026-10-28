import { describe, expect, it } from "vitest";
import { paintStackLayers } from "../src/core/geometry/gradient-utils";
import { Paint } from "../src/core/dsl/types";

const solid = (color: string, extra: Record<string, unknown> = {}): Paint =>
  ({ type: "solid", color, ...extra } as Paint);

describe("paint stack preview layers", () => {
  it("emits one layer per paint, bottom first", () => {
    const layers = paintStackLayers([solid("#FF0000"), solid("#0000FF", { opacity: 0.5 })]);
    expect(layers).toEqual([
      { background: "#ff0000", opacity: 1 },
      { background: "#0000ff", opacity: 0.5 }
    ]);
  });

  // A single-colour swatch of a translucent stack shows the wrong colour, which
  // is exactly what the inspector pill used to do.
  it("keeps translucent upper layers translucent instead of sampling one colour", () => {
    const layers = paintStackLayers([solid("#FFFFFF"), solid("#0000FFCC")]);
    expect(layers).toHaveLength(2);
    expect(layers[1]).toEqual({ background: "#0000ff", opacity: 0.8 });
  });

  it("skips hidden layers and layers with no resolvable image", () => {
    const layers = paintStackLayers([
      solid("#111111"),
      solid("#222222", { enabled: false }),
      { type: "image", assetId: "missing" } as Paint
    ]);
    expect(layers).toEqual([{ background: "#111111", opacity: 1 }]);
  });

  it("resolves image layers through the supplied uri lookup", () => {
    const layers = paintStackLayers([{ type: "image", assetId: "a1" } as Paint], () => "data:image/png;base64,x");
    expect(layers[0].background).toContain("url(\"data:image/png;base64,x\")");
    expect(layers[0].opacity).toBe(1);
  });

  it("renders gradients as their CSS gradient", () => {
    const layers = paintStackLayers([
      { type: "linear-gradient", angle: 90, from: "#000000", to: "#FFFFFF" } as Paint
    ]);
    expect(layers[0].background).toContain("linear-gradient(90deg");
  });

  it("handles an empty or missing stack", () => {
    expect(paintStackLayers([])).toEqual([]);
    expect(paintStackLayers(undefined)).toEqual([]);
  });
});
