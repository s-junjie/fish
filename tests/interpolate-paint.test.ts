import { describe, expect, it } from "vitest";
import { interpolatePaints } from "../src/core/presentation/interpolate-appearance";
import type { Paint } from "../src/core/dsl/types";

/**
 * Paint interpolation is a FIELD merge: it starts from the target layer and moves
 * the fields both sides state. What it must never do is write a field neither
 * side had — the gradient branch used to do exactly that, stamping
 * `from`/`to: "#000000"` onto anything that was not a solid, image or pattern,
 * which is how a ramp carried by `stops` alone went black mid-transition and how
 * a pattern arrived with two illegal keys on it.
 */

const pattern = (over: Record<string, unknown> = {}): Paint =>
  ({
    type: "pattern",
    motif: "diagonal-stripes",
    tile: { width: 8, height: 8 },
    scale: 1,
    weight: 1,
    angle: 0,
    foreground: "#111111",
    background: "#FFFFFF",
    ...over
  }) as unknown as Paint;

const at = (paints: Paint[] | undefined): Record<string, unknown> =>
  (paints ?? [])[0] as unknown as Record<string, unknown>;

describe("a pattern", () => {
  it("lerps one motif's ink, scale and cell rather than inventing from/to", () => {
    const out = at(
      interpolatePaints(
        [pattern({ foreground: "#000000", background: "#000000", scale: 1, angle: 0 })],
        [pattern({ foreground: "#FFFFFF", background: "#FFFFFF", scale: 3, angle: 90, tile: { width: 24, height: 16 } })],
        0.5
      )
    );

    expect(out.type).toBe("pattern");
    expect(out.foreground).toBe("rgba(128, 128, 128, 1)");
    expect(out.background).toBe("rgba(128, 128, 128, 1)");
    expect(out.scale).toBe(2);
    expect(out.angle).toBe(45);
    expect(out.tile).toEqual({ width: 16, height: 12 });
    expect(out).not.toHaveProperty("from");
    expect(out).not.toHaveProperty("to");
  });

  it("cross-fades two different motifs instead of faking a halfway tiling", () => {
    // A stripe grid and a dot grid have nothing in common to interpolate, so the
    // pair dissolves in place — the same rule a change of bitmap follows.
    const stack = interpolatePaints([pattern()], [pattern({ motif: "dots" })], 0.5) ?? [];
    expect(stack).toHaveLength(2);
    expect(stack.map((p) => (p as { motif?: string }).motif)).toEqual(["diagonal-stripes", "dots"]);
    for (const paint of stack) expect(paint.opacity).toBe(0.5);
  });
});

describe("a gradient carried by stops", () => {
  it("does not gain a from/to pair the document never had", () => {
    const ramp = (color: string): Paint =>
      ({
        type: "linear-gradient",
        angle: 0,
        stops: [
          { color, offset: 0 },
          { color: "#0000FF", offset: 1 }
        ]
      }) as unknown as Paint;

    const out = at(interpolatePaints([ramp("#000000")], [ramp("#FFFFFF")], 0.5));
    expect(out).not.toHaveProperty("from");
    expect(out).not.toHaveProperty("to");
    // The stops travel on their own, which is the only ramp this paint states.
    expect((out.stops as { color: string }[])[0].color).toBe("rgba(128, 128, 128, 1)");
  });

  it("still lerps the endpoints when both sides state them", () => {
    const ramp = (from: string, to: string): Paint =>
      ({ type: "linear-gradient", from, to, angle: 0 }) as unknown as Paint;
    const out = at(interpolatePaints([ramp("#000000", "#000000")], [ramp("#FFFFFF", "#FFFFFF")], 0.5));
    expect(out.from).toBe("rgba(128, 128, 128, 1)");
    expect(out.to).toBe("rgba(128, 128, 128, 1)");
  });
});
